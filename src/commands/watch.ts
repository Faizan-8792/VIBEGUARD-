import { watch } from 'node:fs';
import { relative } from 'node:path';
import picomatch from 'picomatch';
import type { CommandContext } from '../context.js';
import { buildGraph } from '../engines/graph-builder.js';
import { computeTags } from '../engines/tagging-engine.js';
import { computeImportance } from '../engines/importance-analyzer.js';
import { resolveFiles } from '../utils/glob-resolver.js';
import { detectLanguage } from '../engines/polyglot-parser.js';
import { header, statusIcon, brand } from '../utils/ui.js';

export interface WatchCommandOptions {
  debounce?: number;
}

/**
 * Watch the project for file changes and incrementally rebuild the graph,
 * tags, and importance scores. Code changes rebuild instantly; doc changes
 * (markdown) trigger a notify-style rebuild too but are flagged separately.
 */
export async function runWatch(ctx: CommandContext, opts: WatchCommandOptions): Promise<void> {
  const { projectRoot, config, logger } = ctx;
  const debounceMs = opts.debounce ?? 400;

  const isSkipped = picomatch(config.effectiveSkipSet);
  const isIncluded = picomatch(config.effectiveInclude);

  process.stdout.write(header('VibeGuard Watch', '👁️') + '\n');
  process.stdout.write(`\n  ${statusIcon('success')} ${brand.success('Watching for changes...')} ${brand.muted('(Ctrl+C to stop)')}\n`);
  process.stdout.write(`  ${brand.muted('Project:')} ${brand.secondary(projectRoot)}\n\n`);

  // Initial build so the graph is fresh on startup
  await rebuild(ctx, 'initial');

  let pending: NodeJS.Timeout | null = null;
  let rebuilding = false;
  const changedFiles = new Set<string>();

  const scheduleRebuild = (): void => {
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      void runScheduledRebuild();
    }, debounceMs);
  };

  const runScheduledRebuild = async (): Promise<void> => {
    pending = null;
    // Avoid overlapping rebuilds that would interleave writes to graph.json.
    // If a rebuild is already running, leave the changed files queued and
    // reschedule; the in-flight rebuild's completion will pick them up.
    if (rebuilding) {
      scheduleRebuild();
      return;
    }

    const files = [...changedFiles];
    changedFiles.clear();
    if (files.length === 0) return;

    const kind = classifyChangeKind(files);

    rebuilding = true;
    try {
      await rebuild(ctx, kind, files);
    } finally {
      rebuilding = false;
    }

    // If new changes arrived while rebuilding, process them now.
    if (changedFiles.size > 0) scheduleRebuild();
  };

  // Recursive watch is supported on Windows and macOS, and on Linux with
  // Node 20+. If the platform/runtime doesn't support it, fail gracefully.
  try {
    watch(projectRoot, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const rel = relative(projectRoot, filename).replace(/\\/g, '/');
      if (isSkipped(rel)) return;
      if (!isIncluded(rel)) return;
      changedFiles.add(rel);
      scheduleRebuild();
    });
  } catch (err) {
    logger.error(`Failed to start watcher: ${err instanceof Error ? err.message : String(err)}`);
    logger.error('Recursive file watching may be unavailable on this platform/Node version. Use `vibeguard map` manually instead.');
    return;
  }

  // Keep the process alive
  await new Promise<void>(() => {
    /* runs until interrupted */
  });
}

async function rebuild(ctx: CommandContext, kind: string, changed?: string[]): Promise<void> {
  const { projectRoot, config, logger } = ctx;
  const start = Date.now();

  try {
    const files = await resolveFiles(projectRoot, config.effectiveInclude, config.effectiveSkipSet);
    const result = await buildGraph(projectRoot, files, config, logger);

    // Incremental tag + importance refresh (reuses the freshly built nodes)
    await computeTags(projectRoot, result.nodes, config);
    await computeImportance(projectRoot, result.nodes, config);

    const elapsed = Date.now() - start;
    const label = changed && changed.length > 0
      ? `${changed.length} file(s) [${kind}]`
      : kind;
    const time = new Date().toLocaleTimeString();
    const { added, removed } = result.summary;
    const deltaParts: string[] = [];
    if (added.length > 0) deltaParts.push(brand.success(`+${added.length} added`));
    if (removed.length > 0) deltaParts.push(brand.danger(`-${removed.length} removed`));
    const delta = deltaParts.length > 0 ? ` ${brand.muted('•')} ${deltaParts.join(' ')}` : '';
    process.stdout.write(
      `  ${brand.muted(time)} ${statusIcon('success')} ${brand.success('Rebuilt')} ${brand.muted(label)} ` +
      `${brand.info(`${result.summary.nodes} nodes, ${result.summary.edges} edges`)}${delta} ${brand.muted(`(${elapsed}ms)`)}\n`,
    );
  } catch (err) {
    process.stdout.write(`  ${statusIcon('error')} ${brand.danger('Rebuild failed:')} ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

/**
 * Classify a batch of changed files into a human-readable rebuild label
 * based on whether it contains source code, documentation, or both.
 */
function classifyChangeKind(files: string[]): string {
  let hasCode = false;
  let hasDocs = false;

  for (const file of files) {
    const lang = detectLanguage(file);
    if (lang === 'markdown') hasDocs = true;
    else if (lang !== 'unknown') hasCode = true;
  }

  if (hasCode && hasDocs) return 'code + docs';
  if (hasDocs) return 'docs';
  if (hasCode) return 'code';
  return 'change';
}
