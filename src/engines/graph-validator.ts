import type { GraphData, GraphNode, GraphEdge } from './graph-builder.js';

/**
 * Validate a GraphData object against the expected schema before consumers
 * (report, HTML, query) rely on it. Inspired by Graphify's validate.py —
 * catches malformed or hand-edited graph.json early with clear errors.
 * Returns a list of error strings; empty means valid.
 */

const VALID_EDGE_TYPES = new Set(['import', 'call', 'type-reference']);
const VALID_CONFIDENCE_LABELS = new Set(['EXTRACTED', 'INFERRED', 'AMBIGUOUS']);

export function validateGraph(data: unknown): string[] {
  const errors: string[] = [];

  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return ['Graph must be a JSON object'];
  }

  const graph = data as Partial<GraphData>;

  if (typeof graph.schemaVersion !== 'string') {
    errors.push("Missing or invalid 'schemaVersion' (must be a string)");
  }

  if (typeof graph.nodes !== 'object' || graph.nodes === null || Array.isArray(graph.nodes)) {
    errors.push("'nodes' must be an object keyed by file path");
    return errors; // can't validate further without nodes
  }

  const nodeKeys = new Set(Object.keys(graph.nodes));

  for (const [key, node] of Object.entries(graph.nodes as Record<string, GraphNode>)) {
    errors.push(...validateNode(key, node, nodeKeys));
  }

  // Top-level edges array (optional, but validated when present)
  if (graph.edges !== undefined) {
    if (!Array.isArray(graph.edges)) {
      errors.push("'edges' must be an array when present");
    } else {
      graph.edges.forEach((edge, i) => {
        errors.push(...validateEdge(`edges[${i}]`, edge, nodeKeys));
      });
    }
  }

  return errors;
}

function validateNode(key: string, node: GraphNode, nodeKeys: Set<string>): string[] {
  const errors: string[] = [];
  if (typeof node !== 'object' || node === null) {
    return [`Node '${key}' must be an object`];
  }
  if (node.file !== key) {
    errors.push(`Node '${key}' has mismatched 'file' field ('${node.file}')`);
  }
  for (const field of ['imports', 'exports', 'dependents'] as const) {
    if (!Array.isArray(node[field])) {
      errors.push(`Node '${key}' field '${field}' must be an array`);
    }
  }
  // Edges on a node are optional; validate shape when present
  if (node.edges !== undefined) {
    if (!Array.isArray(node.edges)) {
      errors.push(`Node '${key}' field 'edges' must be an array`);
    } else {
      node.edges.forEach((edge, i) => {
        errors.push(...validateEdge(`${key}.edges[${i}]`, edge, nodeKeys));
      });
    }
  }
  return errors;
}

function validateEdge(label: string, edge: GraphEdge, nodeKeys: Set<string>): string[] {
  const errors: string[] = [];
  if (typeof edge !== 'object' || edge === null) {
    return [`Edge ${label} must be an object`];
  }
  if (typeof edge.source !== 'string') errors.push(`Edge ${label} missing string 'source'`);
  if (typeof edge.target !== 'string') errors.push(`Edge ${label} missing string 'target'`);
  if (!VALID_EDGE_TYPES.has(edge.type)) {
    errors.push(`Edge ${label} has invalid type '${edge.type}' (expected import|call|type-reference)`);
  }
  if (typeof edge.confidence !== 'number' || edge.confidence < 0 || edge.confidence > 1) {
    errors.push(`Edge ${label} 'confidence' must be a number between 0 and 1`);
  }
  if (edge.confidenceLabel !== undefined && !VALID_CONFIDENCE_LABELS.has(edge.confidenceLabel)) {
    errors.push(`Edge ${label} has invalid confidenceLabel '${edge.confidenceLabel}'`);
  }
  // Referential integrity: target should exist as a node (source is the owner)
  if (typeof edge.target === 'string' && nodeKeys.size > 0 && !nodeKeys.has(edge.target)) {
    errors.push(`Edge ${label} target '${edge.target}' does not match any node`);
  }
  return errors;
}

/** Throw a descriptive error if the graph is invalid. */
export function assertValidGraph(data: unknown): asserts data is GraphData {
  const errors = validateGraph(data);
  if (errors.length > 0) {
    const msg = `Graph has ${errors.length} validation error(s):\n` + errors.map(e => `  • ${e}`).join('\n');
    throw new Error(msg);
  }
}
