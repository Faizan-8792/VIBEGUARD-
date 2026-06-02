import { scanAttacks, type AttackFinding } from '../engines/attack-scanner.js';
import { scanSecurity } from '../engines/security-scanner.js';
import { resolveFiles } from '../utils/glob-resolver.js';
import { CredentialsStore, type LLMCredentials } from '../storage/credentials-store.js';
import { emitJson } from '../utils/json-output.js';
import { header, severityBadge, filePath, divider, summaryLine, statusIcon, brand } from '../utils/ui.js';
import { VibeguardError, ErrorCodes } from '../utils/errors.js';
import type { AIAdvisorResult } from '../engines/ai-security-advisor.js';
import type { FileFixPlan } from '../engines/ai-fixer.js';
import type { CommandContext } from '../context.js';

export interface AttackCommandOptions {
  ai: boolean;
  fix: boolean;
  dryRun: boolean;
  budget?: number;
}

type AttackScanResult = Awaited<ReturnType<typeof scanAttacks>>;
type SecurityScanResult = Awaited<ReturnType<typeof scanSecurity>>;
type FixSummary = { applied: number; backupDir: string };

/** Default token ceiling for a single AI advisor pass. */
const AI_ADVISOR_MAX_TOKENS = 1500;
/** Cap on files sent to the AI fixer per run to keep context budget-friendly. */
const AI_FIX_MAX_FILES = 8;

export async function runAttack(ctx: CommandContext, opts: AttackCommandOptions): Promise<void> {
  const { config, logger, projectRoot, options } = ctx;

  logger.startSpinner('Scanning for cyberattack vulnerabilities...');
  const files = await resolveFiles(projectRoot, config.effectiveInclude, config.effectiveSkipSet);
  const attackResult = await scanAttacks(projectRoot, files, config);
  const securityResult = await scanSecurity(projectRoot, files, config);
  logger.stopSpinner(true);

  if (options.json) {
    await emitAttackJson(ctx, opts, attackResult, securityResult);
  } else {
    await renderAttackTerminal(ctx, opts, attackResult, securityResult);
  }
}

// ─── JSON mode ───────────────────────────────────────────────────────────
// Run everything silently (failures degrade to null) then emit one document.

async function emitAttackJson(
  ctx: CommandContext,
  opts: AttackCommandOptions,
  attackResult: AttackScanResult,
  securityResult: SecurityScanResult,
): Promise<void> {
  const { projectRoot } = ctx;
  let aiResult: AIAdvisorResult | null = null;
  let fixSummary: FixSummary | null = null;

  if (opts.ai) {
    const credentials = await resolveCredentials(projectRoot);

    try {
      aiResult = await runAdvisor(projectRoot, credentials, attackResult, securityResult, opts.budget);
    } catch {
      // leave aiResult null
    }

    if (opts.fix && aiResult && !opts.dryRun) {
      try {
        const changed = await generateChangedFixPlans(projectRoot, credentials, attackResult, securityResult);
        if (changed.length > 0) {
          fixSummary = await applyFixPlans(projectRoot, changed);
        }
      } catch {
        // ignore fix errors in json mode
      }
    }
  }

  emitJson({
    findings: attackResult.findings,
    counts: attackResult.counts,
    coverage: attackResult.coverage,
    ai: aiResult,
    fix: fixSummary,
  });
}

// ─── Terminal mode ─────────────────────────────────────────────────────────
// Print local findings first, then (optionally) the AI deep scan and fixes.

async function renderAttackTerminal(
  ctx: CommandContext,
  opts: AttackCommandOptions,
  attackResult: AttackScanResult,
  securityResult: SecurityScanResult,
): Promise<void> {
  const { logger, projectRoot } = ctx;

  printLocalFindings(attackResult, opts);
  if (!opts.ai) return;

  const credentials = await resolveCredentials(projectRoot);

  logger.startSpinner(`Running AI deep scan (${credentials.model})...`);
  let aiResult: AIAdvisorResult;
  try {
    aiResult = await runAdvisor(projectRoot, credentials, attackResult, securityResult, opts.budget);
    logger.stopSpinner(true);
  } catch (err) {
    logger.stopSpinner(false);
    logger.warn(`AI scan failed: ${errorMessage(err)}`);
    return;
  }

  printAISection(aiResult);

  if (opts.fix) {
    await applyTerminalFixes(ctx, opts, credentials, attackResult, securityResult);
  }
}

async function applyTerminalFixes(
  ctx: CommandContext,
  opts: AttackCommandOptions,
  credentials: LLMCredentials,
  attackResult: AttackScanResult,
  securityResult: SecurityScanResult,
): Promise<void> {
  const { logger, projectRoot } = ctx;

  logger.startSpinner('Generating AI fixes...');
  try {
    const changed = await generateChangedFixPlans(projectRoot, credentials, attackResult, securityResult);
    logger.stopSpinner(true);

    if (changed.length === 0) {
      process.stdout.write(`\n  ${statusIcon('info')} ${brand.muted('No automated fixes could be generated.')}\n\n`);
    } else if (opts.dryRun) {
      const out: string[] = ['', `  ${brand.primary.bold('Proposed Fixes (dry-run)')}`, ''];
      for (const p of changed) {
        out.push(`  ${statusIcon('success')} ${filePath(p.file)} ${brand.muted('— ' + p.explanation)}`);
      }
      out.push('');
      process.stdout.write(out.join('\n') + '\n');
    } else {
      const { applied, backupDir } = await applyFixPlans(projectRoot, changed);
      const relBackup = backupDir.replace(projectRoot, '').replace(/^[/\\]/, '');
      process.stdout.write(`\n  ${statusIcon('success')} ${brand.success.bold(`Applied AI fixes to ${applied} file(s)!`)}\n`);
      process.stdout.write(`  ${brand.muted('Originals backed up to:')} ${brand.secondary(relBackup)}\n`);
      process.stdout.write(`  ${brand.muted('Re-run')} ${brand.secondary('vibeguard attack')} ${brand.muted('to verify.')}\n\n`);
    }
  } catch (err) {
    logger.stopSpinner(false);
    logger.warn(`AI fix failed: ${errorMessage(err)}`);
  }
}

// ─── Shared AI helpers ───────────────────────────────────────────────────────

async function resolveCredentials(projectRoot: string): Promise<LLMCredentials> {
  const credentials = await new CredentialsStore(projectRoot).resolve();
  if (!credentials) {
    throw new VibeguardError(
      ErrorCodes.CONFIG_NOT_FOUND,
      'No LLM API key configured. Run `vibeguard config set-key <key>` first, or set VIBEGUARD_API_KEY.',
    );
  }
  return credentials;
}

async function runAdvisor(
  projectRoot: string,
  credentials: LLMCredentials,
  attackResult: AttackScanResult,
  securityResult: SecurityScanResult,
  budget: number | undefined,
): Promise<AIAdvisorResult> {
  const { runAIAdvisor } = await import('../engines/ai-security-advisor.js');
  return runAIAdvisor(projectRoot, credentials, attackResult.findings, securityResult.issues, {
    maxTokens: budget ?? AI_ADVISOR_MAX_TOKENS,
  });
}

async function generateChangedFixPlans(
  projectRoot: string,
  credentials: LLMCredentials,
  attackResult: AttackScanResult,
  securityResult: SecurityScanResult,
): Promise<FileFixPlan[]> {
  const { generateFixes } = await import('../engines/ai-fixer.js');
  const plans = await generateFixes(projectRoot, credentials, attackResult.findings, securityResult.issues, {
    maxFiles: AI_FIX_MAX_FILES,
  });
  return plans.filter((p) => p.changed);
}

async function applyFixPlans(projectRoot: string, plans: FileFixPlan[]): Promise<FixSummary> {
  const { applyFixes } = await import('../engines/ai-fixer.js');
  return applyFixes(projectRoot, plans);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown error';
}

// ─── Terminal rendering ──────────────────────────────────────────────────────

function printLocalFindings(attackResult: AttackScanResult, opts: AttackCommandOptions): void {
  const output: string[] = [];
  output.push(header('Cyberattack Proof Scan', '🛡️'));
  output.push('');
  output.push(`  ${brand.muted('Scanned for:')} ${brand.secondary(attackResult.coverage.length + ' attack types')}`);
  output.push('');

  if (attackResult.findings.length === 0) {
    output.push(`  ${statusIcon('success')} ${brand.success.bold('No attack vectors detected in local scan!')}`);
  } else {
    output.push(summaryLine([
      { label: 'Critical', value: attackResult.counts.critical, color: attackResult.counts.critical > 0 ? 'danger' : 'muted' },
      { label: 'High', value: attackResult.counts.high, color: attackResult.counts.high > 0 ? 'warning' : 'muted' },
      { label: 'Medium', value: attackResult.counts.medium, color: 'muted' },
      { label: 'Low', value: attackResult.counts.low, color: 'muted' },
    ]));
    output.push('');
    output.push(divider());
    output.push('');

    const byType = new Map<string, AttackFinding[]>();
    for (const f of attackResult.findings) {
      if (!byType.has(f.attackType)) byType.set(f.attackType, []);
      byType.get(f.attackType)!.push(f);
    }

    for (const [attackType, findings] of byType) {
      const worst = findings.reduce((w, f) => (rankSev(f.severity) < rankSev(w.severity) ? f : w), findings[0]);
      output.push(`  ${severityBadge(worst.severity)} ${brand.primary.bold(attackType)} ${brand.muted(`(${findings.length})`)}`);
      for (const f of findings.slice(0, 3)) {
        output.push(`    ${filePath(f.file)}${brand.muted(':' + f.line)}`);
      }
      if (findings.length > 3) {
        output.push(`    ${brand.muted(`... and ${findings.length - 3} more`)}`);
      }
      output.push(`    ${statusIcon('info')} ${brand.secondary(worst.recommendation)}`);
      output.push('');
    }
  }

  if (!opts.ai && attackResult.findings.length > 0) {
    output.push(divider());
    output.push('');
    output.push(`  ${brand.info('💡 For a stronger AI-powered scan + auto-fix:')}`);
    output.push(`     ${brand.secondary('vibeguard config set-key <api-key>')}  ${brand.muted('Configure an LLM provider')}`);
    output.push(`     ${brand.secondary('vibeguard attack --ai --fix')}          ${brand.muted('Deep scan and fix')}`);
    output.push('');
  }

  process.stdout.write(output.join('\n') + '\n');
}

function printAISection(aiResult: AIAdvisorResult): void {
  const output: string[] = [];
  output.push('');
  output.push(divider());
  output.push('');
  output.push(`  ${brand.primary.bold('🤖 AI Deep Scan')} ${brand.muted(`(${aiResult.model}, ${aiResult.tokensUsed} tokens)`)}`);
  output.push('');
  output.push(`  ${aiResult.summary}`);
  output.push('');

  if (aiResult.additionalFindings.length > 0) {
    output.push(`  ${brand.muted.bold('Additional findings:')}`);
    for (const f of aiResult.additionalFindings) {
      output.push(`  ${severityBadge(f.severity)} ${brand.primary(f.attackType)} ${brand.muted('@ ' + f.file)}`);
      output.push(`    ${f.description}`);
      output.push(`    ${statusIcon('success')} ${brand.success('Fix:')} ${brand.secondary(f.fix)}`);
      output.push('');
    }
  }

  if (aiResult.prioritizedFixes.length > 0) {
    output.push(`  ${brand.muted.bold('Prioritized remediation:')}`);
    aiResult.prioritizedFixes.forEach((fix, i) => {
      output.push(`    ${brand.info(`${i + 1}.`)} ${fix}`);
    });
    output.push('');
  }

  process.stdout.write(output.join('\n') + '\n');
}

function rankSev(s: string): number {
  const order: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  return order[s] ?? 5;
}
