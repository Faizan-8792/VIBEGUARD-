import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommandContext } from '../context.js';
import { VibeguardError, ErrorCodes, SCHEMA_VERSION } from '../utils/errors.js';
import { FileStoreImpl } from '../storage/file-store.js';
import { DEFAULT_CONFIG } from '../storage/config-store.js';

export interface InitOptions {
  force: boolean;
}

export async function runInit(ctx: CommandContext, opts: InitOptions): Promise<void> {
  const { logger, projectRoot, options } = ctx;
  const configPath = join(projectRoot, '.vibeguard', 'config.json');

  // Check if config already exists
  let exists = false;
  try {
    await access(configPath);
    exists = true;
  } catch {
    exists = false;
  }

  if (exists && !opts.force) {
    throw new VibeguardError(
      ErrorCodes.ALREADY_EXISTS,
      '.vibeguard/config.json already exists. Use --force to overwrite.',
      { path: configPath }
    );
  }

  const store = new FileStoreImpl(projectRoot);
  await store.ensureDir('.');
  await store.write('config.json', DEFAULT_CONFIG);

  if (options.json) {
    const result = { schemaVersion: SCHEMA_VERSION, message: 'Initialized .vibeguard/config.json', path: configPath };
    process.stdout.write(JSON.stringify(result) + '\n');
  } else {
    logger.info('Initialized .vibeguard/config.json with default configuration');
  }
}
