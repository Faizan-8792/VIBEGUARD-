import { mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { FileStoreImpl } from '../storage/file-store.js';

/**
 * Caveman Mode — output compression for AI coding assistants.
 *
 * Inspired by the `caveman` skill (github.com/JuliusBrussee/caveman): make the
 * agent drop filler words and answer in terse, high-density fragments while
 * keeping 100% technical accuracy. Realistically trims ~20-45% of output tokens
 * on prose-heavy replies (code is never compressed), which also makes responses
 * faster to read. Savings figures here are honest prose-only estimates, not a
 * billing-grade guarantee — see `estimatedSavingsPct`.
 *
 * VibeGuard wires this in natively: enabling caveman writes an always-on
 * steering/rule file for the AI assistant so EVERY chat answers caveman-style
 * until the user turns it off. State is local-only, stored in `.vibeguard/`.
 */

export type CavemanLevel = 'lite' | 'full' | 'ultra';

export const CAVEMAN_LEVELS: readonly CavemanLevel[] = ['lite', 'full', 'ultra'] as const;
export const CAVEMAN_SCHEMA_VERSION = '1.0.0';
export const DEFAULT_CAVEMAN_LEVEL: CavemanLevel = 'full';

/** Persisted caveman state (local-only, lives in `.vibeguard/caveman.json`). */
export interface CavemanState {
  schemaVersion: string;
  enabled: boolean;
  level: CavemanLevel;
  /** ISO timestamp of the last enable. */
  updatedAt: string;
}

const STATE_FILE = 'caveman.json';

/** The default state when caveman has never been configured. */
export function defaultCavemanState(): CavemanState {
  return {
    schemaVersion: CAVEMAN_SCHEMA_VERSION,
    enabled: false,
    level: DEFAULT_CAVEMAN_LEVEL,
    updatedAt: new Date(0).toISOString(),
  };
}

/** Load caveman state from `.vibeguard/caveman.json`, falling back to defaults. */
export async function loadCavemanState(projectRoot: string): Promise<CavemanState> {
  const store = new FileStoreImpl(projectRoot);
  const raw = await store.read<Partial<CavemanState>>(STATE_FILE);
  if (!raw) return defaultCavemanState();

  const level = isCavemanLevel(raw.level) ? raw.level : DEFAULT_CAVEMAN_LEVEL;
  return {
    schemaVersion: CAVEMAN_SCHEMA_VERSION,
    enabled: raw.enabled === true,
    level,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date(0).toISOString(),
  };
}

/** Persist caveman state to `.vibeguard/caveman.json`. */
export async function saveCavemanState(projectRoot: string, state: CavemanState): Promise<void> {
  const store = new FileStoreImpl(projectRoot);
  await store.write(STATE_FILE, state);
}

export function isCavemanLevel(value: unknown): value is CavemanLevel {
  return typeof value === 'string' && (CAVEMAN_LEVELS as readonly string[]).includes(value);
}

/** Per-level metadata: a single source of truth for everything that varies by level. */
interface CavemanLevelMeta {
  /** One-line human summary of what the level does. */
  description: string;
  /** Detailed rule text embedded into the agent rule body. */
  ruleDetail: string;
  /** Rough, deterministic output-token savings estimate (percent). */
  savingsPct: number;
}

// Savings are honest prose-only estimates (code is never compressed). Measured
// against representative replies; real numbers vary with how chatty the answer
// is. These drive the CLI "Est. output savings" line — kept realistic on
// purpose so the figure is trustworthy rather than aspirational.
const LEVEL_META: Record<CavemanLevel, CavemanLevelMeta> = {
  lite: {
    description: 'Drop filler & hedging, keep full sentences. Professional but tight (~20% fewer tokens on prose).',
    ruleDetail:
      '- Remove filler and hedging only. Keep articles and grammatical sentences. Professional, tight, still fluent.',
    savingsPct: 20,
  },
  full: {
    description: 'Drop articles, fragments OK, short synonyms. Classic caveman (~30% fewer tokens on prose).',
    ruleDetail:
      '- Drop articles, use fragments, swap long phrases for short synonyms. Classic caveman density.',
    savingsPct: 30,
  },
  ultra: {
    description:
      'Telegraphic & minimal: answer in the fewest words possible, abbreviate prose, arrows for causality (X → Y) (~45% fewer tokens on prose).',
    ruleDetail: [
      '- Maximum compression. Answer in the fewest words that stay correct — aim to cut output roughly in half.',
      '- No preamble, no recap, no closing summary. Lead with the answer. One short fragment per idea.',
      '- Abbreviate common prose words (DB, auth, config, req, res, fn, impl, env, repo). Strip conjunctions.',
      '- Use arrows for causality (X → Y) and bullets over paragraphs. One word when one word is enough.',
      '- Still never abbreviate code symbols, function names, API names, file paths, or error strings.',
    ].join('\n'),
    savingsPct: 45,
  },
};

/** One-line human summary of what each level does. */
export function levelDescription(level: CavemanLevel): string {
  return LEVEL_META[level].description;
}

/**
 * The shared caveman ruleset, rendered for a given level. This is the body that
 * gets embedded into each agent's always-on rule file so every reply is terse.
 */
export function cavemanRuleBody(level: CavemanLevel): string {
  return `# VibeGuard Caveman Mode — ACTIVE (level: ${level})

"Why use many token when few do trick." Respond terse like a smart caveman.
All technical substance stays. Only filler dies. Brain big, mouth small.

## REQUIRED — visible ON indicator
Begin EVERY reply with this exact line, on its own line, then a blank line:

\`Caveman mode: ON\`

This is mandatory so the user always knows the mode is active. Write it exactly
as shown — no emoji, no level, no extra words. Skip it ONLY inside a fenced code
block that is the entire response.

## Persistence
This rule is ACTIVE on EVERY response until the user says "stop caveman" or
"normal mode". Do not drift back to verbose prose after a few turns.

## Core rules
- Drop articles (a/an/the), filler (just, really, basically, actually, simply),
  pleasantries (sure, certainly, of course, happy to), and hedging.
- Sentence fragments are fine. Prefer short synonyms (big not extensive,
  fix not "implement a solution for").
- Keep technical terms exact. Code blocks, commands, file paths, identifiers,
  and error strings are NEVER abbreviated or altered.
- Pattern: \`[thing] [action] [reason]. [next step].\`

## Current level: ${level}
${LEVEL_META[level].ruleDetail}

## Safety — write normal prose (NOT caveman) for:
- Security warnings and risk callouts
- Irreversible/destructive action confirmations
- Multi-step sequences where dropped conjunctions could be misread
- Anytime compression creates real technical ambiguity
Resume caveman after the clear part is done. (Keep the ON indicator line even here.)

## Boundaries
Code, commit messages, and PR descriptions: write normally. Caveman shapes the
chat *explanation* around them, not the artifacts themselves.

> Token savings are a bonus — the real win is fast, high-signal answers.`;
}

/**
 * Kiro steering file content. `inclusion: always` makes the assistant read this
 * on every turn, so caveman mode persists across the whole session.
 */
export function buildKiroSteering(level: CavemanLevel): string {
  return `---
inclusion: always
description: VibeGuard Caveman Mode — terse, token-saving replies on every turn (level: ${level})
---
${cavemanRuleBody(level)}
`;
}

/** Cursor rule file content (always applied). */
export function buildCursorRule(level: CavemanLevel): string {
  return `---
description: VibeGuard Caveman Mode — ultra-compressed replies
alwaysApply: true
---
${cavemanRuleBody(level)}
`;
}

/** Plain rule body for CLAUDE.md / Copilot / Gemini / Aider style files. */
export function buildPlainRule(level: CavemanLevel): string {
  return cavemanRuleBody(level);
}

/** Windsurf rule file content (workspace rules, always-on via trigger). */
export function buildWindsurfRule(level: CavemanLevel): string {
  return `---
trigger: always_on
description: VibeGuard Caveman Mode — terse, token-saving replies (level: ${level})
---
${cavemanRuleBody(level)}
`;
}

/**
 * Estimate output-token savings for a level. Rough, deterministic figures used
 * for the CLI summary — not a billing-grade measurement.
 */
export function estimatedSavingsPct(level: CavemanLevel): number {
  return LEVEL_META[level].savingsPct;
}

// ---------------------------------------------------------------------------
// Rule-file IO — the always-on mechanism that makes caveman persist per chat.
// Lives in the engine so the command, install flow, and MCP tool all share one
// implementation (single source of truth, no duplicated path logic).
// ---------------------------------------------------------------------------

/** Marker fences for injecting/removing the block in shared memory files. */
export const CAVEMAN_BEGIN_MARK = '<!-- vibeguard-caveman:begin -->';
export const CAVEMAN_END_MARK = '<!-- vibeguard-caveman:end -->';

/** Relative paths VibeGuard may write caveman rules into. */
export const CAVEMAN_KIRO_STEERING_REL = join('.kiro', 'steering', 'vibeguard-caveman.md');
export const CAVEMAN_CURSOR_RULE_REL = join('.cursor', 'rules', 'vibeguard-caveman.mdc');
export const CAVEMAN_WINDSURF_RULE_REL = join('.windsurf', 'rules', 'vibeguard-caveman.md');
const CLAUDE_REL = 'CLAUDE.md';
const COPILOT_REL = join('.github', 'copilot-instructions.md');
const GEMINI_REL = join('.gemini', 'CONTEXT.md');
const WINDSURFRULES_REL = '.windsurfrules';
const CLINERULES_REL = '.clinerules';
const AGENTS_REL = 'AGENTS.md';

/**
 * Memory/instruction files that are CREATED if missing and then receive a
 * marker-fenced caveman block. These are the canonical always-on instruction
 * files each agent reads, so creating them is what makes Caveman Mode work in
 * every IDE without a prior `vibeguard install`. On disable, the block is
 * stripped; if VibeGuard created the file (nothing else in it), it is removed.
 */
const CREATE_MEMORY_FILES = [CLAUDE_REL, COPILOT_REL, GEMINI_REL, AGENTS_REL];

/**
 * Legacy single-file rule formats. Only folded into when they already exist —
 * the newer per-IDE rule files above are the primary mechanism.
 */
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
  const start = content.indexOf(CAVEMAN_BEGIN_MARK);
  if (start === -1) return content;
  const end = content.indexOf(CAVEMAN_END_MARK, start);
  if (end === -1) return content;
  return content.slice(0, start) + content.slice(end + CAVEMAN_END_MARK.length);
}

async function injectMarkerBlock(filePath: string, body: string): Promise<void> {
  let content = '';
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    content = '';
  }
  const block = `${CAVEMAN_BEGIN_MARK}\n${body}\n${CAVEMAN_END_MARK}`;
  const base = removeMarkerBlock(content).trimEnd();
  const next = base.length > 0 ? `${base}\n\n${block}\n` : `${block}\n`;
  // Ensure the parent directory exists (e.g. .github/, .gemini/) before writing.
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, next, 'utf-8');
}

/**
 * Strip the caveman block from a marker-folded file. If, after stripping, the
 * file contains nothing but whitespace (i.e. VibeGuard created it), the file is
 * deleted so disabling leaves no empty litter. Returns true if anything changed.
 */
async function stripMarkerBlock(filePath: string): Promise<boolean> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    return false;
  }
  if (!content.includes(CAVEMAN_BEGIN_MARK)) return false;

  const remainder = removeMarkerBlock(content).trim();
  if (remainder.length === 0) {
    // The file held only our block — remove it entirely.
    await rm(filePath, { force: true });
  } else {
    await writeFile(filePath, remainder + '\n', 'utf-8');
  }
  return true;
}

/**
 * Write the always-on caveman rule into every major IDE/agent integration so
 * the mode works everywhere without a prior `vibeguard install`. Per-IDE rule
 * files (Kiro, Cursor, Windsurf) are CREATED unconditionally; the cross-tool
 * memory files (CLAUDE.md, Copilot, Gemini, AGENTS.md) are created if missing
 * and folded into via a marker block; legacy single-file formats are only
 * folded into when they already exist. Returns repo-relative paths written.
 */
export async function writeCavemanRules(projectRoot: string, level: CavemanLevel): Promise<string[]> {
  const written: string[] = [];

  // Kiro steering (canonical).
  await mkdir(join(projectRoot, '.kiro', 'steering'), { recursive: true });
  await writeFile(join(projectRoot, CAVEMAN_KIRO_STEERING_REL), buildKiroSteering(level), 'utf-8');
  written.push(CAVEMAN_KIRO_STEERING_REL.replace(/\\/g, '/'));

  // Cursor rule (always created so it works in a fresh Cursor project).
  await mkdir(join(projectRoot, '.cursor', 'rules'), { recursive: true });
  await writeFile(join(projectRoot, CAVEMAN_CURSOR_RULE_REL), buildCursorRule(level), 'utf-8');
  written.push(CAVEMAN_CURSOR_RULE_REL.replace(/\\/g, '/'));

  // Windsurf rule (always created).
  await mkdir(join(projectRoot, '.windsurf', 'rules'), { recursive: true });
  await writeFile(join(projectRoot, CAVEMAN_WINDSURF_RULE_REL), buildWindsurfRule(level), 'utf-8');
  written.push(CAVEMAN_WINDSURF_RULE_REL.replace(/\\/g, '/'));

  // Cross-tool memory files — create if missing, then inject the block.
  for (const rel of CREATE_MEMORY_FILES) {
    await injectMarkerBlock(join(projectRoot, rel), buildPlainRule(level));
    written.push(rel.replace(/\\/g, '/'));
  }

  // Legacy single-file formats — only fold into when already present.
  for (const rel of FOLD_ONLY_FILES) {
    if (await pathExists(join(projectRoot, rel))) {
      await injectMarkerBlock(join(projectRoot, rel), buildPlainRule(level));
      written.push(rel.replace(/\\/g, '/'));
    }
  }

  return written;
}

/** Remove every caveman rule artifact and marker block. Returns paths cleaned. */
export async function removeCavemanRules(projectRoot: string): Promise<string[]> {
  const removed: string[] = [];

  // Per-IDE rule files: delete outright (they hold only caveman content).
  for (const rel of [CAVEMAN_KIRO_STEERING_REL, CAVEMAN_CURSOR_RULE_REL, CAVEMAN_WINDSURF_RULE_REL]) {
    const full = join(projectRoot, rel);
    if (await pathExists(full)) {
      await rm(full, { force: true });
      removed.push(rel.replace(/\\/g, '/'));
    }
  }

  // Memory files: strip our block (and delete the file if it held only that).
  for (const rel of [...CREATE_MEMORY_FILES, ...FOLD_ONLY_FILES]) {
    const full = join(projectRoot, rel);
    if ((await pathExists(full)) && (await stripMarkerBlock(full))) {
      removed.push(rel.replace(/\\/g, '/'));
    }
  }

  return removed;
}

export interface EnableResult {
  state: CavemanState;
  written: string[];
}

/**
 * Enable caveman: write rule files and persist enabled state at `level`.
 * Reusable by the CLI command, the `install` flow, and the MCP tool.
 */
export async function enableCaveman(projectRoot: string, level: CavemanLevel): Promise<EnableResult> {
  const written = await writeCavemanRules(projectRoot, level);
  const state: CavemanState = {
    schemaVersion: CAVEMAN_SCHEMA_VERSION,
    enabled: true,
    level,
    updatedAt: new Date().toISOString(),
  };
  await saveCavemanState(projectRoot, state);
  return { state, written };
}

export interface DisableResult {
  state: CavemanState;
  removed: string[];
}

/** Disable caveman: remove rule files and persist disabled state. */
export async function disableCaveman(projectRoot: string): Promise<DisableResult> {
  const previous = await loadCavemanState(projectRoot);
  const removed = await removeCavemanRules(projectRoot);
  const state: CavemanState = {
    schemaVersion: CAVEMAN_SCHEMA_VERSION,
    enabled: false,
    level: previous.level,
    updatedAt: new Date().toISOString(),
  };
  await saveCavemanState(projectRoot, state);
  return { state, removed };
}

// ---------------------------------------------------------------------------
// Text compression — a deterministic, local caveman-izer. Used by the
// `caveman benchmark` action to demonstrate real (not just estimated) savings
// on sample prose. Conservative by design: it never touches code spans.
// ---------------------------------------------------------------------------

/** Filler words removed at every level. */
const FILLER_WORDS = [
  'just', 'really', 'basically', 'actually', 'simply', 'very', 'quite',
  'essentially', 'literally', 'definitely', 'certainly', 'obviously',
  'of course', 'i think', 'i believe', 'please note that', 'it is worth noting that',
  'as you can see', 'in order to', 'due to the fact that',
];

/** Pleasantry phrases stripped from the start of sentences. */
const PLEASANTRIES = [
  "sure", "certainly", "of course", "absolutely", "happy to help",
  "i'd be happy to help", "great question", "no problem", "as an ai",
];

/** Articles dropped at full/ultra. */
const ARTICLES = ['a', 'an', 'the'];

/** Ultra-level prose abbreviations (prose words only, never code). */
const ULTRA_ABBREV: Record<string, string> = {
  database: 'DB', configuration: 'config', request: 'req', response: 'res',
  function: 'fn', implementation: 'impl', authentication: 'auth',
  application: 'app', repository: 'repo', environment: 'env',
  because: 'b/c', without: 'w/o', with: 'w/', development: 'dev',
};

// Patterns are compiled once at module load (not per line) since the source
// word lists are static. Global regexes are safe to reuse across `replace`
// calls because `replace` does not depend on `lastIndex`.

/** Leading-pleasantry matchers, anchored to the start of a line. */
const PLEASANTRY_PATTERNS = PLEASANTRIES.map(
  (phrase) => new RegExp(`^${escapeRegExp(phrase)}[!,.:]?\\s+`, 'i'),
);

/** Word-bounded filler-phrase matchers, applied everywhere in a line. */
const FILLER_PATTERNS = FILLER_WORDS.map(
  (phrase) => new RegExp(`\\b${escapeRegExp(phrase)}\\b`, 'gi'),
);

/** Word-bounded article matchers, dropped at full/ultra levels. */
const ARTICLE_PATTERNS = ARTICLES.map(
  (article) => new RegExp(`\\b${escapeRegExp(article)}\\b`, 'gi'),
);

/** Ultra-level abbreviation rules pairing a matcher with its replacement. */
const ULTRA_ABBREV_PATTERNS = Object.entries(ULTRA_ABBREV).map(
  ([longWord, shortWord]) => ({
    regex: new RegExp(`\\b${escapeRegExp(longWord)}\\b`, 'gi'),
    replacement: shortWord,
  }),
);

/** Estimate tokens with the project's standard ~4-chars-per-token heuristic. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Compress prose to caveman style at the given level. Code spans (fenced blocks
 * and inline backticks) are preserved byte-for-byte. Deterministic — same input
 * always yields the same output, which keeps it testable.
 */
export function compressText(text: string, level: CavemanLevel): string {
  // Protect code: fenced blocks first, then inline code.
  const protectedSpans: string[] = [];
  const protect = (s: string): string => {
    const token = `\u0000${protectedSpans.length}\u0000`;
    protectedSpans.push(s);
    return token;
  };

  let work = text.replace(/```[\s\S]*?```/g, protect).replace(/`[^`]*`/g, protect);

  // Process line by line so list/structure is preserved.
  work = work
    .split('\n')
    .map((line) => compressLine(line, level))
    .join('\n');

  // Restore protected code spans.
  work = work.replace(/\u0000(\d+)\u0000/g, (_m, i) => protectedSpans[Number(i)] ?? '');

  // Collapse the blank runs compression can create, but keep paragraph breaks.
  return work.replace(/[ \t]+/g, ' ').replace(/ *\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function compressLine(line: string, level: CavemanLevel): string {
  if (line.trim().length === 0) return line;

  // Preserve leading indentation / list markers.
  const leadMatch = line.match(/^(\s*(?:[-*+]|\d+\.)?\s*)/);
  const lead = leadMatch ? leadMatch[1] : '';
  let body = line.slice(lead.length);

  // Strip leading pleasantries (e.g. "Sure! " / "Of course, ").
  for (const re of PLEASANTRY_PATTERNS) {
    body = body.replace(re, '');
  }

  // Remove filler phrases everywhere.
  for (const re of FILLER_PATTERNS) {
    body = body.replace(re, ' ');
  }

  if (level === 'full' || level === 'ultra') {
    // Drop standalone articles (preserve token boundaries, keep code tokens intact).
    for (const re of ARTICLE_PATTERNS) {
      body = body.replace(re, ' ');
    }
  }

  if (level === 'ultra') {
    for (const { regex, replacement } of ULTRA_ABBREV_PATTERNS) {
      body = body.replace(regex, replacement);
    }
  }

  // Tidy spacing around punctuation produced by removals.
  body = body.replace(/\s+([,.:;!?])/g, '$1').replace(/[ \t]{2,}/g, ' ').trimEnd();

  return lead + body;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface CompressionResult {
  level: CavemanLevel;
  originalChars: number;
  compressedChars: number;
  originalTokens: number;
  compressedTokens: number;
  /** Percent of tokens saved (0-100, rounded). */
  savedPct: number;
  compressed: string;
}

/** Measure real compression of a sample at a level (for `caveman benchmark`). */
export function measureCompression(text: string, level: CavemanLevel): CompressionResult {
  const compressed = compressText(text, level);
  const originalTokens = estimateTokens(text);
  const compressedTokens = estimateTokens(compressed);
  const savedPct = originalTokens === 0
    ? 0
    : Math.max(0, Math.round(((originalTokens - compressedTokens) / originalTokens) * 100));
  return {
    level,
    originalChars: text.length,
    compressedChars: compressed.length,
    originalTokens,
    compressedTokens,
    savedPct,
    compressed,
  };
}
