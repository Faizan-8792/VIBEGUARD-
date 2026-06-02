/**
 * Change Detector — risk-scored review of a set of changed files.
 *
 * Given the changed files, the dependency graph, and importance scores, this
 * computes each change's "blast radius" (transitive dependents) and a risk
 * score, then ranks the review items. The pure-graph core (`analyzeChanges`)
 * takes plain inputs so it is fully unit-testable without git.
 */

import type { GraphData, GraphNode } from './graph-builder.js';
import type { ImportanceEntry } from './importance-analyzer.js';

export interface ReviewItem {
  file: string;
  /** Number of transitive dependents reachable within `depth` hops. */
  blastRadius: number;
  /** Direct dependents (1 hop). */
  directDependents: number;
  importance: number;
  /** True when the file has no test among its dependents/co-located tests. */
  testGap: boolean;
  /** 0-100 composite risk score (higher = review more carefully). */
  risk: number;
  /** Human-readable reasons contributing to the risk score. */
  reasons: string[];
}

export interface ChangeAnalysis {
  base: string;
  changedFiles: string[];
  /** Changed files that exist as nodes in the graph (others are new/untracked). */
  analyzedFiles: string[];
  reviewItems: ReviewItem[];
  summary: {
    changed: number;
    totalBlastRadius: number;
    highRisk: number;
    testGaps: number;
  };
}

export interface AnalyzeChangesInput {
  base: string;
  changedFiles: string[];
  graph: GraphData;
  importance?: Record<string, ImportanceEntry>;
  depth?: number;
}

/** Whether a file path looks like a test file (used for test-gap detection). */
function isTestPath(file: string): boolean {
  return (
    /\.(test|spec)\./.test(file) ||
    /_test\.(go|py)$/.test(file) ||
    /(^|\/)test_[^/]+\.py$/.test(file) ||
    /Tests?\.java$/.test(file) ||
    file.includes('/__tests__/') ||
    file.includes('/tests/')
  );
}

/**
 * Compute the blast radius (transitive dependents) of a node via reverse-edge
 * BFS up to `depth` hops. Returns the set of reachable dependent file keys
 * (excluding the seed itself).
 */
function computeBlastRadius(
  seed: string,
  nodes: Map<string, GraphNode>,
  depth: number,
): Set<string> {
  const reached = new Set<string>();
  let frontier = new Set<string>([seed]);

  for (let hop = 0; hop < depth; hop++) {
    const next = new Set<string>();
    for (const key of frontier) {
      const node = nodes.get(key);
      if (!node) continue;
      for (const dep of node.dependents) {
        if (dep !== seed && !reached.has(dep)) {
          reached.add(dep);
          next.add(dep);
        }
      }
    }
    if (next.size === 0) break;
    frontier = next;
  }

  return reached;
}

/**
 * Pure-graph change analysis. Deterministic; no I/O.
 */
export function analyzeChanges(input: AnalyzeChangesInput): ChangeAnalysis {
  const depth = input.depth ?? 2;
  const importance = input.importance ?? {};
  const nodes = new Map<string, GraphNode>(Object.entries(input.graph.nodes));

  // Normalize changed paths to forward slashes for graph-key matching.
  const changedFiles = input.changedFiles.map((f) => f.replace(/\\/g, '/'));
  const analyzedFiles = changedFiles.filter((f) => nodes.has(f));

  const reviewItems: ReviewItem[] = [];

  for (const file of analyzedFiles) {
    const node = nodes.get(file)!;
    const blast = computeBlastRadius(file, nodes, depth);
    const directDependents = node.dependents.length;
    const imp = importance[file]?.score ?? 0;

    // Test gap: the file itself is not a test, and none of its dependents are tests.
    const hasTestDependent = node.dependents.some(isTestPath) || isTestPath(file);
    const testGap = !hasTestDependent;

    // Risk model (0-100, clamped). Blast radius dominates; importance and a
    // test gap add weight. These weights are tuned to keep typical changes
    // mid-range and only flag genuinely wide-impact, untested, important files.
    const reasons: string[] = [];
    let risk = 0;

    const blastContribution = Math.min(50, blast.size * 5);
    risk += blastContribution;
    if (blast.size > 0) reasons.push(`${blast.size} dependent file(s) within ${depth} hops`);

    const importanceContribution = Math.min(30, imp * 2);
    risk += importanceContribution;
    if (imp >= 10) reasons.push(`high importance (${imp})`);

    if (testGap) {
      risk += 20;
      reasons.push('no test coverage detected');
    }

    risk = Math.max(0, Math.min(100, Math.round(risk)));
    if (reasons.length === 0) reasons.push('isolated change, low impact');

    reviewItems.push({
      file,
      blastRadius: blast.size,
      directDependents,
      importance: imp,
      testGap,
      risk,
      reasons,
    });
  }

  // Rank by risk desc, then blast radius desc, then path for stable order.
  reviewItems.sort(
    (a, b) => b.risk - a.risk || b.blastRadius - a.blastRadius || a.file.localeCompare(b.file),
  );

  const totalBlastRadius = reviewItems.reduce((sum, it) => sum + it.blastRadius, 0);
  const highRisk = reviewItems.filter((it) => it.risk >= 60).length;
  const testGaps = reviewItems.filter((it) => it.testGap).length;

  return {
    base: input.base,
    changedFiles,
    analyzedFiles,
    reviewItems,
    summary: {
      changed: changedFiles.length,
      totalBlastRadius,
      highRisk,
      testGaps,
    },
  };
}
