import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { statusIcon, brand, header } from '../utils/ui.js';
import { emitJson } from '../utils/json-output.js';
import { VibeguardError, ErrorCodes } from '../utils/errors.js';
import type { CommandContext } from '../context.js';

const SKILL_CONTENT = `# VibeGuard Skill

Local-only TypeScript/JavaScript static analysis, security scanning, dead code detection, and AI context packaging.

## Trigger

When the user types \`/vibeguard\` followed by a command, execute the corresponding action.

## Commands

### \`/vibeguard scan\`
Run security scan on the current project. Detect hard-coded secrets, .env/.gitignore gaps, and framework misuse.

Execute: \`npx vibeguard security --json\`

Parse the JSON output and present issues with severity, file, line, message, and suggested fix.

### \`/vibeguard health\`
Get project health score (0-100) with sub-scores.

Execute: \`npx vibeguard doctor --json\`

### \`/vibeguard pack <task>\`
Generate an optimized context package for a specific task (80-95% token reduction).

Execute: \`npx vibeguard pack "<task>" --json\`

After generating, read \`.vibeguard/context-package.md\` and use it as context.

### \`/vibeguard dead\`
Detect dead code: unused files, unused exports.

Execute: \`npx vibeguard clean --plan --json\`

### \`/vibeguard map\`
Build the dependency graph.

Execute: \`npx vibeguard map --json\`

### \`/vibeguard context <task>\`
Generate context package and auto-include it in the conversation.

Execute:
1. \`npx vibeguard pack "<task>" --json\`
2. Read \`.vibeguard/context-package.md\`
3. Use as context for subsequent responses

### \`/vibeguard fix\`
Auto-fix security issues.

Execute: \`npx vibeguard security --fix=gitignore\`

### \`/vibeguard\`
Show available commands.

## Notes
- All commands are local-only, no network calls
- Results cached in \`.vibeguard/\` for incremental rebuilds
- Use \`pack\` before complex questions to reduce tokens by 80-95%
`;

const STEERING_CONTENT = `---
inclusion: auto
---
# VibeGuard — Always-On Context

VibeGuard is installed in this project. Type \`/vibeguard\` in chat to use it.

## Quick Commands
- \`/vibeguard scan\` — Security scan with fixes
- \`/vibeguard health\` — Project health score
- \`/vibeguard pack "task"\` — Optimized context (80-95% fewer tokens)
- \`/vibeguard context "task"\` — Generate and auto-include context
- \`/vibeguard dead\` — Dead code detection
- \`/vibeguard map\` — Dependency graph
- \`/vibeguard fix\` — Auto-fix security issues

## When to Use
- Before architecture questions: \`/vibeguard pack "question"\`
- Before making changes: \`/vibeguard context "task"\`
- After changes: \`/vibeguard scan\`
- Periodically: \`/vibeguard health\`

#[[file:.vibeguard/context-package.md]]
`;

const SUPPORTED_PLATFORMS = ['kiro', 'cursor', 'claude', 'copilot', 'gemini', 'aider'] as const;
type SupportedPlatform = (typeof SUPPORTED_PLATFORMS)[number];

function normalizePlatform(platform: string): SupportedPlatform {
  if ((SUPPORTED_PLATFORMS as readonly string[]).includes(platform)) {
    return platform as SupportedPlatform;
  }

  throw new VibeguardError(
    ErrorCodes.UNKNOWN_OPTION,
    `Unknown install platform: "${platform}". Valid platforms: ${SUPPORTED_PLATFORMS.join(', ')}`,
    { platform, validPlatforms: [...SUPPORTED_PLATFORMS] },
  );
}

async function withSuppressedStdout<T>(enabled: boolean, fn: () => Promise<T>): Promise<T> {
  if (!enabled) return fn();

  const originalWrite = process.stdout.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    return await fn();
  } finally {
    process.stdout.write = originalWrite;
  }
}

/**
 * Write or merge a VibeGuard MCP server entry into a platform's MCP config file.
 * Merges into any existing config so other MCP servers are preserved.
 * Uses `npx -y vibeguard serve` so it works on any machine without absolute paths.
 */
async function writeMcpConfig(
  projectRoot: string,
  relativeConfigPath: string,
): Promise<{ action: string; path: string }> {
  const configPath = join(projectRoot, relativeConfigPath);
  await mkdir(dirname(configPath), { recursive: true });

  let config: { mcpServers?: Record<string, unknown> } = {};
  let action = 'Created';
  try {
    const raw = await readFile(configPath, 'utf-8');
    config = JSON.parse(raw);
    action = 'Updated';
  } catch {
    // No existing config (or unreadable) — start fresh.
  }

  if (!config.mcpServers || typeof config.mcpServers !== 'object') {
    config.mcpServers = {};
  }

  config.mcpServers['vibeguard'] = {
    command: 'npx',
    args: ['-y', 'vibeguard', 'serve'],
    disabled: false,
    autoApprove: [
      'get_minimal_context',
      'query_graph',
      'explain_node',
      'get_affected',
      'find_path',
    ],
  };

  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  return { action: `${action} MCP config`, path: relativeConfigPath.replace(/\\/g, '/') };
}

/**
 * Remove the VibeGuard entry from a platform's MCP config, preserving any other
 * MCP servers and removing the file only when it becomes empty.
 */
async function removeMcpConfig(
  projectRoot: string,
  relativeConfigPath: string,
): Promise<{ removed: boolean; path: string }> {
  const normalizedPath = relativeConfigPath.replace(/\\/g, '/');
  const configPath = join(projectRoot, relativeConfigPath);

  let config: { mcpServers?: Record<string, unknown> };
  try {
    config = JSON.parse(await readFile(configPath, 'utf-8'));
  } catch {
    return { removed: false, path: normalizedPath };
  }

  if (!config.mcpServers || !config.mcpServers['vibeguard']) {
    return { removed: false, path: normalizedPath };
  }

  delete config.mcpServers['vibeguard'];

  if (Object.keys(config.mcpServers).length === 0) {
    const { rm } = await import('node:fs/promises');
    await rm(configPath);
  } else {
    await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  }

  return { removed: true, path: normalizedPath };
}

export async function runInstall(ctx: CommandContext, opts: { platform: string }): Promise<void> {
  const { projectRoot } = ctx;
  const platform = normalizePlatform(opts.platform);

  await withSuppressedStdout(ctx.options.json, async () => {
    switch (platform) {
      case 'kiro':
        await installKiro(projectRoot);
        break;
      case 'cursor':
        await installCursor(projectRoot);
        break;
      case 'claude':
        await installClaude(projectRoot);
        break;
      case 'copilot':
        await installCopilot(projectRoot);
        break;
      case 'gemini':
        await installGemini(projectRoot);
        break;
      case 'aider':
        await installAider(projectRoot);
        break;
    }
  });

  if (ctx.options.json) {
    emitJson({ action: 'install', platform, installed: true });
  }
}

async function installKiro(projectRoot: string): Promise<void> {
  const output: string[] = [];
  output.push('');
  output.push(header('VibeGuard Install', '⚡'));
  output.push('');

  // Create skill directory
  const skillDir = join(projectRoot, '.kiro', 'skills', 'vibeguard');
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, 'SKILL.md'), SKILL_CONTENT, 'utf-8');
  output.push(`  ${statusIcon('success')} ${brand.success('Created')} ${brand.muted('.kiro/skills/vibeguard/SKILL.md')}`);

  // Create steering file
  const steeringDir = join(projectRoot, '.kiro', 'steering');
  await mkdir(steeringDir, { recursive: true });
  await writeFile(join(steeringDir, 'vibeguard.md'), STEERING_CONTENT, 'utf-8');
  output.push(`  ${statusIcon('success')} ${brand.success('Created')} ${brand.muted('.kiro/steering/vibeguard.md')}`);

  // Write a real MCP server config so the agent gets live tools, not just instructions.
  const mcpResult = await writeMcpConfig(projectRoot, join('.kiro', 'settings', 'mcp.json'));
  output.push(`  ${statusIcon('success')} ${brand.success(mcpResult.action)} ${brand.muted(mcpResult.path)}`);

  // Init vibeguard config if not exists
  const configPath = join(projectRoot, '.vibeguard', 'config.json');
  let configExists = false;
  try {
    await access(configPath);
    configExists = true;
  } catch {
    // doesn't exist
  }

  if (!configExists) {
    const { runInit } = await import('./init.js');
    const { loadConfig } = await import('../storage/config-store.js');
    const { createLogger } = await import('../utils/logger.js');
    const config = await loadConfig(projectRoot);
    const logger = createLogger({ jsonMode: false, quiet: true, verbose: false, command: 'install' });
    const initCtx = { options: { json: false, cwd: projectRoot, include: [], exclude: [], config: undefined, verbose: false, quiet: true }, config, logger, projectRoot };
    await runInit(initCtx, { force: false });
    output.push(`  ${statusIcon('success')} ${brand.success('Created')} ${brand.muted('.vibeguard/config.json')}`);
  } else {
    output.push(`  ${statusIcon('info')} ${brand.muted('.vibeguard/config.json already exists')}`);
  }

  output.push('');
  output.push(`  ${brand.primary.bold('Done!')} VibeGuard is now integrated with Kiro.`);
  output.push('');
  output.push(`  ${brand.secondary('Usage in chat:')}`);
  output.push(`    Type ${brand.info('/vibeguard scan')} to run a security scan`);
  output.push(`    Type ${brand.info('/vibeguard health')} for project health`);
  output.push(`    Type ${brand.info('/vibeguard pack "fix auth"')} for optimized context`);
  output.push('');

  process.stdout.write(output.join('\n') + '\n');
}

async function installCursor(projectRoot: string): Promise<void> {
  const rulesDir = join(projectRoot, '.cursor', 'rules');
  await mkdir(rulesDir, { recursive: true });

  const cursorRule = `---
description: VibeGuard — intelligent context selection for code understanding
alwaysApply: true
---

# VibeGuard Integration

When answering questions about this codebase:
1. Run \`npx vibeguard pack "<user question>" --json\` to get optimized file selection
2. Read only the files listed in the result (5-15 most relevant files)
3. Never blindly read the entire project — use the dependency graph

Available commands:
- \`npx vibeguard --scan\` — Security scan
- \`npx vibeguard --health\` — Project health score
- \`npx vibeguard attack\` — Cyberattack vulnerability scan
- \`npx vibeguard graph\` — Generate interactive HTML graph
- \`npx vibeguard pack "task"\` — Generate context package (80-95% token reduction)

The dependency graph is at \`.vibeguard/graph.json\`. Use it to understand file relationships before answering architecture questions.
`;

  await writeFile(join(rulesDir, 'vibeguard.mdc'), cursorRule, 'utf-8');

  const output: string[] = [];
  output.push('');
  output.push(header('VibeGuard — Cursor Install', '⚡'));
  output.push('');
  output.push(`  ${statusIcon('success')} ${brand.success('Created')} ${brand.muted('.cursor/rules/vibeguard.mdc')}`);
  output.push('');
  output.push(`  ${brand.primary.bold('Done!')} VibeGuard is now always-on in Cursor.`);
  output.push(`  ${brand.muted('Cursor will use the dependency graph to select relevant files automatically.')}`);
  output.push('');
  process.stdout.write(output.join('\n') + '\n');
}

async function installClaude(projectRoot: string): Promise<void> {
  const claudeSection = `
## VibeGuard — Intelligent Context Selection

When working on this codebase:
1. Before answering questions, run: \`npx vibeguard pack "<task>" --json\`
2. Read ONLY the files listed in the output (5-15 most relevant)
3. Use \`.vibeguard/graph.json\` to understand file relationships
4. Never read the entire project blindly — the graph tells you what's connected

Available tools:
- \`npx vibeguard --scan\` — Find secrets & vulnerabilities
- \`npx vibeguard --health\` — Project quality score (0-100)
- \`npx vibeguard attack --ai --fix\` — AI-powered security fix
- \`npx vibeguard graph\` — Generate interactive dependency graph
- \`npx vibeguard pack "task"\` — Get optimized context (80-95% fewer tokens)
`;

  const claudePath = join(projectRoot, 'CLAUDE.md');
  let existingContent = '';
  try {
    existingContent = await readFile(claudePath, 'utf-8');
  } catch {
    // doesn't exist
  }

  if (existingContent.includes('VibeGuard')) {
    process.stdout.write(`\n  ${statusIcon('info')} ${brand.muted('CLAUDE.md already contains VibeGuard section.')}\n\n`);
    return;
  }

  const newContent = existingContent + '\n' + claudeSection;
  await writeFile(claudePath, newContent, 'utf-8');

  const output: string[] = [];
  output.push('');
  output.push(header('VibeGuard — Claude Code Install', '⚡'));
  output.push('');
  output.push(`  ${statusIcon('success')} ${brand.success('Added VibeGuard section to')} ${brand.muted('CLAUDE.md')}`);
  output.push('');
  output.push(`  ${brand.primary.bold('Done!')} Claude Code will now use the dependency graph automatically.`);
  output.push('');
  process.stdout.write(output.join('\n') + '\n');
}

async function installCopilot(projectRoot: string): Promise<void> {
  const instructionsDir = join(projectRoot, '.github');
  await mkdir(instructionsDir, { recursive: true });

  const copilotInstructions = `# VibeGuard — GitHub Copilot Integration

When working on this codebase, use VibeGuard for intelligent context selection and security scanning.

## Context Selection
Before answering questions about architecture or making multi-file changes:
1. Run \`npx vibeguard pack "<task>" --json\` to get the optimal file set
2. Read ONLY the files listed in the output (5-15 most relevant files)
3. Use \`.vibeguard/graph.json\` to understand file relationships
4. Never read the entire project blindly — the graph tells you what's connected

## Available Commands
- \`npx vibeguard --scan\` — Find secrets & security vulnerabilities
- \`npx vibeguard --health\` — Project quality score (0-100)
- \`npx vibeguard --dead\` — Detect unused code
- \`npx vibeguard attack\` — Cyberattack vulnerability scan
- \`npx vibeguard attack --ai --fix\` — AI-powered security fix
- \`npx vibeguard graph\` — Generate interactive HTML dependency graph
- \`npx vibeguard pack "task"\` — Get optimized context (80-95% fewer tokens)

## Workflow
- Before architecture questions: run \`pack\` first
- Before making changes: run \`pack\` to understand dependencies
- After changes: run \`--scan\` to check for security issues
- Periodically: run \`--health\` to track project quality

## Key Files
- \`.vibeguard/graph.json\` — Dependency graph data
- \`.vibeguard/context-package.md\` — Latest context package
- \`.vibeguard/config.json\` — VibeGuard configuration
`;

  await writeFile(join(instructionsDir, 'copilot-instructions.md'), copilotInstructions, 'utf-8');

  const output: string[] = [];
  output.push('');
  output.push(header('VibeGuard — GitHub Copilot Install', '⚡'));
  output.push('');
  output.push(`  ${statusIcon('success')} ${brand.success('Created')} ${brand.muted('.github/copilot-instructions.md')}`);
  output.push('');
  output.push(`  ${brand.primary.bold('Done!')} VibeGuard is now integrated with GitHub Copilot.`);
  output.push(`  ${brand.muted('Copilot will use the dependency graph for intelligent context selection.')}`);
  output.push('');
  process.stdout.write(output.join('\n') + '\n');
}

async function installGemini(projectRoot: string): Promise<void> {
  const geminiContent = `# VibeGuard — Gemini Integration

When working on this codebase, use VibeGuard for intelligent context selection and security scanning.

## Context Selection
Before answering questions about architecture or making multi-file changes:
1. Run \`npx vibeguard pack "<task>" --json\` to get the optimal file set
2. Read ONLY the files listed in the output (5-15 most relevant files)
3. Use \`.vibeguard/graph.json\` to understand file relationships
4. Never read the entire project blindly — the graph tells you what's connected

## Available Commands
- \`npx vibeguard --scan\` — Find secrets & security vulnerabilities
- \`npx vibeguard --health\` — Project quality score (0-100)
- \`npx vibeguard --dead\` — Detect unused code
- \`npx vibeguard attack\` — Cyberattack vulnerability scan
- \`npx vibeguard attack --ai --fix\` — AI-powered security fix
- \`npx vibeguard graph\` — Generate interactive HTML dependency graph
- \`npx vibeguard pack "task"\` — Get optimized context (80-95% fewer tokens)

## Workflow
- Before architecture questions: run \`pack\` first
- Before making changes: run \`pack\` to understand dependencies
- After changes: run \`--scan\` to check for security issues
- Periodically: run \`--health\` to track project quality

## Key Files
- \`.vibeguard/graph.json\` — Dependency graph data
- \`.vibeguard/context-package.md\` — Latest context package
- \`.vibeguard/config.json\` — VibeGuard configuration
`;

  const geminiDir = join(projectRoot, '.gemini');
  await mkdir(geminiDir, { recursive: true });
  await writeFile(join(geminiDir, 'CONTEXT.md'), geminiContent, 'utf-8');

  // Also write a settings file for Gemini CLI/IDE integration
  const settingsPath = join(geminiDir, 'settings.json');
  let existingSettings: Record<string, unknown> = {};
  try {
    const raw = await readFile(settingsPath, 'utf-8');
    existingSettings = JSON.parse(raw);
  } catch {
    // doesn't exist
  }

  existingSettings['vibeguard'] = {
    enabled: true,
    contextFile: '.vibeguard/context-package.md',
    graphFile: '.vibeguard/graph.json',
  };

  await writeFile(settingsPath, JSON.stringify(existingSettings, null, 2), 'utf-8');

  const output: string[] = [];
  output.push('');
  output.push(header('VibeGuard — Gemini Install', '⚡'));
  output.push('');
  output.push(`  ${statusIcon('success')} ${brand.success('Created')} ${brand.muted('.gemini/CONTEXT.md')}`);
  output.push(`  ${statusIcon('success')} ${brand.success('Created')} ${brand.muted('.gemini/settings.json')}`);
  output.push('');
  output.push(`  ${brand.primary.bold('Done!')} VibeGuard is now integrated with Gemini.`);
  output.push(`  ${brand.muted('Gemini will use the dependency graph for intelligent context selection.')}`);
  output.push('');
  process.stdout.write(output.join('\n') + '\n');
}

async function installAider(projectRoot: string): Promise<void> {
  const aiderContent = `# VibeGuard — Project Intelligence

This project uses VibeGuard for static analysis, security scanning, and intelligent context selection.

## Quick Reference

### Get Optimized Context (80-95% fewer tokens)
\`\`\`bash
npx vibeguard pack "your task description"
\`\`\`
Then read \`.vibeguard/context-package.md\` for the focused file set.

### Security Scan
\`\`\`bash
npx vibeguard --scan
\`\`\`

### Project Health Score
\`\`\`bash
npx vibeguard --health
\`\`\`

### Dependency Graph
\`\`\`bash
npx vibeguard --graph
\`\`\`

### Dead Code Detection
\`\`\`bash
npx vibeguard --dead
\`\`\`

### Cyberattack Scan with AI Fix
\`\`\`bash
npx vibeguard attack --ai --fix
\`\`\`

## Key Conventions
- The dependency graph is at \`.vibeguard/graph.json\`
- Context packages are at \`.vibeguard/context-package.md\`
- Always run \`pack\` before working on multi-file tasks
- Use the graph to understand which files are connected before making changes
`;

  const aiderConventions = `# .aider.conf.yml conventions
# VibeGuard integration: use context packages for efficient token usage

read:
  - .vibeguard/context-package.md
  - .vibeguard/graph.json
`;

  await writeFile(join(projectRoot, '.aider.context.md'), aiderContent, 'utf-8');

  // Write .aider.conf.yml if it doesn't exist
  const confPath = join(projectRoot, '.aider.conf.yml');
  let confExists = false;
  try {
    await access(confPath);
    confExists = true;
  } catch {
    // doesn't exist
  }

  if (!confExists) {
    await writeFile(confPath, aiderConventions, 'utf-8');
  }

  const output: string[] = [];
  output.push('');
  output.push(header('VibeGuard — Aider Install', '⚡'));
  output.push('');
  output.push(`  ${statusIcon('success')} ${brand.success('Created')} ${brand.muted('.aider.context.md')}`);
  if (!confExists) {
    output.push(`  ${statusIcon('success')} ${brand.success('Created')} ${brand.muted('.aider.conf.yml')}`);
  } else {
    output.push(`  ${statusIcon('info')} ${brand.muted('.aider.conf.yml already exists (preserved)')}`);
  }
  output.push('');
  output.push(`  ${brand.primary.bold('Done!')} VibeGuard is now integrated with Aider.`);
  output.push(`  ${brand.muted('Use /read .vibeguard/context-package.md in Aider for optimized context.')}`);
  output.push('');
  process.stdout.write(output.join('\n') + '\n');
}

export async function runUninstall(ctx: CommandContext, opts: { platform: string }): Promise<void> {
  const { projectRoot } = ctx;
  const platform = normalizePlatform(opts.platform);

  await withSuppressedStdout(ctx.options.json, async () => {
    switch (platform) {
      case 'kiro':
        await uninstallKiro(projectRoot);
        break;
      case 'cursor':
        await uninstallCursor(projectRoot);
        break;
      case 'claude':
        await uninstallClaude(projectRoot);
        break;
      case 'copilot':
        await uninstallCopilot(projectRoot);
        break;
      case 'gemini':
        await uninstallGemini(projectRoot);
        break;
      case 'aider':
        await uninstallAider(projectRoot);
        break;
    }
  });

  if (ctx.options.json) {
    emitJson({ action: 'uninstall', platform, uninstalled: true });
  }
}

async function uninstallKiro(projectRoot: string): Promise<void> {
  const { rm } = await import('node:fs/promises');

  const output: string[] = [];
  output.push('');
  output.push(header('VibeGuard Uninstall — Kiro', '🗑️'));
  output.push('');

  try {
    await rm(join(projectRoot, '.kiro', 'skills', 'vibeguard'), { recursive: true });
    output.push(`  ${statusIcon('success')} ${brand.success('Removed')} ${brand.muted('.kiro/skills/vibeguard/')}`);
  } catch {
    output.push(`  ${statusIcon('info')} ${brand.muted('Skill not found (already removed)')}`);
  }

  try {
    await rm(join(projectRoot, '.kiro', 'steering', 'vibeguard.md'));
    output.push(`  ${statusIcon('success')} ${brand.success('Removed')} ${brand.muted('.kiro/steering/vibeguard.md')}`);
  } catch {
    output.push(`  ${statusIcon('info')} ${brand.muted('Steering file not found (already removed)')}`);
  }

  const mcpResult = await removeMcpConfig(projectRoot, join('.kiro', 'settings', 'mcp.json'));
  if (mcpResult.removed) {
    output.push(`  ${statusIcon('success')} ${brand.success('Removed vibeguard server from')} ${brand.muted(mcpResult.path)}`);
  } else {
    output.push(`  ${statusIcon('info')} ${brand.muted('No vibeguard MCP entry found (already removed)')}`);
  }

  output.push('');
  output.push(`  ${brand.muted('VibeGuard uninstalled from Kiro. .vibeguard/ data preserved.')}`);
  output.push('');
  process.stdout.write(output.join('\n') + '\n');
}

async function uninstallCursor(projectRoot: string): Promise<void> {
  const { rm } = await import('node:fs/promises');

  const output: string[] = [];
  output.push('');
  output.push(header('VibeGuard Uninstall — Cursor', '🗑️'));
  output.push('');

  try {
    await rm(join(projectRoot, '.cursor', 'rules', 'vibeguard.mdc'));
    output.push(`  ${statusIcon('success')} ${brand.success('Removed')} ${brand.muted('.cursor/rules/vibeguard.mdc')}`);
  } catch {
    output.push(`  ${statusIcon('info')} ${brand.muted('Cursor rule not found (already removed)')}`);
  }

  output.push('');
  output.push(`  ${brand.muted('VibeGuard uninstalled from Cursor. .vibeguard/ data preserved.')}`);
  output.push('');
  process.stdout.write(output.join('\n') + '\n');
}

async function uninstallClaude(projectRoot: string): Promise<void> {
  const claudePath = join(projectRoot, 'CLAUDE.md');
  let content = '';
  try {
    content = await readFile(claudePath, 'utf-8');
  } catch {
    process.stdout.write(`\n  ${statusIcon('info')} ${brand.muted('CLAUDE.md not found (nothing to remove)')}\n\n`);
    return;
  }

  const sectionStart = content.indexOf('## VibeGuard');
  if (sectionStart === -1) {
    process.stdout.write(`\n  ${statusIcon('info')} ${brand.muted('No VibeGuard section found in CLAUDE.md')}\n\n`);
    return;
  }

  // Remove everything from the VibeGuard section header to the next ## or end of file
  const afterSection = content.slice(sectionStart + 1);
  const nextHeading = afterSection.indexOf('\n## ');
  const cleaned = nextHeading === -1
    ? content.slice(0, sectionStart).trimEnd() + '\n'
    : content.slice(0, sectionStart) + afterSection.slice(nextHeading + 1);

  await writeFile(claudePath, cleaned, 'utf-8');

  const output: string[] = [];
  output.push('');
  output.push(header('VibeGuard Uninstall — Claude Code', '🗑️'));
  output.push('');
  output.push(`  ${statusIcon('success')} ${brand.success('Removed VibeGuard section from')} ${brand.muted('CLAUDE.md')}`);
  output.push('');
  output.push(`  ${brand.muted('VibeGuard uninstalled from Claude Code. .vibeguard/ data preserved.')}`);
  output.push('');
  process.stdout.write(output.join('\n') + '\n');
}

async function uninstallCopilot(projectRoot: string): Promise<void> {
  const { rm } = await import('node:fs/promises');

  const output: string[] = [];
  output.push('');
  output.push(header('VibeGuard Uninstall — GitHub Copilot', '🗑️'));
  output.push('');

  try {
    await rm(join(projectRoot, '.github', 'copilot-instructions.md'));
    output.push(`  ${statusIcon('success')} ${brand.success('Removed')} ${brand.muted('.github/copilot-instructions.md')}`);
  } catch {
    output.push(`  ${statusIcon('info')} ${brand.muted('Copilot instructions not found (already removed)')}`);
  }

  output.push('');
  output.push(`  ${brand.muted('VibeGuard uninstalled from GitHub Copilot. .vibeguard/ data preserved.')}`);
  output.push('');
  process.stdout.write(output.join('\n') + '\n');
}

async function uninstallGemini(projectRoot: string): Promise<void> {
  const { rm } = await import('node:fs/promises');

  const output: string[] = [];
  output.push('');
  output.push(header('VibeGuard Uninstall — Gemini', '🗑️'));
  output.push('');

  try {
    await rm(join(projectRoot, '.gemini', 'CONTEXT.md'));
    output.push(`  ${statusIcon('success')} ${brand.success('Removed')} ${brand.muted('.gemini/CONTEXT.md')}`);
  } catch {
    output.push(`  ${statusIcon('info')} ${brand.muted('Gemini context not found (already removed)')}`);
  }

  // Remove vibeguard key from settings.json if it exists
  const settingsPath = join(projectRoot, '.gemini', 'settings.json');
  try {
    const raw = await readFile(settingsPath, 'utf-8');
    const settings = JSON.parse(raw);
    if (settings['vibeguard']) {
      delete settings['vibeguard'];
      await writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
      output.push(`  ${statusIcon('success')} ${brand.success('Removed vibeguard key from')} ${brand.muted('.gemini/settings.json')}`);
    }
  } catch {
    // settings.json doesn't exist or can't be parsed
  }

  output.push('');
  output.push(`  ${brand.muted('VibeGuard uninstalled from Gemini. .vibeguard/ data preserved.')}`);
  output.push('');
  process.stdout.write(output.join('\n') + '\n');
}

async function uninstallAider(projectRoot: string): Promise<void> {
  const { rm } = await import('node:fs/promises');

  const output: string[] = [];
  output.push('');
  output.push(header('VibeGuard Uninstall — Aider', '🗑️'));
  output.push('');

  try {
    await rm(join(projectRoot, '.aider.context.md'));
    output.push(`  ${statusIcon('success')} ${brand.success('Removed')} ${brand.muted('.aider.context.md')}`);
  } catch {
    output.push(`  ${statusIcon('info')} ${brand.muted('.aider.context.md not found (already removed)')}`);
  }

  output.push('');
  output.push(`  ${brand.muted('VibeGuard uninstalled from Aider. .vibeguard/ data preserved.')}`);
  output.push(`  ${brand.muted('Note: .aider.conf.yml was preserved (may contain user config).')}`);
  output.push('');
  process.stdout.write(output.join('\n') + '\n');
}
