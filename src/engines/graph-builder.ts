import { Project, SourceFile, SyntaxKind } from 'ts-morph';
import { resolve, relative, dirname } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { hashFile } from '../utils/hash-utils.js';
import { FileStoreImpl } from '../storage/file-store.js';
import {
  detectLanguage,
  parseFile,
  resolvePolyglotImports,
  type ParsedFile,
  type SymbolUse,
} from './polyglot-parser.js';
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
  summary: {
    nodes: number;
    edges: number;
    rebuilt: number;
    skipped: number;
    /** Files that gained a node since the previous graph (newly created). */
    added: string[];
    /** Files whose node was pruned since the previous graph (deleted/excluded). */
    removed: string[];
  };
}

export const GRAPH_SCHEMA_VERSION = '2.2.0';

/**
 * Hard cap on the byte size of a single file the graph builder will parse.
 * Minified bundles, vendored libraries, and generated artifacts can be many
 * megabytes on a single line — feeding those to ts-morph balloons memory and
 * crashes the process ("JavaScript heap out of memory"). Skipping them keeps
 * the build bounded; they are almost never meaningful graph nodes anyway.
 */
const MAX_PARSE_FILE_BYTES = 1.5 * 1024 * 1024; // 1.5 MB

/**
 * Decide whether a file is safe to parse. Returns a reason string when the file
 * should be skipped (too large or minified), or null when it is fine to parse.
 */
async function tooBigToParse(absPath: string): Promise<string | null> {
  try {
    const { size } = await stat(absPath);
    if (size > MAX_PARSE_FILE_BYTES) {
      return `skipped: file is ${(size / (1024 * 1024)).toFixed(1)}MB (limit ${(MAX_PARSE_FILE_BYTES / (1024 * 1024)).toFixed(1)}MB)`;
    }
  } catch {
    return 'skipped: cannot stat file';
  }
  return null;
}

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
  const oversizedSkips: string[] = [];
  for (const absFile of absoluteTsFiles) {
    const skipReason = await tooBigToParse(absFile);
    if (skipReason) {
      oversizedSkips.push(relative(projectRoot, absFile).replace(/\\/g, '/'));
      logger.debug(`${relative(projectRoot, absFile).replace(/\\/g, '/')}: ${skipReason}`);
      continue;
    }
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
  const parsedPolyglotByFile = new Map<string, ParsedFile>();

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
      const absPolyglot = resolve(projectRoot, file);
      const skipReason = await tooBigToParse(absPolyglot);
      if (skipReason) {
        oversizedSkips.push(file);
        logger.debug(`${file}: ${skipReason}`);
        continue;
      }
      const content = await readFile(absPolyglot, 'utf-8');
      const parsed = parseFile(file, content);
      parsedPolyglotByFile.set(file, parsed);

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

  for (const [filePath, parsed] of parsedPolyglotByFile) {
    const node = nodes.get(filePath);
    if (!node) continue;
    const semanticEdges = extractPolyglotSemanticEdges(filePath, parsed, nodes, parsedPolyglotByFile, allFileSet);
    if (semanticEdges.length > 0) {
      node.edges = [...(node.edges ?? []), ...semanticEdges];
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

  // Compute create/delete deltas against the previous graph so callers can
  // surface exactly which files entered or left the map this run. A new file
  // appears in the current node set but not the previous one; a deleted (or
  // newly-excluded) file is in the previous graph but no longer resolved.
  // The first-ever build has no previous graph — that's an initial population,
  // not a change, so both deltas stay empty rather than flagging every file.
  let added: string[] = [];
  let removed: string[] = [];
  if (existingGraph) {
    const previousNodeKeys = Object.keys(existingGraph.nodes);
    const previousSet = new Set(previousNodeKeys);
    const currentSet = new Set(nodes.keys());
    added = [...currentSet].filter((f) => !previousSet.has(f)).sort();
    removed = previousNodeKeys.filter((f) => !currentSet.has(f)).sort();
  }

  return {
    nodes,
    summary: {
      nodes: nodes.size,
      edges: edgeCount,
      rebuilt: filesToRebuild.length,
      skipped: skippedCount,
      added,
      removed,
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

interface PolyglotTarget {
  files: string[];
  imported?: string;
  confidence: number;
}

function extractPolyglotSemanticEdges(
  currentFile: string,
  parsed: ParsedFile,
  nodes: Map<string, GraphNode>,
  parsedByFile: Map<string, ParsedFile>,
  allFileSet: Set<string>,
): GraphEdge[] {
  const importTargets = buildPolyglotImportTargets(currentFile, parsed, nodes, allFileSet);
  const wildcardTargets = buildPolyglotWildcardTargets(currentFile, parsed, nodes, allFileSet);
  const sameScopeTargets = buildSameScopeTargets(currentFile, parsed, nodes, parsedByFile);
  const groupedEdges = new Map<string, { source: string; target: string; type: GraphEdge['type']; symbols: Set<string>; confidence: number }>();

  for (const use of parsed.symbolUses ?? []) {
    const edgeType: GraphEdge['type'] = use.kind === 'call' ? 'call' : 'type-reference';
    const candidates = resolvePolyglotUseTargets(use, importTargets, wildcardTargets, sameScopeTargets, nodes, parsedByFile);

    for (const candidate of candidates) {
      const symbol = candidate.imported && candidate.imported !== '*'
        ? candidate.imported
        : use.member ?? use.symbol;

      for (const targetFile of candidate.files) {
        if (targetFile === currentFile || !nodes.has(targetFile)) continue;
        const key = `${targetFile}:${edgeType}`;
        const existing = groupedEdges.get(key);
        if (existing) {
          existing.symbols.add(symbol);
          existing.confidence = Math.max(existing.confidence, candidate.confidence);
        } else {
          groupedEdges.set(key, {
            source: currentFile,
            target: targetFile,
            type: edgeType,
            symbols: new Set([symbol]),
            confidence: candidate.confidence,
          });
        }
      }
    }
  }

  return [...groupedEdges.values()].map((edge) => ({
    source: edge.source,
    target: edge.target,
    type: edge.type,
    confidence: Math.round(edge.confidence * 100) / 100,
    confidenceLabel: confidenceLabelFor(edge.type, edge.confidence),
    symbols: [...edge.symbols].sort(),
  }));
}

function buildPolyglotImportTargets(
  currentFile: string,
  parsed: ParsedFile,
  nodes: Map<string, GraphNode>,
  allFileSet: Set<string>,
): Map<string, PolyglotTarget[]> {
  const targetsByLocal = new Map<string, PolyglotTarget[]>();

  for (const binding of parsed.importBindings ?? []) {
    if (binding.kind === 'wildcard' || binding.kind === 'side-effect') continue;
    const resolvedFiles = resolvePolyglotImports(currentFile, [binding.module], allFileSet)
      .filter((targetFile) => nodes.has(targetFile));
    if (resolvedFiles.length === 0) continue;

    const targets = filterTargetsForSymbol(resolvedFiles, binding.imported, nodes, new Map());
    const existing = targetsByLocal.get(binding.local) ?? [];
    existing.push({
      files: targets.length > 0 ? targets : resolvedFiles,
      imported: binding.imported,
      confidence: binding.kind === 'module' ? 0.82 : 0.92,
    });
    targetsByLocal.set(binding.local, existing);
  }

  return targetsByLocal;
}

function buildPolyglotWildcardTargets(
  currentFile: string,
  parsed: ParsedFile,
  nodes: Map<string, GraphNode>,
  allFileSet: Set<string>,
): string[] {
  const targets: string[] = [];
  for (const binding of parsed.importBindings ?? []) {
    if (binding.kind !== 'wildcard') continue;
    targets.push(...resolvePolyglotImports(currentFile, [binding.module], allFileSet).filter((targetFile) => nodes.has(targetFile)));
  }
  return [...new Set(targets)];
}

function buildSameScopeTargets(
  currentFile: string,
  parsed: ParsedFile,
  nodes: Map<string, GraphNode>,
  parsedByFile: Map<string, ParsedFile>,
): Map<string, PolyglotTarget[]> {
  const targetsBySymbol = new Map<string, PolyglotTarget[]>();
  const language = detectLanguage(currentFile);
  const currentDirectory = currentFile.split('/').slice(0, -1).join('/');
  const currentPackage = packageNameForFile(currentFile, parsed, nodes);

  if (language !== 'go' && language !== 'java') return targetsBySymbol;

  for (const [targetFile, targetNode] of nodes) {
    if (targetFile === currentFile || detectLanguage(targetFile) !== language) continue;

    const targetParsed = parsedByFile.get(targetFile);
    const isSameScope = language === 'go'
      ? targetFile.split('/').slice(0, -1).join('/') === currentDirectory
      : Boolean(currentPackage && packageNameForFile(targetFile, targetParsed, nodes) === currentPackage);

    if (!isSameScope) continue;

    for (const symbol of symbolsForFile(targetFile, targetNode, parsedByFile)) {
      const existing = targetsBySymbol.get(symbol) ?? [];
      existing.push({ files: [targetFile], imported: symbol, confidence: 0.78 });
      targetsBySymbol.set(symbol, existing);
    }
  }

  return targetsBySymbol;
}

function resolvePolyglotUseTargets(
  use: SymbolUse,
  importTargets: Map<string, PolyglotTarget[]>,
  wildcardTargets: string[],
  sameScopeTargets: Map<string, PolyglotTarget[]>,
  nodes: Map<string, GraphNode>,
  parsedByFile: Map<string, ParsedFile>,
): PolyglotTarget[] {
  const candidates: PolyglotTarget[] = [];
  const qualifierCandidates = use.qualifier
    ? [use.qualifier, use.qualifier.split('.')[0]].filter(Boolean)
    : [];

  for (const qualifier of qualifierCandidates) {
    const matches = importTargets.get(qualifier);
    if (!matches) continue;
    for (const match of matches) {
      const member = use.member;
      const files = filterTargetsForSymbol(match.files, member, nodes, parsedByFile);
      candidates.push({
        files: files.length > 0 ? files : match.files,
        imported: member ?? match.imported,
        confidence: match.confidence,
      });
    }
  }

  const directMatches = importTargets.get(use.symbol);
  if (directMatches) {
    candidates.push(...directMatches);
  }

  for (const wildcardTarget of wildcardTargets) {
    if (targetHasSymbol(wildcardTarget, use.symbol, nodes, parsedByFile)) {
      candidates.push({ files: [wildcardTarget], imported: use.symbol, confidence: 0.72 });
    }
  }

  const sameScopeMatches = sameScopeTargets.get(use.symbol);
  if (sameScopeMatches) {
    candidates.push(...sameScopeMatches);
  }

  return dedupePolyglotTargets(candidates);
}

function filterTargetsForSymbol(
  targetFiles: string[],
  symbol: string | undefined,
  nodes: Map<string, GraphNode>,
  parsedByFile: Map<string, ParsedFile>,
): string[] {
  if (!symbol || symbol === '*') return targetFiles;
  return targetFiles.filter((targetFile) => targetHasSymbol(targetFile, symbol, nodes, parsedByFile));
}

function targetHasSymbol(
  targetFile: string,
  symbol: string,
  nodes: Map<string, GraphNode>,
  parsedByFile: Map<string, ParsedFile>,
): boolean {
  const node = nodes.get(targetFile);
  if (!node) return false;
  return symbolsForFile(targetFile, node, parsedByFile).has(symbol);
}

function symbolsForFile(
  targetFile: string,
  node: GraphNode,
  parsedByFile: Map<string, ParsedFile>,
): Set<string> {
  const symbols = new Set(node.exports.filter((name) => !name.startsWith('package:')));
  const parsed = parsedByFile.get(targetFile);
  for (const symbol of parsed?.declaredSymbols ?? []) {
    if (!symbol.name.startsWith('package:')) symbols.add(symbol.name);
  }
  return symbols;
}

function packageNameForFile(
  filePath: string,
  parsed: ParsedFile | undefined,
  nodes: Map<string, GraphNode>,
): string | null {
  if (parsed?.packageName) return parsed.packageName;
  const packageExport = nodes.get(filePath)?.exports.find((exportName) => exportName.startsWith('package:'));
  return packageExport ? packageExport.slice('package:'.length) : null;
}

function dedupePolyglotTargets(targets: PolyglotTarget[]): PolyglotTarget[] {
  const byKey = new Map<string, PolyglotTarget>();
  for (const target of targets) {
    const key = `${target.files.slice().sort().join('|')}:${target.imported ?? ''}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.confidence = Math.max(existing.confidence, target.confidence);
    } else {
      byKey.set(key, { ...target, files: [...new Set(target.files)] });
    }
  }
  return [...byKey.values()];
}

export async function loadGraph(projectRoot: string): Promise<GraphData | null> {
  const store = new FileStoreImpl(projectRoot);
  const graph = await store.read<GraphData>('graph.json');
  if (graph && graph.schemaVersion === GRAPH_SCHEMA_VERSION) {
    return graph;
  }
  return null;
}
