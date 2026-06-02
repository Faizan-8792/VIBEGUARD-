/**
 * Graph Index — a pure-TypeScript, zero-native-dependency indexed view over the
 * dependency graph, with an inverted-index full-text search (FTS).
 *
 * Why not SQLite? VibeGuard's requirements mandate "no native compilation"
 * (requirements.md Req 1.10). `better-sqlite3` is a native module, so instead of
 * adding a build-time native dependency we build the same capabilities — fast
 * keyed lookup and full-text search — in plain TypeScript over the existing
 * graph data. This keeps installs friction-free on every platform while still
 * giving downstream tools (query, search) indexed access instead of linear scans.
 */

import type { GraphData, GraphNode } from './graph-builder.js';

export interface FtsHit {
  file: string;
  score: number;
  /** Which fields matched, for transparency/debugging. */
  matchedFields: string[];
}

export interface SearchOptions {
  /** Max hits to return (default 20). */
  limit?: number;
}

/**
 * Tokenize an identifier-rich string into lowercased search terms.
 * Splits on non-alphanumerics AND on camelCase / PascalCase boundaries, so
 * `getUserName` → ["get","user","name","getusername"] and
 * `auth-service.ts` → ["auth","service","ts"].
 */
export function tokenize(input: string): string[] {
  if (!input) return [];
  const tokens = new Set<string>();

  // Split on separators (path, punctuation, whitespace).
  const rawParts = input.split(/[^A-Za-z0-9]+/).filter((p) => p.length > 0);

  for (const part of rawParts) {
    const lower = part.toLowerCase();
    tokens.add(lower);

    // Split camelCase / PascalCase / digit boundaries into sub-words.
    const subWords = part
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .replace(/([a-zA-Z])([0-9])/g, '$1 $2')
      .split(/\s+/)
      .filter((w) => w.length > 0);

    for (const w of subWords) {
      tokens.add(w.toLowerCase());
    }
  }

  return [...tokens];
}

/**
 * An in-memory index over a graph: keyed node lookup plus an inverted index
 * (term → set of file keys) for full-text search. Built once, queried many times.
 */
export class GraphIndex {
  private readonly nodes: Map<string, GraphNode>;
  /** term -> set of node keys containing that term. */
  private readonly invertedIndex: Map<string, Set<string>>;
  /** node key -> its full token set, for scoring. */
  private readonly nodeTokens: Map<string, Set<string>>;

  constructor(graph: GraphData) {
    this.nodes = new Map(Object.entries(graph.nodes));
    this.invertedIndex = new Map();
    this.nodeTokens = new Map();
    this.build();
  }

  private build(): void {
    for (const [key, node] of this.nodes) {
      const tokenSet = new Set<string>();

      // Index the file path and every export name (the "signature" surface).
      for (const t of tokenize(node.file)) tokenSet.add(t);
      for (const exp of node.exports) {
        for (const t of tokenize(exp)) tokenSet.add(t);
      }

      this.nodeTokens.set(key, tokenSet);
      for (const term of tokenSet) {
        let bucket = this.invertedIndex.get(term);
        if (!bucket) {
          bucket = new Set<string>();
          this.invertedIndex.set(term, bucket);
        }
        bucket.add(key);
      }
    }
  }

  /** Number of indexed nodes. */
  get size(): number {
    return this.nodes.size;
  }

  /** Number of distinct indexed terms. */
  get termCount(): number {
    return this.invertedIndex.size;
  }

  /** O(1) exact node lookup by key (file path). */
  getNode(key: string): GraphNode | undefined {
    return this.nodes.get(key);
  }

  /**
   * Full-text search over indexed node names/paths/exports.
   *
   * Scoring (simple, deterministic, explainable):
   * - +2 for each query term that matches a node term exactly
   * - +1 for each query term that is a prefix of some node term
   * - ×1.5 multiplier when the node's basename matches a query term (name boost)
   * Results are sorted by score desc, then file path asc for stable ordering.
   */
  search(query: string, opts: SearchOptions = {}): FtsHit[] {
    const limit = opts.limit ?? 20;
    const queryTerms = tokenize(query);
    if (queryTerms.length === 0) return [];

    const scores = new Map<string, { score: number; fields: Set<string> }>();

    for (const qTerm of queryTerms) {
      // Exact term matches via the inverted index (fast path).
      const exact = this.invertedIndex.get(qTerm);
      if (exact) {
        for (const key of exact) {
          const entry = scores.get(key) ?? { score: 0, fields: new Set<string>() };
          entry.score += 2;
          entry.fields.add(qTerm);
          scores.set(key, entry);
        }
      }

      // Prefix matches (e.g. "auth" matches "authenticate"). Bounded by termCount.
      if (qTerm.length >= 3) {
        for (const [term, keys] of this.invertedIndex) {
          if (term !== qTerm && term.startsWith(qTerm)) {
            for (const key of keys) {
              const entry = scores.get(key) ?? { score: 0, fields: new Set<string>() };
              entry.score += 1;
              entry.fields.add(qTerm);
              scores.set(key, entry);
            }
          }
        }
      }
    }

    // Apply a basename name-boost.
    for (const [key, entry] of scores) {
      const node = this.nodes.get(key);
      if (!node) continue;
      const base = node.file.split('/').pop() ?? node.file;
      const baseTokens = new Set(tokenize(base));
      if (queryTerms.some((q) => baseTokens.has(q))) {
        entry.score *= 1.5;
      }
    }

    const hits: FtsHit[] = [];
    for (const [key, entry] of scores) {
      hits.push({ file: key, score: Math.round(entry.score * 100) / 100, matchedFields: [...entry.fields] });
    }

    hits.sort((a, b) => (b.score - a.score) || a.file.localeCompare(b.file));
    return hits.slice(0, limit);
  }
}

/** Convenience factory. */
export function buildGraphIndex(graph: GraphData): GraphIndex {
  return new GraphIndex(graph);
}
