import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadGraph, buildGraph } from '../engines/graph-builder.js';
import { loadTags, computeTags } from '../engines/tagging-engine.js';
import { loadImportance, computeImportance } from '../engines/importance-analyzer.js';
import { selectContext, type PackMode } from '../engines/context-radius-engine.js';
import { generateContextPackage } from '../engines/context-package-generator.js';
import { estimateCost } from '../engines/cost-estimator.js';
import { resolveFiles } from '../utils/glob-resolver.js';
import { VibeguardError, ErrorCodes } from '../utils/errors.js';
import { emitJson } from '../utils/json-output.js';
import { header, keyValue, divider, statusIcon, filePath, brand } from '../utils/ui.js';
import type { CommandContext } from '../context.js';

export interface PackCommandOptions {
  task: string;
  taskFile?: string;
  radius?: number;
  budget?: number;
  mode?: string;
}

export async function runPack(ctx: CommandContext, opts: PackCommandOptions): Promise<void> {
  const { config, logger, projectRoot, options } = ctx;

  // Resolve task text
  let task = opts.task;
  if (opts.taskFile) {
    try {
      task = await readFile(join(projectRoot, opts.taskFile), 'utf-8');
    } catch {
      throw new VibeguardError(
        ErrorCodes.CONFIG_NOT_FOUND,
        `Task file not found: ${opts.taskFile}`,
      );
    }
  }

  if (!task || task.trim().length === 0) {
    throw new VibeguardError(
      ErrorCodes.CONFIG_INVALID,
      'No task provided. Use `vibeguard pack "task description"` or `--task-file <path>`.',
    );
  }

  logger.startSpinner('Generating context package...');

  // Ensure graph exists
  let graphData = await loadGraph(projectRoot);
  if (!graphData) {
    logger.debug('No graph found, building...');
    const files = await resolveFiles(projectRoot, config.effectiveInclude, config.effectiveSkipSet);
    const result = await buildGraph(projectRoot, files, config, logger);
    graphData = {
      schemaVersion: '1.0.0',
      nodes: Object.fromEntries(result.nodes),
    };
  }

  const graphNodes = new Map(Object.entries(graphData.nodes));

  // Ensure tags exist
  let tags = await loadTags(projectRoot);
  if (!tags) {
    logger.debug('No tags found, computing...');
    tags = await computeTags(projectRoot, graphNodes, config);
  }

  // Ensure importance exists
  let importanceScores = await loadImportance(projectRoot);
  if (!importanceScores) {
    logger.debug('No importance scores found, computing...');
    importanceScores = await computeImportance(projectRoot, graphNodes, config);
  }

  // Select context
  const mode = opts.mode as PackMode | undefined;
  const selectionResult = await selectContext(
    projectRoot,
    task,
    graphNodes,
    tags,
    importanceScores,
    config,
    {
      radius: opts.radius,
      budget: opts.budget,
      mode,
    },
  );

  // Compute total project tokens for reduction percentage
  const allFiles = Object.keys(graphData.nodes);
  const totalEstimate = await estimateCost(allFiles, projectRoot, config);

  // Generate package
  const pkg = await generateContextPackage(
    task,
    selectionResult.selectedFiles,
    selectionResult.tokenEstimates,
    totalEstimate.tokens,
    projectRoot,
    graphData,
  );

  logger.stopSpinner(true);

  if (options.json) {
    emitJson({
      selectedFiles: selectionResult.selectedFiles,
      tokenEstimates: selectionResult.tokenEstimates,
      costEstimates: selectionResult.costEstimates,
      packagePaths: {
        md: '.vibeguard/context-package.md',
        json: '.vibeguard/context-package.json',
      },
      warnings: pkg.warnings,
    });
  } else {
    const output: string[] = [];

    output.push(header('Context Package', '📦'));
    output.push('');
    output.push(keyValue('Task', brand.secondary(`"${task.slice(0, 60)}${task.length > 60 ? '...' : ''}"`)));
    output.push(keyValue('Selected Files', brand.info.bold(String(selectionResult.selectedFiles.length))));
    output.push(keyValue('Token Estimate', brand.info.bold(String(selectionResult.tokenEstimates.tokens))));
    output.push(keyValue('Reduction', brand.success.bold(`${pkg.tokenBudget.reductionPercent}%`) + brand.muted(' vs full project')));
    output.push('');

    if (selectionResult.selectedFiles.length > 0) {
      output.push(divider());
      output.push('');
      output.push(`  ${brand.muted.bold('Selected files:')}`);
      output.push('');
      for (const file of selectionResult.selectedFiles.slice(0, 15)) {
        const roleTag = file.role === 'seed' ? brand.primary(' seed') : brand.muted(` hop-${file.hopDistance}`);
        output.push(`  ${statusIcon('info')} ${filePath(file.path)}${roleTag}`);
      }
      if (selectionResult.selectedFiles.length > 15) {
        output.push(`  ${brand.muted(`  ... and ${selectionResult.selectedFiles.length - 15} more`)}`);
      }
      output.push('');
    }

    if (pkg.warnings.length > 0) {
      for (const w of pkg.warnings) {
        output.push(`  ${statusIcon('warning')} ${brand.warning(w)}`);
      }
      output.push('');
    }

    output.push(`  ${statusIcon('success')} ${brand.success('Saved to')} ${brand.muted('.vibeguard/context-package.md')}`);
    output.push('');

    process.stdout.write(output.join('\n') + '\n');
  }
}
