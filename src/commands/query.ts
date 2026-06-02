import type { CommandContext } from '../context.js';
import { loadGraph, buildGraph, GRAPH_SCHEMA_VERSION } from '../engines/graph-builder.js';
import { queryGraph, findPath, explainNode, affectedNodes } from '../engines/query-engine.js';
import { resolveFiles } from '../utils/glob-resolver.js';
import { emitJson } from '../utils/json-output.js';
import { header, keyValue, brand, statusIcon, divider } from '../utils/ui.js';

export interface QueryCommandOptions {
  question?: string;
  budget?: number;
}

export interface PathCommandOptions {
  source: string;
  target: string;
}

export interface ExplainCommandOptions {
  node: string;
}

export interface AffectedCommandOptions {
  node: string;
  depth?: number;
}

export async function runQuery(ctx: CommandContext, opts: QueryCommandOptions): Promise<void> {
  const graphData = await ensureGraph(ctx);

  const result = queryGraph(graphData, opts.question ?? '', { budget: opts.budget });

  if (ctx.options.json) {
    emitJson({
      answer: result.answer,
      relevantNodes: result.relevantNodes,
      confidence: result.confidence,
      tokensSaved: result.tokensSaved,
      tokensUsed: result.tokensUsed,
    });
  } else {
    const output: string[] = [];
    output.push(header('Graph Query', '🔍'));
    output.push('');
    output.push(`  ${brand.muted('Q:')} ${brand.secondary(opts.question ?? '')}`);
    output.push('');
    output.push(result.answer.split('\n').map(l => `  ${l}`).join('\n'));
    output.push('');
    output.push(divider());
    output.push(keyValue('Relevant nodes', brand.info(String(result.relevantNodes.length))));
    output.push(keyValue('Confidence', brand.info(String(result.confidence))));
    output.push(keyValue('Tokens used (est.)', brand.info(`~${result.tokensUsed.toLocaleString()}`)));
    output.push(keyValue('Tokens saved (est.)', brand.success(`~${result.tokensSaved.toLocaleString()}`)));
    if (opts.budget) {
      output.push(keyValue('Budget', brand.muted(`${opts.budget.toLocaleString()} tokens`)));
    }
    output.push('');
    process.stdout.write(output.join('\n') + '\n');
  }
}

export async function runPath(ctx: CommandContext, opts: PathCommandOptions): Promise<void> {
  const graphData = await ensureGraph(ctx);

  const result = findPath(graphData, opts.source, opts.target);

  if (ctx.options.json) {
    emitJson({
      path: result.path ?? [],
      answer: result.answer,
      relevantNodes: result.relevantNodes,
      confidence: result.confidence,
      tokensSaved: result.tokensSaved,
    });
  } else {
    const output: string[] = [];
    output.push(header('Shortest Path', '🛤️'));
    output.push('');
    output.push(`  ${brand.muted('From:')} ${brand.secondary(opts.source)}`);
    output.push(`  ${brand.muted('To:')}   ${brand.secondary(opts.target)}`);
    output.push('');
    output.push(result.answer.split('\n').map(l => `  ${l}`).join('\n'));
    output.push('');
    output.push(divider());
    output.push(keyValue('Hops', brand.info(String(result.path?.length ?? 0))));
    output.push(keyValue('Tokens saved (est.)', brand.success(`~${result.tokensSaved.toLocaleString()}`)));
    output.push('');
    process.stdout.write(output.join('\n') + '\n');
  }
}

export async function runExplain(ctx: CommandContext, opts: ExplainCommandOptions): Promise<void> {
  const graphData = await ensureGraph(ctx);

  const explanation = explainNode(graphData, opts.node);

  if (!explanation) {
    if (ctx.options.json) {
      emitJson({ error: `Node "${opts.node}" not found in graph.` });
    } else {
      process.stderr.write(`\n  ${statusIcon('error')} ${brand.danger(`Node "${opts.node}" not found in graph.`)}\n\n`);
    }
    return;
  }

  if (ctx.options.json) {
    emitJson({ ...explanation });
  } else {
    const output: string[] = [];
    output.push(header('Node Explanation', '📖'));
    output.push('');
    output.push(keyValue('File', brand.secondary(explanation.file)));
    output.push(keyValue('Role', brand.info(explanation.role)));
    output.push(keyValue('Community', brand.muted(explanation.community)));
    output.push(keyValue('Importance', formatImportance(explanation.importance)));
    output.push('');

    if (explanation.exports.length > 0) {
      output.push(`  ${brand.primary.bold('Exports:')}`);
      for (const exp of explanation.exports.slice(0, 15)) {
        output.push(`    ${brand.muted('•')} ${brand.secondary(exp)}`);
      }
      if (explanation.exports.length > 15) output.push(`    ${brand.muted(`... and ${explanation.exports.length - 15} more`)}`);
      output.push('');
    }

    if (explanation.imports.length > 0) {
      output.push(`  ${brand.primary.bold('Imports from:')}`);
      for (const imp of explanation.imports.slice(0, 10)) {
        output.push(`    ${brand.muted('→')} ${imp}`);
      }
      if (explanation.imports.length > 10) output.push(`    ${brand.muted(`... and ${explanation.imports.length - 10} more`)}`);
      output.push('');
    }

    if (explanation.dependents.length > 0) {
      output.push(`  ${brand.primary.bold('Depended on by:')}`);
      for (const dep of explanation.dependents.slice(0, 10)) {
        output.push(`    ${brand.muted('←')} ${dep}`);
      }
      if (explanation.dependents.length > 10) output.push(`    ${brand.muted(`... and ${explanation.dependents.length - 10} more`)}`);
      output.push('');
    }

    if (explanation.edges.length > 0) {
      output.push(`  ${brand.primary.bold('Semantic edges:')}`);
      for (const edge of explanation.edges.slice(0, 8)) {
        const tag = edge.type === 'call' ? '⚡' : edge.type === 'type-reference' ? '📐' : '📦';
        const syms = edge.symbols?.join(', ') ?? '';
        output.push(`    ${tag} ${brand.info(edge.type)} → ${edge.target} ${syms ? brand.muted(`(${syms})`) : ''} [${edge.confidence}]`);
      }
      output.push('');
    }

    output.push(divider());
    output.push(`  ${brand.muted('Query the graph instead of reading files — save tokens.')}`);
    output.push('');
    process.stdout.write(output.join('\n') + '\n');
  }
}

export async function runAffected(ctx: CommandContext, opts: AffectedCommandOptions): Promise<void> {
  const graphData = await ensureGraph(ctx);

  const result = affectedNodes(graphData, opts.node, opts.depth ?? 2);

  if (result.seed === null) {
    if (ctx.options.json) {
      emitJson({ error: `Node "${opts.node}" not found in graph.` });
    } else {
      process.stderr.write(`\n  ${statusIcon('error')} ${brand.danger(`Node "${opts.node}" not found in graph.`)}\n\n`);
    }
    return;
  }

  if (ctx.options.json) {
    emitJson({
      seed: result.seed,
      affected: result.affected,
      affectedCount: result.affected.length,
      tokensSaved: result.tokensSaved,
      tokensUsed: result.tokensUsed,
    });
  } else {
    const output: string[] = [];
    output.push(header('Impact Analysis', '💥'));
    output.push('');
    output.push(keyValue('If you change', brand.secondary(result.seed)));
    output.push(keyValue('Affected nodes', brand.warning.bold(String(result.affected.length))));
    output.push('');
    if (result.affected.length === 0) {
      output.push(`  ${statusIcon('success')} ${brand.success('Nothing depends on this node — safe to change in isolation.')}`);
    } else {
      output.push(`  ${brand.primary.bold('Impacted (transitive dependents):')}`);
      for (const a of result.affected.slice(0, 25)) {
        const indent = '  '.repeat(a.depth);
        output.push(`    ${indent}${brand.muted('←')} ${brand.secondary(a.file)} ${brand.muted(`[${a.viaRelation}, depth ${a.depth}]`)}`);
      }
      if (result.affected.length > 25) {
        output.push(`    ${brand.muted(`... and ${result.affected.length - 25} more`)}`);
      }
    }
    output.push('');
    output.push(divider());
    output.push(`  ${brand.muted('Review these before refactoring')} ${brand.secondary(result.seed)}`);
    output.push('');
    process.stdout.write(output.join('\n') + '\n');
  }
}

function formatImportance(importance: string): string {
  switch (importance) {
    case 'god-node': return brand.danger.bold('🏛️ God Node');
    case 'hub': return brand.warning.bold('⭐ Hub');
    case 'standard': return brand.info('Standard');
    case 'leaf': return brand.muted('🍃 Leaf');
    default: return brand.muted(importance);
  }
}

async function ensureGraph(ctx: CommandContext) {
  let graphData = await loadGraph(ctx.projectRoot);
  if (!graphData) {
    ctx.logger.startSpinner('Building dependency graph...');
    const files = await resolveFiles(ctx.projectRoot, ctx.config.effectiveInclude, ctx.config.effectiveSkipSet);
    const result = await buildGraph(ctx.projectRoot, files, ctx.config, ctx.logger);
    graphData = { schemaVersion: GRAPH_SCHEMA_VERSION, nodes: Object.fromEntries(result.nodes), edges: [] };
    ctx.logger.stopSpinner(true);
  }
  return graphData;
}
