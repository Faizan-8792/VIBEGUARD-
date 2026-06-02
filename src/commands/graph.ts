import type { CommandContext } from '../context.js';
import { loadGraph, buildGraph } from '../engines/graph-builder.js';
import { generateHTMLGraph } from '../engines/html-graph-generator.js';
import { resolveFiles } from '../utils/glob-resolver.js';
import { emitJson } from '../utils/json-output.js';
import { statusIcon, brand } from '../utils/ui.js';

export interface GraphCommandOptions {
  open: boolean;
}

export async function runGraph(ctx: CommandContext, opts: GraphCommandOptions): Promise<void> {
  let graphData = await loadGraph(ctx.projectRoot);
  if (!graphData) {
    ctx.logger.startSpinner('Building dependency graph...');
    const files = await resolveFiles(ctx.projectRoot, ctx.config.effectiveInclude, ctx.config.effectiveSkipSet);
    const result = await buildGraph(ctx.projectRoot, files, ctx.config, ctx.logger);
    graphData = { schemaVersion: '1.0.0', nodes: Object.fromEntries(result.nodes) };
    ctx.logger.stopSpinner(true);
  }

  ctx.logger.startSpinner('Generating interactive graph...');
  const htmlPath = await generateHTMLGraph(ctx.projectRoot, graphData);
  ctx.logger.stopSpinner(true);

  if (ctx.options.json) {
    emitJson({ path: htmlPath, nodes: Object.keys(graphData.nodes).length });
  } else {
    process.stdout.write(`\n  ${statusIcon('success')} ${brand.success('Interactive graph generated!')}\n`);
    process.stdout.write(`  ${brand.muted('Open in browser:')} ${brand.secondary(htmlPath.replace(ctx.projectRoot, '.').replace(/\\/g, '/'))}\n\n`);

    if (opts.open) {
      const { exec } = await import('node:child_process');
      const cmd = process.platform === 'win32'
        ? `start "" "${htmlPath}"`
        : process.platform === 'darwin'
          ? `open "${htmlPath}"`
          : `xdg-open "${htmlPath}"`;
      exec(cmd);
    }
  }
}
