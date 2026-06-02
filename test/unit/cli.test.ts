import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

const execFileAsync = promisify(execFile);
const cliPath = join(__dirname, '..', '..', 'dist', 'cli.js');
const pkgPath = join(__dirname, '..', '..', 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execFileAsync('node', [cliPath, ...args], {
      timeout: 10000,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      exitCode: e.code ?? 1,
    };
  }
}

describe('CLI Shell', () => {
  it('--version prints package version', async () => {
    const result = await runCli(['--version']);
    expect(result.stdout.trim()).toBe(pkg.version);
    expect(result.exitCode).toBe(0);
  });

  it('--help prints usage information', async () => {
    const result = await runCli(['--help']);
    expect(result.stdout).toContain('vibeguard');
    expect(result.stdout).toContain('doctor');
    expect(result.stdout).toContain('security');
    expect(result.stdout).toContain('clean');
    expect(result.stdout).toContain('map');
    expect(result.stdout).toContain('pack');
    expect(result.stdout).toContain('trash');
    expect(result.stdout).toContain('init');
    expect(result.exitCode).toBe(0);
  });

  it('all public subcommands are registered', async () => {
    const result = await runCli(['--help']);
    const commands = [
      'init',
      'map',
      'security',
      'clean',
      'pack',
      'doctor',
      'trash',
      'kiro',
      'cursor',
      'claude',
      'copilot',
      'gemini',
      'aider',
      'install',
      'uninstall',
      'attack',
      'config',
      'hook',
      'query',
      'path',
      'explain',
      'affected',
      'add',
      'watch',
      'benchmark',
      'graph',
      'serve',
      'review',
      'flows',
      'search',
    ];
    for (const cmd of commands) {
      expect(result.stdout).toContain(cmd);
    }
  });

  it('unknown command exits with code 1 and shows error', async () => {
    const result = await runCli(['nonexistent']);
    // Commander shows error for unknown commands
    expect(result.exitCode).not.toBe(0);
  });

  it('no subcommand does not crash', async () => {
    const result = await runCli([]);
    // CLI may exit 0 or 1 depending on config availability, but should not crash with code > 1
    expect(result.exitCode).toBeLessThanOrEqual(1);
  });
});
