import { describe, it, expect } from 'vitest';
import { validateGraph, assertValidGraph } from '../../src/engines/graph-validator.js';

function validGraph() {
  return {
    schemaVersion: '2.2.0',
    nodes: {
      'src/a.ts': {
        file: 'src/a.ts',
        imports: ['src/b.ts'],
        exports: ['a'],
        dependents: [],
        edges: [
          { source: 'src/a.ts', target: 'src/b.ts', type: 'import', confidence: 1.0, confidenceLabel: 'EXTRACTED' },
        ],
      },
      'src/b.ts': { file: 'src/b.ts', imports: [], exports: ['b'], dependents: ['src/a.ts'], edges: [] },
    },
    edges: [
      { source: 'src/a.ts', target: 'src/b.ts', type: 'import', confidence: 1.0, confidenceLabel: 'EXTRACTED' },
    ],
  };
}

describe('Graph Validator', () => {
  it('accepts a well-formed graph', () => {
    expect(validateGraph(validGraph())).toEqual([]);
  });

  it('rejects non-object input', () => {
    expect(validateGraph(null).length).toBeGreaterThan(0);
    expect(validateGraph([]).length).toBeGreaterThan(0);
    expect(validateGraph('graph').length).toBeGreaterThan(0);
  });

  it('flags missing schemaVersion', () => {
    const g = validGraph();
    delete (g as Record<string, unknown>).schemaVersion;
    expect(validateGraph(g).some((e) => e.includes('schemaVersion'))).toBe(true);
  });

  it('flags a node whose file field mismatches its key', () => {
    const g = validGraph();
    g.nodes['src/a.ts'].file = 'src/wrong.ts';
    expect(validateGraph(g).some((e) => e.includes('mismatched'))).toBe(true);
  });

  it('flags an invalid edge type', () => {
    const g = validGraph();
    (g.nodes['src/a.ts'].edges[0] as Record<string, unknown>).type = 'bogus';
    expect(validateGraph(g).some((e) => e.includes('invalid type'))).toBe(true);
  });

  it('flags out-of-range confidence', () => {
    const g = validGraph();
    g.nodes['src/a.ts'].edges[0].confidence = 5;
    expect(validateGraph(g).some((e) => e.includes('confidence'))).toBe(true);
  });

  it('flags an invalid confidence label', () => {
    const g = validGraph();
    (g.nodes['src/a.ts'].edges[0] as Record<string, unknown>).confidenceLabel = 'MAYBE';
    expect(validateGraph(g).some((e) => e.includes('confidenceLabel'))).toBe(true);
  });

  it('flags an edge target that does not exist as a node', () => {
    const g = validGraph();
    g.nodes['src/a.ts'].edges[0].target = 'src/ghost.ts';
    expect(validateGraph(g).some((e) => e.includes('does not match any node'))).toBe(true);
  });

  it('flags nodes that are not an object', () => {
    const g = { schemaVersion: '2.2.0', nodes: 'not-an-object' };
    expect(validateGraph(g).some((e) => e.includes("'nodes' must be an object"))).toBe(true);
  });

  it('assertValidGraph throws on invalid input', () => {
    expect(() => assertValidGraph({ schemaVersion: '2.2.0', nodes: 'bad' })).toThrow(/validation error/);
  });

  it('assertValidGraph passes on a valid graph', () => {
    expect(() => assertValidGraph(validGraph())).not.toThrow();
  });
});
