import { loadGraph, type GraphData } from './graph-builder.js';
import { scanSecurity, type SecurityIssue } from './security-scanner.js';
import { scanDeadCode } from './dead-code-scanner.js';
import { loadImportance } from './importance-analyzer.js';
import { resolveFiles } from '../utils/glob-resolver.js';
import { detectLanguage } from './polyglot-parser.js';
import type { ResolvedConfig } from '../storage/config-store.js';

export interface ArchitectureDetails {
  cyclicPairs: Array<{ a: string; b: string }>;
  highFanInFiles: Array<{ file: string; dependents: number }>;
}

export interface ContextDetails {
  avgImports: number;
  heavyImportFiles: Array<{ file: string; imports: number }>;
}

export interface HealthResult {
  summary: {
    projectHealth: number;
    security: number | null;
    deadCode: number | null;
    architecture: number | null;
    contextEfficiency: number | null;
  };
  issues: SecurityIssue[];
  warnings: string[];
  architectureDetails: ArchitectureDetails;
  contextDetails: ContextDetails;
}

export interface HealthProgress {
  (percent: number, label: string): void;
}

export async function analyzeHealth(
  config: ResolvedConfig,
  projectRoot: string,
  onProgress?: HealthProgress,
): Promise<HealthResult> {
  const report = (percent: number, label: string): void => {
    if (onProgress) onProgress(Math.max(1, Math.min(100, Math.round(percent))), label);
  };

  const warnings: string[] = [];
  let securityScore: number | null = null;
  let deadCodeScore: number | null = null;
  let architectureScore: number | null = null;
  let contextEfficiencyScore: number | null = null;
  let allIssues: SecurityIssue[] = [];
  let architectureDetails: ArchitectureDetails = { cyclicPairs: [], highFanInFiles: [] };
  let contextDetails: ContextDetails = { avgImports: 0, heavyImportFiles: [] };

  report(1, 'Loading dependency graph...');
  // Load graph
  const graphData = await loadGraph(projectRoot);

  // 1. Security sub-score (10% → 70%: the slow per-file pass)
  try {
    report(10, 'Scanning for security issues...');
    const files = await resolveFiles(projectRoot, config.effectiveInclude, config.effectiveSkipSet);
    const secResult = await scanSecurity(projectRoot, files, config, (current, total) => {
      const pct = total > 0 ? 10 + (current / total) * 60 : 10;
      report(pct, `Scanning security (${current}/${total} files)...`);
    });
    allIssues = secResult.issues;

    let penalty = 0;
    penalty += secResult.counts.critical * 20;
    penalty += secResult.counts.high * 10;
    penalty += secResult.counts.medium * 5;
    penalty += secResult.counts.low * 2;
    securityScore = Math.max(0, Math.min(100, 100 - penalty));
  } catch (err) {
    warnings.push(`Security scan failed: ${err instanceof Error ? err.message : 'unknown'}`);
  }

  // 2. Dead code sub-score (70% → 85%)
  try {
    report(70, 'Analyzing dead code...');
    if (graphData) {
      const importanceScores = await loadImportance(projectRoot) ?? {};
      const graphNodes = new Map(Object.entries(graphData.nodes));
      const deadResult = await scanDeadCode(projectRoot, graphNodes, importanceScores);

      const totalNodes = Object.keys(graphData.nodes).length;
      if (totalNodes > 0) {
        // Only count unused FILES for the health score.
        // Unused exports use simplified detection with many false positives
        // (dynamic imports, re-exports), so they're informational only.
        const deadFileRatio = deadResult.summary.unusedFiles / totalNodes;
        deadCodeScore = Math.max(0, Math.min(100, Math.round(100 - deadFileRatio * 100)));
      } else {
        deadCodeScore = 100;
      }
    } else {
      warnings.push('No graph available for dead code analysis. Run `vibeguard map` first.');
    }
  } catch (err) {
    warnings.push(`Dead code scan failed: ${err instanceof Error ? err.message : 'unknown'}`);
  }

  // 3. Architecture sub-score (85% → 95%)
  try {
    report(85, 'Analyzing architecture...');
    if (graphData) {
      const arch = computeArchitecture(graphData);
      architectureScore = arch.score;
      architectureDetails = arch.details;
    } else {
      warnings.push('No graph available for architecture analysis.');
    }
  } catch (err) {
    warnings.push(`Architecture analysis failed: ${err instanceof Error ? err.message : 'unknown'}`);
  }

  // 4. Context efficiency sub-score (95% → 100%)
  try {
    report(95, 'Analyzing context efficiency...');
    if (graphData) {
      // Only code files count toward context efficiency. Markdown docs link to
      // each other for navigation and would otherwise be flagged as bloated.
      const codeNodes = Object.values(graphData.nodes).filter((n) => isCodeNode(n.file));
      const totalNodes = codeNodes.length;
      let totalImports = 0;
      for (const node of codeNodes) {
        totalImports += node.imports.length;
      }
      const avgImports = totalNodes > 0 ? totalImports / totalNodes : 0;
      contextEfficiencyScore = Math.max(0, Math.min(100, Math.round(100 - avgImports * 5)));

      // Collect the heaviest-import files (top offenders for context bloat)
      const heavyImportFiles = codeNodes
        .filter((n) => n.imports.length > 10)
        .sort((a, b) => b.imports.length - a.imports.length)
        .slice(0, 10)
        .map((n) => ({ file: n.file, imports: n.imports.length }));
      contextDetails = { avgImports: Math.round(avgImports * 10) / 10, heavyImportFiles };
    } else {
      warnings.push('No graph available for context efficiency analysis.');
    }
  } catch (err) {
    warnings.push(`Context efficiency analysis failed: ${err instanceof Error ? err.message : 'unknown'}`);
  }

  // Compute overall health score
  const scores = [securityScore, deadCodeScore, architectureScore, contextEfficiencyScore];
  const validScores = scores.filter((s): s is number => s !== null);
  const projectHealth = validScores.length > 0
    ? Math.round(validScores.reduce((a, b) => a + b, 0) / validScores.length)
    : 0;

  report(100, 'Health analysis complete');

  return {
    summary: {
      projectHealth: Math.max(0, Math.min(100, projectHealth)),
      security: securityScore,
      deadCode: deadCodeScore,
      architecture: architectureScore,
      contextEfficiency: contextEfficiencyScore,
    },
    issues: allIssues,
    warnings,
    architectureDetails,
    contextDetails,
  };
}

/**
 * Whether a graph node represents source code (vs. documentation/markdown).
 * Markdown files cross-link each other for navigation (README ↔ guides), which
 * is not architectural coupling, so they're excluded from cycle and fan-in
 * analysis to avoid false positives.
 */
function isCodeNode(file: string): boolean {
  const lang = detectLanguage(file);
  return lang !== 'markdown' && lang !== 'unknown';
}

function computeArchitecture(graphData: GraphData): { score: number; details: ArchitectureDetails } {
  // Only consider source-code nodes. Documentation links (markdown) are
  // navigation, not dependencies, and would otherwise inflate cycles/fan-in.
  const nodes = Object.values(graphData.nodes).filter((n) => isCodeNode(n.file));
  let penalty = 0;

  // Penalty for files with fan-in > 25 (everything depends on them — refactor risk).
  // Count only code dependents so docs linking to a file don't distort fan-in.
  const highFanInFiles = nodes
    .map((n) => ({ file: n.file, dependents: n.dependents.filter(isCodeNode).length }))
    .filter((n) => n.dependents > 25)
    .sort((a, b) => b.dependents - a.dependents)
    .slice(0, 10);
  penalty += highFanInFiles.length * 5;

  // Penalty for cyclic dependencies; collect the unique offending pairs.
  // Both ends must be code nodes for the cycle to count.
  let cyclicCount = 0;
  const seenPairs = new Set<string>();
  const cyclicPairs: Array<{ a: string; b: string }> = [];
  for (const node of nodes) {
    for (const imp of node.imports) {
      if (!isCodeNode(imp)) continue;
      const importedNode = graphData.nodes[imp];
      if (importedNode && importedNode.imports.includes(node.file)) {
        cyclicCount++;
        const key = [node.file, imp].sort().join('::');
        if (!seenPairs.has(key)) {
          seenPairs.add(key);
          if (cyclicPairs.length < 10) cyclicPairs.push({ a: node.file, b: imp });
        }
      }
    }
  }
  penalty += Math.floor(cyclicCount / 2) * 3;

  const score = Math.max(0, Math.min(100, 100 - penalty));
  return { score, details: { cyclicPairs, highFanInFiles } };
}
