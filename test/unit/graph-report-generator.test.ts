import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateGraphReport } from '../../src/engines/graph-report-generator.js';
import type { GraphData } from '../../src/engines/graph-builder.js';

function node(file: string, imports: string[], dependents: string[]) {
  return { file, imports, exports: [], dependents, edges: [] };
}

describe('Graph Report Generator', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `vibeguard-report-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(testDir, '.vibeguard'), { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('clusters connected components into communities', async () => {
    // Two disconnected clusters: {a,b,c} and {x,y}
    const graph: GraphData = {
      schemaVersion: '2.0.0',
      nodes: {
        'src/a.ts': node('src/a.ts', ['src/b.ts'], []),
        'src/b.ts': node('src/b.ts', ['src/c.ts'], ['src/a.ts']),
        'src/c.ts': node('src/c.ts', [], ['src/b.ts']),
        'lib/x.ts': node('lib/x.ts', ['lib/y.ts'], []),
        'lib/y.ts': node('lib/y.ts', [], ['lib/x.ts']),
      },
    };

    const report = await generateGraphReport(testDir, graph);

    // Two connected components → two communities
    expect(report.communities.length).toBe(2);
    const sizes = report.communities.map((c) => c.files.length).sort((a, b) => b - a);
    expect(sizes).toEqual([3, 2]);

    // Largest community contains the a/b/c cluster
    const largest = report.communities[0];
    expect(largest.files).toContain('src/a.ts');
    expect(largest.files).toContain('src/c.ts');
  });

  it('identifies god nodes by total degree', async () => {
    const graph: GraphData = {
      schemaVersion: '2.0.0',
      nodes: {
        'src/hub.ts': node('src/hub.ts', [], ['src/a.ts', 'src/b.ts', 'src/c.ts']),
        'src/a.ts': node('src/a.ts', ['src/hub.ts'], []),
        'src/b.ts': node('src/b.ts', ['src/hub.ts'], []),
        'src/c.ts': node('src/c.ts', ['src/hub.ts'], []),
      },
    };

    const report = await generateGraphReport(testDir, graph);
    expect(report.godNodes.length).toBeGreaterThan(0);
    // The hub (3 dependents) should rank first
    expect(report.godNodes[0].file).toBe('src/hub.ts');
    expect(report.godNodes[0].connections).toBe(3);
  });

  it('writes GRAPH_REPORT.md with all sections', async () => {
    const graph: GraphData = {
      schemaVersion: '2.0.0',
      nodes: {
        'src/index.ts': node('src/index.ts', ['src/util.ts'], []),
        'src/util.ts': node('src/util.ts', [], ['src/index.ts']),
      },
    };

    await generateGraphReport(testDir, graph);
    const md = await readFile(join(testDir, '.vibeguard', 'GRAPH_REPORT.md'), 'utf-8');

    expect(md).toContain('# VibeGuard');
    expect(md).toContain('God Nodes');
    expect(md).toContain('Communities');
    expect(md).toContain('Suggested Questions');
    expect(md).toContain('Statistics');
  });

  it('generates suggested questions grounded in the graph', async () => {
    const graph: GraphData = {
      schemaVersion: '2.0.0',
      nodes: {
        'src/core.ts': node('src/core.ts', [], ['src/a.ts', 'src/b.ts']),
        'src/a.ts': node('src/a.ts', ['src/core.ts'], []),
        'src/b.ts': node('src/b.ts', ['src/core.ts'], []),
      },
    };

    const report = await generateGraphReport(testDir, graph);
    expect(report.suggestedQuestions.length).toBeGreaterThan(0);
    // The most-connected file should be referenced in at least one question
    expect(report.suggestedQuestions.some((q) => q.includes('core'))).toBe(true);
  });

  it('reports accurate node and edge stats', async () => {
    const graph: GraphData = {
      schemaVersion: '2.0.0',
      nodes: {
        'src/a.ts': node('src/a.ts', ['src/b.ts'], []),
        'src/b.ts': node('src/b.ts', [], ['src/a.ts']),
      },
    };

    const report = await generateGraphReport(testDir, graph);
    expect(report.stats.nodes).toBe(2);
    expect(report.stats.edges).toBe(1);
    expect(report.stats.maxFanIn).toBe(1);
    expect(report.stats.maxFanOut).toBe(1);
  });
});
