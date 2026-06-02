import { describe, it, expect } from 'vitest';
import { embedText, cosineSimilarity, SemanticIndex, hybridSearch } from '../../src/engines/embeddings.js';
import type { GraphData } from '../../src/engines/graph-builder.js';

function n(file: string, exports: string[] = []) {
  return { file, imports: [], exports, dependents: [], edges: [] };
}

const graph: GraphData = {
  schemaVersion: '2.1.0',
  nodes: {
    'src/auth/authentication-service.ts': n('src/auth/authentication-service.ts', ['authenticate', 'login', 'logout']),
    'src/users/user-repository.ts': n('src/users/user-repository.ts', ['findUser', 'createUser']),
    'src/payments/stripe-gateway.ts': n('src/payments/stripe-gateway.ts', ['charge', 'refund']),
  },
};

describe('embedText / cosineSimilarity', () => {
  it('produces deterministic vectors', () => {
    const a = embedText('authenticate login user');
    const b = embedText('authenticate login user');
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('returns a zero vector for empty input', () => {
    const v = embedText('');
    expect(v.every((x) => x === 0)).toBe(true);
  });

  it('a vector is identical to itself (similarity ~1)', () => {
    const v = embedText('payment stripe charge');
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it('related text scores higher than unrelated text', () => {
    const query = embedText('user login authentication');
    const related = embedText('authenticate login logout');
    const unrelated = embedText('stripe charge refund payment');
    expect(cosineSimilarity(query, related)).toBeGreaterThan(cosineSimilarity(query, unrelated));
  });
});

describe('SemanticIndex', () => {
  it('embeds every node', () => {
    const idx = new SemanticIndex(graph);
    expect(idx.size).toBe(3);
  });

  it('ranks the most semantically relevant node first', () => {
    const idx = new SemanticIndex(graph);
    const hits = idx.search('authenticate login');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].file).toBe('src/auth/authentication-service.ts');
  });
});

describe('hybridSearch', () => {
  it('combines keyword and semantic signals', () => {
    const hits = hybridSearch(graph, 'authenticate');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].file).toBe('src/auth/authentication-service.ts');
    expect(hits[0].score).toBeGreaterThan(0);
  });

  it('finds payment files for a payment query', () => {
    const hits = hybridSearch(graph, 'charge payment');
    expect(hits.some((h) => h.file === 'src/payments/stripe-gateway.ts')).toBe(true);
  });

  it('honors the result limit', () => {
    const hits = hybridSearch(graph, 'user', { limit: 1 });
    expect(hits.length).toBeLessThanOrEqual(1);
  });
});
