import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runBenchmark } from '../../src/commands/benchmark.js';
import { loadConfig, type ResolvedConfig } from '../../src/storage/config-store.js';
import { createLogger } from '../../src/utils/logger.js';
import type { CommandContext } from '../../src/context.js';

describe('Integration: benchmark command', () => {
  let testDir: string;
  let config: ResolvedConfig;

  beforeEach(async () => {
    testDir = join(tmpdir(), `vibeguard-bench-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(testDir, 'src'), { recursive: true });
    await mkdir(join(testDir, '.vibeguard'), { recursive: true });
    config = await loadConfig(testDir);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function makeCtx(json: boolean): CommandContext {
    return {
      options: { json, cwd: testDir, include: [], exclude: [], config: undefined, verbose: false, quiet: true },
      config,
      logger: createLogger({ jsonMode: json, quiet: true, verbose: false, command: 'benchmark' }),
      projectRoot: testDir,
    };
  }

  it('reports positive token reduction for a multi-file project', async () => {
    // Create a realistic project — larger than the query neighborhood
    for (let i = 0; i < 20; i++) {
      const body = `import { dep${i} } from './f${(i + 1) % 20}.js';\n` + 'export const x = 1;\n'.repeat(80);
      await writeFile(join(testDir, 'src', `f${i}.ts`), body, 'utf-8');
    }

    let captured = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      captured += chunk.toString();
      return true;
    });

    await runBenchmark(makeCtx(true), {});
    spy.mockRestore();

    const parsed = JSON.parse(captured);
    expect(parsed.files).toBeGreaterThanOrEqual(20);
    expect(parsed.baseline.fullReadTokens).toBeGreaterThan(0);
    // Typical query must use fewer tokens than reading everything
    expect(parsed.vibeguard.typicalQueryTokens).toBeLessThan(parsed.baseline.fullReadTokens);
    expect(parsed.reduction.factor).toBeGreaterThan(1);
    // Graph build cost is always 0 (local)
    expect(parsed.vibeguard.graphBuildTokens).toBe(0);
  });

  it('honors a custom chars-per-token divisor', async () => {
    await writeFile(join(testDir, 'src', 'a.ts'), 'export const a = 1;\n'.repeat(50), 'utf-8');

    let captured = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      captured += chunk.toString();
      return true;
    });

    await runBenchmark(makeCtx(true), { charsPerToken: 2 });
    spy.mockRestore();

    const parsed = JSON.parse(captured);
    expect(parsed.charsPerToken).toBe(2);
    expect(parsed.baseline.fullReadTokens).toBeGreaterThan(0);
  });
});
