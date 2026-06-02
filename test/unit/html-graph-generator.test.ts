import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateHTMLGraph } from '../../src/engines/html-graph-generator.js';
import type { GraphData } from '../../src/engines/graph-builder.js';

function makeGraph(): GraphData {
  return {
    schemaVersion: '2.2.0',
    nodes: {
      'src/cli.ts': { file: 'src/cli.ts', imports: ['src/engines/core.ts'], exports: ['main'], dependents: [], edges: [] },
      'src/engines/core.ts': { file: 'src/engines/core.ts', imports: [], exports: ['core'], dependents: ['src/cli.ts'], edges: [] },
      'src/utils/log.ts': { file: 'src/utils/log.ts', imports: [], exports: ['log'], dependents: [], edges: [] },
    },
  } as unknown as GraphData;
}

let tmp: string | null = null;
afterEach(async () => {
  if (tmp) { await rm(tmp, { recursive: true, force: true }); tmp = null; }
});

async function render(graph = makeGraph()): Promise<string> {
  tmp = await mkdtemp(join(tmpdir(), 'vg-graph-'));
  const out = join(tmp, 'graph.html');
  const result = await generateHTMLGraph(tmp, graph, out);
  expect(result).toBe(out);
  return readFile(out, 'utf-8');
}

describe('generateHTMLGraph (vis-network 2D)', () => {
  it('writes a self-contained HTML document', async () => {
    const html = await render();
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
  });

  it('uses the vis-network renderer (the original design)', async () => {
    const html = await render();
    expect(html).toContain('vis-network');
    expect(html).toContain('new vis.Network');
    expect(html).not.toContain('ForceGraph3D');
    expect(html).not.toContain('3d-force-graph');
  });

  it('highlights connected nodes on hover and on click, restoring on blur', async () => {
    const html = await render();
    expect(html).toContain('getConnectedNodes');
    expect(html).toContain("network.on('hoverNode'");
    expect(html).toContain("network.on('blurNode'");
    expect(html).toContain("network.on('click'");
  });

  it('has search and view controls including a Play/Pause toggle', async () => {
    const html = await render();
    expect(html).toContain('id="search"');
    expect(html).toContain('resetView');
    expect(html).toContain('togglePhysics');
    expect(html).toContain('play-pause-btn');
    expect(html).toContain('Pause');
    expect(html).toContain('Play');
  });

  it('uses a light, readable theme (dark text on light background)', async () => {
    const html = await render();
    expect(html).toContain('#eef2fb');       // light background gradient
    expect(html).toContain("color: '#2b3245'"); // dark node label text
  });

  it('embeds nodes and edges derived from the graph', async () => {
    const html = await render();
    expect(html).toContain('src/cli.ts');
    expect(html).toContain('src/engines/core.ts');
  });
});
