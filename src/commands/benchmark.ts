import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { CommandContext } from '../context.js';
import { loadGraph, buildGraph, GRAPH_SCHEMA_VERSION, type GraphData } from '../engines/graph-builder.js';
import { resolveFiles } from '../utils/glob-resolver.js';
import { emitJson } from '../utils/json-output.js';
import { header, keyValue, brand, statusIcon, divider } from '../utils/ui.js';

export interface BenchmarkCommandOptions {
  /** Chars-per-token divisor for the estimate (default 4). */
  charsPerToken?: number;
}

const DEFAULT_CHARS_PER_TOKEN = 4;
/** Files a typical targeted query reads alongside the graph (neighborhood size). */
const QUERY_NEIGHBORHOOD_FILES = 10;

interface BenchmarkResult {
  readableFiles: number;
  charsPerToken: number;
  fullReadTokens: number;
  avgFileTokens: number;
  graphReadTokens: number;
  queryTokens: number;
  graphReadReduction: number;
  queryReduction: number;
  reductionFactor: number;
}

/** Estimate token count from a character length using the chars-per-token divisor. */
function estimateTokens(charLength: number, charsPerToken: number): number {
  return Math.ceil(charLength / charsPerToken);
}

/** Percentage reduction of `part` relative to `whole`, rounded to one decimal place. */
function percentReduction(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((1 - part / whole) * 1000) / 10;
}

/**
 * Benchmark token usage: a traditional assistant reads whole files to answer
 * a codebase question, whereas VibeGuard reads only the compact graph + a
 * targeted node neighborhood. This quantifies the reduction.
 */
export async function runBenchmark(ctx: CommandContext, opts: BenchmarkCommandOptions): Promise<void> {
  const { projectRoot, config, logger, options } = ctx;
  const charsPerToken = opts.charsPerToken && opts.charsPerToken > 0 ? opts.charsPerToken : DEFAULT_CHARS_PER_TOKEN;

  if (!options.json) logger.startSpinner('Measuring token usage...');

  const files = await resolveFiles(projectRoot, config.effectiveInclude, config.effectiveSkipSet);
  const graph = await ensureGraph(ctx, files);
  const result = await measure(projectRoot, files, graph, charsPerToken);

  if (!options.json) logger.stopSpinner(true);

  if (options.json) {
    emitBenchmarkJson(result);
  } else {
    process.stdout.write(renderBenchmarkReport(result) + '\n');
  }
}

/** Load the persisted graph, building it from `files` when it does not yet exist. */
async function ensureGraph(ctx: CommandContext, files: string[]): Promise<GraphData> {
  const { projectRoot, config, logger } = ctx;
  const existing = await loadGraph(projectRoot);
  if (existing) return existing;

  const built = await buildGraph(projectRoot, files, config, logger);
  return { schemaVersion: GRAPH_SCHEMA_VERSION, nodes: Object.fromEntries(built.nodes), edges: [] };
}

/** Compute the full-read baseline, the graph-based estimate, and their reductions. */
async function measure(
  projectRoot: string,
  files: string[],
  graph: GraphData,
  charsPerToken: number,
): Promise<BenchmarkResult> {
  // Baseline: read every file (what a naive assistant does).
  let readableFiles = 0;
  let fullReadTokens = 0;
  for (const file of files) {
    try {
      const content = await readFile(resolve(projectRoot, file), 'utf-8');
      fullReadTokens += estimateTokens(content.length, charsPerToken);
      readableFiles++;
    } catch {
      // unreadable file — skip
    }
  }

  // VibeGuard: read the compact graph.json once.
  const graphReadTokens = estimateTokens(JSON.stringify(graph).length, charsPerToken);

  // Typical query: graph + a small file neighborhood (vs reading all files).
  const avgFileTokens = readableFiles > 0 ? Math.round(fullReadTokens / readableFiles) : 0;
  const neighborhoodFiles = Math.min(QUERY_NEIGHBORHOOD_FILES, readableFiles);
  const queryTokens = graphReadTokens + neighborhoodFiles * avgFileTokens;

  return {
    readableFiles,
    charsPerToken,
    fullReadTokens,
    avgFileTokens,
    graphReadTokens,
    queryTokens,
    graphReadReduction: percentReduction(graphReadTokens, fullReadTokens),
    queryReduction: percentReduction(queryTokens, fullReadTokens),
    reductionFactor: queryTokens > 0 ? Math.round((fullReadTokens / queryTokens) * 10) / 10 : 0,
  };
}

function emitBenchmarkJson(r: BenchmarkResult): void {
  emitJson({
    files: r.readableFiles,
    charsPerToken: r.charsPerToken,
    baseline: { fullReadTokens: r.fullReadTokens, avgFileTokens: r.avgFileTokens },
    vibeguard: { graphBuildTokens: 0, graphReadTokens: r.graphReadTokens, typicalQueryTokens: r.queryTokens },
    reduction: {
      graphVsFullRead: `${r.graphReadReduction}%`,
      queryVsFullRead: `${r.queryReduction}%`,
      factor: r.reductionFactor,
    },
  });
}

function renderBenchmarkReport(r: BenchmarkResult): string {
  const out: string[] = [];
  out.push(header('Token Usage Benchmark', '📊'));
  out.push('');
  out.push(keyValue('Files analyzed', brand.info(String(r.readableFiles))));
  out.push(keyValue('Chars per token', brand.muted(String(r.charsPerToken))));
  out.push('');
  out.push(`  ${brand.primary.bold('Baseline (read every file):')}`);
  out.push(keyValue('  Full-read tokens', brand.danger(`~${r.fullReadTokens.toLocaleString()}`)));
  out.push('');
  out.push(`  ${brand.primary.bold('VibeGuard (graph-based):')}`);
  out.push(keyValue('  Graph build cost', brand.success('0 tokens (local)')));
  out.push(keyValue('  Graph read', brand.info(`~${r.graphReadTokens.toLocaleString()}`)));
  out.push(keyValue('  Typical query', brand.info(`~${r.queryTokens.toLocaleString()}`)));
  out.push('');
  out.push(divider());
  out.push(keyValue('Query reduction', brand.success.bold(`${r.queryReduction}% fewer tokens`)));
  out.push(keyValue('Reduction factor', brand.success.bold(`${r.reductionFactor}x`)));
  out.push('');
  out.push(`  ${statusIcon('success')} ${brand.muted('Graphify charges ~5,000-50,000 tokens to build a graph. VibeGuard: 0.')}`);
  out.push('');
  return out.join('\n');
}
