import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadGraphModeState,
  enableGraphMode,
  disableGraphMode,
  graphModeRuleBody,
  defaultGraphModeState,
  GRAPHMODE_KIRO_STEERING_REL,
  GRAPHMODE_CURSOR_RULE_REL,
} from '../../src/engines/graphmode.js';

let testDir: string;

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

beforeEach(async () => {
  testDir = join(tmpdir(), `vibeguard-graphmode-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe('GraphMode engine', () => {
  it('defaults to disabled', () => {
    const s = defaultGraphModeState();
    expect(s.enabled).toBe(false);
  });

  it('rule body carries the plain "GraphMode: ON" indicator (no emoji)', () => {
    const body = graphModeRuleBody();
    expect(body).toContain('GraphMode: ON');
    expect(body).not.toContain('🪨');
    expect(body.toLowerCase()).toContain('begin every reply');
  });

  it('enable writes always-on rule files and marks state enabled', async () => {
    const { written } = await enableGraphMode(testDir);

    expect(await exists(join(testDir, GRAPHMODE_KIRO_STEERING_REL))).toBe(true);
    expect(await exists(join(testDir, GRAPHMODE_CURSOR_RULE_REL))).toBe(true);
    expect(written).toContain('.kiro/steering/vibeguard-graphmode.md');

    const kiro = await readFile(join(testDir, GRAPHMODE_KIRO_STEERING_REL), 'utf-8');
    expect(kiro).toContain('inclusion: always');
    expect(kiro).toContain('GraphMode: ON');

    const state = await loadGraphModeState(testDir);
    expect(state.enabled).toBe(true);
  });

  it('disable removes rule files and marks state disabled', async () => {
    await enableGraphMode(testDir);
    await disableGraphMode(testDir);

    expect(await exists(join(testDir, GRAPHMODE_KIRO_STEERING_REL))).toBe(false);
    expect(await exists(join(testDir, GRAPHMODE_CURSOR_RULE_REL))).toBe(false);

    const state = await loadGraphModeState(testDir);
    expect(state.enabled).toBe(false);
  });

  it('is independent of Caveman (separate marker, separate state file)', async () => {
    const { enableCaveman, loadCavemanState } = await import('../../src/engines/caveman.js');
    await enableGraphMode(testDir);
    await enableCaveman(testDir, 'full');

    // Both enabled at once.
    expect((await loadGraphModeState(testDir)).enabled).toBe(true);
    expect((await loadCavemanState(testDir)).enabled).toBe(true);

    // Disabling GraphMode leaves Caveman intact.
    await disableGraphMode(testDir);
    expect((await loadGraphModeState(testDir)).enabled).toBe(false);
    expect((await loadCavemanState(testDir)).enabled).toBe(true);

    // CLAUDE.md still holds the caveman block but not the graphmode block.
    const claude = await readFile(join(testDir, 'CLAUDE.md'), 'utf-8');
    expect(claude).toContain('vibeguard-caveman:begin');
    expect(claude).not.toContain('vibeguard-graphmode:begin');
  });
});
