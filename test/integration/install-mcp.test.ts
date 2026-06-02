import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../../src/utils/logger.js';
import { loadConfig } from '../../src/storage/config-store.js';
import { runInstall } from '../../src/commands/install.js';
import type { CommandContext } from '../../src/context.js';

let projectRoot: string;

async function makeCtx(root: string): Promise<CommandContext> {
  const config = await loadConfig(root);
  const logger = createLogger({ jsonMode: true, quiet: true, verbose: false, command: 'install' });
  return {
    options: { json: true, cwd: root, include: [], exclude: [], config: undefined, verbose: false, quiet: true },
    config,
    logger,
    projectRoot: root,
  };
}

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'vibeguard-install-'));
  await writeFile(join(projectRoot, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }), 'utf-8');
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

describe('Integration: install writes a real MCP config', () => {
  it('kiro install creates .kiro/settings/mcp.json with the vibeguard server', async () => {
    const ctx = await makeCtx(projectRoot);
    await runInstall(ctx, { platform: 'kiro' });

    const raw = await readFile(join(projectRoot, '.kiro', 'settings', 'mcp.json'), 'utf-8');
    const config = JSON.parse(raw);
    expect(config.mcpServers).toBeDefined();
    expect(config.mcpServers.vibeguard).toBeDefined();
    expect(config.mcpServers.vibeguard.args).toContain('serve');
    expect(config.mcpServers.vibeguard.disabled).toBe(false);
  });

  it('merges into an existing mcp.json without clobbering other servers', async () => {
    const settingsDir = join(projectRoot, '.kiro', 'settings');
    await mkdir(settingsDir, { recursive: true });
    await writeFile(
      join(settingsDir, 'mcp.json'),
      JSON.stringify({ mcpServers: { existing: { command: 'foo', args: [] } } }, null, 2),
      'utf-8',
    );

    const ctx = await makeCtx(projectRoot);
    await runInstall(ctx, { platform: 'kiro' });

    const config = JSON.parse(await readFile(join(settingsDir, 'mcp.json'), 'utf-8'));
    expect(config.mcpServers.existing).toBeDefined();
    expect(config.mcpServers.vibeguard).toBeDefined();
  });
});
