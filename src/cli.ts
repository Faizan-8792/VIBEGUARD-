#!/usr/bin/env node

import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger, type Logger } from './utils/logger.js';
import { VibeguardError, ErrorCodes, getExitCode, formatErrorJson, formatErrorTerminal } from './utils/errors.js';
import { loadConfig, type ResolvedConfig } from './storage/config-store.js';
import { runInit } from './commands/init.js';
import { banner, quickStart } from './utils/ui.js';

// Re-export the programmatic API so it's reachable from the entrypoint
export { runCommand, generateContextForEditor, serializeContextPackageForAgent } from './api.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getVersion(): string {
  try {
    const pkgPath = join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

export interface GlobalOptions {
  json: boolean;
  cwd: string;
  include: string[];
  exclude: string[];
  config: string | undefined;
  verbose: boolean;
  quiet: boolean;
}

export interface CommandContext {
  options: GlobalOptions;
  config: ResolvedConfig;
  logger: Logger;
  projectRoot: string;
}

async function createContext(opts: GlobalOptions, commandName: string): Promise<CommandContext> {
  const projectRoot = resolve(opts.cwd || process.cwd());
  const logger = createLogger({
    jsonMode: opts.json,
    quiet: opts.quiet,
    verbose: opts.verbose,
    command: commandName,
  });

  const config = await loadConfig(
    projectRoot,
    opts.config,
    opts.include || [],
    opts.exclude || [],
  );

  return { options: opts, config, logger, projectRoot };
}

interface ShorthandFlags {
  scan?: boolean;
  health?: boolean;
  graph?: boolean;
  dead?: boolean;
  run?: boolean;
}

interface ShorthandDispatch {
  command: string;
  run: (ctx: CommandContext) => Promise<void>;
}

function resolveShorthand(opts: ShorthandFlags): ShorthandDispatch | null {
  if (opts.run) {
    return {
      command: 'interactive',
      async run(ctx) {
        const { runInteractive } = await import('./commands/interactive.js');
        await runInteractive(ctx);
      },
    };
  }
  if (opts.scan) {
    return {
      command: 'security',
      async run(ctx) {
        const { runSecurity } = await import('./commands/security.js');
        await runSecurity(ctx, { dryRun: false, gitSafe: false, force: false });
      },
    };
  }
  if (opts.health) {
    return {
      command: 'doctor',
      async run(ctx) {
        const { runDoctor } = await import('./commands/doctor.js');
        await runDoctor(ctx);
      },
    };
  }
  if (opts.graph) {
    return {
      command: 'map',
      async run(ctx) {
        const { runMap } = await import('./commands/map.js');
        await runMap(ctx);
      },
    };
  }
  if (opts.dead) {
    return {
      command: 'clean',
      async run(ctx) {
        const { runClean } = await import('./commands/clean.js');
        await runClean(ctx, { plan: true, apply: false, interactive: false, dryRun: false, gitSafe: false, force: false });
      },
    };
  }
  return null;
}

function setupProgram(): Command {
  const program = new Command();

  program
    .name('vibeguard')
    .description('Local-only CLI for TypeScript/JavaScript static analysis, dead code detection, and context packaging')
    .version(getVersion())
    .option('--json', 'Output results as JSON', false)
    .option('--cwd <path>', 'Set working directory', '')
    .option('--include <globs...>', 'Include only files matching these globs')
    .option('--exclude <globs...>', 'Exclude files matching these globs')
    .option('--config <path>', 'Path to configuration file')
    .option('--verbose', 'Enable debug output', false)
    .option('--quiet', 'Suppress info and debug output', false)
    .option('--scan', 'Quick shortcut: run security scan')
    .option('--health', 'Quick shortcut: run project health check')
    .option('--graph', 'Quick shortcut: build dependency graph')
    .option('--dead', 'Quick shortcut: detect dead code')
    .option('--run', 'Launch interactive mode (like Claude Code)')
    .action(async () => {
      const globalOpts = program.opts() as GlobalOptions & ShorthandFlags;

      const shorthand = resolveShorthand(globalOpts);
      if (shorthand) {
        const ctx = await createContext(globalOpts, shorthand.command);
        await shorthand.run(ctx);
        return;
      }

      // No subcommand and no shorthand: show branded help
      process.stdout.write(banner() + '\n');
      process.stdout.write(quickStart() + '\n');
    });

  // init command
  program
    .command('init')
    .description('Initialize .vibeguard/ configuration')
    .option('--force', 'Overwrite existing configuration', false)
    .action(async (cmdOpts) => {
      const globalOpts = program.opts() as GlobalOptions;
      const initCtx = await createContext(globalOpts, 'init');
      await runInit(initCtx, { force: cmdOpts.force });
    });

  // map command
  program
    .command('map')
    .description('Build and persist the project dependency graph')
    .action(async () => {
      const globalOpts = program.opts() as GlobalOptions;
      const ctx = await createContext(globalOpts, 'map');
      const { runMap } = await import('./commands/map.js');
      await runMap(ctx);
    });

  // security command
  program
    .command('security')
    .description('Detect security issues: exposed secrets, risky framework usage')
    .option('--fix <type>', 'Apply auto-fix (gitignore, env)')
    .option('--dry-run', 'Show planned changes without applying', false)
    .option('--git-safe', 'Create a branch for changes', false)
    .option('--force', 'Override safety limits', false)
    .action(async (cmdOpts) => {
      const globalOpts = program.opts() as GlobalOptions;
      const ctx = await createContext(globalOpts, 'security');
      const { runSecurity } = await import('./commands/security.js');
      await runSecurity(ctx, {
        fix: cmdOpts.fix,
        dryRun: cmdOpts.dryRun,
        gitSafe: cmdOpts.gitSafe,
        force: cmdOpts.force,
      });
    });

  // clean command
  program
    .command('clean')
    .description('Detect dead code and stage cleanup actions')
    .option('--plan', 'Generate cleanup plan without applying', false)
    .option('--apply', 'Apply the most recent cleanup plan', false)
    .option('--interactive', 'Prompt for confirmation per batch', false)
    .option('--dry-run', 'Show planned changes without applying', false)
    .option('--git-safe', 'Create a branch for changes', false)
    .option('--force', 'Override safety limits', false)
    .action(async (cmdOpts) => {
      const globalOpts = program.opts() as GlobalOptions;
      const ctx = await createContext(globalOpts, 'clean');
      const { runClean } = await import('./commands/clean.js');
      await runClean(ctx, {
        plan: cmdOpts.plan,
        apply: cmdOpts.apply,
        interactive: cmdOpts.interactive,
        dryRun: cmdOpts.dryRun,
        gitSafe: cmdOpts.gitSafe,
        force: cmdOpts.force,
      });
    });

  // pack command
  program
    .command('pack [task]')
    .description('Produce a focused context package for a given task')
    .option('--task-file <path>', 'Read task from file')
    .option('--radius <n>', 'Graph expansion radius', parseInt)
    .option('--budget <n>', 'Token budget', parseInt)
    .option('--mode <mode>', 'Pack mode: feature, bugfix, refactor')
    .action(async (task, cmdOpts) => {
      const globalOpts = program.opts() as GlobalOptions;
      const ctx = await createContext(globalOpts, 'pack');
      const { runPack } = await import('./commands/pack.js');
      await runPack(ctx, {
        task: task || '',
        taskFile: cmdOpts.taskFile,
        radius: cmdOpts.radius,
        budget: cmdOpts.budget,
        mode: cmdOpts.mode,
      });
    });

  // doctor command
  program
    .command('doctor')
    .description('Aggregate findings into a Project Health Score')
    .action(async () => {
      const globalOpts = program.opts() as GlobalOptions;
      const ctx = await createContext(globalOpts, 'doctor');
      const { runDoctor } = await import('./commands/doctor.js');
      await runDoctor(ctx);
    });

  // trash command
  program
    .command('trash')
    .description('Manage soft-deleted artifacts')
    .argument('<action>', 'Action: list, restore, purge')
    .argument('[target]', 'ID or path for restore')
    .option('--force', 'Force overwrite on restore', false)
    .option('--yes', 'Skip confirmation for purge', false)
    .action(async (action, target, cmdOpts) => {
      const globalOpts = program.opts() as GlobalOptions;
      const ctx = await createContext(globalOpts, 'trash');
      const { runTrash } = await import('./commands/trash.js');
      await runTrash(ctx, {
        action,
        target,
        force: cmdOpts.force,
        yes: cmdOpts.yes,
      });
    });

  // kiro command (platform-specific shortcut)
  program
    .command('kiro')
    .description('Install/uninstall VibeGuard as a Kiro skill')
    .argument('<action>', 'Action: install, uninstall')
    .action(async (action) => {
      const globalOpts = program.opts() as GlobalOptions;
      const ctx = await createContext(globalOpts, 'install');
      const { runInstall, runUninstall } = await import('./commands/install.js');
      if (action === 'install') {
        await runInstall(ctx, { platform: 'kiro' });
      } else if (action === 'uninstall') {
        await runUninstall(ctx, { platform: 'kiro' });
      } else {
        throw new VibeguardError(
          ErrorCodes.UNKNOWN_COMMAND,
          `Unknown action: "${action}". Use: vibeguard kiro install | uninstall`,
        );
      }
    });

  // install command
  program
    .command('install')
    .description('Install VibeGuard skill into your AI coding assistant')
    .option('--platform <name>', 'Platform: kiro (default)', 'kiro')
    .action(async (cmdOpts) => {
      const globalOpts = program.opts() as GlobalOptions;
      const ctx = await createContext(globalOpts, 'install');
      const { runInstall } = await import('./commands/install.js');
      await runInstall(ctx, { platform: cmdOpts.platform });
    });

  // uninstall command
  program
    .command('uninstall')
    .description('Remove VibeGuard skill from your AI coding assistant')
    .option('--platform <name>', 'Platform: kiro (default)', 'kiro')
    .action(async (cmdOpts) => {
      const globalOpts = program.opts() as GlobalOptions;
      const ctx = await createContext(globalOpts, 'install');
      const { runUninstall } = await import('./commands/install.js');
      await runUninstall(ctx, { platform: cmdOpts.platform });
    });

  // attack command — cyberattack proof scan
  program
    .command('attack')
    .description('Scan for cyberattack vulnerabilities (DDoS, brute-force, OTP abuse, SQLi, XSS, SSRF, etc.)')
    .option('--ai', 'Run a stronger AI-powered deep scan using your configured LLM', false)
    .option('--fix', 'Apply AI-generated fixes to vulnerable files (requires --ai)', false)
    .option('--dry-run', 'Preview AI fixes without writing changes', false)
    .option('--budget <n>', 'Max tokens for the AI scan', parseInt)
    .action(async (cmdOpts) => {
      const globalOpts = program.opts() as GlobalOptions;
      const ctx = await createContext(globalOpts, 'attack');
      const { runAttack } = await import('./commands/attack.js');
      await runAttack(ctx, { ai: cmdOpts.ai, fix: cmdOpts.fix, dryRun: cmdOpts.dryRun, budget: cmdOpts.budget });
    });

  // config command — manage LLM API keys
  program
    .command('config')
    .description('Manage LLM provider API keys for AI-powered scans')
    .argument('<action>', 'Action: set-key, show, test, clear, providers')
    .argument('[value]', 'API key (for set-key)')
    .option('--provider <name>', 'LLM provider: openrouter, openai, anthropic, google, groq, mistral, custom')
    .option('--model <name>', 'Model name')
    .option('--base-url <url>', 'Base URL (for custom provider)')
    .option('--test', 'Test the connection after saving', false)
    .action(async (action, value, cmdOpts) => {
      const globalOpts = program.opts() as GlobalOptions;
      const ctx = await createContext(globalOpts, 'config');
      const { runConfig } = await import('./commands/config.js');
      await runConfig(ctx, {
        action,
        value,
        provider: cmdOpts.provider,
        model: cmdOpts.model,
        baseUrl: cmdOpts.baseUrl,
        test: cmdOpts.test,
      });
    });

  // hook command — git pre-commit security hook
  program
    .command('hook')
    .description('Manage git pre-commit security hook (blocks commits with secrets)')
    .argument('<action>', 'Action: install, uninstall, status')
    .action(async (action) => {
      const globalOpts = program.opts() as GlobalOptions;
      const ctx = await createContext(globalOpts, 'hook');
      const { runHook } = await import('./commands/hook.js');
      await runHook(ctx, { action });
    });

  return program;
}

async function main(): Promise<void> {
  const program = setupProgram();

  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    const globalOpts = program.opts() as GlobalOptions;
    const isJson = globalOpts?.json ?? false;

    if (err instanceof VibeguardError) {
      if (isJson) {
        process.stdout.write(JSON.stringify(formatErrorJson(err), null, 2) + '\n');
      } else {
        process.stderr.write(formatErrorTerminal(err) + '\n');
      }
      process.exit(getExitCode(err.code));
    } else {
      const internalError = new VibeguardError(
        ErrorCodes.INTERNAL_ERROR,
        err instanceof Error ? err.message : 'Unknown error',
      );
      if (isJson) {
        process.stdout.write(JSON.stringify(formatErrorJson(internalError), null, 2) + '\n');
      } else {
        process.stderr.write(formatErrorTerminal(internalError) + '\n');
      }
      process.exit(3);
    }
  }
}

main();
