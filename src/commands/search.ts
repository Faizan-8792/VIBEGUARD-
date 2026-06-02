import type { CommandContext } from '../context.js';
import { loadGraph, buildGraph, GRAPH_SCHEMA_VERSION, type GraphData } from '../engines/graph-builder.js';
import { hybridSearch } from '../engines/embeddings.js';
import { resolveFiles } from '../utils/glob-resolver.js';
import { emitJson } from '../utils/json-output.js';
import { header, statusIcon, filePath, brand, keyValue } from '../utils/ui.js';

export interface SearchCommandOptions {
  query: string;
  limit?: number;
}

async function ensureGraph(ctx: CommandContext): Promise<GraphData> {
  const existing = await loadGraph(ctx.projectRoot);
  if (existing) return existing;
  const files = await resolveFiles(ctx.projectRoot, ctx.config.effectiveInclude, ctx.config.effectiveSkipSet);
  const result = await buildGraph(ctx.projectRoot, files, ctx.config, ctx.logger);
  return { schemaVersion: GRAPH_SCHEMA_VERSION, nodes: Object.fromEntries(result.nodes), edges: [] };
}

export async function runSearch(ctx: CommandContext, opts: SearchCommandOptions): Promise<void> {
  const { logger, options } = ctx;

  if (!options.json) logger.startSpinner(`Searching for "${opts.query}"...`);
  const graph = await ensureGraph(ctx);
  const hits = hybridSearch(graph, opts.query, { limit: opts.limit ?? 20 });
  if (!options.json) logger.stopSpinner(true);

  if (options.json) {
    emitJson({ query: opts.query, hits });
    return;
  }

  const out: string[] = [];
  out.push(header('Semantic Search', '🔎'));
  out.push('');
  out.push(keyValue('Query', brand.secondary(opts.query)));
  out.push('');

  if (hits.length === 0) {
    out.push(`  ${statusIcon('info')} ${brand.muted('No matching files found.')}`);
    process.stdout.write(out.join('\n') + '\n');
    return;
  }

  out.push(`  ${brand.muted('Top matches (hybrid keyword + semantic):')}`);
  out.push('');
  for (const hit of hits.slice(0, 15)) {
    out.push(`  ${brand.info.bold(hit.score.toFixed(3))} ${filePath(hit.file)} ${brand.muted(`(fts:${hit.ftsScore} sim:${hit.similarity})`)}`);
  }
  out.push('');
  process.stdout.write(out.join('\n') + '\n');
}
