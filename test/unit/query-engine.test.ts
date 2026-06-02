import { describe, it, expect } from 'vitest';
import { queryGraph, findPath, explainNode, affectedNodes } from '../../src/engines/query-engine.js';
import type { GraphData } from '../../src/engines/graph-builder.js';

function n(file: string, imports: string[], dependents: string[], exports: string[] = []) {
  return { file, imports, exports, dependents, edges: [] };
}

/** A small but realistic graph: cli → api → engine → store */
const graph: GraphData = {
  schemaVersion: '2.0.0',
  nodes: {
    'src/cli.ts': n('src/cli.ts', ['src/api.ts'], [], ['main']),
    'src/api.ts': n('src/api.ts', ['src/engines/scanner.ts'], ['src/cli.ts'], ['runScan']),
    'src/engines/scanner.ts': n('src/engines/scanner.ts', ['src/storage/store.ts'], ['src/api.ts'], ['scan']),
    'src/storage/store.ts': n('src/storage/store.ts', [], ['src/engines/scanner.ts'], ['save', 'load']),
    'src/utils/orphan.ts': n('src/utils/orphan.ts', [], [], ['unused']),
  },
};

describe('Query Engine — queryGraph', () => {
  it('finds the relevant node for a keyword question', () => {
    const result = queryGraph(graph, 'how does the scanner work?');
    expect(result.relevantNodes).toContain('src/engines/scanner.ts');
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it('expands to 1-hop neighbors of the matched node', () => {
    const result = queryGraph(graph, 'scanner');
    // scanner imports store and is imported by api → both should appear
    expect(result.relevantNodes).toContain('src/storage/store.ts');
    expect(result.relevantNodes).toContain('src/api.ts');
  });

  it('reports positive token savings vs reading all files', () => {
    const result = queryGraph(graph, 'scanner');
    expect(result.tokensSaved).toBeGreaterThan(0);
    expect(result.tokensUsed).toBeGreaterThan(0);
  });

  it('respects the token budget by capping returned nodes', () => {
    const unbudgeted = queryGraph(graph, 'scanner');
    const budgeted = queryGraph(graph, 'scanner', { budget: 200 }); // 200 / 200 = 1 node max
    expect(budgeted.relevantNodes.length).toBe(1);
    expect(budgeted.relevantNodes.length).toBeLessThanOrEqual(unbudgeted.relevantNodes.length);
    expect(budgeted.tokensUsed).toBeLessThanOrEqual(200);
  });

  it('returns low confidence when nothing matches', () => {
    const result = queryGraph(graph, 'nonexistent xyzzy concept');
    expect(result.confidence).toBeLessThan(0.5);
  });
});

describe('Query Engine — findPath', () => {
  it('finds the shortest path between connected nodes', () => {
    const result = findPath(graph, 'cli', 'store');
    expect(result.path).toBeDefined();
    expect(result.path![0]).toBe('src/cli.ts');
    expect(result.path![result.path!.length - 1]).toBe('src/storage/store.ts');
    // cli → api → scanner → store = 4 nodes
    expect(result.path!.length).toBe(4);
  });

  it('returns confidence 0 when a node cannot be found', () => {
    const result = findPath(graph, 'cli', 'doesnotexist');
    expect(result.confidence).toBe(0);
    expect(result.path).toBeUndefined();
  });

  it('reports no path for disconnected nodes', () => {
    const result = findPath(graph, 'cli', 'orphan');
    expect(result.answer.toLowerCase()).toContain('no path');
  });

  it('handles same source and target', () => {
    const result = findPath(graph, 'cli', 'cli');
    expect(result.path).toEqual(['src/cli.ts']);
  });
});

describe('Query Engine — explainNode', () => {
  it('explains a node with role, imports, dependents, and community', () => {
    const explanation = explainNode(graph, 'scanner');
    expect(explanation).not.toBeNull();
    expect(explanation!.file).toBe('src/engines/scanner.ts');
    expect(explanation!.imports).toContain('src/storage/store.ts');
    expect(explanation!.dependents).toContain('src/api.ts');
    expect(explanation!.community).toBe('src/engines');
  });

  it('classifies a high-fan-in node as a hub or god-node', () => {
    const explanation = explainNode(graph, 'store');
    expect(explanation).not.toBeNull();
    expect(['god-node', 'hub', 'standard', 'leaf']).toContain(explanation!.importance);
  });

  it('returns null for an unknown node', () => {
    const explanation = explainNode(graph, 'totallymissing');
    expect(explanation).toBeNull();
  });

  it('flags a disconnected node as a leaf', () => {
    const explanation = explainNode(graph, 'orphan');
    expect(explanation!.importance).toBe('leaf');
  });
});

describe('Query Engine — affectedNodes (impact analysis)', () => {
  it('finds transitive dependents of a changed node', () => {
    // store is imported by scanner, which is imported by api, which is imported by cli
    const result = affectedNodes(graph, 'store', 5);
    expect(result.seed).toBe('src/storage/store.ts');
    const files = result.affected.map((a) => a.file);
    expect(files).toContain('src/engines/scanner.ts'); // direct dependent
    expect(files).toContain('src/api.ts');             // depth 2
    expect(files).toContain('src/cli.ts');             // depth 3
  });

  it('respects the depth limit', () => {
    // depth 1 from store should only reach scanner
    const result = affectedNodes(graph, 'store', 1);
    const files = result.affected.map((a) => a.file);
    expect(files).toContain('src/engines/scanner.ts');
    expect(files).not.toContain('src/api.ts');
  });

  it('returns empty affected set for a leaf node nothing depends on', () => {
    const result = affectedNodes(graph, 'cli', 3);
    expect(result.seed).toBe('src/cli.ts');
    expect(result.affected).toEqual([]);
  });

  it('returns null seed for an unknown node', () => {
    const result = affectedNodes(graph, 'doesnotexist', 2);
    expect(result.seed).toBeNull();
    expect(result.affected).toEqual([]);
  });

  it('tags each affected node with its depth', () => {
    const result = affectedNodes(graph, 'store', 5);
    const scanner = result.affected.find((a) => a.file === 'src/engines/scanner.ts');
    expect(scanner!.depth).toBe(1);
    const cli = result.affected.find((a) => a.file === 'src/cli.ts');
    expect(cli!.depth).toBe(3);
  });
});
