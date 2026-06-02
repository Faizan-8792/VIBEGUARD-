import { describe, it, expect } from 'vitest';
import {
  detectLanguage,
  parseFile,
  resolvePolyglotImports,
} from '../../src/engines/polyglot-parser.js';

describe('Polyglot Parser — language detection', () => {
  it('detects languages by extension', () => {
    expect(detectLanguage('app/main.py')).toBe('python');
    expect(detectLanguage('script.pyw')).toBe('python');
    expect(detectLanguage('cmd/main.go')).toBe('go');
    expect(detectLanguage('src/Main.java')).toBe('java');
    expect(detectLanguage('README.md')).toBe('markdown');
    expect(detectLanguage('docs/guide.mdx')).toBe('markdown');
    expect(detectLanguage('src/index.ts')).toBe('typescript');
    expect(detectLanguage('data.csv')).toBe('unknown');
  });
});

describe('Polyglot Parser — Python', () => {
  it('extracts imports and exports', () => {
    const result = parseFile('app/views.py', [
      'import os',
      'import sys as system',
      'from django.http import HttpResponse',
      'from .models import User',
      '',
      'def get_users(request):',
      '    pass',
      '',
      'class UserView:',
      '    pass',
      '',
      'def _private_helper():',
      '    pass',
    ].join('\n'));

    expect(result.language).toBe('python');
    expect(result.imports).toContain('os');
    expect(result.imports).toContain('sys');
    expect(result.imports).toContain('django.http');
    expect(result.imports).toContain('.models');
    expect(result.exports).toContain('get_users');
    expect(result.exports).toContain('UserView');
    // Private functions are not exported
    expect(result.exports).not.toContain('_private_helper');
  });

  it('extracts __all__ exports', () => {
    const result = parseFile('app/api.py', '__all__ = ["foo", "bar"]\n');
    expect(result.exports).toContain('foo');
    expect(result.exports).toContain('bar');
  });
});

describe('Polyglot Parser — Go', () => {
  it('extracts single and block imports', () => {
    const result = parseFile('main.go', [
      'package main',
      '',
      'import "fmt"',
      '',
      'import (',
      '  "net/http"',
      '  "github.com/example/pkg"',
      ')',
      '',
      'func HandleRequest() {}',
      'type UserService struct {}',
      'func privateFunc() {}',
    ].join('\n'));

    expect(result.language).toBe('go');
    expect(result.imports).toContain('fmt');
    expect(result.imports).toContain('net/http');
    expect(result.imports).toContain('github.com/example/pkg');
    // Only exported (uppercase) symbols
    expect(result.exports).toContain('HandleRequest');
    expect(result.exports).toContain('UserService');
    expect(result.exports).not.toContain('privateFunc');
  });
});

describe('Polyglot Parser — Java', () => {
  it('extracts imports, package, and public members', () => {
    const result = parseFile('src/main/java/com/example/UserController.java', [
      'package com.example.app;',
      '',
      'import java.util.List;',
      'import static org.junit.Assert.assertEquals;',
      '',
      'public class UserController {',
      '  public List getUsers() { return null; }',
      '}',
    ].join('\n'));

    expect(result.language).toBe('java');
    expect(result.imports).toContain('java.util.List');
    expect(result.imports).toContain('org.junit.Assert.assertEquals');
    expect(result.exports).toContain('UserController');
    expect(result.exports).toContain('package:com.example.app');
  });
});

describe('Polyglot Parser — Markdown', () => {
  it('extracts headings, links, and code references', () => {
    const result = parseFile('README.md', [
      '# My Project',
      '## Installation',
      'See [config](./src/config.ts) and the `utils/helper.py` module.',
      'External [link](https://example.com) is ignored.',
    ].join('\n'));

    expect(result.language).toBe('markdown');
    expect(result.concepts).toContain('My Project');
    expect(result.concepts).toContain('Installation');
    expect(result.imports).toContain('./src/config.ts');
    // External URLs are not tracked as imports
    expect(result.imports).not.toContain('https://example.com');
    expect(result.references).toContain('utils/helper.py');
  });
});

describe('Polyglot Parser — import resolution', () => {
  it('resolves Python absolute and relative imports to file paths', () => {
    const files = new Set(['app/main.py', 'app/models.py', 'app/views.py', 'app/__init__.py']);

    const mainImports = resolvePolyglotImports('app/main.py', ['app.models', 'app.views', 'os'], files);
    expect(mainImports).toContain('app/models.py');
    expect(mainImports).toContain('app/views.py');
    // External stdlib import does not resolve
    expect(mainImports).not.toContain('os');

    const viewsImports = resolvePolyglotImports('app/views.py', ['.models'], files);
    expect(viewsImports).toContain('app/models.py');
  });

  it('resolves Java fully-qualified imports to file paths', () => {
    const files = new Set([
      'src/main/java/com/example/app/UserController.java',
      'src/main/java/com/example/app/UserService.java',
    ]);
    const resolved = resolvePolyglotImports(
      'src/main/java/com/example/app/UserController.java',
      ['com.example.app.UserService', 'java.util.List'],
      files,
    );
    expect(resolved).toContain('src/main/java/com/example/app/UserService.java');
    expect(resolved).not.toContain('java.util.List');
  });

  it('resolves Go package imports to files in matching directories', () => {
    const files = new Set(['main.go', 'internal/auth/auth.go', 'internal/db/db.go']);
    const resolved = resolvePolyglotImports(
      'main.go',
      ['github.com/me/proj/internal/auth', 'fmt'],
      files,
    );
    expect(resolved).toContain('internal/auth/auth.go');
    expect(resolved).not.toContain('fmt');
  });

  it('resolves Markdown relative links to project files', () => {
    const files = new Set(['docs/guide.md', 'src/config.ts']);
    const resolved = resolvePolyglotImports('docs/guide.md', ['../src/config.ts'], files);
    expect(resolved).toContain('src/config.ts');
  });
});
