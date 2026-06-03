import { header, statusIcon, brand, keyValue, divider } from '../utils/ui.js';
import { emitJson } from '../utils/json-output.js';
import { VibeguardError, ErrorCodes } from '../utils/errors.js';
import {
  loadGraphModeState,
  enableGraphMode,
  disableGraphMode,
} from '../engines/graphmode.js';
import type { CommandContext } from '../context.js';

export type GraphModeAction = 'on' | 'off' | 'status';

export interface GraphModeOptions {
  action: GraphModeAction;
}

/**
 * GraphMode command: an independent always-on mode (separate from Caveman) that
 * makes the AI assistant graph-first — it reads only the relevant files via the
 * dependency graph and prints a `GraphMode: ON` indicator on every reply.
 */
export async function runGraphMode(ctx: CommandContext, opts: GraphModeOptions): Promise<void> {
  switch (opts.action) {
    case 'on':
      await enableAction(ctx);
      break;
    case 'off':
      await disableAction(ctx);
      break;
    case 'status':
      await showStatus(ctx);
      break;
    default:
      throw new VibeguardError(
        ErrorCodes.UNKNOWN_OPTION,
        `Unknown graphmode action: "${opts.action}". Use: on | off | status`,
      );
  }
}

async function enableAction(ctx: CommandContext): Promise<void> {
  const { projectRoot, options } = ctx;
  const { written } = await enableGraphMode(projectRoot);

  if (options.json) {
    emitJson({ action: 'graphmode-on', enabled: true, written });
    return;
  }

  const out: string[] = [];
  out.push('');
  out.push(header('GraphMode — ON'));
  out.push('');
  out.push(`  ${statusIcon('success')} ${brand.success('Always-on rules written:')}`);
  for (const w of written) {
    out.push(`    ${brand.muted('•')} ${brand.secondary(w)}`);
  }
  out.push('');
  out.push(divider());
  out.push('');
  out.push(`  ${brand.muted('AI now reads only the relevant files via the graph. Big token savings.')}`);
  out.push(`  ${brand.muted('Build/refresh graph data:')} ${brand.info('vibeguard map')}`);
  out.push(`  ${brand.muted('Turn off:')} ${brand.info('vibeguard graphmode off')}`);
  out.push('');
  process.stdout.write(out.join('\n') + '\n');
}

async function disableAction(ctx: CommandContext): Promise<void> {
  const { projectRoot, options } = ctx;
  const { removed } = await disableGraphMode(projectRoot);

  if (options.json) {
    emitJson({ action: 'graphmode-off', enabled: false, removed });
    return;
  }

  const out: string[] = [];
  out.push('');
  out.push(header('GraphMode — OFF'));
  out.push('');
  if (removed.length > 0) {
    out.push(`  ${statusIcon('success')} ${brand.success('Removed graph-first rules:')}`);
    for (const r of removed) {
      out.push(`    ${brand.muted('•')} ${brand.secondary(r)}`);
    }
  } else {
    out.push(`  ${statusIcon('info')} ${brand.muted('No GraphMode rule files were present.')}`);
  }
  out.push('');
  out.push(`  ${brand.muted('Normal mode restored. Graph data is kept for manual use.')}`);
  out.push('');
  process.stdout.write(out.join('\n') + '\n');
}

async function showStatus(ctx: CommandContext): Promise<void> {
  const { projectRoot, options } = ctx;
  const state = await loadGraphModeState(projectRoot);

  if (options.json) {
    emitJson({ action: 'graphmode-status', enabled: state.enabled, updatedAt: state.updatedAt });
    return;
  }

  const out: string[] = [];
  out.push('');
  out.push(header('GraphMode — Status'));
  out.push('');
  out.push(keyValue('State', state.enabled ? brand.success.bold('ON') : brand.muted('off')));
  out.push('');
  out.push(`  ${brand.muted(state.enabled ? 'Turn off: vibeguard graphmode off' : 'Enable: vibeguard graphmode on')}`);
  out.push('');
  process.stdout.write(out.join('\n') + '\n');
}
