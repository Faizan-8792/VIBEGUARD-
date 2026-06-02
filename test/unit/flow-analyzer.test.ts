import { describe, it, expect } from 'vitest';
import { computeFlows, computeBridges, computeKnowledgeGaps, detectEntryPoints } from '../../src/engines/flow-analyzer.js';
import type { GraphData } from '../../src/engines/graph-builder.js';

function n(file: string, imports: string[] = [], dependents: string[] = []) {
  return { file, imports, exports: [], dependents, edges: [] };
}

// index -> handler -> service -> util (a 4-deep flow)
const graph: GraphData = {
  schemaVersion: '2.1.0',
  nodes: {
    'src/index.ts': n('src/index.ts', ['src/handler.ts'], []),
    'src/handler.ts': n('src/handler.ts', ['src/service.ts'], ['src/index.ts']),
    'src/service.ts': n('src/service.ts', ['src/util.ts'], ['src/handler.ts']),
    'src/util.ts': n('src/util.ts', [], ['src/service.ts', 'src/orphanCaller.ts']),
    'src/orphanCaller.ts': n('src/orphanCaller.ts', ['src/util.ts'], []),
    'src/lonely.ts': n('src/lonely.ts', [], []),
  },
};

describe('detectEntryPoints', () => {
  it('detects index/main files as entry points', () => {
    const entries = detectEntryPoints(graph);
    expect(entries).toContain('src/index.ts');
  });
});

describe('computeFlows', () => {
  it('traces the deepest forward chain from an entry point', () => {
    const flows = computeFlows(graph);
    const fromIndex = flows.find((f) => f.entryPoint === 'src/index.ts');
    expect(fromIndex).toBeDefined();
    expect(fromIndex!.path).toEqual(['src/index.ts', 'src/handler.ts', 'src/service.ts', 'src/util.ts']);
    expect(fromIndex!.depth).toBe(4);
  });

  it('assigns criticality within 0-100 and sorts descending', () => {
    const flows = computeFlows(graph);
    for (const f of flows) {
      expect(f.criticality).toBeGreaterThanOrEqual(0);
      expect(f.criticality).toBeLessThanOrEqual(100);
    }
    for (let i = 1; i < flows.length; i++) {
      expect(flows[i - 1].criticality).toBeGreaterThanOrEqual(flows[i].criticality);
    }
  });

  it('is cycle-safe', () => {
    const cyclic: GraphData = {
      schemaVersion: '2.1.0',
      nodes: {
        'a.ts': n('a.ts', ['b.ts'], ['b.ts']),
        'b.ts': n('b.ts', ['a.ts'], ['a.ts']),
        'index.ts': n('index.ts', ['a.ts'], []),
      },
    };
    expect(() => computeFlows(cyclic)).not.toThrow();
  });
});

describe('computeBridges', () => {
  it('credits interior connector nodes', () => {
    const bridges = computeBridges(graph, { topN: 5 });
    // handler and service are interior to the index flow.
    const files = bridges.map((b) => b.file);
    expect(files).toContain('src/handler.ts');
  });
});

describe('computeKnowledgeGaps', () => {
  it('detects isolated nodes', () => {
    const gaps = computeKnowledgeGaps(graph);
    expect(gaps.isolatedNodes).toContain('src/lonely.ts');
  });

  it('flags untested hotspots above the threshold', () => {
    const gaps = computeKnowledgeGaps(graph, { hotspotThreshold: 2 });
    const files = gaps.untestedHotspots.map((h) => h.file);
    expect(files).toContain('src/util.ts'); // 2 dependents, no test
  });

  it('returns clean summary when nothing qualifies', () => {
    const tiny: GraphData = { schemaVersion: '2.1.0', nodes: { 'a.ts': n('a.ts', ['b.ts']), 'b.ts': n('b.ts', [], ['a.ts']) } };
    const gaps = computeKnowledgeGaps(tiny, { hotspotThreshold: 100 });
    expect(gaps.summary.untestedHotspots).toBe(0);
  });
});
