import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GraphData, GraphNode } from './graph-builder.js';

/**
 * Generates an interactive HTML graph visualization using vis.js (CDN).
 * The output is a self-contained HTML file that can be opened in any browser.
 */
export async function generateHTMLGraph(
  projectRoot: string,
  graphData: GraphData,
  outputPath?: string,
): Promise<string> {
  const nodes = Object.values(graphData.nodes);
  const filePath = outputPath ?? join(projectRoot, '.vibeguard', 'graph.html');

  // Build vis.js data
  const visNodes = nodes.map((node) => ({
    id: node.file,
    label: shortenLabel(node.file),
    title: buildTooltip(node),
    group: getGroup(node.file),
    value: node.dependents.length + node.imports.length + 1,
  }));

  const visEdges: Array<{ from: string; to: string }> = [];
  const seenEdges = new Set<string>();
  for (const node of nodes) {
    for (const imp of node.imports) {
      // Resolve .js → .ts for display
      const resolved = resolveTarget(imp, graphData);
      if (resolved && resolved !== node.file) {
        const key = `${node.file}→${resolved}`;
        if (!seenEdges.has(key)) {
          seenEdges.add(key);
          visEdges.push({ from: node.file, to: resolved });
        }
      }
    }
  }

  const html = buildHTML(visNodes, visEdges, nodes.length, visEdges.length);
  await writeFile(filePath, html, 'utf-8');
  return filePath;
}

function shortenLabel(path: string): string {
  const parts = path.split('/');
  if (parts.length <= 2) return path;
  return parts.slice(-2).join('/');
}

function buildTooltip(node: GraphNode): string {
  return `<b>${node.file}</b><br/>` +
    `Imports: ${node.imports.length}<br/>` +
    `Dependents: ${node.dependents.length}<br/>` +
    `Exports: ${node.exports.join(', ') || 'none'}`;
}

function getGroup(file: string): string {
  if (file.includes('/commands/')) return 'commands';
  if (file.includes('/engines/')) return 'engines';
  if (file.includes('/storage/')) return 'storage';
  if (file.includes('/utils/')) return 'utils';
  if (file.includes('test/') || file.includes('.test.')) return 'tests';
  return 'core';
}

function resolveTarget(imp: string, graphData: GraphData): string | null {
  if (graphData.nodes[imp]) return imp;
  const tsVariant = imp.replace(/\.js$/, '.ts').replace(/\.mjs$/, '.ts');
  if (graphData.nodes[tsVariant]) return tsVariant;
  const tsxVariant = imp.replace(/\.js$/, '.tsx');
  if (graphData.nodes[tsxVariant]) return tsxVariant;
  return null;
}

function buildHTML(
  nodes: Array<{ id: string; label: string; title: string; group: string; value: number }>,
  edges: Array<{ from: string; to: string }>,
  nodeCount: number,
  edgeCount: number,
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>VibeGuard — Dependency Graph</title>
  <script src="https://unpkg.com/vis-network/standalone/umd/vis-network.min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'JetBrains Mono', 'Fira Code', monospace;
      background: linear-gradient(135deg, #eef2fb 0%, #e7ecf7 100%);
      color: #2b3245;
      height: 100vh;
      overflow: hidden;
    }
    #header {
      background: linear-gradient(135deg, #ffffff 0%, #eef1fa 100%);
      padding: 16px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid #d8def0;
      box-shadow: 0 1px 8px rgba(80, 90, 130, 0.06);
    }
    #header h1 {
      font-size: 18px;
      color: #6d28d9;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    #header .stats {
      font-size: 13px;
      color: #8a90a2;
    }
    #header .stats span {
      color: #0891b2;
      font-weight: bold;
    }
    #controls {
      padding: 12px 24px;
      background: #ffffff;
      display: flex;
      gap: 12px;
      align-items: center;
      border-bottom: 1px solid #e3e7f2;
    }
    #controls input {
      background: #f5f7fc;
      border: 1px solid #d8def0;
      border-radius: 8px;
      padding: 8px 14px;
      color: #2b3245;
      font-size: 13px;
      width: 300px;
      outline: none;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    #controls input:focus { border-color: #7c3aed; box-shadow: 0 0 0 3px rgba(124,58,237,0.12); }
    #controls button {
      background: #7c3aed;
      color: white;
      border: none;
      border-radius: 8px;
      padding: 8px 16px;
      cursor: pointer;
      font-size: 13px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: background 0.15s, transform 0.05s;
    }
    #controls button:hover { background: #6d28d9; }
    #controls button:active { transform: translateY(1px); }
    #controls button.paused { background: #0891b2; }
    #controls button.paused:hover { background: #0e7490; }
    .legend {
      display: flex;
      gap: 16px;
      margin-left: auto;
      font-size: 12px;
      color: #5b6276;
    }
    .legend-item {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .legend-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      box-shadow: 0 0 0 2px #ffffff, 0 1px 3px rgba(0,0,0,0.15);
    }
    #graph { width: 100%; height: calc(100vh - 110px); }
    #tooltip {
      position: absolute;
      background: #ffffff;
      border: 1px solid #d8def0;
      border-radius: 8px;
      padding: 12px;
      font-size: 12px;
      line-height: 1.5;
      color: #2b3245;
      display: none;
      z-index: 100;
      max-width: 300px;
      box-shadow: 0 6px 24px rgba(80, 90, 130, 0.18);
    }
  </style>
</head>
<body>
  <div id="header">
    <h1>🛡️ VibeGuard — Dependency Graph</h1>
    <div class="stats">
      <span>${nodeCount}</span> nodes &nbsp;•&nbsp; <span>${edgeCount}</span> edges &nbsp;•&nbsp; Generated ${new Date().toLocaleDateString()}
    </div>
  </div>
  <div id="controls">
    <input type="text" id="search" placeholder="🔍 Search files..." />
    <button onclick="resetView()">⤢ Reset View</button>
    <button id="play-pause-btn" onclick="togglePhysics()">⏸ Pause</button>
    <div class="legend">
      <div class="legend-item"><div class="legend-dot" style="background:#7c3aed"></div>Core</div>
      <div class="legend-item"><div class="legend-dot" style="background:#06b6d4"></div>Commands</div>
      <div class="legend-item"><div class="legend-dot" style="background:#10b981"></div>Engines</div>
      <div class="legend-item"><div class="legend-dot" style="background:#f59e0b"></div>Storage</div>
      <div class="legend-item"><div class="legend-dot" style="background:#6b7280"></div>Utils</div>
    </div>
  </div>
  <div id="graph"></div>
  <div id="tooltip"></div>

  <script>
    const nodesData = ${JSON.stringify(nodes)};
    const edgesData = ${JSON.stringify(edges)};

    const groupColors = {
      core: { background: '#7c3aed', border: '#6d28d9', highlight: { background: '#9333ea', border: '#7c3aed' } },
      commands: { background: '#06b6d4', border: '#0891b2', highlight: { background: '#22d3ee', border: '#06b6d4' } },
      engines: { background: '#10b981', border: '#059669', highlight: { background: '#34d399', border: '#10b981' } },
      storage: { background: '#f59e0b', border: '#d97706', highlight: { background: '#fbbf24', border: '#f59e0b' } },
      utils: { background: '#6b7280', border: '#4b5563', highlight: { background: '#9ca3af', border: '#6b7280' } },
      tests: { background: '#374151', border: '#1f2937', highlight: { background: '#4b5563', border: '#374151' } },
    };

    const nodes = new vis.DataSet(nodesData.map(n => ({
      ...n,
      color: groupColors[n.group] || groupColors.core,
      font: { color: '#2b3245', size: 12, strokeWidth: 3, strokeColor: '#ffffff' },
      shape: 'dot',
      scaling: { min: 8, max: 30 },
    })));

    const edges = new vis.DataSet(edgesData.map(e => ({
      ...e,
      arrows: 'to',
      color: { color: 'rgba(80, 90, 130, 0.25)', highlight: '#7c3aed' },
      smooth: { type: 'cubicBezier', roundness: 0.4 },
    })));

    const container = document.getElementById('graph');
    const network = new vis.Network(container, { nodes, edges }, {
      physics: {
        solver: 'forceAtlas2Based',
        forceAtlas2Based: { gravitationalConstant: -80, springLength: 120 },
        stabilization: { iterations: 200 },
      },
      interaction: { hover: true, tooltipDelay: 200, zoomView: true },
      layout: { improvedLayout: true },
    });

    let physicsEnabled = true;
    const DIM_OPACITY = 0.15;

    function resetView() { network.fit({ animation: true }); }

    // Play/Pause: pause freezes all node movement; play resumes the simulation.
    function togglePhysics() {
      physicsEnabled = !physicsEnabled;
      network.setOptions({ physics: { enabled: physicsEnabled } });
      const btn = document.getElementById('play-pause-btn');
      if (btn) {
        btn.textContent = physicsEnabled ? '⏸ Pause' : '▶ Play';
        btn.classList.toggle('paused', !physicsEnabled);
      }
    }

    // Fully show nodes where keep(node) is true; dim the rest.
    function setNodeOpacity(keep) {
      nodes.forEach(n => nodes.update({ id: n.id, opacity: keep(n) ? 1 : DIM_OPACITY }));
    }

    // Highlight a node and its direct neighbours; dim everything else.
    function highlightConnections(focusId) {
      const connected = network.getConnectedNodes(focusId);
      setNodeOpacity(n => n.id === focusId || connected.includes(n.id));
    }

    // Restore full opacity to every node.
    function restoreOpacity() {
      setNodeOpacity(() => true);
    }

    // Search
    document.getElementById('search').addEventListener('input', function(e) {
      const query = e.target.value.toLowerCase();
      if (!query) {
        restoreOpacity();
        return;
      }
      setNodeOpacity(n => n.id.toLowerCase().includes(query) || n.label.toLowerCase().includes(query));
      const matches = nodes.get().filter(n => n.id.toLowerCase().includes(query));
      if (matches.length === 1) {
        network.focus(matches[0].id, { scale: 1.5, animation: true });
      }
    });

    // Click to highlight connections
    network.on('click', function(params) {
      if (params.nodes.length > 0) {
        highlightConnections(params.nodes[0]);
      } else {
        restoreOpacity();
      }
    });

    // Hover to highlight which files are linked (dim the rest); restore on blur.
    network.on('hoverNode', function(params) {
      highlightConnections(params.node);
    });
    network.on('blurNode', restoreOpacity);
  </script>
</body>
</html>`;
}
