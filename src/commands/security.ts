import { readFile, writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { scanSecurity, type SecurityIssue } from '../engines/security-scanner.js';
import { extractSecretLiteral } from '../engines/security-validators.js';
import { TrashStoreImpl } from '../storage/trash-store.js';
import { resolveFiles } from '../utils/glob-resolver.js';
import { SafetyContext } from '../utils/safety.js';
import { createGitUtils } from '../utils/git-utils.js';
import { CodeScoutError, ErrorCodes } from '../utils/errors.js';
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
        throw new CodeScoutError(
          ErrorCodes.LIMIT_EXCEEDED,
          `--fix=env would modify ${affectedFiles.size} files (limit: 25). Use --force to override.`,
          { count: affectedFiles.size, limit: 25 }
        );
      }

      if (!opts.dryRun) {
        await fixEnvSecrets(projectRoot, secretIssues, logger);
      } else {
        logger.info(`[dry-run] Would move ${secretIssues.length} secrets to .env (originals backed up to .codescout-trash/) from ${affectedFiles.size} files`);
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

    output.push(header('Security Scan'));
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
    if (result.issues.length > 0) {
      output.push(`  ${brand.muted('False positive? Ignore one with')} ${brand.info('codescout ignore add <ID>')} ${brand.muted('(IDs shown above)')}`);
    }
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
  const requiredEntries = ['.env', '.env.local', '.codescout/', '.codescout-trash/'];

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
  issues: SecurityIssue[],
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

  // Group issues by file so each file is read, rewritten, and backed up once.
  const byFile = new Map<string, SecurityIssue[]>();
  for (const issue of issues) {
    const list = byFile.get(issue.file) ?? [];
    list.push(issue);
    byFile.set(issue.file, list);
  }

  const trash = new TrashStoreImpl(projectRoot);
  const usedNames = new Set<string>(collectExistingEnvNames(envContent));
  const newEnvLines: string[] = [];
  const newExampleLines: string[] = [];
  let movedCount = 0;
  let rewrittenFiles = 0;

  for (const [file, fileIssues] of byFile) {
    const absPath = join(projectRoot, file);
    let source: string;
    try {
      source = await readFile(absPath, 'utf-8');
    } catch {
      continue; // unreadable, skip
    }

    let updated = source;
    let fileChanged = false;

    for (const issue of fileIssues) {
      const secret = issue.match ? extractSecretLiteral(issue.match) : undefined;
      // Only rewrite when we have the exact quoted literal present in source.
      if (!secret || secret.length < 4 || !updated.includes(secret)) continue;

      const envVar = deriveEnvVarName(issue, usedNames);
      usedNames.add(envVar);

      // Replace the quoted secret literal with a language-appropriate env ref,
      // preserving the surrounding quotes' removal (we swap the whole literal).
      const replacement = envReferenceForFile(file, envVar);
      updated = replaceQuotedLiteral(updated, secret, replacement);

      newEnvLines.push(`${envVar}=${secret}`);
      newExampleLines.push(`${envVar}=<replace-me>`);
      movedCount++;
      fileChanged = true;
    }

    if (fileChanged && updated !== source) {
      // Back the original up to trash (recoverable) before writing the redacted
      // version, then overwrite the source in place.
      try {
        await trash.move(file, {
          originalPath: file,
          importance: 0,
          lastCommitDate: null,
          kind: 'file',
        });
      } catch {
        // If backup fails, do not destroy the original — skip this file.
        continue;
      }
      await writeFile(absPath, updated, 'utf-8');
      rewrittenFiles++;
    }
  }

  if (newEnvLines.length > 0) {
    envContent = appendLines(envContent, newEnvLines);
    envExampleContent = appendLines(envExampleContent, newExampleLines);
    await writeFile(envPath, envContent, 'utf-8');
    await writeFile(envExamplePath, envExampleContent, 'utf-8');
  }

  logger.info(
    `Moved ${movedCount} secret(s) to .env across ${rewrittenFiles} file(s); ` +
    `originals backed up to .codescout-trash/ and .env.example updated. ` +
    `Review the env references, then rotate the exposed secrets.`,
  );
}

/** Existing VAR names already present in a .env file (left side of `=`). */
function collectExistingEnvNames(envContent: string): string[] {
  const names: string[] = [];
  for (const line of envContent.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (m?.[1]) names.push(m[1]);
  }
  return names;
}

/**
 * Derive a meaningful, unique UPPER_SNAKE env var name for a secret. Prefers a
 * provider-specific name based on the detector message (OpenAI, AWS, Stripe…),
 * falling back to a generic SECRET_n. Guarantees uniqueness against used names.
 */
function deriveEnvVarName(issue: SecurityIssue, used: Set<string>): string {
  const base = providerEnvName(issue.message);
  let candidate = base;
  let n = 1;
  while (used.has(candidate)) {
    n++;
    candidate = `${base}_${n}`;
  }
  return candidate;
}

function providerEnvName(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('openai')) return 'OPENAI_API_KEY';
  if (m.includes('anthropic')) return 'ANTHROPIC_API_KEY';
  if (m.includes('aws')) return 'AWS_SECRET_ACCESS_KEY';
  if (m.includes('google') || m.includes('gemini')) return 'GOOGLE_API_KEY';
  if (m.includes('supabase')) return 'SUPABASE_SERVICE_ROLE_KEY';
  if (m.includes('github')) return 'GITHUB_TOKEN';
  if (m.includes('stripe')) return 'STRIPE_SECRET_KEY';
  if (m.includes('slack')) return 'SLACK_TOKEN';
  if (m.includes('twilio')) return 'TWILIO_ACCOUNT_SID';
  if (m.includes('jwt')) return 'JWT_SECRET';
  if (m.includes('database') || m.includes('connection')) return 'DATABASE_URL';
  if (m.includes('private key')) return 'PRIVATE_KEY';
  return 'SECRET';
}

/** Language-appropriate way to read an env var, used as the source replacement. */
function envReferenceForFile(file: string, envVar: string): string {
  const ext = extname(file).toLowerCase();
  if (ext === '.py' || ext === '.pyw') return `os.environ["${envVar}"]`;
  if (ext === '.go') return `os.Getenv("${envVar}")`;
  if (ext === '.java') return `System.getenv("${envVar}")`;
  // JS/TS and everything else
  return `process.env.${envVar}`;
}

/**
 * Replace the first occurrence of a quoted secret literal (including its
 * surrounding quotes) with a code reference. Falls back to replacing the bare
 * secret if it is not wrapped in quotes.
 */
function replaceQuotedLiteral(source: string, secret: string, replacement: string): string {
  for (const q of ['"', "'", '`']) {
    const quoted = `${q}${secret}${q}`;
    const idx = source.indexOf(quoted);
    if (idx !== -1) {
      return source.slice(0, idx) + replacement + source.slice(idx + quoted.length);
    }
  }
  const bare = source.indexOf(secret);
  if (bare !== -1) {
    return source.slice(0, bare) + replacement + source.slice(bare + secret.length);
  }
  return source;
}

/** Append lines to a file body, ensuring a single trailing newline. */
function appendLines(content: string, lines: string[]): string {
  const dedup = lines.filter((l) => !content.includes(l.split('=')[0] + '='));
  if (dedup.length === 0) return content;
  const body = content.length === 0 || content.endsWith('\n') ? content : content + '\n';
  return body + dedup.join('\n') + '\n';
}
