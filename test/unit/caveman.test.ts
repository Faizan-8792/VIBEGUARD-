import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadCavemanState,
  saveCavemanState,
  isCavemanLevel,
  estimatedSavingsPct,
  buildKiroSteering,
  cavemanRuleBody,
  defaultCavemanState,
  CAVEMAN_LEVELS,
  enableCaveman,
  disableCaveman,
  compressText,
  measureCompression,
  estimateTokens,
  type CavemanLevel,
} from '../../src/engines/caveman.js';
import { runCaveman } from '../../src/commands/caveman.js';
import { createLogger } from '../../src/utils/logger.js';
import { loadConfig } from '../../src/storage/config-store.js';
import type { CommandContext } from '../../src/context.js';

let testDir: string;

async function makeCtx(json = true): Promise<CommandContext> {
  const config = await loadConfig(testDir);
  const logger = createLogger({ jsonMode: json, quiet: true, verbose: false, command: 'caveman' });
  return {
    options: { json, cwd: testDir, include: [], exclude: [], config: undefined, verbose: false, quiet: true },
    config,
    logger,
    projectRoot: testDir,
  };
}

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

beforeEach(async () => {
  testDir = join(tmpdir(), `vibeguard-caveman-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe('caveman engine', () => {
  it('defaults to disabled, full level', () => {
    const s = defaultCavemanState();
    expect(s.enabled).toBe(false);
    expect(s.level).toBe('full');
  });

  it('validates levels', () => {
    for (const lvl of CAVEMAN_LEVELS) expect(isCavemanLevel(lvl)).toBe(true);
    expect(isCavemanLevel('verbose')).toBe(false);
    expect(isCavemanLevel(undefined)).toBe(false);
  });

  it('savings increase with level intensity', () => {
    expect(estimatedSavingsPct('lite')).toBeLessThan(estimatedSavingsPct('full'));
    expect(estimatedSavingsPct('full')).toBeLessThan(estimatedSavingsPct('ultra'));
  });

  it('rule body embeds the active level and keeps safety carve-outs', () => {
    const body = cavemanRuleBody('ultra');
    expect(body).toContain('level: ultra');
    expect(body.toLowerCase()).toContain('security');
    expect(body).toContain('stop caveman');
  });

  it('rule body requires the visible "Caveman mode: ON" indicator with the level', () => {
    for (const lvl of CAVEMAN_LEVELS) {
      const body = cavemanRuleBody(lvl);
      expect(body).toContain(`🪨 Caveman mode: ON (${lvl})`);
      expect(body.toLowerCase()).toContain('begin every reply');
    }
  });

  it('Kiro steering uses inclusion: always and carries a description (no Kiro warning)', () => {
    const steering = buildKiroSteering('full');
    expect(steering).toContain('inclusion: always');
    expect(steering).toMatch(/\ndescription: .+/);
  });

  it('persists and reloads state', async () => {
    await saveCavemanState(testDir, { schemaVersion: '1.0.0', enabled: true, level: 'ultra', updatedAt: new Date().toISOString() });
    const loaded = await loadCavemanState(testDir);
    expect(loaded.enabled).toBe(true);
    expect(loaded.level).toBe('ultra');
  });

  it('coerces an unknown persisted level back to the default', async () => {
    await mkdir(join(testDir, '.vibeguard'), { recursive: true });
    await writeFile(join(testDir, '.vibeguard', 'caveman.json'), JSON.stringify({ enabled: true, level: 'bogus' }), 'utf-8');
    const loaded = await loadCavemanState(testDir);
    expect(loaded.level).toBe('full');
  });
});

describe('caveman command', () => {
  it('on writes the always-on Kiro steering file and marks state enabled', async () => {
    const ctx = await makeCtx();
    await runCaveman(ctx, { action: 'on', level: 'full' });

    const steeringPath = join(testDir, '.kiro', 'steering', 'vibeguard-caveman.md');
    expect(await exists(steeringPath)).toBe(true);
    const content = await readFile(steeringPath, 'utf-8');
    expect(content).toContain('inclusion: always');
    expect(content).toContain('Caveman Mode');

    const state = await loadCavemanState(testDir);
    expect(state.enabled).toBe(true);
    expect(state.level).toBe('full');
  });

  it('off removes the steering file and disables state', async () => {
    const ctx = await makeCtx();
    await runCaveman(ctx, { action: 'on', level: 'lite' });
    await runCaveman(ctx, { action: 'off' });

    const steeringPath = join(testDir, '.kiro', 'steering', 'vibeguard-caveman.md');
    expect(await exists(steeringPath)).toBe(false);

    const state = await loadCavemanState(testDir);
    expect(state.enabled).toBe(false);
  });

  it('level switches the active level while staying enabled', async () => {
    const ctx = await makeCtx();
    await runCaveman(ctx, { action: 'on', level: 'lite' });
    await runCaveman(ctx, { action: 'level', level: 'ultra' });

    const state = await loadCavemanState(testDir);
    expect(state.enabled).toBe(true);
    expect(state.level).toBe('ultra');

    const content = await readFile(join(testDir, '.kiro', 'steering', 'vibeguard-caveman.md'), 'utf-8');
    expect(content).toContain('level: ultra');
  });

  it('level before on is rejected', async () => {
    const ctx = await makeCtx();
    await expect(runCaveman(ctx, { action: 'level', level: 'ultra' })).rejects.toThrow();
  });

  it('rejects an invalid level', async () => {
    const ctx = await makeCtx();
    await expect(runCaveman(ctx, { action: 'on', level: 'turbo' })).rejects.toThrow();
  });

  it('mirrors into an existing CLAUDE.md via marker block, and strips it on off', async () => {
    await writeFile(join(testDir, 'CLAUDE.md'), '# Project\n\nExisting notes.\n', 'utf-8');
    const ctx = await makeCtx();

    await runCaveman(ctx, { action: 'on', level: 'full' });
    let claude = await readFile(join(testDir, 'CLAUDE.md'), 'utf-8');
    expect(claude).toContain('Existing notes.');
    expect(claude).toContain('vibeguard-caveman:begin');
    expect(claude).toContain('Caveman Mode');

    await runCaveman(ctx, { action: 'off' });
    claude = await readFile(join(testDir, 'CLAUDE.md'), 'utf-8');
    expect(claude).toContain('Existing notes.');
    expect(claude).not.toContain('vibeguard-caveman:begin');
  });

  it('does not create agent files that were not already present', async () => {
    const ctx = await makeCtx();
    await runCaveman(ctx, { action: 'on', level: 'full' });
    // No CLAUDE.md existed → none should be created.
    expect(await exists(join(testDir, 'CLAUDE.md'))).toBe(false);
  });
});

describe('caveman compressor (engine)', () => {
  const VERBOSE = "Sure! I'd be happy to help. The reason is basically that you are just creating a new object.";

  it('estimateTokens uses the ~4 chars/token heuristic', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });

  it('removes filler and pleasantries at every level', () => {
    for (const level of CAVEMAN_LEVELS) {
      const out = compressText(VERBOSE, level).toLowerCase();
      expect(out).not.toContain('sure');
      expect(out).not.toContain('happy to help');
      expect(out).not.toContain('basically');
      expect(out).not.toContain('just');
    }
  });

  it('keeps articles at lite but drops them at full/ultra', () => {
    const sample = 'The cache stores the value in a map.';
    expect(compressText(sample, 'lite').toLowerCase()).toContain('the');
    const full = compressText(sample, 'full').toLowerCase();
    expect(full).not.toMatch(/\bthe\b/);
    expect(full).not.toMatch(/\ba\b/);
  });

  it('abbreviates prose words only at ultra', () => {
    const sample = 'The database configuration affects authentication.';
    expect(compressText(sample, 'full')).toContain('database');
    const ultra = compressText(sample, 'ultra');
    expect(ultra).toContain('DB');
    expect(ultra).toContain('config');
    expect(ultra).toContain('auth');
  });

  it('NEVER alters fenced code blocks or inline code', () => {
    const sample = 'Use this:\n```ts\nconst the = a.basically();\n```\nand `the.justValue` inline.';
    for (const level of CAVEMAN_LEVELS) {
      const out = compressText(sample, level);
      expect(out).toContain('const the = a.basically();'); // fenced block byte-preserved
      expect(out).toContain('`the.justValue`');            // inline code byte-preserved
    }
  });

  it('is deterministic (same input → same output)', () => {
    for (const level of CAVEMAN_LEVELS) {
      expect(compressText(VERBOSE, level)).toBe(compressText(VERBOSE, level));
    }
  });

  it('measureCompression reports real, non-negative savings that grow with level', () => {
    const lite = measureCompression(VERBOSE, 'lite');
    const full = measureCompression(VERBOSE, 'full');
    const ultra = measureCompression(VERBOSE, 'ultra');

    for (const r of [lite, full, ultra]) {
      expect(r.savedPct).toBeGreaterThanOrEqual(0);
      expect(r.compressedTokens).toBeLessThanOrEqual(r.originalTokens);
    }
    // More aggressive levels never save fewer tokens than lighter ones.
    expect(full.savedPct).toBeGreaterThanOrEqual(lite.savedPct);
    expect(ultra.savedPct).toBeGreaterThanOrEqual(full.savedPct);
  });

  it('handles empty input without dividing by zero', () => {
    const r = measureCompression('', 'ultra');
    expect(r.savedPct).toBe(0);
    expect(r.originalTokens).toBe(0);
  });
});

describe('caveman engine enable/disable helpers', () => {
  it('enableCaveman writes Kiro steering and persists enabled state', async () => {
    const res = await enableCaveman(testDir, 'ultra');
    expect(res.state.enabled).toBe(true);
    expect(res.state.level).toBe('ultra');
    expect(res.written).toContain('.kiro/steering/vibeguard-caveman.md');

    const steering = await readFile(join(testDir, '.kiro', 'steering', 'vibeguard-caveman.md'), 'utf-8');
    expect(steering).toContain('inclusion: always');
    expect(steering).toContain('level: ultra');
  });

  it('disableCaveman removes the rule file and clears state', async () => {
    await enableCaveman(testDir, 'full');
    const res = await disableCaveman(testDir);
    expect(res.state.enabled).toBe(false);
    expect(res.removed).toContain('.kiro/steering/vibeguard-caveman.md');
    expect(await exists(join(testDir, '.kiro', 'steering', 'vibeguard-caveman.md'))).toBe(false);
  });

  it('enable mirrors into an existing Cursor rules dir', async () => {
    await mkdir(join(testDir, '.cursor', 'rules'), { recursive: true });
    const res = await enableCaveman(testDir, 'full');
    expect(res.written).toContain('.cursor/rules/vibeguard-caveman.mdc');
    const rule = await readFile(join(testDir, '.cursor', 'rules', 'vibeguard-caveman.mdc'), 'utf-8');
    expect(rule).toContain('alwaysApply: true');
  });
});

describe('caveman benchmark action', () => {
  it('emits per-level savings in JSON', async () => {
    const { runCaveman } = await import('../../src/commands/caveman.js');
    const ctx = await makeCtx(true);
    // Capture stdout JSON.
    const lines: string[] = [];
    const orig = process.stdout.write;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout.write as any) = (chunk: any) => { lines.push(String(chunk)); return true; };
    try {
      await runCaveman(ctx, { action: 'benchmark' });
    } finally {
      process.stdout.write = orig;
    }
    const parsed = JSON.parse(lines.join(''));
    expect(parsed.action).toBe('caveman-benchmark');
    expect(parsed.results).toHaveLength(3);
    const levels = parsed.results.map((r: { level: string }) => r.level);
    expect(levels).toEqual([...CAVEMAN_LEVELS]);
    for (const r of parsed.results) {
      expect(r.savedPct).toBeGreaterThanOrEqual(0);
    }
  });
});
