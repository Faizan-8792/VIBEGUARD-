/**
 * Flow Analyzer — execution flows and structural graph intelligence.
 *
 * - Flows: trace forward import/call chains from entry points (routes, CLI,
 *   index, tests), scored by a criticality heuristic (depth × breadth).
 * - Bridges: nodes whose removal would most fragment the graph, approximated by
 *   an efficient flow-betweenness over entrypoint→leaf paths.
 * - Knowledge gaps: isolated nodes, untested hotspots, and thin areas.
 *
 * Pure-graph and deterministic: all functions take a GraphData and return data.
 */

import type { GraphData, GraphNode } from './graph-builder.js';

export interface ExecutionFlow {
  id: number;
  entryPoint: string;
  /** Ordered files visited along the deepest forward chain from the entry. */
  path: string[];
  depth: number;
  nodeCount: number;
  /** 0-100 criticality: deeper, wider flows from real entry points score higher. */
  criticality: number;
}

export interface BridgeNode {
  file: string;
  /** Higher = more central as a connector between otherwise separate areas. */
  score: number;
}

export interface KnowledgeGaps {
  isolatedNodes: string[];
  untestedHotspots: Array<{ file: string; dependents: number }>;
  summary: { isolated: number; untestedHotspots: number };
}

const ROUTE_PREFIXES = ['pages/', 'app/', 'routes/', 'src/pages/', 'src/app/', 'src/routes/'];
const ENTRY_BASENAMES = new Set(['index.ts', 'index.tsx', 'index.js', 'main.ts', 'main.go', 'cli.ts']);

function isTestPath(file: string): boolean {
  return (
    /\.(test|spec)\./.test(file) ||
    /_test\.(go|py)$/.test(file) ||
    file.includes('/__tests__/') ||
    file.includes('/tests/')
  );
}

/**
 * Heuristically identify entry-point files from graph structure alone:
 * route files, conventional index/main/cli files, and test files.
 */
export function detectEntryPoints(graph: GraphData): string[] {
  const entries: string[] = [];
  for (const key of Object.keys(graph.nodes)) {
    const base = key.split('/').pop() ?? key;
    const isRoute = ROUTE_PREFIXES.some((p) => key.startsWith(p));
    if (isRoute || ENTRY_BASENAMES.has(base) || isTestPath(key)) {
      entries.push(key);
    }
  }
  // Fallback: nodes that nothing depends on (roots) are natural entry points.
  if (entries.length === 0) {
    for (const [key, node] of Object.entries(graph.nodes)) {
      if (node.dependents.length === 0 && node.imports.length > 0) entries.push(key);
    }
  }
  return entries;
}

/**
 * Trace the deepest forward import chain from an entry point (DFS, cycle-safe).
 */
function traceFlow(entry: string, nodes: Map<string, GraphNode>): string[] {
  let best: string[] = [];

  const dfs = (current: string, path: string[], visited: Set<string>): void => {
    const node = nodes.get(current);
    if (!node || node.imports.length === 0) {
      if (path.length > best.length) best = [...path];
      return;
    }
    let extended = false;
    for (const imp of node.imports) {
      if (visited.has(imp) || !nodes.has(imp)) continue;
      extended = true;
      visited.add(imp);
      dfs(imp, [...path, imp], visited);
      visited.delete(imp);
    }
    if (!extended && path.length > best.length) best = [...path];
  };

  dfs(entry, [entry], new Set([entry]));
  return best;
}

/**
 * Compute execution flows from detected entry points, sorted by criticality.
 */
export function computeFlows(graph: GraphData, opts: { limit?: number } = {}): ExecutionFlow[] {
  const nodes = new Map<string, GraphNode>(Object.entries(graph.nodes));
  const entries = detectEntryPoints(graph);
  const flows: ExecutionFlow[] = [];

  let id = 1;
  for (const entry of entries) {
    const path = traceFlow(entry, nodes);
    const depth = path.length;
    if (depth <= 1) continue; // not a meaningful flow

    const uniqueFiles = new Set(path);
    const entryNode = nodes.get(entry);
    const breadth = entryNode ? entryNode.imports.length : 0;

    // Criticality: depth dominates, breadth adds, route/cli entries get a boost.
    const base = key_isRouteLike(entry) ? 20 : 0;
    const criticality = Math.max(0, Math.min(100, Math.round(base + depth * 12 + breadth * 3)));

    flows.push({
      id: id++,
      entryPoint: entry,
      path,
      depth,
      nodeCount: uniqueFiles.size,
      criticality,
    });
  }

  flows.sort((a, b) => b.criticality - a.criticality || b.depth - a.depth || a.entryPoint.localeCompare(b.entryPoint));
  const limit = opts.limit ?? 50;
  return flows.slice(0, limit);
}

function key_isRouteLike(file: string): boolean {
  const base = file.split('/').pop() ?? file;
  return ROUTE_PREFIXES.some((p) => file.startsWith(p)) || ENTRY_BASENAMES.has(base);
}

/**
 * Approximate architectural bridges: nodes that lie on many entrypoint→leaf
 * paths. We accumulate a betweenness-like count by walking each flow path and
 * crediting interior nodes. O(entries × path length) — cheap and deterministic.
 */
export function computeBridges(graph: GraphData, opts: { topN?: number } = {}): BridgeNode[] {
  const flows = computeFlows(graph, { limit: 1000 });
  const counts = new Map<string, number>();

  for (const flow of flows) {
    // Interior nodes (exclude the entry and the final leaf) are the connectors.
    for (let i = 1; i < flow.path.length - 1; i++) {
      const file = flow.path[i];
      counts.set(file, (counts.get(file) ?? 0) + 1);
    }
  }

  const bridges: BridgeNode[] = [...counts.entries()].map(([file, score]) => ({ file, score }));
  bridges.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  return bridges.slice(0, opts.topN ?? 10);
}

/**
 * Identify structural weaknesses: isolated nodes (no imports and no
 * dependents) and untested hotspots (high fan-in, no test among dependents).
 */
export function computeKnowledgeGaps(graph: GraphData, opts: { hotspotThreshold?: number } = {}): KnowledgeGaps {
  const threshold = opts.hotspotThreshold ?? 5;
  const isolated: string[] = [];
  const untested: Array<{ file: string; dependents: number }> = [];

  for (const [key, node] of Object.entries(graph.nodes)) {
    if (isTestPath(key)) continue;

    if (node.imports.length === 0 && node.dependents.length === 0) {
      isolated.push(key);
    }

    if (node.dependents.length >= threshold) {
      const hasTest = node.dependents.some(isTestPath);
      if (!hasTest) untested.push({ file: key, dependents: node.dependents.length });
    }
  }

  isolated.sort();
  untested.sort((a, b) => b.dependents - a.dependents || a.file.localeCompare(b.file));

  return {
    isolatedNodes: isolated,
    untestedHotspots: untested.slice(0, 20),
    summary: { isolated: isolated.length, untestedHotspots: untested.length },
  };
}
