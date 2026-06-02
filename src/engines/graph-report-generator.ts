import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GraphData, GraphNode } from './graph-builder.js';

export interface GraphReport {
  godNodes: Array<{ file: string; connections: number; role: string }>;
  communities: Array<{ name: string; files: string[]; description: string }>;
  surprisingConnections: Array<{ from: string; to: string; why: string }>;
  suggestedQuestions: string[];
  stats: { nodes: number; edges: number; avgConnections: number; maxFanIn: number; maxFanOut: number };
}

/**
 * Generates a GRAPH_REPORT.md — the high-level "map" of the project's architecture.
 * Identifies god nodes, communities, surprising connections, and suggested questions.
 * All done locally — zero LLM calls.
 */
export async function generateGraphReport(
  projectRoot: string,
  graphData: GraphData,
): Promise<GraphReport> {
  const nodes = Object.values(graphData.nodes);

  // ─── Stats ──────────────────────────────────────────────────────────────
  let totalEdges = 0;
  let maxFanIn = 0;
  let maxFanOut = 0;
  for (const node of nodes) {
    totalEdges += node.imports.length;
    maxFanIn = Math.max(maxFanIn, node.dependents.length);
    maxFanOut = Math.max(maxFanOut, node.imports.length);
  }
  const avgConnections = nodes.length > 0 ? Math.round(((totalEdges * 2) / nodes.length) * 10) / 10 : 0;

  // ─── God Nodes (highest degree) ────────────────────────────────────────
  const scored = nodes.map((n) => ({
    file: n.file,
    connections: n.imports.length + n.dependents.length,
    fanIn: n.dependents.length,
    fanOut: n.imports.length,
  }));
  scored.sort((a, b) => b.connections - a.connections);

  const godNodes = scored.slice(0, Math.min(8, Math.ceil(nodes.length * 0.15))).map((n) => ({
    file: n.file,
    connections: n.connections,
    role: classifyRole(n.file, n.fanIn, n.fanOut),
  }));

  // ─── Community Detection (connected components + directory clustering) ──
  const communities = detectCommunities(nodes, graphData);

  // ─── Surprising Connections ─────────────────────────────────────────────
  const surprisingConnections = findSurprisingConnections(nodes, communities, graphData);

  // ─── Suggested Questions ────────────────────────────────────────────────
  const suggestedQuestions = generateQuestions(godNodes, communities, scored);

  const report: GraphReport = {
    godNodes,
    communities,
    surprisingConnections,
    suggestedQuestions,
    stats: { nodes: nodes.length, edges: totalEdges, avgConnections, maxFanIn, maxFanOut },
  };

  // Write GRAPH_REPORT.md
  const markdown = renderReportMarkdown(report);
  await writeFile(join(projectRoot, '.vibeguard', 'GRAPH_REPORT.md'), markdown, 'utf-8');

  return report;
}

function classifyRole(file: string, fanIn: number, fanOut: number): string {
  if (file.includes('cli') || file.includes('index') || file.includes('main') || file.includes('app')) return 'entrypoint';
  if (fanIn > fanOut * 2) return 'hub (many depend on it)';
  if (fanOut > fanIn * 2) return 'orchestrator (imports many)';
  if (file.includes('util') || file.includes('helper') || file.includes('lib')) return 'utility';
  if (file.includes('engine') || file.includes('service')) return 'engine';
  if (file.includes('store') || file.includes('storage') || file.includes('db')) return 'data layer';
  if (file.includes('command') || file.includes('handler')) return 'command';
  return 'module';
}

interface Community {
  name: string;
  files: string[];
  description: string;
}

function detectCommunities(nodes: GraphNode[], graphData: GraphData): Community[] {
  // Simple directory-based clustering + connectivity refinement
  const dirGroups = new Map<string, string[]>();

  for (const node of nodes) {
    const parts = node.file.split('/');
    let dir: string;
    if (parts.length >= 3) {
      dir = parts.slice(0, 2).join('/');
    } else if (parts.length === 2) {
      dir = parts[0];
    } else {
      dir = 'root';
    }
    if (!dirGroups.has(dir)) dirGroups.set(dir, []);
    dirGroups.get(dir)!.push(node.file);
  }

  const communities: Community[] = [];
  for (const [dir, files] of dirGroups) {
    if (files.length === 0) continue;
    communities.push({
      name: dir,
      files: files.sort(),
      description: describeCommunity(dir, files),
    });
  }

  return communities.sort((a, b) => b.files.length - a.files.length);
}

function describeCommunity(dir: string, files: string[]): string {
  if (dir.includes('command')) return `Command handlers (${files.length} files)`;
  if (dir.includes('engine')) return `Analysis engines (${files.length} files)`;
  if (dir.includes('storage') || dir.includes('store')) return `Data persistence (${files.length} files)`;
  if (dir.includes('util')) return `Shared utilities (${files.length} files)`;
  if (dir.includes('test')) return `Test files (${files.length} files)`;
  return `${dir} module (${files.length} files)`;
}

function findSurprisingConnections(
  nodes: GraphNode[],
  communities: Community[],
  graphData: GraphData,
): Array<{ from: string; to: string; why: string }> {
  // Find cross-community edges (files in different directories importing each other)
  const fileToCommunity = new Map<string, string>();
  for (const c of communities) {
    for (const f of c.files) fileToCommunity.set(f, c.name);
  }

  const surprising: Array<{ from: string; to: string; why: string }> = [];
  for (const node of nodes) {
    const fromCommunity = fileToCommunity.get(node.file);
    for (const imp of node.imports) {
      const resolved = resolveImport(imp, graphData);
      if (!resolved) continue;
      const toCommunity = fileToCommunity.get(resolved);
      if (fromCommunity && toCommunity && fromCommunity !== toCommunity) {
        // Cross-community edge
        if (surprising.length < 10) {
          surprising.push({
            from: node.file,
            to: resolved,
            why: `Cross-module dependency: ${fromCommunity} → ${toCommunity}`,
          });
        }
      }
    }
  }

  return surprising.slice(0, 5);
}

function resolveImport(imp: string, graphData: GraphData): string | null {
  if (graphData.nodes[imp]) return imp;
  const ts = imp.replace(/\.js$/, '.ts');
  if (graphData.nodes[ts]) return ts;
  return null;
}

function generateQuestions(
  godNodes: GraphReport['godNodes'],
  communities: Community[],
  scored: Array<{ file: string; connections: number }>,
): string[] {
  const questions: string[] = [];

  if (godNodes.length > 0) {
    questions.push(`What is the responsibility of ${shortenPath(godNodes[0].file)} and why does everything depend on it?`);
  }
  if (communities.length >= 2) {
    questions.push(`How do ${communities[0].name} and ${communities[1].name} interact?`);
  }
  if (godNodes.length >= 2) {
    questions.push(`What is the data flow between ${shortenPath(godNodes[0].file)} and ${shortenPath(godNodes[1].file)}?`);
  }
  questions.push('Which files would be affected if I refactor the most-connected module?');
  if (scored.length > 5) {
    const leastConnected = scored[scored.length - 1];
    questions.push(`Is ${shortenPath(leastConnected.file)} still needed or is it dead code?`);
  }

  return questions.slice(0, 5);
}

function shortenPath(path: string): string {
  const parts = path.split('/');
  return parts.length > 2 ? parts.slice(-2).join('/') : path;
}

function renderReportMarkdown(report: GraphReport): string {
  let md = '';

  md += `# VibeGuard — Graph Report\n\n`;
  md += `> Auto-generated architectural overview. No LLM tokens used.\n\n`;

  // Stats
  md += `## 📊 Statistics\n\n`;
  md += `| Metric | Value |\n|--------|-------|\n`;
  md += `| Nodes | ${report.stats.nodes} |\n`;
  md += `| Edges | ${report.stats.edges} |\n`;
  md += `| Avg connections/file | ${report.stats.avgConnections} |\n`;
  md += `| Max fan-in | ${report.stats.maxFanIn} |\n`;
  md += `| Max fan-out | ${report.stats.maxFanOut} |\n\n`;

  // God Nodes
  md += `## 🏛️ God Nodes (highest connectivity)\n\n`;
  md += `These files are the backbone of the project — many other files depend on them.\n\n`;
  for (const g of report.godNodes) {
    md += `- **${g.file}** — ${g.connections} connections (${g.role})\n`;
  }
  md += '\n';

  // Communities
  md += `## 🏘️ Communities (file clusters)\n\n`;
  for (const c of report.communities) {
    md += `### ${c.name}\n`;
    md += `${c.description}\n\n`;
    for (const f of c.files.slice(0, 10)) {
      md += `- ${f}\n`;
    }
    if (c.files.length > 10) md += `- ... and ${c.files.length - 10} more\n`;
    md += '\n';
  }

  // Surprising Connections
  if (report.surprisingConnections.length > 0) {
    md += `## 🔗 Surprising Connections\n\n`;
    md += `Cross-module dependencies that reveal architectural decisions:\n\n`;
    for (const s of report.surprisingConnections) {
      md += `- **${shortenPath(s.from)}** → **${shortenPath(s.to)}** — ${s.why}\n`;
    }
    md += '\n';
  }

  // Suggested Questions
  md += `## ❓ Suggested Questions\n\n`;
  md += `Questions this graph is well-positioned to answer:\n\n`;
  for (const q of report.suggestedQuestions) {
    md += `- ${q}\n`;
  }
  md += '\n';

  md += `---\n*Generated by VibeGuard • ${new Date().toLocaleDateString()} • Zero tokens used*\n`;

  return md;
}
