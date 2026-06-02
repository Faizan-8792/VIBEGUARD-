import { describe, it, expect } from 'vitest';
import { buildGraphIndex, tokenize } from '../../src/engines/graph-index.js';
import type { GraphData } from '../../src/engines/graph-builder.js';

function node(file: string, exports: string[] = [], imports: string[] = []) {
  return { file, imports, exports, dependents: [], edges: [] };
}

const graph: GraphData = {
  schemaVersion: '2.1.0',
  nodes: {
    'src/auth/auth-service.ts': node('src/auth/auth-service.ts', ['authenticate', 'AuthService']),
    'src/auth/token.ts': node('src/auth/token.ts', ['signToken', 'verifyToken']),
    'src/users/user-repository.ts': node('src/users/user-repository.ts', ['UserRepository', 'findUser']),
    'src/index.ts': node('src/index.ts', ['main']),
  },
  edges: [],
};

describe('tokenize', () => {
  it('splits camelCase into sub-words plus the whole token', () => {
    const tokens = tokenize('getUserName');
    expect(tokens).toContain('get');
    expect(tokens).toContain('user');
    expect(tokens).toContain('name');
    expect(tokens).toContain('getusername');
  });

  it('splits path and punctuation', () => {
    const tokens = tokenize('auth-service.ts');
    expect(tokens).toContain('auth');
    expect(tokens).toContain('service');
    expect(tokens).toContain('ts');
  });

  it('returns empty array for empty input', () => {
    expect(tokenize('')).toEqual([]);
  });
});

describe('GraphIndex', () => {
  it('indexes every node and builds a term vocabulary', () => {
    const idx = buildGraphIndex(graph);
    expect(idx.size).toBe(4);
    expect(idx.termCount).toBeGreaterThan(0);
  });

  it('provides O(1) exact node lookup', () => {
    const idx = buildGraphIndex(graph);
    expect(idx.getNode('src/auth/token.ts')?.exports).toContain('signToken');
    expect(idx.getNode('does/not/exist.ts')).toBeUndefined();
  });

  it('finds nodes by export name (exact term match)', () => {
    const idx = buildGraphIndex(graph);
    const hits = idx.search('authenticate');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].file).toBe('src/auth/auth-service.ts');
  });

  it('finds nodes by path token', () => {
    const idx = buildGraphIndex(graph);
    const hits = idx.search('user');
    const files = hits.map((h) => h.file);
    expect(files).toContain('src/users/user-repository.ts');
  });

  it('supports prefix matching', () => {
    const idx = buildGraphIndex(graph);
    const hits = idx.search('auth');
    // "auth" should match auth-service.ts and token.ts (verifyToken? no) via path/exports
    expect(hits.some((h) => h.file === 'src/auth/auth-service.ts')).toBe(true);
  });

  it('ranks basename matches higher and returns stable order', () => {
    const idx = buildGraphIndex(graph);
    const hits = idx.search('token');
    expect(hits[0].file).toBe('src/auth/token.ts');
    expect(hits[0].score).toBeGreaterThan(0);
  });

  it('honors the result limit', () => {
    const idx = buildGraphIndex(graph);
    const hits = idx.search('src', { limit: 2 });
    expect(hits.length).toBeLessThanOrEqual(2);
  });

  it('returns empty for a query with no matches', () => {
    const idx = buildGraphIndex(graph);
    expect(idx.search('zzzznomatch')).toEqual([]);
  });
});
