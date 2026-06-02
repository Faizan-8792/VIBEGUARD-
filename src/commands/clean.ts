import { scanDeadCode, type DeadCodeCandidate } from '../engines/dead-code-scanner.js';
import { loadGraph } from '../engines/graph-builder.js';
import { loadImportance } from '../engines/importance-analyzer.js';
import { FileStoreImpl } from '../storage/file-store.js';
import { TrashStoreImpl } from '../storage/trash-store.js';
import { SafetyContext } from '../utils/safety.js';
import { createGitUtils } from '../utils/git-utils.js';
import { VibeguardError, ErrorCodes } from '../utils/errors.js';
import { emitJson } from '../utils/json-output.js';
import { header, divider, summaryLine, statusIcon, filePath, brand } from '../utils/ui.js';
import type { CommandContext } from '../context.js';

export interface CleanCommandOptions {
  plan: boolean;
  apply: boolean;
  interactive: boolean;
  dryRun: boolean;
  gitSafe: boolean;
  force: boolean;
}

interface CleanupPlan {
  schemaVersion: string;
  createdAt: string;
  candidates: DeadCodeCandidate[];
}

type DeadCodeScanResult = Awaited<ReturnType<typeof scanDeadCode>>;

const MAX_LISTED_CANDIDATES = 20;

function candidateIcon(kind: DeadCodeCandidate['kind']): string {
  if (kind === 'file') return '📄';
  if (kind === 'export') return '📤';
  return '📥';
}

function importanceColor(importance: number): 'success' | 'warning' | 'danger' {
  if (importance <= 2) return 'success';
  if (importance <= 5) return 'warning';
  return 'danger';
}

function renderPlanOutput(result: DeadCodeScanResult): string {
  const output: string[] = [header('Dead Code Analysis', '🧹'), ''];

  if (result.warning) {
    output.push(`  ${statusIcon('warning')} ${brand.warning(result.warning)}`, '');
    return output.join('\n');
  }

  output.push(summaryLine([
    { label: 'Unused Files', value: result.summary.unusedFiles, color: result.summary.unusedFiles > 0 ? 'warning' : 'success' },
    { label: 'Unused Exports', value: result.summary.unusedExports, color: result.summary.unusedExports > 0 ? 'warning' : 'success' },
    { label: 'Duplicates', value: result.summary.duplicateComponents, color: 'muted' },
  ]));
  output.push('');

  if (result.candidates.length > 0) {
    output.push(divider(), '', `  ${brand.muted.bold('Candidates (sorted by importance):')}`, '');

    for (const c of result.candidates.slice(0, MAX_LISTED_CANDIDATES)) {
      output.push(`  ${candidateIcon(c.kind)} ${filePath(c.path)} ${brand[importanceColor(c.importance)](`imp:${c.importance}`)}`);
    }

    if (result.candidates.length > MAX_LISTED_CANDIDATES) {
      output.push(`  ${brand.muted(`  ... and ${result.candidates.length - MAX_LISTED_CANDIDATES} more`)}`);
    }
    output.push('');
  }

  output.push(`  ${statusIcon('success')} ${brand.success('Plan saved to')} ${brand.muted('.vibeguard/cleanup-plan.json')}`);
  output.push(`  ${brand.muted('Run with --apply to move dead files to trash')}`);
  output.push('');

  return output.join('\n');
}

export async function runClean(ctx: CommandContext, opts: CleanCommandOptions): Promise<void> {
  const { config, logger, projectRoot, options } = ctx;

  // Load graph
  const graphData = await loadGraph(projectRoot);
  if (!graphData) {
    throw new VibeguardError(
      ErrorCodes.CONFIG_NOT_FOUND,
      'No graph found. Run `vibeguard map` first.',
    );
  }

  // Load importance
  const importanceScores = await loadImportance(projectRoot) ?? {};

  const graphNodes = new Map(Object.entries(graphData.nodes));

  if (opts.plan || !opts.apply) {
    // Generate plan
    logger.startSpinner('Scanning for dead code...');

    const result = await scanDeadCode(projectRoot, graphNodes, importanceScores);

    logger.stopSpinner(true);

    // Sort by ascending importance
    result.candidates.sort((a, b) => a.importance - b.importance);

    // Write cleanup plan
    const fileStore = new FileStoreImpl(projectRoot);
    const plan: CleanupPlan = {
      schemaVersion: '1.0.0',
      createdAt: new Date().toISOString(),
      candidates: result.candidates,
    };
    await fileStore.write('cleanup-plan.json', plan);

    if (options.json) {
      emitJson({
        candidates: result.candidates,
        summary: result.summary,
        ...(result.warning ? { warning: result.warning } : {}),
      });
    } else {
      process.stdout.write(renderPlanOutput(result) + '\n');
    }
    return;
  }

  if (opts.apply) {
    // Load existing plan
    const fileStore = new FileStoreImpl(projectRoot);
    const plan = await fileStore.read<CleanupPlan>('cleanup-plan.json');

    if (!plan) {
      throw new VibeguardError(
        ErrorCodes.CONFIG_NOT_FOUND,
        'No cleanup plan found. Run `vibeguard clean --plan` first.',
      );
    }

    const fileCandidates = plan.candidates.filter((c: DeadCodeCandidate) => c.kind === 'file');

    // Enforce limits
    if (fileCandidates.length > config.clean.maxChangesPerRun && !opts.force) {
      throw new VibeguardError(
        ErrorCodes.LIMIT_EXCEEDED,
        `Cleanup plan has ${fileCandidates.length} file candidates, exceeding limit of ${config.clean.maxChangesPerRun}. Use --force to override.`,
        { count: fileCandidates.length, limit: config.clean.maxChangesPerRun }
      );
    }

    const safety = new SafetyContext({
      dryRun: opts.dryRun,
      gitSafe: opts.gitSafe,
      force: opts.force,
      projectRoot,
    });

    const gitUtils = opts.gitSafe ? createGitUtils() : null;

    if (gitUtils) {
      await safety.enforceGitSafe(gitUtils, 'clean');
    }

    if (opts.dryRun) {
      logger.info(`[dry-run] Would move ${fileCandidates.length} files to trash:`);
      for (const candidate of fileCandidates) {
        logger.info(`  ${candidate.path} (importance: ${candidate.importance})`);
      }

      if (options.json) {
        emitJson({
          dryRun: true,
          plannedChanges: fileCandidates.map((c: DeadCodeCandidate) => ({
            type: 'move',
            path: c.path,
            target: `.vibeguard-trash/`,
          })),
        });
      }
      return;
    }

    // Apply: move files to trash
    const trashStore = new TrashStoreImpl(projectRoot);
    let movedCount = 0;

    logger.startSpinner(`Moving ${fileCandidates.length} files to trash...`);
    for (const candidate of fileCandidates) {
      try {
        // trashStore.move expects a path RELATIVE to projectRoot
        await trashStore.move(candidate.path, {
          originalPath: candidate.path,
          importance: candidate.importance,
          lastCommitDate: candidate.lastCommitDate,
          kind: candidate.kind,
        });
        movedCount++;
        logger.updateSpinner(`Moving files to trash... (${movedCount}/${fileCandidates.length})`);
        logger.debug(`Moved to trash: ${candidate.path}`);
      } catch (err) {
        logger.warn(`Failed to move ${candidate.path}: ${err instanceof Error ? err.message : 'unknown error'}`);
      }
    }
    logger.stopSpinner(true);

    if (gitUtils) {
      await safety.commitGitSafe(gitUtils, 'clean');
    }

    if (options.json) {
      emitJson({
        applied: true,
        movedFiles: movedCount,
        totalCandidates: fileCandidates.length,
      });
    } else {
      logger.info(`Moved ${movedCount} files to .vibeguard-trash/`);
    }
  }
}
