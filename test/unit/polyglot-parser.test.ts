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

  it('captures aliases, declared symbols, and cross-file symbol uses', () => {
    const result = parseFile('app/views.py', [
      'from app.services import UserService as Service',
      'import app.models as models',
      '',
      'async def handler():',
      '    return Service(models.User())',
    ].join('\n'));

    expect(result.importBindings).toContainEqual({
      module: 'app.services',
      imported: 'UserService',
      local: 'Service',
      kind: 'named',
    });
    expect(result.importBindings).toContainEqual({
      module: 'app.models',
      imported: '*',
      local: 'models',
      kind: 'module',
    });
    expect(result.declaredSymbols?.some((symbol) => symbol.name === 'handler')).toBe(true);
    expect(result.symbolUses?.some((use) => use.symbol === 'Service' && use.kind === 'call')).toBe(true);
    expect(result.symbolUses?.some((use) => use.symbol === 'models.User' && use.member === 'User')).toBe(true);
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

  it('captures package, import aliases, and unexported declarations for same-package analysis', () => {
    const result = parseFile('internal/auth/handler.go', [
      'package auth',
      'import authsvc "github.com/acme/app/internal/service"',
      'func Handle() { validateToken(); authsvc.Login() }',
      'func validateToken() bool { return true }',
    ].join('\n'));

    expect(result.packageName).toBe('auth');
    expect(result.importBindings).toContainEqual({
      module: 'github.com/acme/app/internal/service',
      imported: '*',
      local: 'authsvc',
      kind: 'module',
    });
    expect(result.exports).toContain('Handle');
    expect(result.exports).not.toContain('validateToken');
    expect(result.declaredSymbols?.some((symbol) => symbol.name === 'validateToken' && !symbol.exported)).toBe(true);
    expect(result.symbolUses?.some((use) => use.symbol === 'authsvc.Login')).toBe(true);
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

  it('captures static imports, same-package type uses, and constructor references', () => {
    const result = parseFile('src/main/java/com/example/UserController.java', [
      'package com.example;',
      'import static com.example.Security.requireUser;',
      'public class UserController {',
      '  private UserService service;',
      '  public void handle() {',
      '    requireUser();',
      '    new UserService().load();',
      '  }',
      '}',
    ].join('\n'));

    expect(result.importBindings).toContainEqual({
      module: 'com.example.Security.requireUser',
      imported: 'requireUser',
      local: 'requireUser',
      kind: 'static',
    });
    expect(result.symbolUses?.some((use) => use.symbol === 'requireUser' && use.kind === 'call')).toBe(true);
    expect(result.symbolUses?.some((use) => use.symbol === 'UserService' && use.kind === 'type-reference')).toBe(true);
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
    expect(result.imports).toContain('utils/helper.py');
  });

  it('extracts wiki links and plain code-path references', () => {
    const result = parseFile('docs/architecture.md', [
      '# Architecture',
      'See [[docs/setup.md]] and app/main.py.',
      'The handler lives at `internal/auth/handler.go`.',
    ].join('\n'));

    expect(result.imports).toContain('docs/setup.md');
    expect(result.imports).toContain('app/main.py');
    expect(result.imports).toContain('internal/auth/handler.go');
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
