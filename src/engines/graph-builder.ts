import { Project, SourceFile, SyntaxKind } from 'ts-morph';
import { resolve, relative, dirname } from 'node:path';
import { readFile } from 'node:fs/promises';
import { hashFile } from '../utils/hash-utils.js';
import { FileStoreImpl } from '../storage/file-store.js';
import { detectLanguage, parseFile, resolvePolyglotImports } from './polyglot-parser.js';
import type { ResolvedConfig } from '../storage/config-store.js';
import type { Logger } from '../utils/logger.js';

export type ConfidenceLabel = 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS';

export interface GraphEdge {
  source: string;
  target: string;
  type: 'import' | 'call' | 'type-reference';
  confidence: number; // 0.0 to 1.0
  confidenceLabel: ConfidenceLabel; // qualitative tag (Graphify-compatible)
  symbols?: string[];  // which symbols are involved
}

/**
 * Map a numeric confidence + edge type to a qualitative label.
 * - Imports are explicit in source → EXTRACTED.
 * - High-confidence calls/type-refs are reasonable inferences → INFERRED.
 * - Low-confidence edges are uncertain → AMBIGUOUS.
 */
export function confidenceLabelFor(type: GraphEdge['type'], confidence: number): ConfidenceLabel {
  if (type === 'import') return 'EXTRACTED';
  if (confidence >= 0.75) return 'INFERRED';
  return 'AMBIGUOUS';
}

export interface GraphNode {
  file: string;
  imports: string[];
  exports: string[];
  dependents: string[];
  edges?: GraphEdge[];
}

export interface GraphData {
  schemaVersion: string;
  nodes: Record<string, GraphNode>;
  edges?: GraphEdge[];
}

export interface AnalysisMeta {
  schemaVersion: string;
  buildTimestamp: string;
  fileHashes: Record<string, string>;
  parseErrors: Array<{ file: string; error: string }>;
  warnings: string[];
}

export interface GraphBuildResult {
  nodes: Map<string, GraphNode>;
  summary: { nodes: number; edges: number; rebuilt: number; skipped: number };
}

export const GRAPH_SCHEMA_VERSION = '2.1.0';

export async function buildGraph(
  projectRoot: string,
  files: string[],
  config: ResolvedConfig,
  logger: Logger
): Promise<GraphBuildResult> {
  const store = new FileStoreImpl(projectRoot);

  // Load existing meta for incremental
  const existingMeta = await store.read<AnalysisMeta>('analysis-meta.json');
  const existingGraph = await store.read<GraphData>('graph.json');

  const needsFullRebuild =
    !existingMeta ||
    !existingGraph ||
    existingMeta.schemaVersion !== GRAPH_SCHEMA_VERSION ||
    existingGraph.schemaVersion !== GRAPH_SCHEMA_VERSION;

  // Compute current hashes
  const currentHashes: Record<string, string> = {};
  for (const file of files) {
    try {
      currentHashes[file] = await hashFile(resolve(projectRoot, file));
    } catch {
      // File might have been deleted between resolve and hash
    }
  }

  // Determine which files need rebuilding
  let filesToRebuild: string[];
  let skippedCount: number;

  if (needsFullRebuild) {
    filesToRebuild = files;
    skippedCount = 0;
    logger.debug('Performing full graph rebuild');
  } else {
    filesToRebuild = [];
    for (const file of files) {
      const oldHash = existingMeta.fileHashes[file];
      if (!oldHash || oldHash !== currentHashes[file]) {
        filesToRebuild.push(file);
      }
    }
    skippedCount = files.length - filesToRebuild.length;
    logger.debug(`Incremental rebuild: ${filesToRebuild.length} changed, ${skippedCount} skipped`);
  }

  // Separate files by language: TS/JS go through ts-morph, others use polyglot parser
  const tsFiles: string[] = [];
  const polyglotFiles: string[] = [];

  for (const f of filesToRebuild) {
    const lang = detectLanguage(f);
    if (lang === 'typescript') {
      tsFiles.push(f);
    } else if (lang !== 'unknown') {
      polyglotFiles.push(f);
    }
  }

  // Parse TS/JS files with ts-morph
  let tsConfigPath: string | undefined;
  try {
    const tscPath = resolve(projectRoot, 'tsconfig.json');
    await readFile(tscPath);
    tsConfigPath = tscPath;
  } catch {
    // No tsconfig
  }

  const project = new Project({
    tsConfigFilePath: tsConfigPath,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: tsConfigPath ? undefined : { allowJs: true, esModuleInterop: true },
  });

  // Add TS/JS files to parse
  const absoluteTsFiles = tsFiles.map((f) => resolve(projectRoot, f));
  for (const absFile of absoluteTsFiles) {
    try {
      project.addSourceFileAtPath(absFile);
    } catch {
      // Skip files that can't be added
    }
  }

  // Build nodes from parsed files
  const nodes: Map<string, GraphNode> = new Map();
  const parseErrors: Array<{ file: string; error: string }> = [];
  const rebuildSet = new Set(filesToRebuild);

  // Carry over unchanged nodes from existing graph
  if (!needsFullRebuild && existingGraph) {
    for (const file of files) {
      if (!rebuildSet.has(file) && existingGraph.nodes[file]) {
        const existing = existingGraph.nodes[file];
        nodes.set(file, { ...existing, edges: existing.edges ?? [] });
      }
    }
  }

  // Parse rebuilt TS/JS files via ts-morph
  for (const sourceFile of project.getSourceFiles()) {
    const absPath = sourceFile.getFilePath();
    const rel = relative(projectRoot, absPath).replace(/\\/g, '/');

    try {
      const imports = extractImports(sourceFile, projectRoot, rel);
      const exports = extractExports(sourceFile);

      nodes.set(rel, {
        file: rel,
        imports,
        exports,
        dependents: [], // computed below
        edges: [], // computed below
      });
    } catch (err) {
      parseErrors.push({
        file: rel,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Parse polyglot files (Python, Go, Java, Markdown) via regex-based parser.
  // Build a set of all project files so imports can be resolved to real paths.
  const allFileSet = new Set(files);
  for (const file of polyglotFiles) {
    try {
      const content = await readFile(resolve(projectRoot, file), 'utf-8');
      const parsed = parseFile(file, content);

      // Resolve raw module names to actual project file paths (internal edges only)
      const resolvedImports = resolvePolyglotImports(file, parsed.imports, allFileSet);

      nodes.set(file, {
        file,
        imports: resolvedImports,
        exports: parsed.exports,
        dependents: [], // computed below
        edges: [], // computed below
      });
    } catch (err) {
      parseErrors.push({
        file,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Extract semantic edges (function calls, type references) onto each node.
  // The top-level edge list is rebuilt later from the final node set, so edges
  // are only ever stored on the owning node here.
  for (const sourceFile of project.getSourceFiles()) {
    const absPath = sourceFile.getFilePath();
    const rel = relative(projectRoot, absPath).replace(/\\/g, '/');
    const node = nodes.get(rel);
    if (!node) continue;

    try {
      node.edges = extractSemanticEdges(sourceFile, projectRoot, rel, nodes);
    } catch {
      // Non-fatal: semantic analysis can fail on complex files
    }
  }

  // Normalize each node's imports to actual node keys. ESM TypeScript requires
  // `.js` extensions in import specifiers (e.g. './user.js'), but node keys are
  // the real source paths ('src/user.ts'). Without this, edges and dependents
  // never connect for ESM TS projects. Map .js/.mjs/.cjs → .ts/.tsx and bare
  // directory imports → index files.
  const nodeKeySet = new Set(nodes.keys());
  const resolveToNodeKey = (imp: string): string => {
    if (nodeKeySet.has(imp)) return imp;
    const withoutExt = imp.replace(/\.(js|mjs|cjs|jsx)$/, '');
    const candidates = [
      `${withoutExt}.ts`,
      `${withoutExt}.tsx`,
      `${imp}.ts`,
      `${imp}.tsx`,
      `${imp}/index.ts`,
      `${imp}/index.tsx`,
      `${withoutExt}/index.ts`,
      `${withoutExt}/index.tsx`,
    ];
    for (const c of candidates) {
      if (nodeKeySet.has(c)) return c;
    }
    return imp;
  };
  for (const node of nodes.values()) {
    if (node.imports.length > 0) {
      node.imports = [...new Set(node.imports.map(resolveToNodeKey))];
    }
  }

  // Also create import edges with confidence scoring
  for (const [filePath, node] of nodes) {
    for (const imp of node.imports) {
      const target = nodes.get(imp);
      if (target) {
        // Avoid duplicate if already in edges
        const nodeEdges = node.edges ?? [];
        node.edges = nodeEdges;
        if (!nodeEdges.some(e => e.target === imp && e.type === 'import')) {
          nodeEdges.push({
            source: filePath,
            target: imp,
            type: 'import',
            confidence: 1.0, // direct imports are certain
            confidenceLabel: 'EXTRACTED',
          });
        }
      }
    }
  }

  // Compute dependents
  for (const node of nodes.values()) {
    node.dependents = [];
  }
  for (const [filePath, node] of nodes) {
    for (const imp of node.imports) {
      const target = nodes.get(imp);
      if (target && !target.dependents.includes(filePath)) {
        target.dependents.push(filePath);
      }
    }
  }

  // Count edges and rebuild the authoritative top-level edge list from the
  // final node set. This keeps the top-level `edges` array complete and
  // consistent on incremental rebuilds (where `allEdges` only holds edges
  // from rebuilt files), since carried-over nodes retain their own edges.
  let edgeCount = 0;
  const persistedEdges: GraphEdge[] = [];
  for (const node of nodes.values()) {
    const nodeEdges = node.edges ?? [];
    edgeCount += nodeEdges.length;
    persistedEdges.push(...nodeEdges);
  }

  // Persist
  const graphData: GraphData = {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    nodes: Object.fromEntries(nodes),
    edges: persistedEdges,
  };

  const meta: AnalysisMeta = {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    buildTimestamp: new Date().toISOString(),
    fileHashes: currentHashes,
    parseErrors,
    warnings: [],
  };

  await store.write('graph.json', graphData);
  await store.write('analysis-meta.json', meta);

  return {
    nodes,
    summary: {
      nodes: nodes.size,
      edges: edgeCount,
      rebuilt: filesToRebuild.length,
      skipped: skippedCount,
    },
  };
}

function extractImports(sourceFile: SourceFile, projectRoot: string, currentFile: string): string[] {
  const imports: string[] = [];
  const currentDir = dirname(resolve(projectRoot, currentFile));

  for (const decl of sourceFile.getImportDeclarations()) {
    const specifier = decl.getModuleSpecifierValue();
    const resolved = resolveImportSpecifier(specifier, currentDir, projectRoot);
    if (resolved) {
      imports.push(resolved);
    }
  }

  // Also check dynamic imports
  const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);
  for (const call of callExpressions) {
    const expr = call.getExpression();
    if (expr.getKind() === SyntaxKind.ImportKeyword) {
      const args = call.getArguments();
      if (args.length > 0 && args[0].getKind() === SyntaxKind.StringLiteral) {
        const specifier = args[0].getText().slice(1, -1); // Remove quotes
        const resolved = resolveImportSpecifier(specifier, currentDir, projectRoot);
        if (resolved) {
          imports.push(resolved);
        }
      }
    }
  }

  return [...new Set(imports)];
}

function resolveImportSpecifier(specifier: string, currentDir: string, projectRoot: string): string | null {
  // Skip bare package imports (external)
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
    return null;
  }

  const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
  const resolved = resolve(currentDir, specifier);
  const rel = relative(projectRoot, resolved).replace(/\\/g, '/');

  // Try exact match or with extensions
  for (const ext of ['', ...extensions]) {
    const candidate = rel + ext;
    // We'll accept it as-is — the graph will only contain files that exist
    if (ext === '' && extensions.some((e) => rel.endsWith(e))) {
      return rel;
    }
    if (ext !== '') {
      return candidate;
    }
  }

  // Try index files
  for (const ext of extensions) {
    const candidate = rel + '/index' + ext;
    return candidate;
  }

  return rel;
}

function extractExports(sourceFile: SourceFile): string[] {
  const exports: string[] = [];

  for (const decl of sourceFile.getExportedDeclarations()) {
    const [name] = decl;
    if (name !== 'default') {
      exports.push(name);
    } else {
      exports.push('default');
    }
  }

  return exports;
}

/**
 * Extract semantic edges: function calls and type references that cross file boundaries.
 * This gives deeper insight than import-only edges — it shows which functions actually
 * call into other files, and which types are referenced across boundaries.
 */
function extractSemanticEdges(
  sourceFile: SourceFile,
  projectRoot: string,
  currentFile: string,
  nodes: Map<string, GraphNode>,
): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const currentDir = dirname(resolve(projectRoot, currentFile));

  // Build a map: imported symbol name -> resolved file path
  const importedSymbols = new Map<string, { file: string; symbol: string }>();

  for (const decl of sourceFile.getImportDeclarations()) {
    const specifier = decl.getModuleSpecifierValue();
    const resolvedFile = resolveImportSpecifier(specifier, currentDir, projectRoot);
    if (!resolvedFile || !nodes.has(resolvedFile)) continue;

    // Named imports
    for (const named of decl.getNamedImports()) {
      const symbolName = named.getAliasNode()?.getText() ?? named.getName();
      importedSymbols.set(symbolName, { file: resolvedFile, symbol: named.getName() });
    }

    // Default import
    const defaultImport = decl.getDefaultImport();
    if (defaultImport) {
      importedSymbols.set(defaultImport.getText(), { file: resolvedFile, symbol: 'default' });
    }

    // Namespace import
    const namespaceImport = decl.getNamespaceImport();
    if (namespaceImport) {
      importedSymbols.set(namespaceImport.getText(), { file: resolvedFile, symbol: '*' });
    }
  }

  // Track which symbols from each target file are actually called
  const callEdges = new Map<string, Set<string>>(); // target file -> set of symbols called
  const typeEdges = new Map<string, Set<string>>(); // target file -> set of types referenced

  // Scan all call expressions
  const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);
  for (const call of callExpressions) {
    const expr = call.getExpression();
    const text = expr.getText();

    // Direct call: importedFn()
    const directMatch = importedSymbols.get(text);
    if (directMatch) {
      const set = callEdges.get(directMatch.file) ?? new Set();
      set.add(directMatch.symbol);
      callEdges.set(directMatch.file, set);
      continue;
    }

    // Property access: namespace.fn() or obj.method()
    if (expr.getKind() === SyntaxKind.PropertyAccessExpression) {
      const parts = text.split('.');
      if (parts.length >= 2) {
        const obj = parts[0];
        const method = parts[1];
        const nsMatch = importedSymbols.get(obj);
        if (nsMatch) {
          const set = callEdges.get(nsMatch.file) ?? new Set();
          set.add(method);
          callEdges.set(nsMatch.file, set);
        }
      }
    }
  }

  // Scan type references (interface, type alias usage in type positions)
  const typeRefs = sourceFile.getDescendantsOfKind(SyntaxKind.TypeReference);
  for (const ref of typeRefs) {
    const typeName = ref.getTypeName().getText();
    const match = importedSymbols.get(typeName);
    if (match) {
      const set = typeEdges.get(match.file) ?? new Set();
      set.add(match.symbol);
      typeEdges.set(match.file, set);
    }
  }

  // Convert to GraphEdge with confidence scoring
  for (const [targetFile, symbols] of callEdges) {
    const targetNode = nodes.get(targetFile);
    const symbolList = [...symbols];

    // Confidence: higher if the called symbols are actually exported by the target
    let matchedExports = 0;
    if (targetNode) {
      for (const sym of symbolList) {
        if (targetNode.exports.includes(sym) || sym === '*') {
          matchedExports++;
        }
      }
    }

    const confidence = targetNode
      ? symbolList.length > 0
        ? Math.min(1.0, 0.7 + (matchedExports / symbolList.length) * 0.3)
        : 0.7
      : 0.5;

    edges.push({
      source: currentFile,
      target: targetFile,
      type: 'call',
      confidence: Math.round(confidence * 100) / 100,
      confidenceLabel: confidenceLabelFor('call', confidence),
      symbols: symbolList,
    });
  }

  for (const [targetFile, symbols] of typeEdges) {
    const targetNode = nodes.get(targetFile);
    const symbolList = [...symbols];

    let matchedExports = 0;
    if (targetNode) {
      for (const sym of symbolList) {
        if (targetNode.exports.includes(sym)) {
          matchedExports++;
        }
      }
    }

    const confidence = targetNode
      ? symbolList.length > 0
        ? Math.min(1.0, 0.6 + (matchedExports / symbolList.length) * 0.4)
        : 0.6
      : 0.4;

    edges.push({
      source: currentFile,
      target: targetFile,
      type: 'type-reference',
      confidence: Math.round(confidence * 100) / 100,
      confidenceLabel: confidenceLabelFor('type-reference', confidence),
      symbols: symbolList,
    });
  }

  return edges;
}

export async function loadGraph(projectRoot: string): Promise<GraphData | null> {
  const store = new FileStoreImpl(projectRoot);
  const graph = await store.read<GraphData>('graph.json');
  if (graph && graph.schemaVersion === GRAPH_SCHEMA_VERSION) {
    return graph;
  }
  return null;
}
