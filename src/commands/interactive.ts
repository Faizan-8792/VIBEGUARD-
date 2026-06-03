import { select } from '@inquirer/prompts';
import clipboardy from 'clipboardy';
import { banner, header, statusIcon, brand, divider, severityBadge, filePath, scoreBar, keyValue, summaryLine } from '../utils/ui.js';
import type { CommandContext } from '../context.js';
import type { SecurityIssue } from '../engines/security-scanner.js';
import type { ArchitectureDetails, ContextDetails } from '../engines/health-analyzer.js';
import type { LLMProvider } from '../storage/credentials-store.js';

/**
 * Copy text to system clipboard and print confirmation.
 * Falls back to printing the text with copy markers if clipboard access fails.
 */
async function copyToClipboard(text: string, label?: string): Promise<void> {
  try {
    await clipboardy.write(text);
    const msg = label ?? 'Copied to clipboard!';
    process.stdout.write(`\n  ${statusIcon('success')} ${brand.success(msg)}\n`);
  } catch {
    // Fallback: print with copy markers for manual selection
    const output: string[] = [];
    output.push('');
    output.push(`  ${brand.primary.bold('📋 Copy the following into your AI chat:')}`);
    output.push('');
    output.push(brand.secondary('  ─── START COPY ───'));
    output.push('');
    output.push(text.split('\n').map(line => `  ${line}`).join('\n'));
    output.push('');
    output.push(brand.secondary('  ─── END COPY ───'));
    output.push('');
    process.stdout.write(output.join('\n') + '\n');
  }
}

/**
 * Clear the terminal and move the cursor to the top-left so the next render
 * starts at the top of the viewport. This keeps the interactive menu and its
 * output anchored at the top instead of scrolling down the screen. No-ops when
 * stdout is not a TTY (piped/redirected) so captured output stays clean.
 */
function clearScreen(): void {
  if (!process.stdout.isTTY) return;
  // \x1b[2J clears the screen, \x1b[3J clears scrollback, \x1b[H homes cursor.
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
}

export async function runInteractive(ctx: CommandContext): Promise<void> {
  while (true) {
    // Re-anchor the view at the top of the terminal on every cycle so output
    // never drifts down the screen and the menu is always in the same place.
    clearScreen();

    // ── Active-mode indicators (strictly one line each, only when ON) ──────
    const { loadCavemanState } = await import('../engines/caveman.js');
    const cavemanState = await loadCavemanState(ctx.projectRoot);
    if (cavemanState.enabled) {
      process.stdout.write(`Caveman mode: ON\n`);
    }
    const { loadGraphModeState } = await import('../engines/graphmode.js');
    const graphModeState = await loadGraphModeState(ctx.projectRoot);
    if (graphModeState.enabled) {
      process.stdout.write(`GraphMode: ON\n`);
    }

    process.stdout.write('\n');
    process.stdout.write(banner());
    process.stdout.write('\n');

    const action = await select<string>({
      message: brand.primary.bold('What would you like to do?'),
      choices: [
        { name: 'Quick Setup            — Install all & become ready', value: 'quick-setup' },
        { name: 'GraphMode              — Use graph for token savings', value: 'graphmode' },
        { name: 'Caveman Mode           — Save tokens & boost speed', value: 'caveman' },
        { name: 'Cyberattack Proof      — Scan for DDoS, SQLi, XSS, OTP abuse...', value: 'attack' },
        { name: 'Security Scan          — Find secrets & vulnerabilities', value: 'security' },
        { name: 'Security Audit         — Deps (CVE), taint, misconfig + SBOM', value: 'audit' },
        { name: 'Health Check           — Project health score', value: 'health' },
        { name: 'Dead Code Detection    — Find unused files & exports', value: 'dead' },
        { name: 'Context Package        — Generate AI context', value: 'pack' },
        { name: 'Trash Manager          — View soft-deleted files', value: 'trash' },
        { name: 'Initialize Config      — Setup .vibeguard/', value: 'init' },
        { name: 'Configure LLM          — Add API key (OpenAI, Gemini, DeepSeek...)', value: 'llm' },
        { name: brand.muted('Exit'), value: 'exit' },
      ],
    });

    if (action === 'exit') {
      process.stdout.write(`\n  ${statusIcon('success')} ${brand.muted('Goodbye!')}\n\n`);
      break;
    }

    process.stdout.write('\n');

    try {
      switch (action) {
        case 'quick-setup':
          await runQuickSetupInteractive(ctx);
          break;
        case 'security':
          await runSecurityInteractive(ctx);
          break;
        case 'attack':
          await runAttackInteractive(ctx);
          break;
        case 'audit':
          await runAuditInteractive(ctx);
          break;
        case 'health':
          await runHealthInteractive(ctx);
          break;
        case 'dead':
          await runDeadInteractive(ctx);
          break;
        case 'pack':
          await runPackInteractive(ctx);
          break;
        case 'caveman':
          await runCavemanInteractive(ctx);
          break;
        case 'graphmode':
          await runGraphModeInteractive(ctx);
          break;
        case 'trash':
          await runTrashInteractive(ctx);
          break;
        case 'init':
          await runInitInteractive(ctx);
          break;
        case 'llm':
          await runLLMConfigInteractive(ctx);
          break;
      }
    } catch (err) {
      process.stdout.write(`  ${statusIcon('error')} ${brand.danger(err instanceof Error ? err.message : 'Unknown error')}\n`);
    }

    process.stdout.write('\n');

    // Pause so the action's output stays readable at the top of the screen
    // before the next cycle clears and re-anchors the view.
    await pauseForReturn();
  }
}

/**
 * Wait for the user to press Enter before continuing. Lets the current result
 * stay on screen (top-anchored) until the user is ready for the next menu
 * cycle. No-ops on non-TTY stdin so piped/automated runs don't hang.
 */
async function pauseForReturn(): Promise<void> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) return;
  const { input } = await import('@inquirer/prompts');
  try {
    await input({ message: brand.muted('Press Enter to return to the menu…') });
  } catch {
    // Ctrl-C / closed prompt — fall through to the loop, which handles exit.
  }
}

/**
 * Quick Setup: one action = init config + build graph + enable caveman. Makes
 * the project fully ready for VibeGuard in a single menu pick (equivalent to
 * running `npx vibeguard init` from the terminal).
 */
async function runQuickSetupInteractive(ctx: CommandContext): Promise<void> {
  const output: string[] = [];
  output.push(header('Quick Setup'));
  output.push('');

  // 1) Init config
  const { runInit } = await import('./init.js');
  try {
    await runInit(ctx, { force: false });
    output.push(`  ${statusIcon('success')} ${brand.success('Configuration initialized')}`);
  } catch (err) {
    if (err instanceof Error && err.message.includes('already exists')) {
      output.push(`  ${statusIcon('info')} ${brand.muted('Config already exists (kept)')}`);
    } else {
      throw err;
    }
  }

  // 2) Enable Caveman Mode + GraphMode (independent always-on modes)
  const { enableCaveman, DEFAULT_CAVEMAN_LEVEL } = await import('../engines/caveman.js');
  await enableCaveman(ctx.projectRoot, DEFAULT_CAVEMAN_LEVEL);
  const { enableGraphMode } = await import('../engines/graphmode.js');
  await enableGraphMode(ctx.projectRoot);
  output.push(`  ${statusIcon('success')} ${brand.success('Caveman Mode enabled')}`);
  output.push(`  ${statusIcon('success')} ${brand.success('GraphMode enabled')}`);
  process.stdout.write(output.join('\n') + '\n');

  // 3) Build the dependency map — ask the user HOW (LLM / copy-prompt / offline).
  process.stdout.write(`\n  ${brand.primary.bold('Now build the dependency map:')}\n\n`);
  await chooseMapSource(ctx);

  process.stdout.write(`\n  ${brand.primary.bold('All done! Project is fully ready.')}\n`);
}

/**
 * GraphMode toggle. GraphMode is an independent always-on mode (like Caveman)
 * that writes a rule into every IDE/agent memory file telling the assistant to
 * be graph-first and print a `GraphMode: ON` indicator. ON/OFF is real state in
 * `.vibeguard/graphmode.json`; turning it on also builds the graph so the
 * assistant has data to consult.
 */
async function runGraphModeInteractive(ctx: CommandContext): Promise<void> {
  const { loadGraphModeState, enableGraphMode, disableGraphMode } = await import('../engines/graphmode.js');
  const state = await loadGraphModeState(ctx.projectRoot);

  if (state.enabled) {
    const action = await select<string>({
      message: brand.primary.bold('GraphMode is ON. What do you want?'),
      choices: [
        { name: 'Rebuild graph (refresh data)', value: 'rebuild' },
        { name: 'Turn OFF (stop graph-first mode)', value: 'off' },
        { name: brand.muted('↩   Back'), value: 'back' },
      ],
    });

    if (action === 'back') return;
    if (action === 'rebuild') {
      await runMapInteractive(ctx);
      return;
    }
    if (action === 'off') {
      const { removed } = await disableGraphMode(ctx.projectRoot);
      process.stdout.write(`\n  ${statusIcon('success')} ${brand.success('GraphMode: OFF')}\n`);
      if (removed.length > 0) {
        process.stdout.write(`  ${brand.muted(`Removed graph-first rules from ${removed.length} file(s).`)}\n`);
      }
      process.stdout.write(`  ${brand.muted('Graph data kept. Re-enable anytime.')}\n`);
    }
    return;
  }

  // OFF → enable: write rules, then let the user choose HOW to build the map.
  const { written } = await enableGraphMode(ctx.projectRoot);
  process.stdout.write(`\n  ${statusIcon('success')} ${brand.success('GraphMode: ON')} ${brand.muted(`(rules written to ${written.length} file(s))`)}\n\n`);
  await chooseMapSource(ctx);
}

/**
 * Map-source picker. "Copy prompt" is the recommended, most accurate path (a
 * capable coding agent with full repo access builds the exact graph.json), so
 * it sits at the top. LLM generation is a one-click alternative; offline is the
 * always-available local fallback.
 */
async function chooseMapSource(ctx: CommandContext): Promise<void> {
  const { resolveFiles } = await import('../utils/glob-resolver.js');

  const choice = await select<string>({
    message: brand.primary.bold('How should the dependency map be built?'),
    choices: [
      { name: `Copy prompt for creating map  ${brand.success('(recommended — most accurate)')}`, value: 'copy' },
      { name: 'Generate map using LLM        — uses your configured AI key', value: 'llm' },
      { name: 'Create offline map            — local, no AI, instant', value: 'offline' },
      { name: brand.muted('↩   Skip for now'), value: 'skip' },
    ],
  });

  if (choice === 'skip') return;

  if (choice === 'offline') {
    await runMapInteractive(ctx);
    return;
  }

  const files = await resolveFiles(ctx.projectRoot, ctx.config.effectiveInclude, ctx.config.effectiveSkipSet);

  if (choice === 'copy') {
    const { buildMapPrompt } = await import('../engines/map-prompt.js');
    const prompt = buildMapPrompt(files);
    await copyToClipboard(prompt, 'Map-building prompt copied to clipboard!');
    process.stdout.write(`\n  ${brand.muted('Paste it into your coding agent (with repo access). It will write')}\n`);
    process.stdout.write(`  ${brand.secondary('.vibeguard/graph.json')}${brand.muted(', then run')} ${brand.info('vibeguard graph')} ${brand.muted('to view it.')}\n`);
    return;
  }

  if (choice === 'llm') {
    const { CredentialsStore } = await import('../storage/credentials-store.js');
    const creds = await new CredentialsStore(ctx.projectRoot).resolve();
    if (!creds?.apiKey) {
      process.stdout.write(`\n  ${statusIcon('warning')} ${brand.warning('No LLM key configured.')} ${brand.muted('Run "Configure LLM" first, or use Copy prompt / offline.')}\n`);
      return;
    }
    const { generateMapViaLLM } = await import('../engines/map-prompt.js');
    ctx.logger.startSpinner(`Generating map via ${creds.provider} (${creds.model})...`);
    try {
      const result = await generateMapViaLLM(ctx.projectRoot, files, creds);
      ctx.logger.stopSpinner(true);
      process.stdout.write(`\n  ${statusIcon('success')} ${brand.success('Map generated via LLM:')} ${brand.muted(`${result.nodes} files, ${result.edges} edges`)}\n`);
      process.stdout.write(`  ${brand.muted('View it:')} ${brand.info('vibeguard graph')}\n`);
    } catch (err) {
      ctx.logger.stopSpinner(false);
      process.stdout.write(`\n  ${statusIcon('error')} ${brand.danger(err instanceof Error ? err.message : 'LLM map generation failed')}\n`);
      process.stdout.write(`  ${brand.muted('Falling back to offline map...')}\n\n`);
      await runMapInteractive(ctx);
    }
  }
}

async function runSecurityInteractive(ctx: CommandContext): Promise<void> {
  const { resolveFiles } = await import('../utils/glob-resolver.js');
  const { scanSecurity } = await import('../engines/security-scanner.js');

  ctx.logger.startSpinner('[0%] Scanning for security issues...');
  const files = await resolveFiles(ctx.projectRoot, ctx.config.effectiveInclude, ctx.config.effectiveSkipSet);
  const result = await scanSecurity(ctx.projectRoot, files, ctx.config, (current, total) => {
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    ctx.logger.updateSpinner(`[${pct}%] Scanning security (${current}/${total} files)...`);
  });
  ctx.logger.stopSpinner(true);

  const output: string[] = [];
  output.push(header('Security Scan Results'));
  output.push('');

  if (result.issues.length === 0) {
    output.push(`  ${statusIcon('success')} ${brand.success.bold('No security issues found! Your code is clean.')}`);
    process.stdout.write(output.join('\n') + '\n');
    return;
  }

  output.push(summaryLine([
    { label: 'Critical', value: result.counts.critical, color: result.counts.critical > 0 ? 'danger' : 'muted' },
    { label: 'High', value: result.counts.high, color: result.counts.high > 0 ? 'warning' : 'muted' },
    { label: 'Medium', value: result.counts.medium, color: 'muted' },
    { label: 'Low', value: result.counts.low, color: 'muted' },
  ]));
  output.push('');
  output.push(divider());
  output.push('');

  for (const issue of result.issues.slice(0, 15)) {
    output.push(`  ${severityBadge(issue.severity)} ${brand.muted(issue.id)}`);
    output.push(`    ${filePath(issue.file)}${brand.muted(':' + issue.line)}`);
    output.push(`    ${issue.message}`);
    if (issue.suggestedFix) {
      output.push(`    ${statusIcon('success')} ${brand.success('Fix:')} ${brand.secondary(issue.suggestedFix)}`);
    }
    output.push('');
  }

  if (result.issues.length > 15) {
    output.push(`  ${brand.muted(`... and ${result.issues.length - 15} more`)}`);
  }

  process.stdout.write(output.join('\n') + '\n');

  // Ask what to do
  const action = await select<string>({
    message: brand.primary('What would you like to do?'),
    choices: [
      { name: 'Fix Now — Auto-fix .gitignore issues', value: 'fix-gitignore' },
      { name: 'Fix Now — Move secrets to .env', value: 'fix-env' },
      { name: 'Ignore a finding — Stop flagging a false positive', value: 'ignore' },
      { name: 'Copy Fix Instructions (for AI chat)', value: 'copy-instructions' },
      { name: 'Back to menu', value: 'back' },
    ],
  });

  if (action === 'fix-gitignore' || action === 'fix-env') {
    const { runSecurity } = await import('./security.js');
    const fixType = action === 'fix-gitignore' ? 'gitignore' : 'env';
    await runSecurity(ctx, { fix: fixType, dryRun: false, gitSafe: false, force: false });
  } else if (action === 'ignore') {
    await ignoreFindingInteractive(ctx, result.issues);
  } else if (action === 'copy-instructions') {
    await copyFixInstructionsToClipboard(result.issues);
  }
}

/**
 * Interactive false-positive suppression: let the user pick a finding from the
 * current scan and add its ID to `security.ignore` so future scans skip it.
 */
async function ignoreFindingInteractive(ctx: CommandContext, issues: SecurityIssue[]): Promise<void> {
  const { addIgnoredFindings } = await import('../storage/config-store.js');

  const choices = issues.slice(0, 25).map((i) => ({
    name: `${i.id}  ${i.file}:${i.line} — ${i.message}`,
    value: i.id,
  }));
  choices.push({ name: brand.muted('↩   Back'), value: '__back__' });

  const id = await select<string>({
    message: brand.primary('Which finding should VibeGuard stop flagging?'),
    choices,
  });

  if (id === '__back__') return;

  const added = await addIgnoredFindings(ctx.projectRoot, [id]);
  if (added.length > 0) {
    process.stdout.write(`\n  ${statusIcon('success')} ${brand.success(`Ignoring ${id}.`)} ${brand.muted('It will not be flagged again.')}\n`);
    process.stdout.write(`  ${brand.muted('Undo with:')} ${brand.secondary('vibeguard ignore remove ' + id)}\n`);
  } else {
    process.stdout.write(`\n  ${statusIcon('info')} ${brand.muted(`${id} was already ignored.`)}\n`);
  }
}

async function runHealthInteractive(ctx: CommandContext): Promise<void> {
  const { analyzeHealth } = await import('../engines/health-analyzer.js');
  const { select: selectPrompt } = await import('@inquirer/prompts');

  ctx.logger.startSpinner('[1%] Analyzing project health...');
  const result = await analyzeHealth(ctx.config, ctx.projectRoot, (percent, label) => {
    ctx.logger.updateSpinner(`[${percent}%] ${label}`);
  });
  ctx.logger.stopSpinner(true);

  const output: string[] = [];
  output.push(header('Project Health Report'));
  output.push('');

  const overallColor = result.summary.projectHealth >= 80 ? 'success' : result.summary.projectHealth >= 50 ? 'warning' : 'danger';
  output.push(`  ${brand[overallColor].bold(`Overall Health: ${result.summary.projectHealth}/100`)}`);
  output.push('');
  output.push(keyValue('Security', scoreBar(result.summary.security)));
  output.push(keyValue('Dead Code', scoreBar(result.summary.deadCode)));
  output.push(keyValue('Architecture', scoreBar(result.summary.architecture)));
  output.push(keyValue('Context Efficiency', scoreBar(result.summary.contextEfficiency)));

  if (result.warnings.length > 0) {
    output.push('');
    for (const w of result.warnings) {
      output.push(`  ${statusIcon('warning')} ${brand.muted(w)}`);
    }
  }

  process.stdout.write(output.join('\n') + '\n\n');

  if (result.summary.projectHealth < 100) {
    const choices: Array<{ name: string; value: string }> = [];

    if (result.summary.security !== null && result.summary.security < 100) {
      choices.push({ name: 'Fix Security Issues', value: 'security' });
    }
    if (result.summary.deadCode !== null && result.summary.deadCode < 100) {
      choices.push({ name: 'Fix Dead Code', value: 'dead' });
    }
    if (result.summary.architecture !== null && result.summary.architecture < 100) {
      choices.push({ name: 'Fix Architecture (cycles & god-files)', value: 'architecture' });
    }
    if (result.summary.contextEfficiency !== null && result.summary.contextEfficiency < 100) {
      choices.push({ name: 'Fix Context Efficiency (heavy imports)', value: 'context' });
    }
    choices.push({ name: 'Copy Full Report (for AI chat)', value: 'copy' });
    choices.push({ name: 'Back to menu', value: 'back' });

    const action = await selectPrompt<string>({
      message: brand.primary('Improve your score:'),
      choices,
    });

    if (action === 'security') {
      await runSecurityInteractive(ctx);
    } else if (action === 'dead') {
      await runDeadInteractive(ctx);
    } else if (action === 'architecture') {
      await showArchitectureFix(result.architectureDetails);
    } else if (action === 'context') {
      await showContextFix(result.contextDetails);
    } else if (action === 'copy') {
      const lines: string[] = [];
      lines.push(`Project Health Score: ${result.summary.projectHealth}/100`);
      lines.push(`- Security: ${result.summary.security ?? 'N/A'}/100`);
      lines.push(`- Dead Code: ${result.summary.deadCode ?? 'N/A'}/100`);
      lines.push(`- Architecture: ${result.summary.architecture ?? 'N/A'}/100`);
      lines.push(`- Context Efficiency: ${result.summary.contextEfficiency ?? 'N/A'}/100`);
      lines.push('');
      if (result.issues.length > 0) {
        lines.push(`Security issues found: ${result.issues.length}`);
        for (const issue of result.issues.slice(0, 10)) {
          lines.push(`- [${issue.severity}] ${issue.file}:${issue.line} — ${issue.message}`);
        }
        lines.push('');
      }
      lines.push('Please help improve the project health by fixing the above issues.');
      await copyToClipboard(lines.join('\n'));
    }
  }
}

async function showArchitectureFix(details: ArchitectureDetails): Promise<void> {
  const { select: selectPrompt } = await import('@inquirer/prompts');

  const output: string[] = [];
  output.push(header('Architecture Issues'));
  output.push('');

  if (details.cyclicPairs.length === 0 && details.highFanInFiles.length === 0) {
    output.push(`  ${statusIcon('success')} ${brand.success('No specific architecture issues found. Score may be affected by other factors.')}`);
    process.stdout.write(output.join('\n') + '\n');
    return;
  }

  if (details.cyclicPairs.length > 0) {
    output.push(`  ${brand.warning.bold('🔄 Circular dependencies')} ${brand.muted('(files that import each other)')}`);
    for (const p of details.cyclicPairs) {
      output.push(`    ${brand.secondary(p.a)} ${brand.muted('⇄')} ${brand.secondary(p.b)}`);
    }
    output.push('');
  }

  if (details.highFanInFiles.length > 0) {
    output.push(`  ${brand.warning.bold('🏛️ God-files')} ${brand.muted('(too many files depend on these)')}`);
    for (const f of details.highFanInFiles) {
      output.push(`    ${brand.secondary(f.file)} ${brand.muted(`(${f.dependents} dependents)`)}`);
    }
    output.push('');
  }

  output.push(divider());
  output.push(`  ${brand.muted('Fix by: breaking cycles (extract shared code to a third module),')}`);
  output.push(`  ${brand.muted('and splitting god-files into focused modules.')}`);
  output.push('');
  process.stdout.write(output.join('\n') + '\n\n');

  const action = await selectPrompt<string>({
    message: brand.primary('What would you like to do?'),
    choices: [
      { name: 'Copy Fix Instructions (for AI chat)', value: 'copy' },
      { name: 'Back to menu', value: 'back' },
    ],
  });

  if (action === 'copy') {
    const lines: string[] = [];
    lines.push('Refactor the following architecture issues in my project:\n');
    if (details.cyclicPairs.length > 0) {
      lines.push('Circular dependencies (these files import each other — break the cycle by extracting shared code into a new module, or inverting one dependency):');
      for (const p of details.cyclicPairs) {
        lines.push(`- ${p.a}  <->  ${p.b}`);
      }
      lines.push('');
    }
    if (details.highFanInFiles.length > 0) {
      lines.push('God-files (too many modules depend on these — split them into smaller, focused modules so changes have a narrower blast radius):');
      for (const f of details.highFanInFiles) {
        lines.push(`- ${f.file} (${f.dependents} dependents)`);
      }
      lines.push('');
    }
    lines.push('For each: propose a concrete refactor that preserves behavior, and update all imports.');
    await copyToClipboard(lines.join('\n'));
  }
}

async function showContextFix(details: ContextDetails): Promise<void> {
  const { select: selectPrompt } = await import('@inquirer/prompts');

  const output: string[] = [];
  output.push(header('Context Efficiency'));
  output.push('');
  output.push(keyValue('Avg imports/file', brand.info(String(details.avgImports))));
  output.push('');

  if (details.heavyImportFiles.length === 0) {
    output.push(`  ${statusIcon('success')} ${brand.success('No heavy-import files found. Reduce average imports to improve the score.')}`);
    process.stdout.write(output.join('\n') + '\n');
    return;
  }

  output.push(`  ${brand.warning.bold('📦 Heavy-import files')} ${brand.muted('(high import count = large context to load)')}`);
  for (const f of details.heavyImportFiles) {
    output.push(`    ${brand.secondary(f.file)} ${brand.muted(`(${f.imports} imports)`)}`);
  }
  output.push('');
  output.push(divider());
  output.push(`  ${brand.muted('Fix by: grouping related imports behind a barrel/facade module,')}`);
  output.push(`  ${brand.muted('removing unused imports, and splitting large files by responsibility.')}`);
  output.push('');
  process.stdout.write(output.join('\n') + '\n\n');

  const action = await selectPrompt<string>({
    message: brand.primary('What would you like to do?'),
    choices: [
      { name: 'Copy Fix Instructions (for AI chat)', value: 'copy' },
      { name: 'Back to menu', value: 'back' },
    ],
  });

  if (action === 'copy') {
    const lines: string[] = [];
    lines.push('Reduce import bloat (context efficiency) in my project:\n');
    lines.push(`Average imports per file: ${details.avgImports}`);
    lines.push('');
    lines.push('These files have the most imports — split them by responsibility, remove unused imports, or introduce a facade/barrel module for related dependencies:');
    for (const f of details.heavyImportFiles) {
      lines.push(`- ${f.file} (${f.imports} imports)`);
    }
    lines.push('');
    lines.push('Keep behavior identical and update all references.');
    await copyToClipboard(lines.join('\n'));
  }
}

async function runAuditInteractive(ctx: CommandContext): Promise<void> {
  const { runAudit } = await import('./audit.js');
  // Reuse the audit command directly; it renders its own terminal report.
  await runAudit(ctx, { sbom: false });
}

async function runMapInteractive(ctx: CommandContext): Promise<void> {
  const { buildGraph, GRAPH_SCHEMA_VERSION } = await import('../engines/graph-builder.js');
  const { resolveFiles } = await import('../utils/glob-resolver.js');
  const { generateHTMLGraph } = await import('../engines/html-graph-generator.js');
  const { generateGraphReport } = await import('../engines/graph-report-generator.js');

  ctx.logger.startSpinner('Building dependency graph...');
  const files = await resolveFiles(ctx.projectRoot, ctx.config.effectiveInclude, ctx.config.effectiveSkipSet);
  const result = await buildGraph(ctx.projectRoot, files, ctx.config, ctx.logger);
  ctx.logger.stopSpinner(true);

  // Also produce the interactive HTML + architecture report, so choosing "map"
  // from the menu yields the full graph.html (not just graph.json).
  const graphData = { schemaVersion: GRAPH_SCHEMA_VERSION, nodes: Object.fromEntries(result.nodes) };
  ctx.logger.startSpinner('Generating report & visualization...');
  await Promise.all([
    generateHTMLGraph(ctx.projectRoot, graphData),
    generateGraphReport(ctx.projectRoot, graphData),
  ]);
  ctx.logger.stopSpinner(true);

  const output: string[] = [];
  output.push(header('Dependency Graph'));
  output.push('');
  output.push(keyValue('Nodes', brand.info.bold(String(result.summary.nodes))));
  output.push(keyValue('Edges', brand.info.bold(String(result.summary.edges))));
  output.push(keyValue('Rebuilt', brand.secondary(String(result.summary.rebuilt))));
  output.push(keyValue('Skipped', brand.muted(String(result.summary.skipped))));
  if (result.summary.added.length > 0) {
    output.push(keyValue('Added', brand.success(`+${result.summary.added.length}`)));
  }
  if (result.summary.removed.length > 0) {
    output.push(keyValue('Removed', brand.danger(`-${result.summary.removed.length}`)));
  }
  output.push('');
  output.push(`  ${statusIcon('success')} ${brand.success('Generated:')}`);
  output.push(`    ${brand.muted('•')} ${brand.secondary('.vibeguard/graph.json')}       ${brand.muted('Dependency data')}`);
  output.push(`    ${brand.muted('•')} ${brand.secondary('.vibeguard/graph.html')}       ${brand.muted('Interactive visualization')}`);
  output.push(`    ${brand.muted('•')} ${brand.secondary('.vibeguard/GRAPH_REPORT.md')}  ${brand.muted('Architecture report')}`);
  output.push('');
  output.push(`  ${brand.muted('Open the interactive graph:')} ${brand.secondary('vibeguard graph')}`);

  process.stdout.write(output.join('\n') + '\n');
}

async function runDeadInteractive(ctx: CommandContext): Promise<void> {
  const { loadGraph } = await import('../engines/graph-builder.js');
  const { loadImportance } = await import('../engines/importance-analyzer.js');
  const { scanDeadCode } = await import('../engines/dead-code-scanner.js');

  let graph = await loadGraph(ctx.projectRoot);
  if (!graph) {
    process.stdout.write(`  ${statusIcon('warning')} ${brand.warning('No graph found. Running map first...')}\n\n`);
    await runMapInteractive(ctx);
    process.stdout.write('\n');
    graph = await loadGraph(ctx.projectRoot);
  }

  if (!graph) {
    process.stdout.write(`  ${statusIcon('error')} ${brand.danger('Failed to build graph')}\n`);
    return;
  }

  const importanceScores = await loadImportance(ctx.projectRoot) ?? {};
  const graphNodes = new Map(Object.entries(graph.nodes));
  const result = await scanDeadCode(ctx.projectRoot, graphNodes, importanceScores);

  // If the scanner aborted (no valid entrypoint / too many flagged), warn and stop.
  if (result.warning) {
    process.stdout.write(`\n  ${header('Dead Code Analysis')}\n\n`);
    process.stdout.write(`  ${statusIcon('warning')} ${brand.warning(result.warning)}\n\n`);
    return;
  }

  const output: string[] = [];
  output.push(header('Dead Code Analysis'));
  output.push('');
  output.push(summaryLine([
    { label: 'Unused Files', value: result.summary.unusedFiles, color: result.summary.unusedFiles > 0 ? 'warning' : 'success' },
    { label: 'Unused Exports', value: result.summary.unusedExports, color: 'muted' },
  ]));
  output.push('');

  if (result.candidates.length > 0) {
    result.candidates.sort((a, b) => a.importance - b.importance);
    output.push(divider());
    output.push('');

    for (const c of result.candidates.slice(0, 10)) {
      output.push(`  📄 ${filePath(c.path)} ${brand.muted(`imp:${c.importance}`)}`);
    }

    if (result.candidates.length > 10) {
      output.push(`  ${brand.muted(`... and ${result.candidates.length - 10} more`)}`);
    }

    process.stdout.write(output.join('\n') + '\n\n');

    const action = await select<string>({
      message: brand.primary('What would you like to do?'),
      choices: [
        { name: 'Move dead files to trash (safe, reversible)', value: 'apply' },
        { name: 'Preview changes (dry-run)', value: 'dry-run' },
        { name: 'Copy Fix Instructions (for AI chat)', value: 'copy' },
        { name: 'Back to menu', value: 'back' },
      ],
    });

    if (action === 'apply') {
      const { runClean } = await import('./clean.js');
      await runClean(ctx, { plan: false, apply: true, interactive: false, dryRun: false, gitSafe: false, force: false });
    } else if (action === 'dry-run') {
      const { runClean } = await import('./clean.js');
      await runClean(ctx, { plan: false, apply: true, interactive: false, dryRun: true, gitSafe: false, force: false });
    } else if (action === 'copy') {
      const lines: string[] = [];
      lines.push('These files are dead code (unreachable from entrypoints):');
      lines.push('');
      for (const c of result.candidates.filter(c => c.kind === 'file').slice(0, 30)) {
        lines.push(`- ${c.path} (importance: ${c.importance})`);
      }
      lines.push('');
      lines.push('Please review and either delete unused files or wire them into the project.');
      await copyToClipboard(lines.join('\n'));
    }
  } else {
    output.push(`  ${statusIcon('success')} ${brand.success.bold('No dead code found!')}`);
    process.stdout.write(output.join('\n') + '\n');
  }
}

async function runPackInteractive(ctx: CommandContext): Promise<void> {
  const { input } = await import('@inquirer/prompts');

  const task = await input({
    message: brand.primary('Describe your task:'),
    validate: (val) => val.trim().length > 0 || 'Please enter a task description',
  });

  const { runPack } = await import('./pack.js');
  await runPack(ctx, { task, radius: undefined, budget: undefined, mode: undefined });
}

async function runCavemanInteractive(ctx: CommandContext): Promise<void> {
  const { loadCavemanState, estimatedSavingsPct } = await import('../engines/caveman.js');
  const { runCaveman } = await import('./caveman.js');

  const state = await loadCavemanState(ctx.projectRoot);

  const output: string[] = [];
  output.push(header('Caveman Mode'));
  output.push('');
  output.push(`  ${brand.primary.bold('Why use many token when few do trick.')}`);
  output.push(`  ${brand.muted('Terse, high-signal AI replies. Full technical accuracy. Fewer tokens, faster reads.')}`);
  output.push('');
  output.push(keyValue('Current', state.enabled ? brand.success.bold(`ON (${state.level})`) : brand.muted('off')));
  output.push('');
  process.stdout.write(output.join('\n') + '\n');

  const choice = await select<string>({
    message: brand.primary.bold('Caveman action:'),
    choices: [
      { name: `Enable — lite    ${brand.muted(`(~${estimatedSavingsPct('lite')}%)`)}`, value: 'lite' },
      { name: `Enable — full    ${brand.muted(`(~${estimatedSavingsPct('full')}%)`)}`, value: 'full' },
      { name: `Enable — ultra   ${brand.muted(`(~${estimatedSavingsPct('ultra')}%)`)}`, value: 'ultra' },
      { name: 'Disable (normal mode)', value: 'off' },
      { name: brand.muted('↩   Back'), value: 'back' },
    ],
  });

  process.stdout.write('\n');

  if (choice === 'back') return;
  if (choice === 'off') {
    await runCaveman(ctx, { action: 'off' });
    return;
  }
  await runCaveman(ctx, { action: 'on', level: choice });
}

async function runTrashInteractive(ctx: CommandContext): Promise<void> {
  const { TrashStoreImpl } = await import('../storage/trash-store.js');
  const trashStore = new TrashStoreImpl(ctx.projectRoot);
  const entries = await trashStore.list();

  const output: string[] = [];
  output.push(header('Trash Manager'));
  output.push('');

  if (entries.length === 0) {
    output.push(`  ${statusIcon('success')} ${brand.success('Trash is empty — nothing to restore')}`);
  } else {
    output.push(`  ${brand.muted(`${entries.length} entries in trash:`)}`);
    output.push('');
    for (const entry of entries.slice(0, 15)) {
      const date = new Date(entry.movedAt).toLocaleDateString();
      output.push(`  ${brand.muted(entry.id.slice(0, 8))} ${filePath(entry.originalPath)} ${brand.muted(`(${date})`)}`);
    }
    output.push('');
    output.push(`  ${brand.info('💡 To restore:')}`);
    output.push(`     ${brand.secondary('npx vibeguard trash restore <id>')}`);
  }

  process.stdout.write(output.join('\n') + '\n');
}

async function runInitInteractive(ctx: CommandContext): Promise<void> {
  const { runInit } = await import('./init.js');
  try {
    await runInit(ctx, { force: false });
    process.stdout.write(`  ${statusIcon('success')} ${brand.success('Configuration initialized!')}\n`);
  } catch (err) {
    if (err instanceof Error && err.message.includes('already exists')) {
      process.stdout.write(`  ${statusIcon('info')} ${brand.info('Already initialized. Use')} ${brand.secondary('vibeguard init --force')} ${brand.info('to reset.')}\n`);
    } else {
      throw err;
    }
  }

  // Build the dependency graph + interactive HTML right after init so the
  // project is immediately usable (graph.json, graph.html, GRAPH_REPORT.md).
  process.stdout.write('\n');
  await runMapInteractive(ctx);
}

async function copyFixInstructionsToClipboard(issues: SecurityIssue[]): Promise<void> {
  const clipText: string[] = [];
  clipText.push('Fix the following security issues in my project:\n');
  for (const issue of issues) {
    clipText.push(`- [${issue.severity.toUpperCase()}] ${issue.file}:${issue.line} — ${issue.message}`);
    if (issue.suggestedFix) {
      clipText.push(`  Suggested fix: ${issue.suggestedFix}`);
    }
  }
  clipText.push('\nPlease fix each issue by:');
  clipText.push('1. Moving hard-coded secrets to environment variables (.env)');
  clipText.push('2. Adding .env to .gitignore');
  clipText.push('3. Replacing hard-coded values with process.env.VARIABLE_NAME');
  clipText.push('4. Fixing CORS configuration to use specific origins');

  await copyToClipboard(clipText.join('\n'));
}

async function runAttackInteractive(ctx: CommandContext): Promise<void> {
  const { scanAttacks } = await import('../engines/attack-scanner.js');
  const { scanSecurity } = await import('../engines/security-scanner.js');
  const { resolveFiles } = await import('../utils/glob-resolver.js');
  const { CredentialsStore } = await import('../storage/credentials-store.js');
  const { select: selectPrompt } = await import('@inquirer/prompts');

  const files = await resolveFiles(ctx.projectRoot, ctx.config.effectiveInclude, ctx.config.effectiveSkipSet);
  ctx.logger.startSpinner('Scanning for cyberattack vectors...');
  const result = await scanAttacks(ctx.projectRoot, files, ctx.config);
  ctx.logger.stopSpinner(true);

  const output: string[] = [];
  output.push(header('Cyberattack Proof Scan'));
  output.push('');
  output.push(`  ${brand.muted('Scanned for:')} ${brand.secondary(result.coverage.length + ' attack types')} ${brand.muted('(DDoS, brute-force, OTP abuse, SQLi, XSS, SSRF, CSRF, weak crypto, etc.)')}`);
  output.push('');

  if (result.findings.length === 0) {
    output.push(`  ${statusIcon('success')} ${brand.success.bold('No attack vectors detected in local scan!')}`);
  } else {
    output.push(summaryLine([
      { label: 'Critical', value: result.counts.critical, color: result.counts.critical > 0 ? 'danger' : 'muted' },
      { label: 'High', value: result.counts.high, color: result.counts.high > 0 ? 'warning' : 'muted' },
      { label: 'Medium', value: result.counts.medium, color: 'muted' },
      { label: 'Low', value: result.counts.low, color: 'muted' },
    ]));
    output.push('');
    output.push(divider());
    output.push('');

    const byType = new Map<string, typeof result.findings>();
    for (const f of result.findings) {
      if (!byType.has(f.attackType)) byType.set(f.attackType, []);
      byType.get(f.attackType)!.push(f);
    }

    for (const [attackType, findings] of byType) {
      const worst = findings[0];
      output.push(`  ${severityBadge(worst.severity)} ${brand.primary.bold(attackType)} ${brand.muted(`(${findings.length})`)}`);
      for (const f of findings.slice(0, 2)) {
        output.push(`    ${filePath(f.file)}${brand.muted(':' + f.line)}`);
      }
      output.push(`    ${statusIcon('info')} ${brand.secondary(worst.recommendation)}`);
      output.push('');
    }
  }

  process.stdout.write(output.join('\n') + '\n\n');

  // Offer next actions
  const credStore = new CredentialsStore(ctx.projectRoot);
  const hasCredentials = (await credStore.resolve()) !== null;

  const choices: Array<{ name: string; value: string }> = [];
  if (hasCredentials) {
    choices.push({ name: 'Run AI Deep Scan (stronger, uses your LLM)', value: 'ai' });
  } else {
    choices.push({ name: 'Set up LLM API key for AI deep scan', value: 'setup' });
  }
  choices.push({ name: 'Copy findings to clipboard', value: 'copy' });
  choices.push({ name: 'Back to menu', value: 'back' });

  const action = await selectPrompt<string>({
    message: brand.primary('What next?'),
    choices,
  });

  if (action === 'ai') {
    const credentials = await credStore.resolve();
    if (!credentials) return;
    const securityResult = await scanSecurity(ctx.projectRoot, files, ctx.config);
    process.stdout.write(`\n  ${statusIcon('info')} ${brand.muted(`Running AI deep scan with ${credentials.model}...`)}\n`);
    try {
      const { runAIAdvisor } = await import('../engines/ai-security-advisor.js');
      const ai = await runAIAdvisor(ctx.projectRoot, credentials, result.findings, securityResult.issues, { maxTokens: 1500 });
      const aiOut: string[] = [];
      aiOut.push('');
      aiOut.push(`  ${brand.primary.bold('🤖 AI Deep Scan')} ${brand.muted(`(${ai.model}, ${ai.tokensUsed} tokens)`)}`);
      aiOut.push('');
      aiOut.push(`  ${ai.summary}`);
      aiOut.push('');
      if (ai.additionalFindings.length > 0) {
        aiOut.push(`  ${brand.muted.bold('Additional findings:')}`);
        for (const f of ai.additionalFindings) {
          aiOut.push(`  ${severityBadge(f.severity)} ${brand.primary(f.attackType)} ${brand.muted('@ ' + f.file)}`);
          aiOut.push(`    ${f.description}`);
          aiOut.push(`    ${statusIcon('success')} ${brand.success('Fix:')} ${brand.secondary(f.fix)}`);
          aiOut.push('');
        }
      }
      if (ai.prioritizedFixes.length > 0) {
        aiOut.push(`  ${brand.muted.bold('Prioritized remediation:')}`);
        ai.prioritizedFixes.forEach((fix, i) => aiOut.push(`    ${brand.info(`${i + 1}.`)} ${fix}`));
        aiOut.push('');
      }
      process.stdout.write(aiOut.join('\n') + '\n');

      // Offer to actually apply fixes
      const fixAction = await selectPrompt<string>({
        message: brand.primary('Fix these issues now?'),
        choices: [
          { name: 'Yes — Let AI fix the vulnerable files (with backup)', value: 'fix' },
          { name: 'Preview AI fixes first (diff, no changes)', value: 'preview' },
          { name: 'Not now', value: 'skip' },
        ],
      });

      if (fixAction === 'fix' || fixAction === 'preview') {
        await runAIFixFlow(ctx, credentials, result.findings, securityResult.issues, fixAction === 'preview');

        // After applying fixes, re-scan so the user sees the updated state
        if (fixAction === 'fix') {
          const rescan = await scanAttacks(ctx.projectRoot, files, ctx.config);
          const remaining = rescan.findings.length;
          if (remaining === 0) {
            process.stdout.write(`\n  ${statusIcon('success')} ${brand.success.bold('Re-scan complete — no attack vectors remain!')}\n\n`);
          } else {
            process.stdout.write(`\n  ${statusIcon('info')} ${brand.muted(`Re-scan: ${remaining} finding(s) remain (some may need manual review).`)}\n\n`);
          }
        }
      }
    } catch (err) {
      process.stdout.write(`  ${statusIcon('error')} ${brand.danger(`AI scan failed: ${err instanceof Error ? err.message : 'unknown'}`)}\n`);
    }
  } else if (action === 'setup') {
    const { input } = await import('@inquirer/prompts');
    const key = await input({ message: brand.primary('Paste your LLM API key:'), validate: (v) => v.trim().length > 0 || 'Key required' });
    const { runConfig } = await import('./config.js');
    await runConfig(ctx, { action: 'set-key', value: key.trim(), test: true });
  } else if (action === 'copy') {
    const lines: string[] = [];
    lines.push('Fix the following cyberattack vulnerabilities in my project:\n');
    for (const f of result.findings) {
      lines.push(`- [${f.severity.toUpperCase()}] ${f.attackType} @ ${f.file}:${f.line}`);
      lines.push(`  ${f.message}`);
      lines.push(`  Fix: ${f.recommendation}`);
    }
    await copyToClipboard(lines.join('\n'));
  }
}

async function runLLMConfigInteractive(ctx: CommandContext): Promise<void> {
  const { select: selectPrompt, input, password } = await import('@inquirer/prompts');
  const { PROVIDER_DEFAULTS, LLM_PROVIDERS } = await import('../storage/credentials-store.js');
  const { runConfig } = await import('./config.js');

  process.stdout.write('\n');
  process.stdout.write(header('Configure LLM Provider') + '\n\n');

  const provider = await selectPrompt<LLMProvider>({
    message: brand.primary('Select your LLM provider:'),
    choices: LLM_PROVIDERS.map((p) => ({
      name: PROVIDER_DEFAULTS[p].label,
      value: p,
    })),
  });

  const defaults = PROVIDER_DEFAULTS[provider];

  // Custom provider needs base URL + model
  let baseUrl: string | undefined;
  let model: string;

  if (provider === 'custom') {
    baseUrl = await input({
      message: brand.primary('Base URL (OpenAI-compatible /v1 endpoint):'),
      validate: (v) => v.trim().length > 0 || 'Base URL required',
    });
    model = await input({
      message: brand.primary('Model name:'),
      validate: (v) => v.trim().length > 0 || 'Model name required',
    });
  } else {
    model = await input({
      message: brand.primary('Model name:'),
      default: defaults.model,
    });
  }

  // Ollama (local) doesn't require a key
  let apiKey = 'local';
  if (provider !== 'ollama') {
    apiKey = await password({
      message: brand.primary(`Paste your ${defaults.label} API key:`),
      mask: '*',
      validate: (v) => v.trim().length > 0 || 'API key required',
    });
  }

  await runConfig(ctx, {
    action: 'set-key',
    value: apiKey.trim(),
    provider,
    model: model.trim(),
    baseUrl,
    test: true,
  });
}

async function runAIFixFlow(
  ctx: CommandContext,
  credentials: import('../storage/credentials-store.js').LLMCredentials,
  attackFindings: import('../engines/attack-scanner.js').AttackFinding[],
  securityIssues: SecurityIssue[],
  previewOnly: boolean,
): Promise<void> {
  const { generateFixes, applyFixes } = await import('../engines/ai-fixer.js');
  const { select: selectPrompt } = await import('@inquirer/prompts');

  process.stdout.write(`\n  ${statusIcon('info')} ${brand.muted('Generating AI fixes (this may take a moment)...')}\n`);

  let plans;
  try {
    plans = await generateFixes(ctx.projectRoot, credentials, attackFindings, securityIssues, { maxFiles: 8 });
  } catch (err) {
    process.stdout.write(`  ${statusIcon('error')} ${brand.danger(`Fix generation failed: ${err instanceof Error ? err.message : 'unknown'}`)}\n`);
    return;
  }

  const changedPlans = plans.filter((p) => p.changed);

  if (changedPlans.length === 0) {
    process.stdout.write(`\n  ${statusIcon('info')} ${brand.muted('No automated fixes could be generated. Review findings manually.')}\n\n`);
    return;
  }

  // Show summary of proposed fixes
  const out: string[] = [];
  out.push('');
  out.push(divider());
  out.push('');
  out.push(`  ${brand.primary.bold('Proposed Fixes')} ${brand.muted(`(${changedPlans.length} files)`)}`);
  out.push('');
  for (const plan of changedPlans) {
    out.push(`  ${statusIcon('success')} ${filePath(plan.file)}`);
    out.push(`    ${brand.muted(plan.explanation)}`);
    const before = plan.originalContent.split('\n').length;
    const after = plan.fixedContent.split('\n').length;
    out.push(`    ${brand.secondary(`${plan.issues.length} issue(s) addressed`)} ${brand.muted(`(${before} → ${after} lines)`)}`);
    out.push('');
  }
  process.stdout.write(out.join('\n'));

  if (previewOnly) {
    process.stdout.write(`  ${brand.info('💡 Preview only — no files changed.')} ${brand.muted('Re-run and choose "Yes" to apply.')}\n\n`);
    return;
  }

  // Confirm before applying
  const confirm = await selectPrompt<string>({
    message: brand.primary(`Apply these fixes to ${changedPlans.length} file(s)?`),
    choices: [
      { name: 'Yes, apply (originals backed up to .vibeguard-trash/)', value: 'yes' },
      { name: 'Cancel', value: 'no' },
    ],
  });

  if (confirm !== 'yes') {
    process.stdout.write(`\n  ${statusIcon('info')} ${brand.muted('Cancelled. No changes made.')}\n\n`);
    return;
  }

  const { applied, backupDir } = await applyFixes(ctx.projectRoot, changedPlans);
  const relBackup = backupDir.replace(ctx.projectRoot, '').replace(/^[/\\]/, '');

  process.stdout.write(`\n  ${statusIcon('success')} ${brand.success.bold(`Applied fixes to ${applied} file(s)!`)}\n`);
  process.stdout.write(`  ${brand.muted('Originals backed up to:')} ${brand.secondary(relBackup)}\n`);
  process.stdout.write(`  ${brand.muted('Re-run')} ${brand.secondary('vibeguard attack')} ${brand.muted('to verify the fixes.')}\n\n`);
}
