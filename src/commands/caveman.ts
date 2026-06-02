import { header, statusIcon, brand, keyValue, divider } from '../utils/ui.js';
import { emitJson } from '../utils/json-output.js';
import { VibeguardError, ErrorCodes } from '../utils/errors.js';
import {
  loadCavemanState,
  isCavemanLevel,
  levelDescription,
  estimatedSavingsPct,
  enableCaveman as enableCavemanEngine,
  disableCaveman as disableCavemanEngine,
  measureCompression,
  CAVEMAN_LEVELS,
  type CavemanLevel,
} from '../engines/caveman.js';
import type { CommandContext } from '../context.js';

export type CavemanAction = 'on' | 'off' | 'status' | 'level' | 'benchmark';

export interface CavemanOptions {
  action: CavemanAction;
  level?: string;
}

/** A representative verbose sample used by `caveman benchmark` to show real savings. */
const BENCHMARK_SAMPLE = `Sure! I'd be happy to help you with that. The reason your application is \
re-rendering is basically because you are creating a new object reference on \
each render cycle. When you pass an inline object as a prop, the shallow \
comparison in the framework sees it as a different object every single time, \
which actually triggers a re-render. I would definitely recommend that you \
simply wrap the configuration object in a memoization helper so that the \
reference stays stable across renders. You can use \`useMemo\` for this.`;

export async function runCaveman(ctx: CommandContext, opts: CavemanOptions): Promise<void> {
  const { projectRoot, options } = ctx;

  switch (opts.action) {
    case 'on':
      await enableAction(ctx, opts.level, false);
      break;
    case 'level':
      await enableAction(ctx, opts.level, true);
      break;
    case 'off':
      await disableAction(ctx);
      break;
    case 'status':
      await showStatus(projectRoot, options.json);
      break;
    case 'benchmark':
      await showBenchmark(projectRoot, options.json);
      break;
    default:
      throw new VibeguardError(
        ErrorCodes.UNKNOWN_OPTION,
        `Unknown caveman action: "${opts.action}". Use: on | off | status | level | benchmark`,
      );
  }
}

function resolveLevel(raw: string | undefined, current: CavemanLevel): CavemanLevel {
  if (raw === undefined) return current;
  if (!isCavemanLevel(raw)) {
    throw new VibeguardError(
      ErrorCodes.UNKNOWN_OPTION,
      `Unknown caveman level: "${raw}". Valid levels: ${CAVEMAN_LEVELS.join(', ')}`,
      { level: raw, validLevels: [...CAVEMAN_LEVELS] },
    );
  }
  return raw;
}

async function enableAction(ctx: CommandContext, rawLevel: string | undefined, levelOnly: boolean): Promise<void> {
  const { projectRoot, options } = ctx;
  const previous = await loadCavemanState(projectRoot);

  if (levelOnly && !previous.enabled) {
    throw new VibeguardError(
      ErrorCodes.UNKNOWN_OPTION,
      'Caveman mode is off. Enable it first with `vibeguard caveman on`.',
    );
  }

  const level = resolveLevel(rawLevel, previous.level);
  const { written } = await enableCavemanEngine(projectRoot, level);

  if (options.json) {
    emitJson({
      action: levelOnly ? 'caveman-level' : 'caveman-on',
      enabled: true,
      level,
      estimatedSavingsPct: estimatedSavingsPct(level),
      written,
    });
    return;
  }

  const out: string[] = [];
  out.push('');
  out.push(header('Caveman Mode — ON', '🪨'));
  out.push('');
  out.push(keyValue('Level', brand.info.bold(level)));
  out.push(keyValue('Effect', brand.muted(levelDescription(level))));
  out.push(keyValue('Est. output savings', brand.success(`~${estimatedSavingsPct(level)}%`)));
  out.push('');
  out.push(`  ${statusIcon('success')} ${brand.success('Always-on rules written:')}`);
  for (const w of written) {
    out.push(`    ${brand.muted('•')} ${brand.secondary(w)}`);
  }
  out.push('');
  out.push(divider());
  out.push('');
  out.push(`  ${brand.primary.bold('Why use many token when few do trick.')}`);
  out.push(`  ${brand.muted('Every chat now answers terse, high-signal. Technical accuracy kept 100%.')}`);
  out.push(`  ${brand.muted('Switch level:')} ${brand.info('vibeguard caveman level ultra')}`);
  out.push(`  ${brand.muted('Turn off:')}     ${brand.info('vibeguard caveman off')}`);
  out.push('');
  process.stdout.write(out.join('\n') + '\n');
}

async function disableAction(ctx: CommandContext): Promise<void> {
  const { projectRoot, options } = ctx;
  const { removed } = await disableCavemanEngine(projectRoot);

  if (options.json) {
    emitJson({ action: 'caveman-off', enabled: false, removed });
    return;
  }

  const out: string[] = [];
  out.push('');
  out.push(header('Caveman Mode — OFF', '🗣️'));
  out.push('');
  if (removed.length > 0) {
    out.push(`  ${statusIcon('success')} ${brand.success('Removed always-on rules:')}`);
    for (const r of removed) {
      out.push(`    ${brand.muted('•')} ${brand.secondary(r)}`);
    }
  } else {
    out.push(`  ${statusIcon('info')} ${brand.muted('No caveman rule files were present.')}`);
  }
  out.push('');
  out.push(`  ${brand.muted('Normal mode restored. Replies return to full prose.')}`);
  out.push('');
  process.stdout.write(out.join('\n') + '\n');
}

async function showStatus(projectRoot: string, jsonMode: boolean): Promise<void> {
  const state = await loadCavemanState(projectRoot);

  if (jsonMode) {
    emitJson({
      action: 'caveman-status',
      enabled: state.enabled,
      level: state.level,
      estimatedSavingsPct: state.enabled ? estimatedSavingsPct(state.level) : 0,
      updatedAt: state.updatedAt,
    });
    return;
  }

  const out: string[] = [];
  out.push('');
  out.push(header('Caveman Mode — Status', '🪨'));
  out.push('');
  out.push(keyValue('State', state.enabled ? brand.success.bold('ON') : brand.muted('off')));
  out.push(keyValue('Level', brand.info(state.level)));
  if (state.enabled) {
    out.push(keyValue('Effect', brand.muted(levelDescription(state.level))));
    out.push(keyValue('Est. output savings', brand.success(`~${estimatedSavingsPct(state.level)}%`)));
  }
  out.push('');
  out.push(`  ${brand.muted(state.enabled ? 'Turn off: vibeguard caveman off' : 'Enable: vibeguard caveman on')}`);
  out.push('');
  process.stdout.write(out.join('\n') + '\n');
}

/**
 * Measure real (not estimated) compression of a representative sample at all
 * three levels and show the token savings — proof the mode works.
 */
async function showBenchmark(_projectRoot: string, jsonMode: boolean): Promise<void> {
  const results = CAVEMAN_LEVELS.map((level) => measureCompression(BENCHMARK_SAMPLE, level));

  if (jsonMode) {
    emitJson({
      action: 'caveman-benchmark',
      sampleChars: BENCHMARK_SAMPLE.length,
      results: results.map((r) => ({
        level: r.level,
        originalTokens: r.originalTokens,
        compressedTokens: r.compressedTokens,
        savedPct: r.savedPct,
      })),
    });
    return;
  }

  const out: string[] = [];
  out.push('');
  out.push(header('Caveman Mode — Benchmark', '🪨'));
  out.push('');
  out.push(`  ${brand.muted('Real compression of a sample reply (~4 chars/token estimate):')}`);
  out.push('');
  for (const r of results) {
    out.push(keyValue(
      r.level,
      `${brand.muted(`${r.originalTokens} → ${r.compressedTokens} tok`)}  ${brand.success(`−${r.savedPct}%`)}`,
    ));
  }
  out.push('');
  out.push(`  ${brand.muted('Enable with:')} ${brand.info('vibeguard caveman on full')}`);
  out.push('');
  process.stdout.write(out.join('\n') + '\n');
}
