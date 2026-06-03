import { mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { FileStoreImpl } from '../storage/file-store.js';

/**
 * GraphMode — graph-first context for AI coding assistants.
 *
 * When enabled, VibeGuard writes an always-on rule into every major IDE/agent
 * memory file instructing the assistant to (a) print a visible `GraphMode: ON`
 * indicator on every reply, and (b) consult the local dependency graph
 * (`.vibeguard/graph.json`) and `pack` the few relevant files instead of
 * blindly reading the whole repo — the core token-saving behavior.
 *
 * It is fully independent of Caveman Mode: either can be on/off without
 * affecting the other. State is local-only in `.vibeguard/graphmode.json`.
 */

export const GRAPHMODE_SCHEMA_VERSION = '1.0.0';

/** Persisted GraphMode state (local-only, lives in `.vibeguard/graphmode.json`). */
export interface GraphModeState {
  schemaVersion: string;
  enabled: boolean;
  /** ISO timestamp of the last enable/disable. */
  updatedAt: string;
}

const STATE_FILE = 'graphmode.json';

export function defaultGraphModeState(): GraphModeState {
  return {
    schemaVersion: GRAPHMODE_SCHEMA_VERSION,
    enabled: false,
    updatedAt: new Date(0).toISOString(),
  };
}

/** Load GraphMode state from `.vibeguard/graphmode.json`, falling back to defaults. */
export async function loadGraphModeState(projectRoot: string): Promise<GraphModeState> {
  const store = new FileStoreImpl(projectRoot);
  const raw = await store.read<Partial<GraphModeState>>(STATE_FILE);
  if (!raw) return defaultGraphModeState();
  return {
    schemaVersion: GRAPHMODE_SCHEMA_VERSION,
    enabled: raw.enabled === true,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date(0).toISOString(),
  };
}

/** Persist GraphMode state to `.vibeguard/graphmode.json`. */
export async function saveGraphModeState(projectRoot: string, state: GraphModeState): Promise<void> {
  const store = new FileStoreImpl(projectRoot);
  await store.write(STATE_FILE, state);
}

/**
 * The shared GraphMode ruleset embedded into each agent's always-on rule file
 * so every reply is graph-first and shows the indicator.
 */
export function graphModeRuleBody(): string {
  return `# VibeGuard GraphMode — ACTIVE

Graph-first context. Use the local dependency graph instead of reading the
whole repo, so answers stay cheap and focused.

## REQUIRED — visible ON indicator
Begin EVERY reply with this exact line, on its own line, then a blank line:

\`GraphMode: ON\`

Write it exactly as shown — no emoji, no extra words. Skip it ONLY inside a
fenced code block that is the entire response.

## Persistence
This rule is ACTIVE on EVERY response until the user says "stop graphmode" or
"normal mode". Do not drift back to reading the whole project.

## Core rules
- Before answering architecture questions or making multi-file changes, run
  \`npx vibeguard pack "<task>" --json\` and read ONLY the listed files (5-15).
- Use \`.vibeguard/graph.json\` to understand imports/dependents before editing.
- Never read the entire project blindly — the graph tells you what's connected.
- Prefer \`npx vibeguard query\`, \`explain\`, \`affected\` for graph Q&A (zero tokens).

> The win: 80-95% fewer tokens by reading the right files, not all the files.`;
}

/** Kiro steering file content (`inclusion: always`). */
export function buildGraphModeKiroSteering(): string {
  return `---
inclusion: always
description: VibeGuard GraphMode — graph-first, token-saving context on every turn
---
${graphModeRuleBody()}
`;
}

/** Cursor rule file content (always applied). */
export function buildGraphModeCursorRule(): string {
  return `---
description: VibeGuard GraphMode — graph-first context selection
alwaysApply: true
---
${graphModeRuleBody()}
`;
}

/** Windsurf rule file content (always-on via trigger). */
export function buildGraphModeWindsurfRule(): string {
  return `---
trigger: always_on
description: VibeGuard GraphMode — graph-first, token-saving context
---
${graphModeRuleBody()}
`;
}

/** Plain rule body for CLAUDE.md / Copilot / Gemini / AGENTS.md style files. */
export function buildGraphModePlainRule(): string {
  return graphModeRuleBody();
}

// ---------------------------------------------------------------------------
// Rule-file IO — mirrors the caveman mechanism with a distinct marker so the
// two modes never overwrite each other and can be toggled independently.
// ---------------------------------------------------------------------------

export const GRAPHMODE_BEGIN_MARK = '<!-- vibeguard-graphmode:begin -->';
export const GRAPHMODE_END_MARK = '<!-- vibeguard-graphmode:end -->';

export const GRAPHMODE_KIRO_STEERING_REL = join('.kiro', 'steering', 'vibeguard-graphmode.md');
export const GRAPHMODE_CURSOR_RULE_REL = join('.cursor', 'rules', 'vibeguard-graphmode.mdc');
export const GRAPHMODE_WINDSURF_RULE_REL = join('.windsurf', 'rules', 'vibeguard-graphmode.md');
const CLAUDE_REL = 'CLAUDE.md';
const COPILOT_REL = join('.github', 'copilot-instructions.md');
const GEMINI_REL = join('.gemini', 'CONTEXT.md');
const WINDSURFRULES_REL = '.windsurfrules';
const CLINERULES_REL = '.clinerules';
const AGENTS_REL = 'AGENTS.md';

const CREATE_MEMORY_FILES = [CLAUDE_REL, COPILOT_REL, GEMINI_REL, AGENTS_REL];
const FOLD_ONLY_FILES = [WINDSURFRULES_REL, CLINERULES_REL];

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function removeMarkerBlock(content: string): string {
  const start = content.indexOf(GRAPHMODE_BEGIN_MARK);
  if (start === -1) return content;
  const end = content.indexOf(GRAPHMODE_END_MARK, start);
  if (end === -1) return content;
  return content.slice(0, start) + content.slice(end + GRAPHMODE_END_MARK.length);
}

async function injectMarkerBlock(filePath: string, body: string): Promise<void> {
  let content = '';
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    content = '';
  }
  const block = `${GRAPHMODE_BEGIN_MARK}\n${body}\n${GRAPHMODE_END_MARK}`;
  const base = removeMarkerBlock(content).trimEnd();
  const next = base.length > 0 ? `${base}\n\n${block}\n` : `${block}\n`;
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, next, 'utf-8');
}

async function stripMarkerBlock(filePath: string): Promise<boolean> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    return false;
  }
  if (!content.includes(GRAPHMODE_BEGIN_MARK)) return false;

  const remainder = removeMarkerBlock(content).trim();
  if (remainder.length === 0) {
    await rm(filePath, { force: true });
  } else {
    await writeFile(filePath, remainder + '\n', 'utf-8');
  }
  return true;
}

/** Write the always-on GraphMode rule into every major IDE/agent integration. */
export async function writeGraphModeRules(projectRoot: string): Promise<string[]> {
  const written: string[] = [];

  await mkdir(join(projectRoot, '.kiro', 'steering'), { recursive: true });
  await writeFile(join(projectRoot, GRAPHMODE_KIRO_STEERING_REL), buildGraphModeKiroSteering(), 'utf-8');
  written.push(GRAPHMODE_KIRO_STEERING_REL.replace(/\\/g, '/'));

  await mkdir(join(projectRoot, '.cursor', 'rules'), { recursive: true });
  await writeFile(join(projectRoot, GRAPHMODE_CURSOR_RULE_REL), buildGraphModeCursorRule(), 'utf-8');
  written.push(GRAPHMODE_CURSOR_RULE_REL.replace(/\\/g, '/'));

  await mkdir(join(projectRoot, '.windsurf', 'rules'), { recursive: true });
  await writeFile(join(projectRoot, GRAPHMODE_WINDSURF_RULE_REL), buildGraphModeWindsurfRule(), 'utf-8');
  written.push(GRAPHMODE_WINDSURF_RULE_REL.replace(/\\/g, '/'));

  for (const rel of CREATE_MEMORY_FILES) {
    await injectMarkerBlock(join(projectRoot, rel), buildGraphModePlainRule());
    written.push(rel.replace(/\\/g, '/'));
  }

  for (const rel of FOLD_ONLY_FILES) {
    if (await pathExists(join(projectRoot, rel))) {
      await injectMarkerBlock(join(projectRoot, rel), buildGraphModePlainRule());
      written.push(rel.replace(/\\/g, '/'));
    }
  }

  return written;
}

/** Remove every GraphMode rule artifact and marker block. Returns paths cleaned. */
export async function removeGraphModeRules(projectRoot: string): Promise<string[]> {
  const removed: string[] = [];

  for (const rel of [GRAPHMODE_KIRO_STEERING_REL, GRAPHMODE_CURSOR_RULE_REL, GRAPHMODE_WINDSURF_RULE_REL]) {
    const full = join(projectRoot, rel);
    if (await pathExists(full)) {
      await rm(full, { force: true });
      removed.push(rel.replace(/\\/g, '/'));
    }
  }

  for (const rel of [...CREATE_MEMORY_FILES, ...FOLD_ONLY_FILES]) {
    const full = join(projectRoot, rel);
    if ((await pathExists(full)) && (await stripMarkerBlock(full))) {
      removed.push(rel.replace(/\\/g, '/'));
    }
  }

  return removed;
}

export interface GraphModeEnableResult {
  state: GraphModeState;
  written: string[];
}

/** Enable GraphMode: write rule files and persist enabled state. */
export async function enableGraphMode(projectRoot: string): Promise<GraphModeEnableResult> {
  const written = await writeGraphModeRules(projectRoot);
  const state: GraphModeState = {
    schemaVersion: GRAPHMODE_SCHEMA_VERSION,
    enabled: true,
    updatedAt: new Date().toISOString(),
  };
  await saveGraphModeState(projectRoot, state);
  return { state, written };
}

export interface GraphModeDisableResult {
  state: GraphModeState;
  removed: string[];
}

/** Disable GraphMode: remove rule files and persist disabled state. */
export async function disableGraphMode(projectRoot: string): Promise<GraphModeDisableResult> {
  const removed = await removeGraphModeRules(projectRoot);
  const state: GraphModeState = {
    schemaVersion: GRAPHMODE_SCHEMA_VERSION,
    enabled: false,
    updatedAt: new Date().toISOString(),
  };
  await saveGraphModeState(projectRoot, state);
  return { state, removed };
}
