import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scanSecurity } from '../engines/security-scanner.js';
import { resolveFiles } from '../utils/glob-resolver.js';
import { SafetyContext } from '../utils/safety.js';
import { createGitUtils } from '../utils/git-utils.js';
import { VibeguardError, ErrorCodes } from '../utils/errors.js';
import { emitJson } from '../utils/json-output.js';
import { header, severityBadge, filePath, divider, summaryLine, statusIcon, brand } from '../utils/ui.js';
import type { CommandContext } from '../context.js';

export interface SecurityCommandOptions {
  fix?: string;
  dryRun: boolean;
  gitSafe: boolean;
  force: boolean;
}

export async function runSecurity(ctx: CommandContext, opts: SecurityCommandOptions): Promise<void> {
  const { config, logger, projectRoot, options } = ctx;

  logger.startSpinner('Scanning for security issues...');

  const files = await resolveFiles(projectRoot, config.effectiveInclude, config.effectiveSkipSet);
  const result = await scanSecurity(projectRoot, files, config, (current, total) => {
    logger.progress(current, total, 'scanning files...');
  });

  logger.stopSpinner(true);

  // Handle --fix modes
  if (opts.fix) {
    const safety = new SafetyContext({
      dryRun: opts.dryRun,
      gitSafe: opts.gitSafe,
      force: opts.force,
      projectRoot,
    });

    const gitUtils = opts.gitSafe ? createGitUtils() : null;

    if (gitUtils) {
      await safety.enforceGitSafe(gitUtils, 'security');
    }

    if (opts.fix === 'gitignore') {
      await fixGitignore(projectRoot, safety, logger);
    } else if (opts.fix === 'env') {
      const secretIssues = result.issues.filter((i) => i.category === 'hard-coded-secret');
      const affectedFiles = new Set(secretIssues.map((i) => i.file));

      if (affectedFiles.size > 25 && !opts.force) {
        throw new VibeguardError(
          ErrorCodes.LIMIT_EXCEEDED,
          `--fix=env would modify ${affectedFiles.size} files (limit: 25). Use --force to override.`,
          { count: affectedFiles.size, limit: 25 }
        );
      }

      if (!opts.dryRun) {
        await fixEnvSecrets(projectRoot, secretIssues, logger);
      } else {
        logger.info(`[dry-run] Would move ${secretIssues.length} secrets to .env from ${affectedFiles.size} files`);
      }
    }

    if (gitUtils && !opts.dryRun) {
      await safety.commitGitSafe(gitUtils, 'security');
    }
  }

  // Output results
  if (options.json) {
    emitJson({
      issues: result.issues,
      counts: result.counts,
    });
  } else {
    const output: string[] = [];

    output.push(header('Security Scan', '🔒'));
    output.push('');

    if (result.issues.length === 0) {
      output.push(`  ${statusIcon('success')} ${brand.success.bold('No security issues found')}`);
    } else {
      // Summary badges
      output.push(summaryLine([
        { label: 'Critical', value: result.counts.critical, color: result.counts.critical > 0 ? 'danger' : 'muted' },
        { label: 'High', value: result.counts.high, color: result.counts.high > 0 ? 'warning' : 'muted' },
        { label: 'Medium', value: result.counts.medium, color: 'muted' },
        { label: 'Low', value: result.counts.low, color: 'muted' },
        { label: 'Info', value: result.counts.info, color: 'muted' },
      ]));
      output.push('');
      output.push(divider());
      output.push('');

      // Issue list (max 25)
      const displayIssues = result.issues.slice(0, 25);
      for (const issue of displayIssues) {
        output.push(`  ${severityBadge(issue.severity)} ${brand.muted(issue.id)}`);
        output.push(`    ${filePath(issue.file)}${brand.muted(':' + issue.line)}`);
        output.push(`    ${issue.message}`);
        if (issue.suggestedFix) {
          output.push(`    ${statusIcon('info')} ${brand.secondary(issue.suggestedFix)}`);
        }
        output.push('');
      }

      if (result.issues.length > 25) {
        output.push(`  ${brand.muted(`... and ${result.issues.length - 25} more issues`)}`);
        output.push('');
      }
    }

    output.push(`  ${brand.muted('Run with --fix=gitignore or --fix=env to auto-fix')}`);
    output.push('');
    process.stdout.write(output.join('\n') + '\n');
  }
}

async function fixGitignore(
  projectRoot: string,
  safety: SafetyContext,
  logger: { info(msg: string): void },
): Promise<void> {
  const gitignorePath = join(projectRoot, '.gitignore');
  const requiredEntries = ['.env', '.env.local', '.vibeguard/', '.vibeguard-trash/'];

  let content = '';
  try {
    content = await readFile(gitignorePath, 'utf-8');
  } catch {
    // File doesn't exist, will create
  }

  const existingLines = content.split('\n').map((l) => l.trim());
  const toAdd: string[] = [];

  for (const entry of requiredEntries) {
    if (!existingLines.includes(entry)) {
      toAdd.push(entry);
    }
  }

  if (toAdd.length === 0) {
    logger.info('.gitignore already contains all required entries');
    return;
  }

  if (safety.isDryRun) {
    logger.info(`[dry-run] Would add to .gitignore: ${toAdd.join(', ')}`);
    safety.recordChange({ type: 'modify', path: '.gitignore' });
    return;
  }

  const newContent = content.endsWith('\n') || content.length === 0
    ? content + toAdd.join('\n') + '\n'
    : content + '\n' + toAdd.join('\n') + '\n';

  await writeFile(gitignorePath, newContent, 'utf-8');
  logger.info(`Added to .gitignore: ${toAdd.join(', ')}`);
}

async function fixEnvSecrets(
  projectRoot: string,
  issues: Array<{ file: string; line: number; message: string; snippet?: string }>,
  logger: { info(msg: string): void },
): Promise<void> {
  const envPath = join(projectRoot, '.env');
  const envExamplePath = join(projectRoot, '.env.example');

  let envContent = '';
  try {
    envContent = await readFile(envPath, 'utf-8');
  } catch {
    // Will create
  }

  let envExampleContent = '';
  try {
    envExampleContent = await readFile(envExamplePath, 'utf-8');
  } catch {
    // Will create
  }

  let counter = 0;
  for (const issue of issues) {
    counter++;
    const envVarName = `SECRET_${counter}`;
    const snippet = issue.snippet || 'unknown';

    if (!envContent.includes(envVarName)) {
      envContent += `${envVarName}=${snippet}\n`;
    }
    if (!envExampleContent.includes(envVarName)) {
      envExampleContent += `${envVarName}=<replace-me>\n`;
    }
  }

  await writeFile(envPath, envContent, 'utf-8');
  await writeFile(envExamplePath, envExampleContent, 'utf-8');
  logger.info(`Moved ${issues.length} secrets to .env and updated .env.example`);
}
