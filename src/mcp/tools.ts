/**
 * MCP tool registry.
 *
 * Each tool wraps an existing VibeGuard engine and returns a plain JSON-able
 * object. The registry is transport-agnostic: the MCP server (server.ts) maps
 * these definitions onto the protocol, but the tools themselves can be invoked
 * directly in tests without any MCP runtime. This mirrors how the CLI commands
 * reuse the same engines — there is one source of truth per capability.
 */
import { loadConfig } from '../storage/config-store.js';
import { createLogger } from '../utils/logger.js';
import { resolveFiles } from '../utils/glob-resolver.js';
import { FileStoreImpl } from '../storage/file-store.js';
import { loadGraph, buildGraph, GRAPH_SCHEMA_VERSION, type GraphData } from '../engines/graph-builder.js';

export interface ToolContext {
  projectRoot: string;
}

/**
 * Canonical list of tool names this registry exposes, in agent-reach order.
 * Single source of truth for `get_minimal_context`, allowlist validation, and
 * the MCP server's tool listing.
 */
export const TOOL_NAMES = [
  'get_minimal_context',
  'scan_security',
  'scan_attacks',
  'get_health',
  'build_graph',
  'query_graph',
  'find_path',
  'explain_node',
  'get_affected',
  'pack_context',
  'detect_dead_code',
  'set_caveman',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON-schema-style input description for MCP clients. */
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required?: string[];
  };
  /** Execute the tool. Args are already parsed from the client. */
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

/** Build a quiet, JSON-mode logger for engine calls inside the server. */
function serverLogger(command: string) {
  return createLogger({ jsonMode: true, quiet: true, verbose: false, command });
}

/** Load the graph from disk, building it once if absent. Shared by graph tools. */
async function ensureGraph(projectRoot: string): Promise<GraphData> {
  const existing = await loadGraph(projectRoot);
  if (existing) return existing;

  const config = await loadConfig(projectRoot);
  const logger = serverLogger('mcp-build');
  const files = await resolveFiles(projectRoot, config.effectiveInclude, config.effectiveSkipSet);
  const result = await buildGraph(projectRoot, files, config, logger);
  return { schemaVersion: GRAPH_SCHEMA_VERSION, nodes: Object.fromEntries(result.nodes), edges: [] };
}

function str(args: Record<string, unknown>, key: string, fallback = ''): string {
  const v = args[key];
  return typeof v === 'string' ? v : fallback;
}

function num(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * The full set of VibeGuard MCP tools. Ordered roughly by how an agent should
 * reach for them: minimal context first, then security/health, then graph.
 */
export function createTools(): ToolDefinition[] {
  return [
    {
      name: 'get_minimal_context',
      description: 'Ultra-compact project summary (~100 tokens). Call this FIRST to orient before any other tool.',
      inputSchema: { type: 'object', properties: {} },
      async run(_args, { projectRoot }) {
        const graph = await loadGraph(projectRoot);
        const store = new FileStoreImpl(projectRoot);
        let name = 'unknown';
        try {
          const { readFile } = await import('node:fs/promises');
          const { join } = await import('node:path');
          const pkg = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf-8'));
          name = pkg.name ?? 'unknown';
        } catch { /* no package.json */ }

        const nodeCount = graph ? Object.keys(graph.nodes).length : 0;
        const importance = await store.read<{ scores: Record<string, { score: number }> }>('importance.json');
        const topFiles = importance
          ? Object.entries(importance.scores)
              .sort((a, b) => b[1].score - a[1].score)
              .slice(0, 5)
              .map(([f]) => f)
          : [];

        return {
          project: name,
          graphBuilt: graph !== null,
          fileCount: nodeCount,
          topFiles,
          tools: TOOL_NAMES,
          hint: nodeCount === 0 ? 'Run build_graph first.' : 'Use query_graph / get_affected / pack_context for details.',
        };
      },
    },
    {
      name: 'scan_security',
      description: 'Scan for exposed secrets, framework misuse, and .gitignore gaps. Returns issues with severity.',
      inputSchema: { type: 'object', properties: {} },
      async run(_args, { projectRoot }) {
        const { scanSecurity } = await import('../engines/security-scanner.js');
        const config = await loadConfig(projectRoot);
        const files = await resolveFiles(projectRoot, config.effectiveInclude, config.effectiveSkipSet);
        const result = await scanSecurity(projectRoot, files, config);
        return { issues: result.issues, counts: result.counts };
      },
    },
    {
      name: 'scan_attacks',
      description: 'Scan for cyberattack vulnerabilities (SQLi, XSS, SSRF, OTP abuse, DDoS vectors, etc.).',
      inputSchema: { type: 'object', properties: {} },
      async run(_args, { projectRoot }) {
        const { scanAttacks } = await import('../engines/attack-scanner.js');
        const config = await loadConfig(projectRoot);
        const files = await resolveFiles(projectRoot, config.effectiveInclude, config.effectiveSkipSet);
        const result = await scanAttacks(projectRoot, files, config);
        return result;
      },
    },
    {
      name: 'get_health',
      description: 'Project Health Score: security, dead-code, architecture, and context-efficiency sub-scores (0-100).',
      inputSchema: { type: 'object', properties: {} },
      async run(_args, { projectRoot }) {
        const { analyzeHealth } = await import('../engines/health-analyzer.js');
        const config = await loadConfig(projectRoot);
        const result = await analyzeHealth(config, projectRoot);
        return { summary: result.summary, warnings: result.warnings };
      },
    },
    {
      name: 'build_graph',
      description: 'Build or incrementally update the dependency graph. Run before graph queries on a fresh project.',
      inputSchema: { type: 'object', properties: {} },
      async run(_args, { projectRoot }) {
        const config = await loadConfig(projectRoot);
        const logger = serverLogger('mcp-build');
        const files = await resolveFiles(projectRoot, config.effectiveInclude, config.effectiveSkipSet);
        const result = await buildGraph(projectRoot, files, config, logger);
        return { summary: result.summary };
      },
    },
    {
      name: 'query_graph',
      description: 'Answer a question about the codebase by traversing the graph (no file reads). Token-efficient.',
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'Natural-language question about the codebase' },
          budget: { type: 'number', description: 'Optional token budget capping the returned node set' },
        },
        required: ['question'],
      },
      async run(args, { projectRoot }) {
        const { queryGraph } = await import('../engines/query-engine.js');
        const graph = await ensureGraph(projectRoot);
        return queryGraph(graph, str(args, 'question'), { budget: num(args, 'budget') });
      },
    },
    {
      name: 'find_path',
      description: 'Find the shortest dependency path between two files/symbols in the graph.',
      inputSchema: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'Source node (file name or symbol)' },
          target: { type: 'string', description: 'Target node (file name or symbol)' },
        },
        required: ['source', 'target'],
      },
      async run(args, { projectRoot }) {
        const { findPath } = await import('../engines/query-engine.js');
        const graph = await ensureGraph(projectRoot);
        return findPath(graph, str(args, 'source'), str(args, 'target'));
      },
    },
    {
      name: 'explain_node',
      description: 'Explain a node: its role, imports, dependents, exports, and importance class.',
      inputSchema: {
        type: 'object',
        properties: { node: { type: 'string', description: 'Node to explain (file name or symbol)' } },
        required: ['node'],
      },
      async run(args, { projectRoot }) {
        const { explainNode } = await import('../engines/query-engine.js');
        const graph = await ensureGraph(projectRoot);
        const explanation = explainNode(graph, str(args, 'node'));
        return explanation ?? { error: `Node "${str(args, 'node')}" not found in graph.` };
      },
    },
    {
      name: 'get_affected',
      description: 'Reverse-impact analysis: what transitively depends on a node (blast radius of changing it).',
      inputSchema: {
        type: 'object',
        properties: {
          node: { type: 'string', description: 'Node to analyze (file name or symbol)' },
          depth: { type: 'number', description: 'How many hops of dependents to walk (default 2)' },
        },
        required: ['node'],
      },
      async run(args, { projectRoot }) {
        const { affectedNodes } = await import('../engines/query-engine.js');
        const graph = await ensureGraph(projectRoot);
        return affectedNodes(graph, str(args, 'node'), num(args, 'depth') ?? 2);
      },
    },
    {
      name: 'pack_context',
      description: 'Assemble a focused, token-budgeted context package for a task (the core 80-95% token reduction).',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'Task description to pack context for' },
          budget: { type: 'number', description: 'Optional token budget' },
          radius: { type: 'number', description: 'Optional graph expansion radius' },
        },
        required: ['task'],
      },
      async run(args, { projectRoot }) {
        const { generateContextForEditor } = await import('../api.js');
        const pkg = await generateContextForEditor(str(args, 'task'), {
          budget: num(args, 'budget'),
          radius: num(args, 'radius'),
          cwd: projectRoot,
        });
        return {
          task: pkg.task,
          detectedStack: pkg.detectedStack,
          selectedFiles: pkg.selectedFiles.map((f) => ({ path: f.path, tags: f.tags, importance: f.importance })),
          tokenBudget: pkg.tokenBudget,
          warnings: pkg.warnings,
        };
      },
    },
    {
      name: 'detect_dead_code',
      description: 'Detect unused files and exports (dead code) reachable from no entrypoint.',
      inputSchema: { type: 'object', properties: {} },
      async run(_args, { projectRoot }) {
        const { scanDeadCode } = await import('../engines/dead-code-scanner.js');
        const { loadImportance } = await import('../engines/importance-analyzer.js');
        const graph = await ensureGraph(projectRoot);
        const importance = (await loadImportance(projectRoot)) ?? {};
        const graphNodes = new Map(Object.entries(graph.nodes));
        const result = await scanDeadCode(projectRoot, graphNodes, importance);
        return { candidates: result.candidates, summary: result.summary, ...(result.warning ? { warning: result.warning } : {}) };
      },
    },
    {
      name: 'set_caveman',
      description: 'Toggle Caveman Mode — terse, token-saving replies. action: on|off|status|level. Persists across the whole session via an always-on rule file.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'on | off | status | level' },
          level: { type: 'string', description: 'Compression level when enabling: lite | full | ultra' },
        },
        required: ['action'],
      },
      async run(args, { projectRoot }) {
        const {
          enableCaveman, disableCaveman, loadCavemanState, isCavemanLevel,
          estimatedSavingsPct, DEFAULT_CAVEMAN_LEVEL,
        } = await import('../engines/caveman.js');

        const action = str(args, 'action', 'status');
        const rawLevel = str(args, 'level') || undefined;

        if (action === 'on' || action === 'level') {
          const current = await loadCavemanState(projectRoot);
          if (action === 'level' && !current.enabled) {
            return { error: 'Caveman is off. Use action "on" first.' };
          }
          if (rawLevel !== undefined && !isCavemanLevel(rawLevel)) {
            return { error: `Unknown level "${rawLevel}". Use lite | full | ultra.` };
          }
          const level = isCavemanLevel(rawLevel) ? rawLevel : (current.enabled ? current.level : DEFAULT_CAVEMAN_LEVEL);
          const { written } = await enableCaveman(projectRoot, level);
          return { enabled: true, level, estimatedSavingsPct: estimatedSavingsPct(level), written };
        }

        if (action === 'off') {
          const { removed } = await disableCaveman(projectRoot);
          return { enabled: false, removed };
        }

        // status
        const state = await loadCavemanState(projectRoot);
        return {
          enabled: state.enabled,
          level: state.level,
          estimatedSavingsPct: state.enabled ? estimatedSavingsPct(state.level) : 0,
        };
      },
    },
  ];
}

/**
 * Apply an optional allowlist (from `--tools` / VIBEGUARD_TOOLS) to a tool set.
 * Unknown names are ignored. An empty/undefined allowlist returns all tools.
 */
export function filterTools(tools: ToolDefinition[], allow?: string[]): ToolDefinition[] {
  if (!allow || allow.length === 0) return tools;
  const set = new Set(allow.map((t) => t.trim()).filter(Boolean));
  return tools.filter((t) => set.has(t.name));
}

/** Parse an allowlist from a CLI flag value or env var (comma-separated). */
export function parseToolAllowlist(flag?: string): string[] | undefined {
  const raw = flag ?? process.env['VIBEGUARD_TOOLS'];
  if (!raw) return undefined;
  const known = new Set<string>(TOOL_NAMES);
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter((name) => known.has(name));
  return list.length > 0 ? list : undefined;
}
