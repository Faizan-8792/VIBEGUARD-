import { header, statusIcon, brand, keyValue, divider } from '../utils/ui.js';
import { emitJson } from '../utils/json-output.js';
import { VibeguardError, ErrorCodes } from '../utils/errors.js';
import {
  loadGraphModeState,
  enableGraphMode,
  disableGraphMode,
  listGraphModeArtifacts,
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
  const leftovers = await listGraphModeArtifacts(projectRoot);

  if (options.json) {
    emitJson({ action: 'graphmode-off', enabled: false, projectRoot, removed, leftovers });
    return;
  }

  const out: string[] = [];
  out.push('');
  out.push(header('GraphMode — OFF'));
  out.push('');
  out.push(keyValue('Project root', brand.secondary(projectRoot)));
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
  if (leftovers.length > 0) {
    out.push(`  ${statusIcon('warning')} ${brand.warning.bold('Still found mode instructions in:')}`);
    for (const l of leftovers) out.push(`    ${brand.muted('•')} ${brand.secondary(l)}`);
    out.push(`  ${brand.muted('Remove these manually, or re-run off in the correct project root.')}`);
    out.push('');
  }
  out.push(`  ${brand.muted('Normal mode restored. Graph data is kept for manual use.')}`);
  out.push(`  ${brand.muted('Tip: if your IDE still shows "GraphMode: ON", start a NEW chat —')}`);
  out.push(`  ${brand.muted('open AI sessions cache the old instructions until then.')}`);
  out.push('');
  process.stdout.write(out.join('\n') + '\n');
}

async function showStatus(ctx: CommandContext): Promise<void> {
  const { projectRoot, options } = ctx;
  const state = await loadGraphModeState(projectRoot);
  const artifacts = await listGraphModeArtifacts(projectRoot);
  const driftStaleOn = !state.enabled && artifacts.length > 0;
  const driftStaleOff = state.enabled && artifacts.length === 0;

  if (options.json) {
    emitJson({
      action: 'graphmode-status',
      enabled: state.enabled,
      updatedAt: state.updatedAt,
      projectRoot,
      ruleFiles: artifacts,
      drift: driftStaleOn ? 'stale-on' : driftStaleOff ? 'stale-off' : null,
    });
    return;
  }

  const out: string[] = [];
  out.push('');
  out.push(header('GraphMode — Status'));
  out.push('');
  out.push(keyValue('State', state.enabled ? brand.success.bold('ON') : brand.muted('off')));
  out.push(keyValue('Project', brand.muted(projectRoot)));
  out.push(keyValue('Rule files', artifacts.length > 0 ? brand.info(String(artifacts.length)) : brand.muted('0')));
  out.push('');

  if (driftStaleOn) {
    out.push(`  ${statusIcon('warning')} ${brand.warning.bold('Drift detected: state is OFF but rule files still exist.')}`);
    out.push(`  ${brand.muted('These files still tell your AI to stay in GraphMode:')}`);
    for (const a of artifacts) out.push(`    ${brand.muted('•')} ${brand.secondary(a)}`);
    out.push(`  ${brand.muted('Fix (run in THIS project):')} ${brand.info('vibeguard graphmode off')}`);
    out.push('');
  } else if (driftStaleOff) {
    out.push(`  ${statusIcon('warning')} ${brand.warning.bold('Drift detected: state is ON but no rule files found.')}`);
    out.push(`  ${brand.muted('Re-apply rules with:')} ${brand.info('vibeguard graphmode on')}`);
    out.push('');
  }

  out.push(`  ${brand.muted(state.enabled ? 'Turn off: vibeguard graphmode off' : 'Enable: vibeguard graphmode on')}`);
  out.push(`  ${brand.muted('Still seeing "GraphMode: ON" in your IDE after off? Start a NEW chat —')}`);
  out.push(`  ${brand.muted('the AI caches instructions for the current session until then.')}`);
  out.push('');
  process.stdout.write(out.join('\n') + '\n');
}
