import { header, statusIcon, brand } from '../utils/ui.js';
import { emitJson } from '../utils/json-output.js';
import { VibeguardError, ErrorCodes } from '../utils/errors.js';
import { addIgnoredFindings, removeIgnoredFindings } from '../storage/config-store.js';
import type { CommandContext } from '../context.js';

export interface IgnoreOptions {
  action: string;
  ids: string[];
}

/**
 * Manage the per-finding ignore list. Ignored finding IDs (e.g. SEC-006-1a2b3c4d
 * or ATK-104-…) are stored in `.vibeguard/config.json` under `security.ignore`
 * and suppressed by the security + attack scanners on every future run.
 */
export async function runIgnore(ctx: CommandContext, opts: IgnoreOptions): Promise<void> {
  const { config, options } = ctx;

  switch (opts.action) {
    case 'add':
      await addAction(ctx, opts.ids);
      break;
    case 'remove':
      await removeAction(ctx, opts.ids);
      break;
    case 'list':
      listAction(config.security.ignore ?? [], options.json);
      break;
    default:
      throw new VibeguardError(
        ErrorCodes.UNKNOWN_COMMAND,
        `Unknown ignore action: "${opts.action}". Valid: add <id...>, remove <id...>, list`,
      );
  }
}

async function addAction(ctx: CommandContext, ids: string[]): Promise<void> {
  if (ids.length === 0) {
    throw new VibeguardError(ErrorCodes.UNKNOWN_OPTION, 'Provide at least one finding ID to ignore, e.g. `vibeguard ignore add SEC-006-1a2b3c4d`');
  }

  const added = await addIgnoredFindings(ctx.projectRoot, ids);

  if (ctx.options.json) {
    emitJson({ action: 'ignore-add', requested: ids, added });
    return;
  }

  const out: string[] = [];
  out.push('');
  out.push(header('Ignore Findings', '🙈'));
  out.push('');
  if (added.length > 0) {
    out.push(`  ${statusIcon('success')} ${brand.success(`Ignoring ${added.length} finding(s):`)}`);
    for (const id of added) out.push(`    ${brand.muted('•')} ${brand.secondary(id)}`);
  } else {
    out.push(`  ${statusIcon('info')} ${brand.muted('All given IDs were already ignored.')}`);
  }
  out.push('');
  out.push(`  ${brand.muted('These will no longer be flagged by security/attack scans.')}`);
  out.push(`  ${brand.muted('Undo with:')} ${brand.info('vibeguard ignore remove <id>')}`);
  out.push('');
  process.stdout.write(out.join('\n') + '\n');
}

async function removeAction(ctx: CommandContext, ids: string[]): Promise<void> {
  if (ids.length === 0) {
    throw new VibeguardError(ErrorCodes.UNKNOWN_OPTION, 'Provide at least one finding ID to un-ignore.');
  }

  const removed = await removeIgnoredFindings(ctx.projectRoot, ids);

  if (ctx.options.json) {
    emitJson({ action: 'ignore-remove', requested: ids, removed });
    return;
  }

  const out: string[] = [];
  out.push('');
  out.push(header('Un-ignore Findings', '👁️'));
  out.push('');
  if (removed.length > 0) {
    out.push(`  ${statusIcon('success')} ${brand.success(`Restored ${removed.length} finding(s) to scans:`)}`);
    for (const id of removed) out.push(`    ${brand.muted('•')} ${brand.secondary(id)}`);
  } else {
    out.push(`  ${statusIcon('info')} ${brand.muted('None of the given IDs were in the ignore list.')}`);
  }
  out.push('');
  process.stdout.write(out.join('\n') + '\n');
}

function listAction(ignored: string[], json: boolean): void {
  if (json) {
    emitJson({ action: 'ignore-list', ignored });
    return;
  }

  const out: string[] = [];
  out.push('');
  out.push(header('Ignored Findings', '🙈'));
  out.push('');
  if (ignored.length === 0) {
    out.push(`  ${statusIcon('info')} ${brand.muted('No findings are ignored.')}`);
  } else {
    out.push(`  ${brand.muted(`${ignored.length} finding(s) ignored:`)}`);
    for (const id of ignored) out.push(`    ${brand.muted('•')} ${brand.secondary(id)}`);
  }
  out.push('');
  process.stdout.write(out.join('\n') + '\n');
}
