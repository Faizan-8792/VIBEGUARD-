import { TrashStoreImpl } from '../storage/trash-store.js';
import { VibeguardError, ErrorCodes } from '../utils/errors.js';
import { emitJson } from '../utils/json-output.js';
import { header, statusIcon, filePath, brand } from '../utils/ui.js';
import type { CommandContext } from '../context.js';

export interface TrashCommandOptions {
  action: string;
  target?: string;
  force: boolean;
  yes: boolean;
}

export async function runTrash(ctx: CommandContext, opts: TrashCommandOptions): Promise<void> {
  const { projectRoot, options } = ctx;
  const trashStore = new TrashStoreImpl(projectRoot);

  switch (opts.action) {
    case 'list': {
      const entries = await trashStore.list();

      if (options.json) {
        emitJson({ entries });
      } else {
        const output: string[] = [];
        output.push(header('Trash', '🗑️'));
        output.push('');

        if (entries.length === 0) {
          output.push(`  ${statusIcon('success')} ${brand.success('Trash is empty')}`);
        } else {
          output.push(`  ${brand.muted(`${entries.length} entries`)}`);
          output.push('');

          for (const entry of entries) {
            const shortId = entry.id.slice(0, 8);
            const date = new Date(entry.movedAt).toLocaleDateString();
            output.push(`  ${brand.muted(shortId)} ${filePath(entry.originalPath)} ${brand.muted(`(${entry.kind}, imp:${entry.importance}, ${date})`)}`);
          }
        }

        output.push('');
        process.stdout.write(output.join('\n') + '\n');
      }
      break;
    }

    case 'restore': {
      if (!opts.target) {
        throw new VibeguardError(
          ErrorCodes.CONFIG_INVALID,
          'Restore requires an ID or path. Usage: vibeguard trash restore <id|path>',
        );
      }

      try {
        await trashStore.restore(opts.target, opts.force);
        if (options.json) {
          emitJson({ restored: opts.target });
        } else {
          process.stdout.write(`\n  ${statusIcon('success')} ${brand.success('Restored:')} ${filePath(opts.target)}\n\n`);
        }
      } catch (err) {
        throw new VibeguardError(
          ErrorCodes.RESTORE_CONFLICT,
          err instanceof Error ? err.message : 'Restore failed',
        );
      }
      break;
    }

    case 'purge': {
      if (!opts.yes) {
        throw new VibeguardError(
          ErrorCodes.LIMIT_EXCEEDED,
          'Purge requires --yes flag to confirm deletion of all trash entries.',
        );
      }

      await trashStore.purge();

      if (options.json) {
        emitJson({ purged: true });
      } else {
        process.stdout.write(`\n  ${statusIcon('success')} ${brand.success('Trash purged')}\n\n`);
      }
      break;
    }

    default:
      throw new VibeguardError(
        ErrorCodes.UNKNOWN_COMMAND,
        `Unknown trash action: "${opts.action}". Valid actions: list, restore, purge`,
      );
  }
}
