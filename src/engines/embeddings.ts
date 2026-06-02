/**
 * Embeddings — local-first semantic search over graph nodes.
 *
 * The default provider is a deterministic, dependency-free "hashing embedding":
 * each node's signature text (path + export names) is tokenized and hashed into
 * a fixed-dimension vector. This gives meaningful local semantic similarity with
 * zero network calls and zero native dependencies — consistent with VibeGuard's
 * local-first, zero-token guarantees.
 *
 * The design leaves room for optional cloud providers later (OpenAI-compatible,
 * Gemini) behind an explicit opt-in, but none are wired by default.
 */

import type { GraphData, GraphNode } from './graph-builder.js';
import { tokenize, GraphIndex } from './graph-index.js';

const DIMENSION = 128;

export interface SemanticHit {
  file: string;
  /** Cosine similarity in [0, 1]. */
  similarity: number;
}

export interface HybridHit {
  file: string;
  /** Combined score: keyword FTS score normalized + semantic similarity. */
  score: number;
  ftsScore: number;
  similarity: number;
}

/** Stable 32-bit string hash (FNV-1a). Deterministic across runs/machines. */
function hash32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Embed a piece of text into a fixed-dimension L2-normalized vector using the
 * hashing trick: each token contributes to a hashed dimension (with a signed
 * secondary hash to reduce collisions). Identifier sub-words are weighted so
 * that `getUserName` and `username` land near each other.
 */
export function embedText(text: string): Float64Array {
  const vec = new Float64Array(DIMENSION);
  const tokens = tokenize(text);
  if (tokens.length === 0) return vec;

  for (const token of tokens) {
    const idx = hash32(token) % DIMENSION;
    const sign = (hash32('s:' + token) & 1) === 0 ? 1 : -1;
    vec[idx] += sign;
  }

  // L2 normalize so cosine similarity reduces to a dot product.
  let norm = 0;
  for (let i = 0; i < DIMENSION; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < DIMENSION; i++) vec[i] /= norm;
  }
  return vec;
}

/** Cosine similarity of two L2-normalized vectors (dot product), clamped to [0,1]. */
export function cosineSimilarity(a: Float64Array, b: Float64Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  // Hashing trick can produce small negatives; clamp to [0,1] for a clean score.
  return Math.max(0, Math.min(1, dot));
}

/** Build the signature text a node is embedded/searched on. */
function nodeText(node: GraphNode): string {
  const base = node.file.split('/').pop() ?? node.file;
  return [node.file, base, ...node.exports].join(' ');
}

/**
 * An in-memory semantic index: one embedding per graph node. Built once,
 * queried many times. Deterministic and local.
 */
export class SemanticIndex {
  private readonly vectors: Map<string, Float64Array>;

  constructor(graph: GraphData) {
    this.vectors = new Map();
    for (const [key, node] of Object.entries(graph.nodes)) {
      this.vectors.set(key, embedText(nodeText(node)));
    }
  }

  get size(): number {
    return this.vectors.size;
  }

  /** Pure semantic search: rank nodes by cosine similarity to the query. */
  search(query: string, opts: { limit?: number } = {}): SemanticHit[] {
    const qVec = embedText(query);
    const hits: SemanticHit[] = [];
    for (const [file, vec] of this.vectors) {
      const similarity = Math.round(cosineSimilarity(qVec, vec) * 1000) / 1000;
      if (similarity > 0) hits.push({ file, similarity });
    }
    hits.sort((a, b) => b.similarity - a.similarity || a.file.localeCompare(b.file));
    return hits.slice(0, opts.limit ?? 20);
  }
}

/**
 * Hybrid search: combine keyword FTS (exact/prefix term matches) with semantic
 * similarity. FTS scores are normalized to [0,1] by the top hit, then blended
 * with similarity (weighted toward keyword precision, with semantic as a
 * recall booster). Deterministic and local.
 */
export function hybridSearch(
  graph: GraphData,
  query: string,
  opts: { limit?: number; ftsWeight?: number } = {},
): HybridHit[] {
  const limit = opts.limit ?? 20;
  const ftsWeight = opts.ftsWeight ?? 0.6;
  const semanticWeight = 1 - ftsWeight;

  const index = new GraphIndex(graph);
  const semantic = new SemanticIndex(graph);

  const ftsHits = index.search(query, { limit: 200 });
  const maxFts = ftsHits.length > 0 ? Math.max(...ftsHits.map((h) => h.score)) : 0;
  const ftsByFile = new Map(ftsHits.map((h) => [h.file, h.score]));

  const semHits = semantic.search(query, { limit: 200 });
  const simByFile = new Map(semHits.map((h) => [h.file, h.similarity]));

  // Union of candidate files from both retrievers.
  const candidates = new Set<string>([...ftsByFile.keys(), ...simByFile.keys()]);

  const results: HybridHit[] = [];
  for (const file of candidates) {
    const rawFts = ftsByFile.get(file) ?? 0;
    const normFts = maxFts > 0 ? rawFts / maxFts : 0;
    const similarity = simByFile.get(file) ?? 0;
    const score = Math.round((normFts * ftsWeight + similarity * semanticWeight) * 1000) / 1000;
    if (score > 0) {
      results.push({ file, score, ftsScore: rawFts, similarity });
    }
  }

  results.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  return results.slice(0, limit);
}
