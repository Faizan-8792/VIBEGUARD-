import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, DEFAULT_CONFIG } from '../../src/storage/config-store.js';

describe('Config Store', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `vibeguard-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('returns defaults when no config file exists', async () => {
    const config = await loadConfig(testDir);
    expect(config.ignore).toEqual(DEFAULT_CONFIG.ignore);
    expect(config.importance.weights).toEqual(DEFAULT_CONFIG.importance.weights);
    expect(config.context.defaultRadius).toBe(2);
    expect(config.context.defaultTokenBudget).toBe(12000);
  });

  it('loads and merges config from file', async () => {
    await mkdir(join(testDir, '.vibeguard'), { recursive: true });
    await writeFile(
      join(testDir, '.vibeguard', 'config.json'),
      JSON.stringify({
        ignore: ['custom/**'],
        importance: { weights: { dependents: 10 } },
      }),
      'utf-8'
    );

    const config = await loadConfig(testDir);
    expect(config.ignore).toEqual(['custom/**']);
    expect(config.importance.weights.dependents).toBe(10);
    expect(config.importance.weights.imports).toBe(2); // default preserved
  });

  it('throws on malformed JSON', async () => {
    await mkdir(join(testDir, '.vibeguard'), { recursive: true });
    await writeFile(join(testDir, '.vibeguard', 'config.json'), 'not json', 'utf-8');

    await expect(loadConfig(testDir)).rejects.toThrow('malformed JSON');
  });

  it('throws on invalid config shape', async () => {
    await mkdir(join(testDir, '.vibeguard'), { recursive: true });
    await writeFile(
      join(testDir, '.vibeguard', 'config.json'),
      JSON.stringify({ ignore: 'not-an-array' }),
      'utf-8'
    );

    await expect(loadConfig(testDir)).rejects.toThrow('ignore');
  });

  it('merges CLI include and exclude into resolved config', async () => {
    const config = await loadConfig(testDir, undefined, ['src/**/*.ts'], ['vendor/**']);
    expect(config.effectiveInclude).toEqual(['src/**/*.ts']);
    expect(config.effectiveSkipSet).toContain('vendor/**');
    expect(config.effectiveSkipSet).toContain('**/node_modules/**');
  });

  it('uses default extensions when no include specified', async () => {
    const config = await loadConfig(testDir);
    expect(config.effectiveInclude.length).toBeGreaterThan(0);
    expect(config.effectiveInclude.some((p) => p.includes('*.ts'))).toBe(true);
  });
});
