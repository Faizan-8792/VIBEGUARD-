import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GraphNode } from './graph-builder.js';
import type { ImportanceEntry } from './importance-analyzer.js';
import { createGitUtils } from '../utils/git-utils.js';

export interface DeadCodeCandidate {
  id: string;
  path: string;
  kind: 'file' | 'export' | 'import' | 'duplicate-component';
  importance: number;
  lastCommitDate: string | null;
  testOnlyReferences: boolean;
  similarityScore?: number;
  pairedWith?: string;
}

export interface DeadCodeScanResult {
  candidates: DeadCodeCandidate[];
  summary: {
    unusedFiles: number;
    unusedExports: number;
    unusedImports: number;
    duplicateComponents: number;
  };
  warning?: string;
}

// Matches compiled output paths (dist/foo/bar.js) and captures the path stem ("foo/bar").
const COMPILED_OUTPUT_RE = /^(?:dist|build|out|lib)\/(.+)\.(?:js|cjs|mjs)$/;
// Matches a trailing JavaScript module extension so it can be swapped for a TS one.
const JS_EXTENSION_RE = /\.(?:js|cjs|mjs)$/;

// Conventional entrypoint files checked against the graph regardless of package.json.
const KNOWN_ENTRYPOINTS = [
  'src/index.ts', 'src/index.tsx', 'src/index.js',
  'src/main.ts', 'src/main.tsx',
  'src/cli.ts', 'cli.ts',
  'src/api.ts', 'src/lib.ts',
  'index.ts', 'index.tsx', 'index.js',
  'main.ts',
];

// Directory prefixes whose files are framework-managed routes and always reachable.
const ROUTE_PREFIXES = ['pages/', 'app/', 'src/pages/', 'src/app/'];

// If more than this fraction of files appear unreachable, entrypoint detection
// almost certainly failed, so dead-code results are suppressed for safety.
const UNREACHABLE_ABORT_RATIO = 0.5;

function normalizeEntryPath(rawPath: string): string {
  return rawPath.replace(/^\.\//, '').replace(/\\/g, '/');
}

// Given a (possibly compiled) module path, list the source files it may map back to.
function sourceCandidatesFor(normalizedPath: string): string[] {
  const candidates: string[] = [];

  // Map compiled output back to source: dist/foo/bar.js -> src/foo/bar.ts
  const compiledMatch = normalizedPath.match(COMPILED_OUTPUT_RE);
  if (compiledMatch) {
    const stem = compiledMatch[1];
    candidates.push(`src/${stem}.ts`, `src/${stem}.tsx`, `${stem}.ts`, `${stem}.tsx`);
  }

  // Map .js -> .ts in place (ESM imports often reference the compiled .js extension).
  const withoutJsExt = normalizedPath.replace(JS_EXTENSION_RE, '');
  candidates.push(`${withoutJsExt}.ts`, `${withoutJsExt}.tsx`);

  return candidates;
}

function sanitizeForId(value: string, maxLength: number): string {
  return value.replace(/[^a-z0-9]/gi, '-').substring(0, maxLength);
}

export async function scanDeadCode(
  projectRoot: string,
  graphNodes: Map<string, GraphNode>,
  importanceScores: Record<string, ImportanceEntry>
): Promise<DeadCodeScanResult> {
  const candidates: DeadCodeCandidate[] = [];
  const gitUtils = createGitUtils();
  const isGit = await gitUtils.isGitRepo(projectRoot);

  // Identify entrypoints
  const entrypoints = await identifyEntrypoints(projectRoot, graphNodes);

  // Find reachable files from entrypoints
  const reachable = computeReachable(entrypoints, graphNodes);

  // Classify unused files
  let unusedFiles = 0;
  let unusedExports = 0;
  let unusedImports = 0;

  for (const [filePath, node] of graphNodes) {
    if (entrypoints.has(filePath)) continue;

    // Never flag config files or type declaration files as dead — they are
    // loaded by tooling, not imported through the graph.
    if (isConfigOrDeclaration(filePath)) continue;

    // Never flag test files or test fixtures as dead — they are intentionally
    // disconnected from production code.
    if (isTestFile(filePath)) continue;

    const importance = importanceScores[filePath]?.score ?? 0;
    let lastCommitDate: string | null = null;
    if (isGit) {
      lastCommitDate = await gitUtils.getLastCommitDate(filePath, projectRoot);
    }

    const testOnlyReferences = node.dependents.every((d) => d.match(/\.(test|spec)\./));

    if (!reachable.has(filePath)) {
      unusedFiles++;
      candidates.push({
        id: `dead-file-${sanitizeForId(filePath, 30)}`,
        path: filePath,
        kind: 'file',
        importance,
        lastCommitDate,
        testOnlyReferences,
      });
    }
  }

  // Detect unused exports (simplified — checks if any internal file imports the name).
  // Since the current heuristic checks dependents at the file level, we can skip the
  // per-export loop entirely for files that have dependents.
  for (const [filePath, node] of graphNodes) {
    if (!reachable.has(filePath)) continue; // Already flagged as unused file
    if (node.dependents.length > 0) continue; // File has dependents — exports assumed used

    const importance = importanceScores[filePath]?.score ?? 0;
    for (const exportName of node.exports) {
      unusedExports++;
      candidates.push({
        id: `dead-export-${sanitizeForId(filePath, 20)}-${exportName}`,
        path: filePath,
        kind: 'export',
        importance,
        lastCommitDate: null,
        testOnlyReferences: false,
      });
    }
  }

  // Safety guard: if more than 50% of all files are flagged as unused, the
  // entrypoint detection almost certainly failed (e.g. compiled bin path that
  // doesn't map to source). Returning an empty result prevents a catastrophic
  // "delete the whole project" outcome.
  const totalNodes = graphNodes.size;
  if (totalNodes > 0 && unusedFiles / totalNodes > UNREACHABLE_ABORT_RATIO) {
    return {
      candidates: [],
      summary: {
        unusedFiles: 0,
        unusedExports: 0,
        unusedImports: 0,
        duplicateComponents: 0,
      },
      warning: `Dead-code detection aborted: ${unusedFiles}/${totalNodes} files appeared unreachable, which usually means no valid entrypoint was found. No files were flagged. Configure an entrypoint (package.json "main"/"bin" pointing to a source file, or src/index.ts) and re-run.`,
    };
  }

  return {
    candidates,
    summary: {
      unusedFiles,
      unusedExports,
      unusedImports,
      duplicateComponents: 0,
    },
  };
}

// Well-known tooling config filenames that are loaded by external tools, not imported.
const KNOWN_CONFIG_FILES = new Set([
  'vitest.config.ts', 'vite.config.ts', 'jest.config.ts', 'jest.config.js',
  'webpack.config.js', 'rollup.config.js', 'tailwind.config.ts', 'tailwind.config.js',
  'next.config.js', 'next.config.mjs', 'eslint.config.js', 'eslint.config.mjs',
  'playwright.config.ts', 'tsup.config.ts',
]);

/**
 * Config files, declaration files, and tooling configs are loaded by external
 * tools (vitest, tsc, bundlers) rather than imported through the dependency
 * graph, so they must never be flagged as dead code.
 */
function isConfigOrDeclaration(filePath: string): boolean {
  const base = filePath.split('/').pop() ?? filePath;
  if (base.endsWith('.d.ts')) return true;
  if (/\.config\.(ts|js|mjs|cjs|tsx)$/.test(base)) return true;
  return KNOWN_CONFIG_FILES.has(base);
}

/**
 * Test files and test fixtures are intentionally disconnected from production
 * code — they must never be flagged as dead code.
 */
function isTestFile(filePath: string): boolean {
  if (filePath.startsWith('test/') || filePath.startsWith('tests/') || filePath.startsWith('__tests__/')) return true;
  if (filePath.includes('/test/') || filePath.includes('/tests/') || filePath.includes('/__tests__/')) return true;
  if (/\.(test|spec)\.(ts|tsx|js|jsx)$/.test(filePath)) return true;
  return false;
}

async function identifyEntrypoints(
  projectRoot: string,
  graphNodes: Map<string, GraphNode>
): Promise<Set<string>> {
  const entrypoints = new Set<string>();

  // Register a declared entrypoint path, plus the likely source file it maps to
  // when the path points at compiled output (e.g. dist/cli.js -> src/cli.ts).
  const addWithSourceMapping = (rawPath: string): void => {
    const normalized = normalizeEntryPath(rawPath);
    if (graphNodes.has(normalized)) entrypoints.add(normalized);

    for (const candidate of sourceCandidatesFor(normalized)) {
      if (graphNodes.has(candidate)) entrypoints.add(candidate);
    }
  };

  await collectPackageJsonEntrypoints(projectRoot, addWithSourceMapping);

  // Conventional entrypoint files.
  for (const ep of KNOWN_ENTRYPOINTS) {
    if (graphNodes.has(ep)) entrypoints.add(ep);
  }

  // Next.js / framework route files are always reachable.
  for (const filePath of graphNodes.keys()) {
    if (ROUTE_PREFIXES.some((prefix) => filePath.startsWith(prefix))) {
      entrypoints.add(filePath);
    }
  }

  return entrypoints;
}

/**
 * Reads package.json and feeds every declared entrypoint (main, module, bin,
 * exports) to the provided registrar. Silently no-ops when package.json is
 * absent or unparseable, matching the previous fail-soft behavior.
 */
async function collectPackageJsonEntrypoints(
  projectRoot: string,
  register: (rawPath: string) => void
): Promise<void> {
  let pkg: Record<string, unknown>;
  try {
    const pkgContent = await readFile(join(projectRoot, 'package.json'), 'utf-8');
    pkg = JSON.parse(pkgContent) as Record<string, unknown>;
  } catch {
    return; // No (or invalid) package.json
  }

  if (typeof pkg.main === 'string') register(pkg.main);
  if (typeof pkg.module === 'string') register(pkg.module);

  if (typeof pkg.bin === 'string') {
    register(pkg.bin);
  } else if (typeof pkg.bin === 'object' && pkg.bin !== null) {
    for (const val of Object.values(pkg.bin as Record<string, unknown>)) {
      if (typeof val === 'string') register(val);
    }
  }

  // exports may be a string or an arbitrarily nested object of condition maps.
  const collectExportTargets = (val: unknown): void => {
    if (typeof val === 'string') {
      register(val);
    } else if (typeof val === 'object' && val !== null) {
      for (const v of Object.values(val as Record<string, unknown>)) collectExportTargets(v);
    }
  };
  collectExportTargets(pkg.exports);
}

function computeReachable(entrypoints: Set<string>, graphNodes: Map<string, GraphNode>): Set<string> {
  const reachable = new Set<string>();
  const queue = [...entrypoints];

  // Build a lookup that resolves .js/.mjs/.cjs import paths to actual .ts node keys
  const importToNode = new Map<string, string>();
  for (const key of graphNodes.keys()) {
    importToNode.set(key, key);
    // Also map .js equivalent to .ts node
    const jsVariant = key.replace(/\.(ts|tsx)$/, '.js');
    if (jsVariant !== key) importToNode.set(jsVariant, key);
    const mjsVariant = key.replace(/\.(ts|tsx)$/, '.mjs');
    if (mjsVariant !== key) importToNode.set(mjsVariant, key);
  }

  while (queue.length > 0) {
    const current = queue.pop()!;
    if (reachable.has(current)) continue;
    reachable.add(current);

    const node = graphNodes.get(current);
    if (node) {
      for (const imp of node.imports) {
        // Resolve the import to its actual node key (handles .js → .ts)
        const resolved = importToNode.get(imp) ?? imp;
        if (!reachable.has(resolved) && graphNodes.has(resolved)) {
          queue.push(resolved);
        }
      }
    }
  }

  return reachable;
}


