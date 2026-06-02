import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const execFileAsync = promisify(execFile);
const cliPath = join(__dirname, '..', '..', 'dist', 'cli.js');

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCli(args: string[], cwd?: string): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync('node', [cliPath, ...args], {
      timeout: 30000,
      cwd,
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

async function createTempProject(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `vg-int-${prefix}-`));
}

async function removeTempProject(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

const DEFAULT_TSCONFIG = JSON.stringify({
  compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext' },
  include: ['src/**/*'],
});

describe('Integration: init command', () => {
  let projectDir: string;

  beforeAll(async () => {
    projectDir = await createTempProject('init');
  });

  afterAll(async () => {
    await removeTempProject(projectDir);
  });

  it('creates .vibeguard/config.json', async () => {
    const result = await runCli(['init', '--json'], projectDir);
    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.schemaVersion).toBe('1.0.0');
    expect(parsed.message).toContain('Initialized');

    // Verify file exists
    const configContent = await readFile(join(projectDir, '.vibeguard', 'config.json'), 'utf-8');
    const config = JSON.parse(configContent);
    expect(config.ignore).toBeDefined();
    expect(Array.isArray(config.ignore)).toBe(true);
  });

  it('fails without --force when config exists', async () => {
    const result = await runCli(['init', '--json'], projectDir);
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.error.code).toBe('ALREADY_EXISTS');
  });

  it('succeeds with --force when config exists', async () => {
    const result = await runCli(['init', '--force', '--json'], projectDir);
    expect(result.exitCode).toBe(0);
  });
});

describe('Integration: map command', () => {
  let projectDir: string;

  beforeAll(async () => {
    projectDir = await createTempProject('map');
    await mkdir(join(projectDir, 'src'), { recursive: true });
    await writeFile(join(projectDir, 'src/index.ts'), 'import { helper } from "./utils.js";\nexport const main = helper();', 'utf-8');
    await writeFile(join(projectDir, 'src/utils.ts'), 'export function helper() { return 42; }', 'utf-8');
    await writeFile(join(projectDir, 'tsconfig.json'), DEFAULT_TSCONFIG, 'utf-8');
    await runCli(['init'], projectDir);
  });

  afterAll(async () => {
    await removeTempProject(projectDir);
  });

  it('builds graph and outputs JSON', async () => {
    const result = await runCli(['map', '--json'], projectDir);
    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.schemaVersion).toBe('1.0.0');
    expect(parsed.summary.nodes).toBeGreaterThanOrEqual(2);
    expect(parsed.summary.edges).toBeGreaterThanOrEqual(0);
    expect(parsed.outputs.graph).toBe('.vibeguard/graph.json');
  });

  it('creates graph.json file', async () => {
    const graphContent = await readFile(join(projectDir, '.vibeguard', 'graph.json'), 'utf-8');
    const graph = JSON.parse(graphContent);
    expect(graph.schemaVersion).toBe('2.2.0');
    expect(graph.nodes).toBeDefined();
  });
});

describe('Integration: security command', () => {
  let projectDir: string;

  beforeAll(async () => {
    projectDir = await createTempProject('sec');
    await mkdir(join(projectDir, 'src'), { recursive: true });
    await writeFile(join(projectDir, 'src/config.ts'), 'const apiKey = "sk-abcdefghijklmnopqrstuvwxyz1234";', 'utf-8');
    await runCli(['init'], projectDir);
  });

  afterAll(async () => {
    await removeTempProject(projectDir);
  });

  it('detects secrets and outputs JSON', async () => {
    const result = await runCli(['security', '--json'], projectDir);
    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.schemaVersion).toBe('1.0.0');
    expect(parsed.issues.length).toBeGreaterThan(0);
    expect(parsed.issues[0].category).toBe('hard-coded-secret');
    expect(parsed.counts.critical).toBeGreaterThan(0);
  });
});

describe('Integration: doctor command', () => {
  let projectDir: string;

  beforeAll(async () => {
    projectDir = await createTempProject('doc');
    await mkdir(join(projectDir, 'src'), { recursive: true });
    await writeFile(join(projectDir, 'src/index.ts'), 'export const x = 1;', 'utf-8');
    await runCli(['init'], projectDir);
  });

  afterAll(async () => {
    await removeTempProject(projectDir);
  });

  it('produces health scores in JSON', async () => {
    const result = await runCli(['doctor', '--json'], projectDir);
    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.schemaVersion).toBe('1.0.0');
    expect(parsed.summary).toBeDefined();
    expect(typeof parsed.summary.projectHealth).toBe('number');
    expect(parsed.summary.projectHealth).toBeGreaterThanOrEqual(0);
    expect(parsed.summary.projectHealth).toBeLessThanOrEqual(100);
  });
});

describe('Integration: pack command', () => {
  let projectDir: string;

  beforeAll(async () => {
    projectDir = await createTempProject('pack');
    await mkdir(join(projectDir, 'src'), { recursive: true });
    await writeFile(join(projectDir, 'src/auth.ts'), 'export function login() { return true; }', 'utf-8');
    await writeFile(join(projectDir, 'src/db.ts'), 'export function query() { return []; }', 'utf-8');
    await writeFile(join(projectDir, 'tsconfig.json'), DEFAULT_TSCONFIG, 'utf-8');
    await runCli(['init'], projectDir);
  });

  afterAll(async () => {
    await removeTempProject(projectDir);
  });

  it('generates context package in JSON', async () => {
    const result = await runCli(['pack', 'fix auth login', '--json'], projectDir);
    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.schemaVersion).toBe('1.0.0');
    expect(parsed.selectedFiles).toBeDefined();
    expect(parsed.tokenEstimates).toBeDefined();
    expect(parsed.packagePaths).toBeDefined();
    expect(parsed.packagePaths.md).toBe('.vibeguard/context-package.md');
    expect(parsed.packagePaths.json).toBe('.vibeguard/context-package.json');
  });

  it('creates context-package.md and .json files', async () => {
    const mdContent = await readFile(join(projectDir, '.vibeguard', 'context-package.md'), 'utf-8');
    expect(mdContent).toContain('Context Package');

    const jsonContent = await readFile(join(projectDir, '.vibeguard', 'context-package.json'), 'utf-8');
    const pkg = JSON.parse(jsonContent);
    expect(pkg.schemaVersion).toBe('1.0.0');
    expect(pkg.task).toContain('auth');
  });
});

describe('Integration: trash command', () => {
  let projectDir: string;

  beforeAll(async () => {
    projectDir = await createTempProject('trash');
    await runCli(['init'], projectDir);
  });

  afterAll(async () => {
    await removeTempProject(projectDir);
  });

  it('list returns empty when no trash', async () => {
    const result = await runCli(['trash', 'list', '--json'], projectDir);
    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.schemaVersion).toBe('1.0.0');
    expect(parsed.entries).toEqual([]);
  });

  it('purge without --yes fails', async () => {
    const result = await runCli(['trash', 'purge', '--json'], projectDir);
    expect(result.exitCode).toBe(1);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.error.code).toBe('LIMIT_EXCEEDED');
  });
});

describe('Integration: --json output validity', () => {
  let projectDir: string;

  beforeAll(async () => {
    projectDir = await createTempProject('json');
    await mkdir(join(projectDir, 'src'), { recursive: true });
    await writeFile(join(projectDir, 'src/index.ts'), 'export const x = 1;', 'utf-8');
    await runCli(['init'], projectDir);
  });

  afterAll(async () => {
    await removeTempProject(projectDir);
  });

  it('all commands produce valid JSON with schemaVersion', async () => {
    const commands = [
      ['map', '--json'],
      ['security', '--json'],
      ['attack', '--json'],
      ['doctor', '--json'],
      ['clean', '--plan', '--json'],
      ['benchmark', '--json'],
      ['graph', '--no-open', '--json'],
      ['query', 'describe index', '--json'],
      ['path', 'src/index.ts', 'src/index.ts', '--json'],
      ['explain', 'src/index.ts', '--json'],
      ['affected', 'src/index.ts', '--json'],
      ['trash', 'list', '--json'],
      ['hook', 'status', '--json'],
      ['install', '--platform', 'cursor', '--json'],
      ['uninstall', '--platform', 'cursor', '--json'],
    ];

    for (const args of commands) {
      const result = await runCli(args, projectDir);
      expect(result.exitCode).toBe(0);

      const parsed = JSON.parse(result.stdout);
      expect(parsed.schemaVersion).toBe('1.0.0');
    }
  });

  it('rejects unknown install platforms instead of silently installing Kiro', async () => {
    const result = await runCli(['install', '--platform', 'unknown-editor', '--json'], projectDir);
    expect(result.exitCode).toBe(2);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.schemaVersion).toBe('1.0.0');
    expect(parsed.error.code).toBe('UNKNOWN_OPTION');
    expect(parsed.error.details.validPlatforms).toContain('kiro');
  });
});

describe('Integration: --dry-run produces no mutations', () => {
  let projectDir: string;

  beforeAll(async () => {
    projectDir = await createTempProject('dry');
    await mkdir(join(projectDir, 'src'), { recursive: true });
    await writeFile(join(projectDir, 'src/index.ts'), 'export const x = 1;', 'utf-8');
    await writeFile(join(projectDir, '.env'), 'SECRET=value', 'utf-8');
    await runCli(['init'], projectDir);
  });

  afterAll(async () => {
    await removeTempProject(projectDir);
  });

  it('security --fix=gitignore --dry-run does not modify .gitignore', async () => {
    await runCli(['security', '--fix', 'gitignore', '--dry-run'], projectDir);

    expect(await fileExists(join(projectDir, '.gitignore'))).toBe(false);
  });
});
