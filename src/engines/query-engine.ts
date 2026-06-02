import type { GraphData, GraphNode } from './graph-builder.js';

/** Average tokens to represent a graph node (metadata only). */
const TOKENS_PER_GRAPH_NODE = 200;
/** Average tokens for actual file content. */
const TOKENS_PER_FILE_CONTENT = 1500;

export interface QueryOptions {
  /** Max tokens for the result's relevant-node set. Caps how many nodes are returned. */
  budget?: number;
}

export interface QueryResult {
  answer: string;
  relevantNodes: string[];
  path?: string[];
  confidence: number;
  tokensSaved: number; // estimated tokens saved vs reading all files
  tokensUsed: number;  // estimated tokens the returned node set represents
}

export interface NodeExplanation {
  file: string;
  role: string;
  imports: string[];
  dependents: string[];
  exports: string[];
  edges: Array<{ target: string; type: string; confidence: number; symbols?: string[] }>;
  community: string;
  importance: 'god-node' | 'hub' | 'standard' | 'leaf';
}

/**
 * Query the graph to answer questions about the codebase without reading files.
 * This is the core token-reduction mechanism — traverse the graph instead of grep.
 */
export function queryGraph(graphData: GraphData, question: string, opts: QueryOptions = {}): QueryResult {
  const nodes = Object.values(graphData.nodes);

  // Extract keywords from the question
  const keywords = extractKeywords(question);

  // Find nodes that match the keywords
  const matchedNodes = findMatchingNodes(nodes, keywords);

  // If we found matches, expand to their neighborhood
  const relevantNodes: string[] = [];
  const visited = new Set<string>();

  for (const match of matchedNodes.slice(0, 5)) {
    if (visited.has(match.file)) continue;
    visited.add(match.file);
    relevantNodes.push(match.file);

    // Add direct connections (1-hop)
    for (const imp of match.imports) {
      if (!visited.has(imp) && graphData.nodes[imp]) {
        visited.add(imp);
        relevantNodes.push(imp);
      }
    }
    for (const dep of match.dependents) {
      if (!visited.has(dep) && graphData.nodes[dep]) {
        visited.add(dep);
        relevantNodes.push(dep);
      }
    }
  }

  // Apply token budget: cap the relevant-node set so it never exceeds the budget.
  // Default hard cap is 15 nodes; an explicit budget tightens it further.
  const maxByBudget = opts.budget && opts.budget > 0
    ? Math.max(1, Math.floor(opts.budget / TOKENS_PER_GRAPH_NODE))
    : Infinity;
  const cap = Math.min(15, maxByBudget);
  const budgetedNodes = relevantNodes.slice(0, cap);

  // Build the answer from graph structure
  const answer = buildAnswer(question, matchedNodes);

  // Estimate tokens saved vs reading every file, and tokens the result represents
  const { tokensUsed, tokensSaved } = estimateTokenAccounting(budgetedNodes.length, nodes.length);

  return {
    answer,
    relevantNodes: budgetedNodes,
    confidence: matchedNodes.length > 0 ? 0.8 : 0.3,
    tokensSaved,
    tokensUsed,
  };
}

/**
 * Find the shortest path between two nodes in the graph.
 * Uses BFS on the import/dependent edges.
 */
export function findPath(graphData: GraphData, sourceQuery: string, targetQuery: string): QueryResult {
  const nodes = Object.values(graphData.nodes);

  // Fuzzy-find source and target
  const source = fuzzyFindNode(nodes, sourceQuery);
  const target = fuzzyFindNode(nodes, targetQuery);

  if (!source || !target) {
    const missing = !source ? sourceQuery : targetQuery;
    return {
      answer: `Could not find node matching "${missing}" in the graph.`,
      relevantNodes: [],
      confidence: 0,
      tokensSaved: 0,
      tokensUsed: 0,
    };
  }

  if (source.file === target.file) {
    return {
      answer: `"${source.file}" and "${target.file}" are the same node.`,
      relevantNodes: [source.file],
      path: [source.file],
      confidence: 1.0,
      tokensSaved: 0,
      tokensUsed: TOKENS_PER_GRAPH_NODE,
    };
  }

  // BFS to find shortest path
  const queue: Array<{ node: string; path: string[] }> = [{ node: source.file, path: [source.file] }];
  const visited = new Set<string>([source.file]);

  while (queue.length > 0) {
    const current = queue.shift()!;

    if (current.node === target.file) {
      const pathNodes = current.path;
      const answer = formatPathAnswer(pathNodes, graphData);
      const { tokensUsed, tokensSaved } = estimateTokenAccounting(pathNodes.length, nodes.length);

      return {
        answer,
        relevantNodes: pathNodes,
        path: pathNodes,
        confidence: 1.0,
        tokensSaved,
        tokensUsed,
      };
    }

    // Expand neighbors (imports + dependents)
    const nodeData = graphData.nodes[current.node];
    if (!nodeData) continue;

    const neighbors = [...nodeData.imports, ...nodeData.dependents];
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor) && graphData.nodes[neighbor]) {
        visited.add(neighbor);
        queue.push({ node: neighbor, path: [...current.path, neighbor] });
      }
    }
  }

  return {
    answer: `No path found between "${source.file}" and "${target.file}". They are in disconnected components.`,
    relevantNodes: [source.file, target.file],
    confidence: 1.0,
    tokensSaved: 0,
    tokensUsed: 2 * TOKENS_PER_GRAPH_NODE,
  };
}

/**
 * Generate a plain-language explanation of a node and its role in the project.
 */
export function explainNode(graphData: GraphData, nodeQuery: string): NodeExplanation | null {
  const nodes = Object.values(graphData.nodes);
  const node = fuzzyFindNode(nodes, nodeQuery);
  if (!node) return null;

  const totalNodes = nodes.length;
  const connections = node.imports.length + node.dependents.length;
  const avgConnections = nodes.reduce((sum, n) => sum + n.imports.length + n.dependents.length, 0) / totalNodes;

  let importance: NodeExplanation['importance'];
  if (connections > avgConnections * 3) importance = 'god-node';
  else if (connections > avgConnections * 1.5) importance = 'hub';
  else if (connections === 0 || (node.imports.length === 0 && node.dependents.length === 0)) importance = 'leaf';
  else importance = 'standard';

  const role = classifyNodeRole(node);
  const community = detectNodeCommunity(node);
  const edges = (node.edges ?? []).map(e => ({
    target: e.target,
    type: e.type,
    confidence: e.confidence,
    symbols: e.symbols,
  }));

  return {
    file: node.file,
    role,
    imports: node.imports,
    dependents: node.dependents,
    exports: node.exports,
    edges,
    community,
    importance,
  };
}

export interface AffectedNode {
  file: string;
  depth: number;
  viaRelation: string;
}

export interface AffectedResult {
  seed: string | null;
  affected: AffectedNode[];
  tokensSaved: number;
  tokensUsed: number;
}

/**
 * Reverse-impact analysis: given a node, find everything that would be affected
 * if it changed — i.e. all transitive dependents (files that import/call into it).
 * Walks the dependent edges (inverse of imports) up to `depth` hops.
 */
export function affectedNodes(graphData: GraphData, nodeQuery: string, depth = 2): AffectedResult {
  const nodes = Object.values(graphData.nodes);
  const seedNode = fuzzyFindNode(nodes, nodeQuery);

  if (!seedNode) {
    return { seed: null, affected: [], tokensSaved: 0, tokensUsed: 0 };
  }

  const seen = new Set<string>([seedNode.file]);
  const affected: AffectedNode[] = [];
  // BFS over dependents (who depends on the current node → impacted by its change)
  let frontier: Array<{ file: string; depth: number }> = [{ file: seedNode.file, depth: 0 }];

  while (frontier.length > 0) {
    const next: Array<{ file: string; depth: number }> = [];
    for (const { file, depth: d } of frontier) {
      if (d >= depth) continue;
      const node = graphData.nodes[file];
      if (!node) continue;
      for (const dependent of node.dependents) {
        if (seen.has(dependent)) continue;
        if (!graphData.nodes[dependent]) continue;
        seen.add(dependent);
        // Determine the relation type via the dependent's edge to this file
        const depNode = graphData.nodes[dependent];
        const edge = depNode.edges?.find(e => e.target === file);
        const viaRelation = edge?.type ?? 'imports';
        affected.push({ file: dependent, depth: d + 1, viaRelation });
        next.push({ file: dependent, depth: d + 1 });
      }
    }
    frontier = next;
  }

  const { tokensUsed, tokensSaved } = estimateTokenAccounting(affected.length + 1, nodes.length);
  return { seed: seedNode.file, affected, tokensSaved, tokensUsed };
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

/**
 * Estimate the token cost of a returned node set and the tokens saved versus
 * reading every file in the project. Centralizes the accounting so query and
 * path results stay consistent.
 */
function estimateTokenAccounting(
  selectedNodeCount: number,
  totalNodeCount: number,
): { tokensUsed: number; tokensSaved: number } {
  const tokensUsed = selectedNodeCount * TOKENS_PER_GRAPH_NODE;
  const tokensSaved = Math.max(0, totalNodeCount * TOKENS_PER_FILE_CONTENT - tokensUsed);
  return { tokensUsed, tokensSaved };
}

const STOP_WORDS = new Set([
  'what', 'how', 'why', 'where', 'when', 'which', 'who',
  'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at',
  'to', 'for', 'of', 'with', 'by', 'from', 'as', 'into',
  'does', 'do', 'did', 'has', 'have', 'had', 'will', 'would',
  'can', 'could', 'should', 'may', 'might', 'shall',
  'this', 'that', 'these', 'those', 'it', 'its',
  'connects', 'connect', 'between', 'related', 'relationship',
  'show', 'tell', 'me', 'about', 'explain', 'find',
  'file', 'files', 'module', 'modules', 'function', 'class',
]);

function extractKeywords(question: string): string[] {
  return question
    .toLowerCase()
    .replace(/[^a-z0-9\s\-_./]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w));
}

function findMatchingNodes(nodes: GraphNode[], keywords: string[]): GraphNode[] {
  if (keywords.length === 0) return [];

  const scored = nodes.map(node => {
    let score = 0;
    const fileLower = node.file.toLowerCase();
    const exportsLower = node.exports.map(e => e.toLowerCase());
    const basenameLower = fileLower.split('/').pop() ?? '';

    for (const kw of keywords) {
      // File path match (strongest)
      if (fileLower.includes(kw)) score += 10;
      // Export name match
      if (exportsLower.some(e => e.includes(kw))) score += 5;
      // Basename match
      if (basenameLower.includes(kw)) score += 8;
    }

    return { node, score };
  });

  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(s => s.node);
}

function fuzzyFindNode(nodes: GraphNode[], query: string): GraphNode | null {
  const q = query.toLowerCase().replace(/[^a-z0-9\-_./]/g, '');

  // Exact match
  const exact = nodes.find(n => n.file.toLowerCase() === q);
  if (exact) return exact;

  // Basename match
  const basename = nodes.find(n => {
    const name = n.file.split('/').pop()?.replace(/\.(ts|js|tsx|jsx)$/, '').toLowerCase() ?? '';
    return name === q;
  });
  if (basename) return basename;

  // Partial match
  const partial = nodes.find(n => n.file.toLowerCase().includes(q));
  if (partial) return partial;

  // Export match
  const exportMatch = nodes.find(n =>
    n.exports.some(e => e.toLowerCase().includes(q))
  );
  return exportMatch ?? null;
}

function buildAnswer(question: string, matchedNodes: GraphNode[]): string {
  if (matchedNodes.length === 0) {
    return 'No nodes in the graph match your query. Try using file names or exported symbol names.';
  }

  const lines: string[] = [];
  const primary = matchedNodes[0];

  lines.push(`## Query: ${question}\n`);
  lines.push(`### Primary match: \`${primary.file}\`\n`);
  lines.push(`- **Role:** ${classifyNodeRole(primary)}`);
  lines.push(`- **Exports:** ${primary.exports.slice(0, 10).join(', ') || 'none'}`);
  lines.push(`- **Imports from:** ${primary.imports.slice(0, 8).join(', ') || 'none'}`);
  lines.push(`- **Depended on by:** ${primary.dependents.slice(0, 8).join(', ') || 'none'}`);

  // Show semantic edges if available
  const nodeEdges = primary.edges ?? [];
  const callEdges = nodeEdges.filter(e => e.type === 'call');
  const typeEdges = nodeEdges.filter(e => e.type === 'type-reference');

  if (callEdges.length > 0) {
    lines.push(`\n### Function calls (outgoing):`);
    for (const e of callEdges.slice(0, 5)) {
      lines.push(`- → \`${e.target}\` (${e.symbols?.join(', ') || 'unnamed'}) [confidence: ${e.confidence}]`);
    }
  }

  if (typeEdges.length > 0) {
    lines.push(`\n### Type references:`);
    for (const e of typeEdges.slice(0, 5)) {
      lines.push(`- → \`${e.target}\` (${e.symbols?.join(', ') || 'unnamed'}) [confidence: ${e.confidence}]`);
    }
  }

  if (matchedNodes.length > 1) {
    lines.push(`\n### Other relevant nodes:`);
    for (const n of matchedNodes.slice(1, 6)) {
      lines.push(`- \`${n.file}\` — ${n.exports.slice(0, 3).join(', ') || 'no exports'} (${n.dependents.length} dependents)`);
    }
  }

  lines.push(`\n---`);
  lines.push(`*Answered from graph traversal — 0 file reads, 0 tokens consumed on file content.*`);

  return lines.join('\n');
}

function formatPathAnswer(path: string[], graphData: GraphData): string {
  const lines: string[] = [];
  lines.push(`## Shortest path (${path.length} hops)\n`);

  for (let i = 0; i < path.length; i++) {
    const node = graphData.nodes[path[i]];
    const prefix = i === 0 ? '🟢' : i === path.length - 1 ? '🔴' : '⬜';
    const role = node ? classifyNodeRole(node) : 'unknown';
    lines.push(`${prefix} \`${path[i]}\` (${role})`);

    if (i < path.length - 1) {
      const next = path[i + 1];
      const edge = node?.edges?.find(e => e.target === next);
      if (edge) {
        lines.push(`   ↓ ${edge.type} [${edge.confidence}] ${edge.symbols?.join(', ') ?? ''}`);
      } else if (node?.imports.includes(next)) {
        lines.push(`   ↓ imports`);
      } else if (node?.dependents.includes(next)) {
        lines.push(`   ↑ depended on by`);
      } else {
        lines.push(`   ↔ connected`);
      }
    }
  }

  lines.push(`\n---`);
  lines.push(`*Path found via BFS graph traversal — 0 file reads needed.*`);

  return lines.join('\n');
}

function classifyNodeRole(node: GraphNode): string {
  const file = node.file;
  if (file.includes('cli') || file.includes('index') || file.includes('main') || file.includes('app')) return 'entrypoint';
  if (node.dependents.length > node.imports.length * 2) return 'hub (many depend on it)';
  if (node.imports.length > node.dependents.length * 2) return 'orchestrator (imports many)';
  if (file.includes('util') || file.includes('helper') || file.includes('lib')) return 'utility';
  if (file.includes('engine') || file.includes('service')) return 'engine';
  if (file.includes('store') || file.includes('storage') || file.includes('db')) return 'data layer';
  if (file.includes('command') || file.includes('handler') || file.includes('route')) return 'command/handler';
  if (file.includes('test') || file.includes('spec')) return 'test';
  return 'module';
}

function detectNodeCommunity(node: GraphNode): string {
  const parts = node.file.split('/');
  if (parts.length >= 3) return parts.slice(0, 2).join('/');
  if (parts.length === 2) return parts[0];
  return 'root';
}
