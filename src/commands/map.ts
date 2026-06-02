import { buildGraph } from '../engines/graph-builder.js';
import { generateHTMLGraph } from '../engines/html-graph-generator.js';
import { generateGraphReport } from '../engines/graph-report-generator.js';
import { resolveFiles } from '../utils/glob-resolver.js';
import { emitJson } from '../utils/json-output.js';
import { header, keyValue, statusIcon, brand, divider } from '../utils/ui.js';
import type { CommandContext } from '../cli.js';

export async function runMap(ctx: CommandContext): Promise<void> {
  const { config, logger, projectRoot, options } = ctx;

  logger.startSpinner('Building dependency graph...');

  const files = await resolveFiles(projectRoot, config.effectiveInclude, config.effectiveSkipSet);
  logger.debug(`Found ${files.length} candidate files`);

  const result = await buildGraph(projectRoot, files, config, logger);

  logger.stopSpinner(true);

  // Generate HTML visualization + report
  const graphData = { schemaVersion: '1.0.0', nodes: Object.fromEntries(result.nodes) };

  logger.startSpinner('Generating report & visualization...');
  const [htmlPath, report] = await Promise.all([
    generateHTMLGraph(projectRoot, graphData),
    generateGraphReport(projectRoot, graphData),
  ]);
  logger.stopSpinner(true);

  if (options.json) {
    emitJson({
      summary: {
        nodes: result.summary.nodes,
        edges: result.summary.edges,
        rebuilt: result.summary.rebuilt,
        skipped: result.summary.skipped,
      },
      report: {
        godNodes: report.godNodes,
        communities: report.communities.length,
        surprisingConnections: report.surprisingConnections.length,
      },
      outputs: {
        graph: '.vibeguard/graph.json',
        html: '.vibeguard/graph.html',
        report: '.vibeguard/GRAPH_REPORT.md',
      },
    });
  } else {
    const output: string[] = [];

    output.push(header('Dependency Graph', '🗺️'));
    output.push('');
    output.push(keyValue('Nodes', brand.info.bold(String(result.summary.nodes))));
    output.push(keyValue('Edges', brand.info.bold(String(result.summary.edges))));
    output.push(keyValue('Rebuilt', brand.secondary(String(result.summary.rebuilt))));
    output.push(keyValue('Skipped', brand.muted(String(result.summary.skipped))));
    output.push('');

    // God nodes summary
    if (report.godNodes.length > 0) {
      output.push(divider());
      output.push('');
      output.push(`  ${brand.primary.bold('🏛️ God Nodes')} ${brand.muted('(highest connectivity)')}`);
      for (const g of report.godNodes.slice(0, 5)) {
        output.push(`    ${brand.info('●')} ${brand.secondary(g.file)} ${brand.muted(`(${g.connections} connections, ${g.role})`)}`);
      }
      output.push('');
    }

    // Communities
    if (report.communities.length > 0) {
      output.push(`  ${brand.primary.bold('🏘️ Communities:')} ${brand.info(String(report.communities.length))} ${brand.muted('file clusters detected')}`);
      output.push('');
    }

    output.push(divider());
    output.push('');
    output.push(`  ${statusIcon('success')} ${brand.success('Generated:')}`);
    output.push(`    ${brand.muted('•')} ${brand.secondary('.vibeguard/graph.json')}       ${brand.muted('Dependency data')}`);
    output.push(`    ${brand.muted('•')} ${brand.secondary('.vibeguard/graph.html')}       ${brand.muted('Interactive visualization')}`);
    output.push(`    ${brand.muted('•')} ${brand.secondary('.vibeguard/GRAPH_REPORT.md')}  ${brand.muted('Architecture report')}`);
    output.push('');
    output.push(`  ${brand.muted('Open graph:')} ${brand.secondary('vibeguard graph')}`);
    output.push('');

    process.stdout.write(output.join('\n') + '\n');
  }
}
