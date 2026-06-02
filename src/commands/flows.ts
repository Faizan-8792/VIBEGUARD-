import type { CommandContext } from '../context.js';
import { loadGraph, buildGraph, GRAPH_SCHEMA_VERSION, type GraphData } from '../engines/graph-builder.js';
import { computeFlows, computeBridges, computeKnowledgeGaps } from '../engines/flow-analyzer.js';
import { resolveFiles } from '../utils/glob-resolver.js';
import { emitJson } from '../utils/json-output.js';
import { header, divider, statusIcon, filePath, brand, summaryLine } from '../utils/ui.js';

export interface FlowsCommandOptions {
  /** View: flows (default), bridges, or gaps. */
  view?: string;
  limit?: number;
}

async function ensureGraph(ctx: CommandContext): Promise<GraphData> {
  const existing = await loadGraph(ctx.projectRoot);
  if (existing) return existing;
  const files = await resolveFiles(ctx.projectRoot, ctx.config.effectiveInclude, ctx.config.effectiveSkipSet);
  const result = await buildGraph(ctx.projectRoot, files, ctx.config, ctx.logger);
  return { schemaVersion: GRAPH_SCHEMA_VERSION, nodes: Object.fromEntries(result.nodes), edges: [] };
}

export async function runFlows(ctx: CommandContext, opts: FlowsCommandOptions): Promise<void> {
  const { logger, options } = ctx;
  const view = opts.view ?? 'flows';

  if (!options.json) logger.startSpinner('Analyzing execution flows...');
  const graph = await ensureGraph(ctx);

  if (view === 'bridges') {
    const bridges = computeBridges(graph, { topN: opts.limit ?? 10 });
    if (!options.json) logger.stopSpinner(true);
    if (options.json) return emitJson({ bridges });
    renderBridges(bridges);
    return;
  }

  if (view === 'gaps') {
    const gaps = computeKnowledgeGaps(graph);
    if (!options.json) logger.stopSpinner(true);
    if (options.json) return emitJson({ ...gaps });
    renderGaps(gaps);
    return;
  }

  const flows = computeFlows(graph, { limit: opts.limit ?? 50 });
  if (!options.json) logger.stopSpinner(true);
  if (options.json) return emitJson({ flows });
  renderFlows(flows);
}

function flush(lines: string[]): void {
  process.stdout.write(lines.join('\n') + '\n');
}

function renderFlows(flows: ReturnType<typeof computeFlows>): void {
  const out: string[] = [];
  out.push(header('Execution Flows', '🔀'));
  out.push('');
  if (flows.length === 0) {
    out.push(`  ${statusIcon('info')} ${brand.muted('No multi-step flows detected. Build the graph first with `vibeguard map`.')}`);
    flush(out);
    return;
  }
  out.push(`  ${brand.muted(`${flows.length} flows (sorted by criticality):`)}`);
  out.push('');
  for (const flow of flows.slice(0, 20)) {
    const color = flow.criticality >= 60 ? 'danger' : flow.criticality >= 30 ? 'warning' : 'info';
    out.push(`  ${brand[color].bold(`[${flow.criticality}]`)} ${filePath(flow.entryPoint)} ${brand.muted(`(depth ${flow.depth}, ${flow.nodeCount} files)`)}`);
  }
  out.push('');
  flush(out);
}

function renderBridges(bridges: ReturnType<typeof computeBridges>): void {
  const out: string[] = [];
  out.push(header('Architectural Bridges', '🌉'));
  out.push('');
  if (bridges.length === 0) {
    out.push(`  ${statusIcon('info')} ${brand.muted('No bridge nodes detected.')}`);
  } else {
    out.push(`  ${brand.muted('Connector nodes (removal would fragment the graph most):')}`);
    out.push('');
    for (const b of bridges) {
      out.push(`  ${brand.warning.bold(`[${b.score}]`)} ${filePath(b.file)}`);
    }
  }
  out.push('');
  flush(out);
}

function renderGaps(gaps: ReturnType<typeof computeKnowledgeGaps>): void {
  const out: string[] = [];
  out.push(header('Knowledge Gaps', '🧩'));
  out.push('');
  out.push(summaryLine([
    { label: 'Isolated', value: gaps.summary.isolated, color: gaps.summary.isolated > 0 ? 'warning' : 'muted' },
    { label: 'Untested hotspots', value: gaps.summary.untestedHotspots, color: gaps.summary.untestedHotspots > 0 ? 'danger' : 'muted' },
  ]));
  out.push('');

  if (gaps.untestedHotspots.length > 0) {
    out.push(divider());
    out.push(`  ${brand.danger.bold('Untested hotspots (high fan-in, no tests):')}`);
    for (const h of gaps.untestedHotspots.slice(0, 10)) {
      out.push(`    ${filePath(h.file)} ${brand.muted(`(${h.dependents} dependents)`)}`);
    }
    out.push('');
  }

  if (gaps.isolatedNodes.length > 0) {
    out.push(divider());
    out.push(`  ${brand.warning.bold('Isolated nodes (no imports, no dependents):')}`);
    for (const f of gaps.isolatedNodes.slice(0, 10)) {
      out.push(`    ${filePath(f)}`);
    }
    out.push('');
  }

  if (gaps.summary.isolated === 0 && gaps.summary.untestedHotspots === 0) {
    out.push(`  ${statusIcon('success')} ${brand.success('No structural gaps detected.')}`);
    out.push('');
  }

  flush(out);
}
