/**
 * VibeGuard MCP Server
 *
 * Exposes VibeGuard's local analysis engines as live Model Context Protocol
 * tools, so AI coding assistants can call them directly instead of shelling
 * out to `npx vibeguard ... --json` and screen-scraping.
 *
 * Design notes:
 * - Every tool returns a single JSON document (stringified) carrying the same
 *   stable shapes the CLI emits, so agents get one consistent contract.
 * - The server is local-only and performs zero network calls in its core tools.
 * - Tools can be restricted via an allowlist (see createVibeGuardServer).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { resolve } from 'node:path';

import { loadConfig } from '../storage/config-store.js';
import { createLogger } from '../utils/logger.js';
import { resolveFiles } from '../utils/glob-resolver.js';
import {
  buildGraph,
  loadGraph,
  GRAPH_SCHEMA_VERSION,
  type GraphData,
  type GraphNode,
} from '../engines/graph-builder.js';
import { scanSecurity } from '../engines/security-scanner.js';
import { scanAttacks } from '../engines/attack-scanner.js';
import { analyzeHealth } from '../engines/health-analyzer.js';
import { scanDeadCode } from '../engines/dead-code-scanner.js';
import { loadImportance } from '../engines/importance-analyzer.js';
import { queryGraph, findPath, explainNode, affectedNodes } from '../engines/query-engine.js';

const SCHEMA_VERSION = '1.0.0';

/** All tool names this server can expose. */
export const VIBEGUARD_TOOL_NAMES = [
  'get_minimal_context',
  'build_graph',
  'scan_security',
  'scan_attacks',
  'get_health',
  'query_graph',
  'find_path',
  'explain_node',
  'get_affected',
  'pack_context',
  'detect_dead_code',
] as const;

export type VibeGuardToolName = (typeof VIBEGUARD_TOOL_NAMES)[number];

/** Shared per-request helpers bound to a project root. */
interface ToolContext {
  projectRoot: string;
}

function jsonResult(payload: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...(payload as object) }, null, 2),
      },
    ],
  };
}

function resolveRoot(repoRoot: string | undefined, fallback: string): string {
  return resolve(repoRoot && repoRoot.trim().length > 0 ? repoRoot : fallback);
}

/** Build a quiet logger that never writes to stdout (MCP uses stdout for protocol). */
function quietLogger(command: string) {
  return createLogger({ jsonMode: true, quiet: true, verbose: false, command });
}

/** Load the persisted graph, or build it on demand if missing/stale. */
async function ensureGraph(projectRoot: string): Promise<GraphData> {
  const existing = await loadGraph(projectRoot);
  if (existing) return existing;

  const config = await loadConfig(projectRoot);
  const logger = quietLogger('mcp-build');
  const files = await resolveFiles(projectRoot, config.effectiveInclude, config.effectiveSkipSet);
  const result = await buildGraph(projectRoot, files, config, logger);
  return { schemaVersion: GRAPH_SCHEMA_VERSION, nodes: Object.fromEntries(result.nodes), edges: [] };
}

/**
 * Create (but do not start) a VibeGuard MCP server.
 *
 * @param opts.projectRoot  Default repo root for tools that omit `repo_root`.
 * @param opts.allowedTools Optional allowlist; when provided, only these tools
 *                          are registered. Unknown names are ignored.
 */
export function createVibeGuardServer(opts: {
  projectRoot: string;
  allowedTools?: VibeGuardToolName[];
}): McpServer {
  const ctx: ToolContext = { projectRoot: resolve(opts.projectRoot) };
  const allow = opts.allowedTools && opts.allowedTools.length > 0 ? new Set(opts.allowedTools) : null;
  const enabled = (name: VibeGuardToolName): boolean => allow === null || allow.has(name);

  const server = new McpServer({
    name: 'vibeguard',
    version: SCHEMA_VERSION,
  });

  // ── get_minimal_context — ultra-compact summary, call this first ──────────
  if (enabled('get_minimal_context')) {
    server.registerTool(
      'get_minimal_context',
      {
        title: 'Get Minimal Context',
        description:
          'Ultra-compact project summary (~100 tokens): node/edge counts, top hubs, ' +
          'and available tools. Call this FIRST to orient before deeper queries.',
        inputSchema: { repo_root: z.string().optional() },
      },
      async ({ repo_root }) => {
        const projectRoot = resolveRoot(repo_root, ctx.projectRoot);
        const graph = await loadGraph(projectRoot);
        const nodeCount = graph ? Object.keys(graph.nodes).length : 0;
        let edgeCount = 0;
        const hubs: Array<{ file: string; dependents: number }> = [];
        if (graph) {
          for (const node of Object.values(graph.nodes)) {
            edgeCount += node.imports.length;
            hubs.push({ file: node.file, dependents: node.dependents.length });
          }
          hubs.sort((a, b) => b.dependents - a.dependents);
        }
        return jsonResult({
          graphBuilt: graph !== null,
          nodes: nodeCount,
          edges: edgeCount,
          topHubs: hubs.slice(0, 5),
          tools: VIBEGUARD_TOOL_NAMES.filter(enabled),
          hint: graph ? 'Use query_graph / get_affected for details.' : 'Run build_graph first.',
        });
      },
    );
  }

  // ── build_graph ───────────────────────────────────────────────────────────
  if (enabled('build_graph')) {
    server.registerTool(
      'build_graph',
      {
        title: 'Build Dependency Graph',
        description: 'Build or incrementally update the dependency graph. Returns node/edge counts.',
        inputSchema: { repo_root: z.string().optional() },
      },
      async ({ repo_root }) => {
        const projectRoot = resolveRoot(repo_root, ctx.projectRoot);
        const config = await loadConfig(projectRoot);
        const logger = quietLogger('mcp-build');
        const files = await resolveFiles(projectRoot, config.effectiveInclude, config.effectiveSkipSet);
        const result = await buildGraph(projectRoot, files, config, logger);
        return jsonResult({ summary: result.summary });
      },
    );
  }

  // ── scan_security ──────────────────────────────────────────────────────────
  if (enabled('scan_security')) {
    server.registerTool(
      'scan_security',
      {
        title: 'Scan Security',
        description: 'Detect hard-coded secrets, .gitignore gaps, and risky framework usage.',
        inputSchema: { repo_root: z.string().optional() },
      },
      async ({ repo_root }) => {
        const projectRoot = resolveRoot(repo_root, ctx.projectRoot);
        const config = await loadConfig(projectRoot);
        const files = await resolveFiles(projectRoot, config.effectiveInclude, config.effectiveSkipSet);
        const result = await scanSecurity(projectRoot, files, config);
        return jsonResult({ issues: result.issues, counts: result.counts });
      },
    );
  }

  // ── scan_attacks ───────────────────────────────────────────────────────────
  if (enabled('scan_attacks')) {
    server.registerTool(
      'scan_attacks',
      {
        title: 'Scan Cyberattack Vectors',
        description: 'Scan for cyberattack vulnerabilities (SQLi, XSS, SSRF, DDoS, OTP abuse, etc.).',
        inputSchema: { repo_root: z.string().optional() },
      },
      async ({ repo_root }) => {
        const projectRoot = resolveRoot(repo_root, ctx.projectRoot);
        const config = await loadConfig(projectRoot);
        const files = await resolveFiles(projectRoot, config.effectiveInclude, config.effectiveSkipSet);
        const result = await scanAttacks(projectRoot, files, config);
        return jsonResult({ findings: result.findings, counts: result.counts });
      },
    );
  }

  // ── get_health ─────────────────────────────────────────────────────────────
  if (enabled('get_health')) {
    server.registerTool(
      'get_health',
      {
        title: 'Get Project Health',
        description: 'Aggregate findings into a Project Health Score (security, dead code, architecture, context).',
        inputSchema: { repo_root: z.string().optional() },
      },
      async ({ repo_root }) => {
        const projectRoot = resolveRoot(repo_root, ctx.projectRoot);
        const config = await loadConfig(projectRoot);
        const result = await analyzeHealth(config, projectRoot);
        return jsonResult({ summary: result.summary, warnings: result.warnings });
      },
    );
  }

  // ── query_graph ────────────────────────────────────────────────────────────
  if (enabled('query_graph')) {
    server.registerTool(
      'query_graph',
      {
        title: 'Query Graph',
        description: 'Answer a natural-language question about the codebase using the graph (token-efficient).',
        inputSchema: {
          question: z.string(),
          budget: z.number().optional(),
          repo_root: z.string().optional(),
        },
      },
      async ({ question, budget, repo_root }) => {
        const projectRoot = resolveRoot(repo_root, ctx.projectRoot);
        const graph = await ensureGraph(projectRoot);
        const result = queryGraph(graph, question, { budget });
        return jsonResult({ ...result });
      },
    );
  }

  // ── find_path ──────────────────────────────────────────────────────────────
  if (enabled('find_path')) {
    server.registerTool(
      'find_path',
      {
        title: 'Find Path',
        description: 'Find the shortest dependency path between two nodes (files or symbols).',
        inputSchema: {
          source: z.string(),
          target: z.string(),
          repo_root: z.string().optional(),
        },
      },
      async ({ source, target, repo_root }) => {
        const projectRoot = resolveRoot(repo_root, ctx.projectRoot);
        const graph = await ensureGraph(projectRoot);
        const result = findPath(graph, source, target);
        return jsonResult({ ...result });
      },
    );
  }

  // ── explain_node ───────────────────────────────────────────────────────────
  if (enabled('explain_node')) {
    server.registerTool(
      'explain_node',
      {
        title: 'Explain Node',
        description: 'Explain a node: role, community, importance, imports, dependents, and edges.',
        inputSchema: {
          node: z.string(),
          repo_root: z.string().optional(),
        },
      },
      async ({ node, repo_root }) => {
        const projectRoot = resolveRoot(repo_root, ctx.projectRoot);
        const graph = await ensureGraph(projectRoot);
        const explanation = explainNode(graph, node);
        if (!explanation) return jsonResult({ error: `Node "${node}" not found in graph.` });
        return jsonResult({ ...explanation });
      },
    );
  }

  // ── get_affected ───────────────────────────────────────────────────────────
  if (enabled('get_affected')) {
    server.registerTool(
      'get_affected',
      {
        title: 'Get Affected (Blast Radius)',
        description: 'Show transitive dependents of a node — what would be affected if it changed.',
        inputSchema: {
          node: z.string(),
          depth: z.number().optional(),
          repo_root: z.string().optional(),
        },
      },
      async ({ node, depth, repo_root }) => {
        const projectRoot = resolveRoot(repo_root, ctx.projectRoot);
        const graph = await ensureGraph(projectRoot);
        const result = affectedNodes(graph, node, depth ?? 2);
        return jsonResult({ ...result });
      },
    );
  }

  // ── pack_context ───────────────────────────────────────────────────────────
  if (enabled('pack_context')) {
    server.registerTool(
      'pack_context',
      {
        title: 'Pack Context',
        description: 'Produce a focused, token-budgeted context package for a task (80-95% token reduction).',
        inputSchema: {
          task: z.string(),
          radius: z.number().optional(),
          budget: z.number().optional(),
          repo_root: z.string().optional(),
        },
      },
      async ({ task, radius, budget, repo_root }) => {
        const projectRoot = resolveRoot(repo_root, ctx.projectRoot);
        const { generateContextForEditor } = await import('../api.js');
        const pkg = await generateContextForEditor(task, { radius, budget, cwd: projectRoot });
        return jsonResult({
          task: pkg.task,
          detectedStack: pkg.detectedStack,
          selectedFiles: pkg.selectedFiles,
          warnings: pkg.warnings,
          tokenBudget: pkg.tokenBudget,
        });
      },
    );
  }

  // ── detect_dead_code ───────────────────────────────────────────────────────
  if (enabled('detect_dead_code')) {
    server.registerTool(
      'detect_dead_code',
      {
        title: 'Detect Dead Code',
        description: 'Detect unused files and exports (reachability from entrypoints).',
        inputSchema: { repo_root: z.string().optional() },
      },
      async ({ repo_root }) => {
        const projectRoot = resolveRoot(repo_root, ctx.projectRoot);
        const graph = await ensureGraph(projectRoot);
        const importanceScores = (await loadImportance(projectRoot)) ?? {};
        const graphNodes = new Map<string, GraphNode>(Object.entries(graph.nodes));
        const result = await scanDeadCode(projectRoot, graphNodes, importanceScores);
        return jsonResult({ candidates: result.candidates, summary: result.summary, warning: result.warning });
      },
    );
  }

  return server;
}

/** Boot the server over stdio. Resolves when the transport connects. */
export async function startVibeGuardServer(opts: {
  projectRoot: string;
  allowedTools?: VibeGuardToolName[];
}): Promise<void> {
  const server = createVibeGuardServer(opts);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
