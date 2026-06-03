import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, mkdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../../src/utils/logger.js';
import { loadConfig } from '../../src/storage/config-store.js';
import { runInstall, runUninstall } from '../../src/commands/install.js';
import { runDoctor } from '../../src/commands/doctor.js';
import { loadCavemanState } from '../../src/engines/caveman.js';
import type { CommandContext } from '../../src/context.js';

let projectRoot: string;

async function makeCtx(root: string, command: string): Promise<CommandContext> {
  const config = await loadConfig(root);
  const logger = createLogger({ jsonMode: true, quiet: true, verbose: false, command });
  return {
    options: { json: true, cwd: root, include: [], exclude: [], config: undefined, verbose: false, quiet: true },
    config,
    logger,
    projectRoot: root,
  };
}

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

/** Capture stdout produced during fn() and return it as a single string. */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const orig = process.stdout.write;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout.write as any) = (chunk: any) => { lines.push(String(chunk)); return true; };
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return lines.join('');
}

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'vibeguard-caveman-int-'));
  await writeFile(join(projectRoot, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }), 'utf-8');
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

describe('Integration: install --caveman enables Caveman in one step', () => {
  const steeringRel = join('.kiro', 'steering', 'vibeguard-caveman.md');

  it('install enables Caveman by default (one-shot setup)', async () => {
    const ctx = await makeCtx(projectRoot, 'install');
    await captureStdout(() => runInstall(ctx, { platform: 'kiro', map: false }));
    const state = await loadCavemanState(projectRoot);
    expect(state.enabled).toBe(true);
    expect(await exists(join(projectRoot, steeringRel))).toBe(true);
  });

  it('install --no-caveman (caveman: false) skips enabling caveman', async () => {
    const ctx = await makeCtx(projectRoot, 'install');
    await captureStdout(() => runInstall(ctx, { platform: 'kiro', caveman: false, map: false }));
    const state = await loadCavemanState(projectRoot);
    expect(state.enabled).toBe(false);
    expect(await exists(join(projectRoot, steeringRel))).toBe(false);
  });

  it('install --caveman ultra enables caveman at that level + writes steering', async () => {
    const ctx = await makeCtx(projectRoot, 'install');
    const out = await captureStdout(() => runInstall(ctx, { platform: 'kiro', caveman: 'ultra' }));

    const state = await loadCavemanState(projectRoot);
    expect(state.enabled).toBe(true);
    expect(state.level).toBe('ultra');
    expect(await exists(join(projectRoot, steeringRel))).toBe(true);

    const json = JSON.parse(out);
    expect(json.caveman.level).toBe('ultra');
  });

  it('install --caveman (boolean, no level) uses the default level', async () => {
    const ctx = await makeCtx(projectRoot, 'install');
    await captureStdout(() => runInstall(ctx, { platform: 'kiro', caveman: true }));
    const state = await loadCavemanState(projectRoot);
    expect(state.enabled).toBe(true);
    expect(state.level).toBe('full');
  });

  it('install --caveman with an invalid level throws', async () => {
    const ctx = await makeCtx(projectRoot, 'install');
    await expect(
      captureStdout(() => runInstall(ctx, { platform: 'kiro', caveman: 'turbo' })),
    ).rejects.toThrow();
  });

  it('uninstall removes the Caveman steering file and disables state', async () => {
    const installCtx = await makeCtx(projectRoot, 'install');
    await captureStdout(() => runInstall(installCtx, { platform: 'kiro', caveman: 'full' }));
    expect(await exists(join(projectRoot, steeringRel))).toBe(true);

    const uninstallCtx = await makeCtx(projectRoot, 'install');
    const out = await captureStdout(() => runUninstall(uninstallCtx, { platform: 'kiro' }));

    expect(await exists(join(projectRoot, steeringRel))).toBe(false);
    const state = await loadCavemanState(projectRoot);
    expect(state.enabled).toBe(false);
    const json = JSON.parse(out);
    expect(json.cavemanRemoved).toContain('.kiro/steering/vibeguard-caveman.md');
  });
});

describe('Integration: doctor reports Caveman status', () => {
  beforeEach(async () => {
    // Minimal source file so health analysis has something to chew on.
    await mkdir(join(projectRoot, 'src'), { recursive: true });
    await writeFile(join(projectRoot, 'src', 'index.ts'), 'export const x = 1;\n', 'utf-8');
  });

  it('shows caveman: disabled by default', async () => {
    const ctx = await makeCtx(projectRoot, 'doctor');
    const out = await captureStdout(() => runDoctor(ctx));
    const json = JSON.parse(out);
    expect(json.caveman).toBeDefined();
    expect(json.caveman.enabled).toBe(false);
  });

  it('shows caveman: enabled after turning it on', async () => {
    const { enableCaveman } = await import('../../src/engines/caveman.js');
    await enableCaveman(projectRoot, 'full');

    const ctx = await makeCtx(projectRoot, 'doctor');
    const out = await captureStdout(() => runDoctor(ctx));
    const json = JSON.parse(out);
    expect(json.caveman.enabled).toBe(true);
    expect(json.caveman.level).toBe('full');
    expect(json.caveman.estimatedSavingsPct).toBeGreaterThan(0);
  });
});

describe('Integration: Caveman multi-IDE rule mirroring', () => {
  const KIRO = join('.kiro', 'steering', 'vibeguard-caveman.md');
  const CURSOR = join('.cursor', 'rules', 'vibeguard-caveman.mdc');
  const WINDSURF = join('.windsurf', 'rules', 'vibeguard-caveman.md');

  it('always writes Kiro steering with an ON indicator instruction', async () => {
    const { enableCaveman } = await import('../../src/engines/caveman.js');
    await enableCaveman(projectRoot, 'ultra');
    const body = await readFile(join(projectRoot, KIRO), 'utf-8');
    expect(body).toContain('Caveman mode: ON');
    expect(body).toContain('inclusion: always');
    expect(body).toMatch(/description: .+/);
  });

  it('always creates Cursor and Windsurf rule files (works without prior install)', async () => {
    const { enableCaveman } = await import('../../src/engines/caveman.js');
    const { written } = await enableCaveman(projectRoot, 'full');

    expect(written).toContain('.cursor/rules/vibeguard-caveman.mdc');
    expect(written).toContain('.windsurf/rules/vibeguard-caveman.md');

    const cursor = await readFile(join(projectRoot, CURSOR), 'utf-8');
    const windsurf = await readFile(join(projectRoot, WINDSURF), 'utf-8');
    expect(cursor).toContain('alwaysApply: true');
    expect(cursor).toContain('Caveman mode: ON');
    expect(windsurf).toContain('trigger: always_on');
    expect(windsurf).toContain('Caveman mode: ON');
  });

  it('creates cross-tool memory files (CLAUDE.md, AGENTS.md) and folds existing ones', async () => {
    await writeFile(join(projectRoot, 'CLAUDE.md'), '# Project\n\nNotes.\n', 'utf-8');
    await writeFile(join(projectRoot, '.windsurfrules'), 'existing windsurf rules\n', 'utf-8');

    const { enableCaveman, disableCaveman } = await import('../../src/engines/caveman.js');
    const { written } = await enableCaveman(projectRoot, 'full');
    // CLAUDE.md existed; AGENTS.md is created fresh; .windsurfrules folded.
    expect(written).toEqual(expect.arrayContaining(['CLAUDE.md', 'AGENTS.md', '.windsurfrules']));

    for (const f of ['CLAUDE.md', 'AGENTS.md', '.windsurfrules']) {
      const c = await readFile(join(projectRoot, f), 'utf-8');
      expect(c).toContain('vibeguard-caveman:begin');
      expect(c).toContain('Caveman mode: ON');
    }

    // Disable strips the block; existing files keep their original content,
    // and the file VibeGuard created (AGENTS.md) is removed entirely.
    await disableCaveman(projectRoot);
    const claude = await readFile(join(projectRoot, 'CLAUDE.md'), 'utf-8');
    expect(claude).toContain('Notes.');
    expect(claude).not.toContain('vibeguard-caveman:begin');
    expect(await exists(join(projectRoot, 'AGENTS.md'))).toBe(false);
    const windsurfRules = await readFile(join(projectRoot, '.windsurfrules'), 'utf-8');
    expect(windsurfRules).toContain('existing windsurf rules');
    expect(windsurfRules).not.toContain('vibeguard-caveman:begin');
  });

  it('creates the canonical IDE rule files even on a fresh project (Caveman works everywhere)', async () => {
    const { enableCaveman } = await import('../../src/engines/caveman.js');
    await enableCaveman(projectRoot, 'full');
    // Per-IDE rule files + created memory files are present without prior install.
    expect(await exists(join(projectRoot, KIRO))).toBe(true);
    expect(await exists(join(projectRoot, CURSOR))).toBe(true);
    expect(await exists(join(projectRoot, WINDSURF))).toBe(true);
    expect(await exists(join(projectRoot, 'CLAUDE.md'))).toBe(true);
    expect(await exists(join(projectRoot, 'AGENTS.md'))).toBe(true);
  });

  it('uninstall removes Kiro + Cursor + Windsurf rule files', async () => {
    await mkdir(join(projectRoot, '.cursor', 'rules'), { recursive: true });
    await mkdir(join(projectRoot, '.windsurf', 'rules'), { recursive: true });
    const { enableCaveman, disableCaveman } = await import('../../src/engines/caveman.js');
    await enableCaveman(projectRoot, 'full');

    const { removed } = await disableCaveman(projectRoot);
    expect(removed).toEqual(expect.arrayContaining([
      '.kiro/steering/vibeguard-caveman.md',
      '.cursor/rules/vibeguard-caveman.mdc',
      '.windsurf/rules/vibeguard-caveman.md',
    ]));
    expect(await exists(join(projectRoot, KIRO))).toBe(false);
    expect(await exists(join(projectRoot, CURSOR))).toBe(false);
    expect(await exists(join(projectRoot, WINDSURF))).toBe(false);
  });
});
