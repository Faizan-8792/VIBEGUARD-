import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { CommandContext } from '../context.js';
import { loadGraph, buildGraph, GRAPH_SCHEMA_VERSION, type GraphData } from '../engines/graph-builder.js';
import { loadImportance } from '../engines/importance-analyzer.js';
import { analyzeChanges, type ReviewItem } from '../engines/change-detector.js';
import { computeTokenSavings } from '../engines/token-savings.js';
import { scanSecurity, type SecurityIssue } from '../engines/security-scanner.js';
import { scanAttacks } from '../engines/attack-scanner.js';
import { resolveFiles } from '../utils/glob-resolver.js';
import { createGitUtils } from '../utils/git-utils.js';
import { emitJson } from '../utils/json-output.js';
import { VibeguardError, ErrorCodes } from '../utils/errors.js';
import { header, keyValue, divider, summaryLine, statusIcon, filePath, brand, box } from '../utils/ui.js';

export interface ReviewCommandOptions {
  base: string;
  depth?: number;
  brief: boolean;
}

export async function runReview(ctx: CommandContext, opts: ReviewCommandOptions): Promise<void> {
  const { config, logger, projectRoot, options } = ctx;

  const git = createGitUtils();
  if (!(await git.isGitRepo(projectRoot))) {
    throw new VibeguardError(
      ErrorCodes.GIT_UNAVAILABLE,
      'Not a git repository. `vibeguard review` needs git to detect changed files.',
    );
  }

  if (!options.json) logger.startSpinner(`Analyzing changes since ${opts.base}...`);

  // Ensure a graph exists.
  let graph: GraphData | null = await loadGraph(projectRoot);
  if (!graph) {
    const files = await resolveFiles(projectRoot, config.effectiveInclude, config.effectiveSkipSet);
    const result = await buildGraph(projectRoot, files, config, logger);
    graph = { schemaVersion: GRAPH_SCHEMA_VERSION, nodes: Object.fromEntries(result.nodes), edges: [] };
  }

  const changedFiles = await git.getChangedFiles(opts.base, projectRoot);
  const importance = (await loadImportance(projectRoot)) ?? {};

  const analysis = analyzeChanges({
    base: opts.base,
    changedFiles,
    graph,
    importance,
    depth: opts.depth,
  });

  // Differentiator: fold security + attack findings on the CHANGED files into
  // the review. No competing graph tool surfaces security in change review.
  let securityOnChanged: SecurityIssue[] = [];
  let attackCountOnChanged = 0;

  if (analysis.changedFiles.length > 0) {
    try {
      const secResult = await scanSecurity(projectRoot, analysis.changedFiles, config);
      securityOnChanged = secResult.issues;
      const attackResult = await scanAttacks(projectRoot, analysis.changedFiles, config);
      attackCountOnChanged = attackResult.findings.length;
    } catch {
      // Security scan is best-effort here; review still proceeds without it.
    }
  }

  // Token-savings estimate: full content of changed files vs this review response.
  let fullContextChars = 0;
  for (const f of analysis.analyzedFiles) {
    try {
      const s = await stat(resolve(projectRoot, f));
      fullContextChars += s.size;
    } catch {
      // skip unreadable
    }
  }

  const responsePayload = { analysis, securityOnChanged, attackCountOnChanged };
  const savings = computeTokenSavings(fullContextChars, responsePayload);

  if (!options.json) logger.stopSpinner(true);

  if (options.json) {
    emitJson({
      base: analysis.base,
      summary: {
        ...analysis.summary,
        securityIssues: securityOnChanged.length,
        attackFindings: attackCountOnChanged,
      },
      reviewItems: analysis.reviewItems,
      securityOnChanged,
      contextSavings: savings,
    });
    return;
  }

  renderReview(analysis.reviewItems, analysis.summary, securityOnChanged, attackCountOnChanged, savings, opts);
}

function renderReview(
  items: ReviewItem[],
  summary: { changed: number; totalBlastRadius: number; highRisk: number; testGaps: number },
  security: SecurityIssue[],
  attackCount: number,
  savings: ReturnType<typeof computeTokenSavings>,
  opts: ReviewCommandOptions,
): void {
  const output: string[] = [];
  output.push(header('Change Review', '🔎'));
  output.push('');
  output.push(keyValue('Base', brand.secondary(opts.base)));
  output.push(summaryLine([
    { label: 'Changed', value: summary.changed, color: 'info' },
    { label: 'High risk', value: summary.highRisk, color: summary.highRisk > 0 ? 'danger' : 'muted' },
    { label: 'Test gaps', value: summary.testGaps, color: summary.testGaps > 0 ? 'warning' : 'muted' },
    { label: 'Security', value: security.length, color: security.length > 0 ? 'danger' : 'muted' },
    { label: 'Attacks', value: attackCount, color: attackCount > 0 ? 'danger' : 'muted' },
  ]));
  output.push('');

  if (items.length === 0) {
    output.push(`  ${statusIcon('success')} ${brand.success('No graph-tracked files changed. Nothing to review.')}`);
    process.stdout.write(output.join('\n') + '\n');
    return;
  }

  output.push(divider());
  output.push('');
  output.push(`  ${brand.primary.bold('Risk-ranked changes:')}`);
  output.push('');

  for (const item of items.slice(0, 20)) {
    const riskColor = item.risk >= 60 ? 'danger' : item.risk >= 30 ? 'warning' : 'success';
    output.push(`  ${brand[riskColor].bold(`[risk ${item.risk}]`)} ${filePath(item.file)}`);
    output.push(`    ${brand.muted(item.reasons.join(' · '))}`);
  }
  if (items.length > 20) {
    output.push(`  ${brand.muted(`... and ${items.length - 20} more`)}`);
  }
  output.push('');

  // Security findings on changed files — the unique differentiator.
  if (security.length > 0) {
    output.push(divider());
    output.push('');
    output.push(`  ${brand.danger.bold('🔒 Security issues in changed files:')}`);
    for (const issue of security.slice(0, 10)) {
      output.push(`    ${brand.danger(issue.severity.toUpperCase())} ${filePath(issue.file)}${brand.muted(':' + issue.line)} — ${issue.message}`);
    }
    output.push('');
  }

  // Token Savings panel.
  const panel = [
    `Full context would be:   ${savings.fullContextTokens.toLocaleString()} tokens`,
    `Graph review used:       ${savings.graphContextTokens.toLocaleString()} tokens`,
    `Saved:                   ${savings.savedTokens.toLocaleString()} tokens (~${savings.savedPercent}%)`,
    `(estimated)`,
  ].join('\n');
  output.push(box(panel, { width: 60 }));
  output.push('');

  process.stdout.write(output.join('\n') + '\n');
}
