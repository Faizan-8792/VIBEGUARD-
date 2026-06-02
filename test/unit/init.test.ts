import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInit } from '../../src/commands/init.js';
import { loadConfig, type ResolvedConfig } from '../../src/storage/config-store.js';
import { createLogger } from '../../src/utils/logger.js';
import type { CommandContext } from '../../src/context.js';

describe('Init Command', () => {
  let testDir: string;
  let config: ResolvedConfig;

  beforeEach(async () => {
    testDir = join(tmpdir(), `vibeguard-init-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
    config = await loadConfig(testDir);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  function makeCtx(): CommandContext {
    return {
      options: { json: false, cwd: testDir, include: [], exclude: [], config: undefined, verbose: false, quiet: true },
      config,
      logger: createLogger({ jsonMode: false, quiet: true, verbose: false, command: 'init' }),
      projectRoot: testDir,
    };
  }

  it('creates .vibeguard/config.json with defaults', async () => {
    await runInit(makeCtx(), { force: false });

    const configPath = join(testDir, '.vibeguard', 'config.json');
    const content = await readFile(configPath, 'utf-8');
    const written = JSON.parse(content);

    expect(written.ignore).toContain('node_modules/**');
    expect(written.importance.weights.dependents).toBe(5);
    expect(written.context.defaultRadius).toBe(2);
    expect(written.context.defaultTokenBudget).toBe(12000);
  });

  it('refuses to overwrite without --force', async () => {
    await runInit(makeCtx(), { force: false });

    await expect(runInit(makeCtx(), { force: false })).rejects.toThrow('already exists');
  });

  it('overwrites with --force', async () => {
    await runInit(makeCtx(), { force: false });
    await runInit(makeCtx(), { force: true }); // Should not throw

    const configPath = join(testDir, '.vibeguard', 'config.json');
    await access(configPath); // Should exist
  });

  it('creates .vibeguard/ directory', async () => {
    await runInit(makeCtx(), { force: false });

    const dirPath = join(testDir, '.vibeguard');
    await access(dirPath); // Should exist
  });
});
