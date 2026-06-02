import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildGraph } from '../../src/engines/graph-builder.js';
import { scanSecurity } from '../../src/engines/security-scanner.js';
import { computeTags } from '../../src/engines/tagging-engine.js';
import { loadConfig, type ResolvedConfig } from '../../src/storage/config-store.js';
import { createLogger } from '../../src/utils/logger.js';

const logger = createLogger({ jsonMode: true, quiet: true, verbose: false, command: 'test' });

describe('Integration: Polyglot graph building', () => {
  let testDir: string;
  let config: ResolvedConfig;

  beforeEach(async () => {
    testDir = join(tmpdir(), `vibeguard-polyglot-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(testDir, '.vibeguard'), { recursive: true });
    config = await loadConfig(testDir);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  async function writeFiles(files: Record<string, string>): Promise<void> {
    for (const [path, content] of Object.entries(files)) {
      const full = join(testDir, path);
      await mkdir(join(full, '..'), { recursive: true });
      await writeFile(full, content, 'utf-8');
    }
  }

  it('connects a Python project graph (imports resolve to dependents)', async () => {
    await writeFiles({
      'app/main.py': 'from app.models import User\nfrom app.views import index\n\ndef run():\n    pass\n',
      'app/models.py': 'class User:\n    pass\n',
      'app/views.py': 'from app.models import User\n\ndef index():\n    pass\n',
      'app/__init__.py': '',
    });

    const files = ['app/main.py', 'app/models.py', 'app/views.py', 'app/__init__.py'];
    const result = await buildGraph(testDir, files, config, logger);

    const main = result.nodes.get('app/main.py');
    const models = result.nodes.get('app/models.py');

    // main.py imports must resolve to actual file paths
    expect(main!.imports).toContain('app/models.py');
    expect(main!.imports).toContain('app/views.py');

    // models.py must have dependents (main + views import it)
    expect(models!.dependents).toContain('app/main.py');
    expect(models!.dependents).toContain('app/views.py');

    // Graph must have real edges, not be disconnected
    expect(result.summary.edges).toBeGreaterThan(0);
  });

  it('connects a Java project graph by fully-qualified imports', async () => {
    await writeFiles({
      'src/main/java/com/example/app/UserController.java':
        'package com.example.app;\n\nimport com.example.app.UserService;\n\npublic class UserController {\n  public void handle() {}\n}\n',
      'src/main/java/com/example/app/UserService.java':
        'package com.example.app;\n\npublic class UserService {\n  public void doWork() {}\n}\n',
    });

    const files = [
      'src/main/java/com/example/app/UserController.java',
      'src/main/java/com/example/app/UserService.java',
    ];
    const result = await buildGraph(testDir, files, config, logger);

    const controller = result.nodes.get('src/main/java/com/example/app/UserController.java');
    expect(controller!.imports).toContain('src/main/java/com/example/app/UserService.java');

    const service = result.nodes.get('src/main/java/com/example/app/UserService.java');
    expect(service!.dependents).toContain('src/main/java/com/example/app/UserController.java');
  });

  it('detects Python security vulnerabilities', async () => {
    await writeFiles({
      'app/danger.py': [
        'import os',
        'import pickle',
        '',
        'def run(cmd, data):',
        '    eval(cmd)',
        '    os.system(cmd)',
        '    return pickle.loads(data)',
      ].join('\n'),
    });

    const result = await scanSecurity(testDir, ['app/danger.py'], config);
    const codes = result.issues.map((i) => i.id);

    // eval, os.system, pickle.loads should all be flagged
    expect(codes.some((c) => c.includes('PY-001'))).toBe(true); // eval
    expect(codes.some((c) => c.includes('PY-004'))).toBe(true); // os.system
    expect(codes.some((c) => c.includes('PY-005'))).toBe(true); // pickle
    expect(result.counts.critical).toBeGreaterThan(0);
  });

  it('detects Java security vulnerabilities', async () => {
    await writeFiles({
      'src/Db.java': [
        'package app;',
        'public class Db {',
        '  public void query(String id) {',
        '    stmt.executeQuery("SELECT * FROM users WHERE id = " + id);',
        '  }',
        '}',
      ].join('\n'),
    });

    const result = await scanSecurity(testDir, ['src/Db.java'], config);
    expect(result.issues.some((i) => i.id.includes('JAVA-001'))).toBe(true); // SQL injection
  });

  it('tags polyglot files by language and framework role', async () => {
    await writeFiles({
      'app/models.py': 'class User:\n    pass\n',
      'cmd/main.go': 'package main\nfunc main() {}\n',
      'src/UserController.java': 'package app;\npublic class UserController {}\n',
      'README.md': '# Project\n## Setup\n',
    });

    const files = ['app/models.py', 'cmd/main.go', 'src/UserController.java', 'README.md'];
    const result = await buildGraph(testDir, files, config, logger);
    const tags = await computeTags(testDir, result.nodes, config);

    expect(tags['app/models.py']).toContain('python');
    expect(tags['app/models.py']).toContain('model');
    expect(tags['cmd/main.go']).toContain('go');
    expect(tags['cmd/main.go']).toContain('entrypoint');
    expect(tags['src/UserController.java']).toContain('java');
    expect(tags['src/UserController.java']).toContain('controller');
    expect(tags['README.md']).toContain('documentation');
    expect(tags['README.md']).toContain('readme');
  });

  it('links markdown docs to code files via references', async () => {
    await writeFiles({
      'docs/architecture.md': '# Architecture\nThe entry is [main](../app/main.py).\n',
      'app/main.py': 'def run():\n    pass\n',
    });

    const files = ['docs/architecture.md', 'app/main.py'];
    const result = await buildGraph(testDir, files, config, logger);

    const doc = result.nodes.get('docs/architecture.md');
    expect(doc!.imports).toContain('app/main.py');

    const code = result.nodes.get('app/main.py');
    expect(code!.dependents).toContain('docs/architecture.md');
  });
});
