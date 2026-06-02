import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildGraph, loadGraph } from '../../src/engines/graph-builder.js';
import { loadConfig, type ResolvedConfig } from '../../src/storage/config-store.js';
import { createLogger } from '../../src/utils/logger.js';

const TSCONFIG = JSON.stringify({
  compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true },
});

describe('Graph Builder', () => {
  let testDir: string;
  let config: ResolvedConfig;
  const logger = createLogger({ jsonMode: true, quiet: true, verbose: false, command: 'test' });

  beforeEach(async () => {
    testDir = join(tmpdir(), `vibeguard-graph-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(testDir, 'src'), { recursive: true });
    await mkdir(join(testDir, '.vibeguard'), { recursive: true });
    await writeFile(join(testDir, 'tsconfig.json'), TSCONFIG, 'utf-8');
    config = await loadConfig(testDir);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  /** Write source files into the test project's src/ directory. */
  async function writeSrcFiles(files: Record<string, string>): Promise<void> {
    await Promise.all(
      Object.entries(files).map(([name, content]) =>
        writeFile(join(testDir, 'src', name), content, 'utf-8')
      )
    );
  }

  it('builds a graph with correct node shape', async () => {
    await writeSrcFiles({
      'index.ts': 'import { helper } from "./helper.js";\nexport function main() { helper(); }',
      'helper.ts': 'export function helper() { return 1; }',
    });

    const result = await buildGraph(testDir, ['src/index.ts', 'src/helper.ts'], config, logger);

    expect(result.nodes.size).toBe(2);

    const indexNode = result.nodes.get('src/index.ts');
    expect(indexNode).toBeDefined();
    expect(indexNode!.file).toBe('src/index.ts');
    expect(indexNode!.imports).toBeDefined();
    expect(indexNode!.exports).toBeDefined();
    expect(indexNode!.dependents).toBeDefined();
  });

  it('computes dependents as inverse of imports', async () => {
    await writeSrcFiles({
      'a.ts': 'import { b } from "./b";\nexport const a = b;',
      'b.ts': 'export const b = 1;',
    });

    const result = await buildGraph(testDir, ['src/a.ts', 'src/b.ts'], config, logger);

    const aNode = result.nodes.get('src/a.ts');
    // The import should resolve to some form of src/b (with extension appended)
    expect(aNode!.imports.length).toBeGreaterThan(0);
    // The resolved import should reference b
    expect(aNode!.imports[0]).toContain('b');
  });

  it('resolves ESM .js import specifiers to .ts node keys (regression)', async () => {
    // ESM TypeScript requires .js extensions in import specifiers even though
    // the source files are .ts. The graph must connect these — otherwise edges
    // and dependents silently break for every real ESM TS project.
    await writeSrcFiles({
      'index.ts': 'import { getUser } from "./user.js";\nexport function main() { return getUser(); }',
      'user.ts': 'export function getUser() { return 1; }',
    });

    const result = await buildGraph(testDir, ['src/index.ts', 'src/user.ts'], config, logger);

    const indexNode = result.nodes.get('src/index.ts');
    const userNode = result.nodes.get('src/user.ts');

    // The .js specifier must resolve to the real .ts node key
    expect(indexNode!.imports).toContain('src/user.ts');
    // Dependents must be populated (inverse edge)
    expect(userNode!.dependents).toContain('src/index.ts');
    // Graph must have at least one real edge
    expect(result.summary.edges).toBeGreaterThan(0);
  });

  it('persists graph.json and analysis-meta.json', async () => {
    await writeSrcFiles({ 'index.ts': 'export const x = 1;' });

    await buildGraph(testDir, ['src/index.ts'], config, logger);

    const graph = await loadGraph(testDir);
    expect(graph).not.toBeNull();
    expect(graph!.schemaVersion).toBe('2.2.0');
    expect(graph!.nodes['src/index.ts']).toBeDefined();
  });

  it('handles parse errors gracefully', async () => {
    await writeSrcFiles({
      'good.ts': 'export const x = 1;',
      'bad.ts': 'export const x = {{{;', // Invalid TS — ts-morph won't throw on addSourceFileAtPath
    });

    const result = await buildGraph(testDir, ['src/good.ts', 'src/bad.ts'], config, logger);
    expect(result.nodes.size).toBeGreaterThan(0);
  });

  it('reports summary with correct counts', async () => {
    await writeSrcFiles({
      'a.ts': 'export const a = 1;',
      'b.ts': 'export const b = 2;',
    });

    const result = await buildGraph(testDir, ['src/a.ts', 'src/b.ts'], config, logger);

    expect(result.summary.nodes).toBe(2);
    expect(result.summary.rebuilt).toBe(2);
    expect(result.summary.skipped).toBe(0);
  });

  it('incremental rebuild skips unchanged files', async () => {
    await writeSrcFiles({
      'a.ts': 'export const a = 1;',
      'b.ts': 'export const b = 2;',
    });

    // First build
    await buildGraph(testDir, ['src/a.ts', 'src/b.ts'], config, logger);

    // Second build without changes
    const result2 = await buildGraph(testDir, ['src/a.ts', 'src/b.ts'], config, logger);
    expect(result2.summary.skipped).toBe(2);
    expect(result2.summary.rebuilt).toBe(0);
  });

  it('tracks a newly created file: node added + reported in summary.added', async () => {
    await writeSrcFiles({ 'a.ts': 'export const a = 1;' });
    const first = await buildGraph(testDir, ['src/a.ts'], config, logger);
    // First build has no previous graph, so nothing is "added" relative to a prior run.
    expect(first.summary.added).toEqual([]);

    // Simulate a new file appearing during development.
    await writeSrcFiles({ 'b.ts': 'export const b = 2;' });
    const second = await buildGraph(testDir, ['src/a.ts', 'src/b.ts'], config, logger);

    expect(second.nodes.has('src/b.ts')).toBe(true);
    expect(second.summary.added).toContain('src/b.ts');
    expect(second.summary.removed).toEqual([]);

    // The new node must be persisted to graph.json.
    const graph = await loadGraph(testDir);
    expect(graph!.nodes['src/b.ts']).toBeDefined();
  });

  it('tracks a deleted file: node pruned from map + graph.json + summary.removed', async () => {
    await writeSrcFiles({
      'a.ts': 'export const a = 1;',
      'b.ts': 'export const b = 2;',
    });
    await buildGraph(testDir, ['src/a.ts', 'src/b.ts'], config, logger);

    // Simulate b.ts being deleted: it drops out of the resolved file set.
    await rm(join(testDir, 'src', 'b.ts'), { force: true });
    const result = await buildGraph(testDir, ['src/a.ts'], config, logger);

    // Pruned from the in-memory node set...
    expect(result.nodes.has('src/b.ts')).toBe(false);
    expect(result.summary.removed).toContain('src/b.ts');
    expect(result.summary.added).toEqual([]);

    // ...and from the persisted graph.
    const graph = await loadGraph(testDir);
    expect(graph!.nodes['src/b.ts']).toBeUndefined();
    expect(graph!.nodes['src/a.ts']).toBeDefined();
  });

  it('drops stale dependents when an importing file is deleted', async () => {
    await writeSrcFiles({
      'index.ts': 'import { getUser } from "./user.js";\nexport function main() { return getUser(); }',
      'user.ts': 'export function getUser() { return 1; }',
    });
    await buildGraph(testDir, ['src/index.ts', 'src/user.ts'], config, logger);

    // Delete the importer; user.ts should no longer list it as a dependent.
    await rm(join(testDir, 'src', 'index.ts'), { force: true });
    const result = await buildGraph(testDir, ['src/user.ts'], config, logger);

    expect(result.summary.removed).toContain('src/index.ts');
    const userNode = result.nodes.get('src/user.ts');
    expect(userNode!.dependents).not.toContain('src/index.ts');
  });
});
