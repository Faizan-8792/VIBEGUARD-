import { describe, it, expect } from 'vitest';
import { analyzeChanges } from '../../src/engines/change-detector.js';
import { computeTokenSavings, estimateTokens } from '../../src/engines/token-savings.js';
import type { GraphData } from '../../src/engines/graph-builder.js';
import type { ImportanceEntry } from '../../src/engines/importance-analyzer.js';

function n(file: string, imports: string[] = [], dependents: string[] = [], exports: string[] = []) {
  return { file, imports, exports, dependents, edges: [] };
}

// Graph: util.ts is depended on by service.ts and handler.ts; handler.ts by index.ts.
const graph: GraphData = {
  schemaVersion: '2.1.0',
  nodes: {
    'src/util.ts': n('src/util.ts', [], ['src/service.ts', 'src/handler.ts'], ['helper']),
    'src/service.ts': n('src/service.ts', ['src/util.ts'], ['src/handler.ts'], ['service']),
    'src/handler.ts': n('src/handler.ts', ['src/util.ts', 'src/service.ts'], ['src/index.ts', 'src/handler.test.ts'], ['handle']),
    'src/index.ts': n('src/index.ts', ['src/handler.ts'], [], ['main']),
    'src/handler.test.ts': n('src/handler.test.ts', ['src/handler.ts'], [], []),
  },
};

const importance: Record<string, ImportanceEntry> = {
  'src/util.ts': { score: 20, dependents: 2, imports: 0, gitCommits: 0, routeUsage: 0 },
  'src/service.ts': { score: 8, dependents: 1, imports: 1, gitCommits: 0, routeUsage: 0 },
};

describe('analyzeChanges', () => {
  it('only analyzes files that exist as graph nodes', () => {
    const result = analyzeChanges({
      base: 'HEAD~1',
      changedFiles: ['src/util.ts', 'README.md', 'new-untracked.ts'],
      graph,
      importance,
    });
    expect(result.analyzedFiles).toEqual(['src/util.ts']);
    expect(result.summary.changed).toBe(3);
  });

  it('computes blast radius via reverse-dependency BFS', () => {
    const result = analyzeChanges({
      base: 'HEAD~1',
      changedFiles: ['src/util.ts'],
      graph,
      importance,
      depth: 2,
    });
    const item = result.reviewItems.find((r) => r.file === 'src/util.ts')!;
    // util -> {service, handler} (1 hop) -> {index} via handler (2nd hop). test file also depends on handler.
    expect(item.blastRadius).toBeGreaterThanOrEqual(3);
    expect(item.directDependents).toBe(2);
  });

  it('ranks higher-impact changes first', () => {
    const result = analyzeChanges({
      base: 'HEAD~1',
      changedFiles: ['src/util.ts', 'src/index.ts'],
      graph,
      importance,
    });
    // util.ts (wide blast + high importance) should outrank index.ts (leaf).
    expect(result.reviewItems[0].file).toBe('src/util.ts');
    expect(result.reviewItems[0].risk).toBeGreaterThan(result.reviewItems[1].risk);
  });

  it('flags a test gap when no test depends on the file', () => {
    const result = analyzeChanges({
      base: 'HEAD~1',
      changedFiles: ['src/service.ts'],
      graph,
      importance,
    });
    // service.ts has no test dependent → test gap.
    expect(result.reviewItems[0].testGap).toBe(true);
  });

  it('does not flag a test gap when a test depends on the file', () => {
    const result = analyzeChanges({
      base: 'HEAD~1',
      changedFiles: ['src/handler.ts'],
      graph,
      importance,
    });
    // handler.test.ts depends on handler.ts → no test gap.
    expect(result.reviewItems[0].testGap).toBe(false);
  });

  it('risk score stays within 0-100', () => {
    const result = analyzeChanges({
      base: 'HEAD~1',
      changedFiles: Object.keys(graph.nodes),
      graph,
      importance,
    });
    for (const item of result.reviewItems) {
      expect(item.risk).toBeGreaterThanOrEqual(0);
      expect(item.risk).toBeLessThanOrEqual(100);
    }
  });

  it('handles an empty change set', () => {
    const result = analyzeChanges({ base: 'HEAD~1', changedFiles: [], graph, importance });
    expect(result.reviewItems).toEqual([]);
    expect(result.summary.changed).toBe(0);
  });
});

describe('computeTokenSavings', () => {
  it('estimates tokens as chars/4', () => {
    expect(estimateTokens('a'.repeat(40))).toBe(10);
  });

  it('reports positive savings when full context exceeds the response', () => {
    const savings = computeTokenSavings(40000, { small: 'response' });
    expect(savings.estimated).toBe(true);
    expect(savings.fullContextTokens).toBe(10000);
    expect(savings.savedTokens).toBeGreaterThan(0);
    expect(savings.savedPercent).toBeGreaterThan(0);
  });

  it('never reports negative savings for tiny diffs', () => {
    const savings = computeTokenSavings(8, { a: 'much larger response object than the diff' });
    expect(savings.savedTokens).toBeGreaterThanOrEqual(0);
    expect(savings.savedPercent).toBeGreaterThanOrEqual(0);
  });
});
