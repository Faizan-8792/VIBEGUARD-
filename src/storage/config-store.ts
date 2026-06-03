import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { VibeguardError, ErrorCodes } from '../utils/errors.js';
import { FileStoreImpl } from './file-store.js';

export interface TagRule {
  match: string;
  add: string[];
}

export interface ImportanceWeights {
  dependents: number;
  imports: number;
  git: number;
  route: number;
}

export interface ModelConfig {
  tokensPerKiloChar: number;
  pricePer1K: number;
}

export interface VibeguardConfig {
  ignore: string[];
  tags: { customRules: TagRule[] };
  importance: { weights: ImportanceWeights };
  security: {
    customSecretPatterns: string[];
    /** Finding IDs (e.g. "SEC-006-1a2b3c4d", "ATK-104-…") to suppress on future scans. */
    ignore: string[];
  };
  context: {
    defaultRadius: number;
    defaultTokenBudget: number;
    models: Record<string, ModelConfig>;
  };
  clean: { maxChangesPerRun: number };
  limits: { maxFilesPerRun: number };
}

export interface ResolvedConfig extends VibeguardConfig {
  effectiveSkipSet: string[];
  effectiveInclude: string[];
}

export const DEFAULT_CONFIG: VibeguardConfig = {
  ignore: [
    // Dependencies & build output — match at ANY depth (monorepos put these
    // under client/, server/, packages/*, etc., not just the repo root).
    '**/node_modules',
    '**/node_modules/**',
    '**/dist',
    '**/dist/**',
    '**/build',
    '**/build/**',
    '**/out/**',
    '**/coverage/**',
    '**/vendor/**',
    '**/third_party/**',
    '**/third-party/**',
    'takeinspiration/**',
    // Framework / tooling caches that hold large generated or bundled files.
    '**/.next/**',
    '**/.nuxt/**',
    '**/.svelte-kit/**',
    '**/.angular/**',
    '**/.cache/**',
    '**/.turbo/**',
    '**/.parcel-cache/**',
    '**/.yarn/**',
    '**/tmp/**',
    '**/temp/**',
    // WhatsApp/puppeteer session stores ship multi-MB bundled JS that OOMs parsers.
    '**/.wwebjs_auth/**',
    '**/.wwebjs_cache/**',
    '**/.puppeteer_cache/**',
    // Minified / bundled / generated artifacts — never useful and full of
    // high-entropy strings that trip secret detectors.
    '**/*.min.js',
    '**/*.min.css',
    '**/*.bundle.js',
    '**/*.map',
    '**/*.lock',
    '**/package-lock.json',
    '**/pnpm-lock.yaml',
    '**/yarn.lock',
    // Test fixtures and specs.
    '**/*.test.ts',
    '**/*.test.tsx',
    '**/*.test.js',
    '**/*.spec.ts',
    '**/*.spec.tsx',
    '**/*.spec.js',
    '.vibeguard/**',
    '.vibeguard-trash/**',
  ],
  tags: { customRules: [] },
  importance: {
    weights: { dependents: 5, imports: 2, git: 3, route: 4 },
  },
  security: { customSecretPatterns: [], ignore: [] },
  context: {
    defaultRadius: 2,
    defaultTokenBudget: 12000,
    models: {
      'claude-3': { tokensPerKiloChar: 280, pricePer1K: 0.003 },
      'gpt-4': { tokensPerKiloChar: 260, pricePer1K: 0.01 },
    },
  },
  clean: { maxChangesPerRun: 50 },
  limits: { maxFilesPerRun: 200 },
};

const DEFAULT_EXTENSIONS = [
  '**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs',
  '**/*.py', '**/*.pyw',
  '**/*.go',
  '**/*.java',
  '**/*.md', '**/*.mdx',
];

function validateConfig(data: unknown): VibeguardConfig {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new VibeguardError(ErrorCodes.CONFIG_INVALID, 'Config must be a JSON object');
  }

  const obj = data as Record<string, unknown>;

  // Validate ignore
  if (obj.ignore !== undefined && !Array.isArray(obj.ignore)) {
    throw new VibeguardError(ErrorCodes.CONFIG_INVALID, 'Config key "ignore" must be an array', { key: 'ignore' });
  }

  // Validate importance.weights
  if (obj.importance !== undefined) {
    if (typeof obj.importance !== 'object' || obj.importance === null) {
      throw new VibeguardError(ErrorCodes.CONFIG_INVALID, 'Config key "importance" must be an object', { key: 'importance' });
    }
    const imp = obj.importance as Record<string, unknown>;
    if (imp.weights !== undefined && typeof imp.weights !== 'object') {
      throw new VibeguardError(ErrorCodes.CONFIG_INVALID, 'Config key "importance.weights" must be an object', { key: 'importance.weights' });
    }
  }

  // Validate context
  if (obj.context !== undefined) {
    if (typeof obj.context !== 'object' || obj.context === null) {
      throw new VibeguardError(ErrorCodes.CONFIG_INVALID, 'Config key "context" must be an object', { key: 'context' });
    }
    const ctx = obj.context as Record<string, unknown>;
    if (ctx.defaultRadius !== undefined && typeof ctx.defaultRadius !== 'number') {
      throw new VibeguardError(ErrorCodes.CONFIG_INVALID, 'Config key "context.defaultRadius" must be a number', { key: 'context.defaultRadius' });
    }
    if (ctx.defaultTokenBudget !== undefined && typeof ctx.defaultTokenBudget !== 'number') {
      throw new VibeguardError(ErrorCodes.CONFIG_INVALID, 'Config key "context.defaultTokenBudget" must be a number', { key: 'context.defaultTokenBudget' });
    }
  }

  // Merge with defaults
  const config: VibeguardConfig = {
    ignore: (obj.ignore as string[]) ?? DEFAULT_CONFIG.ignore,
    tags: {
      customRules: ((obj.tags as Record<string, unknown>)?.customRules as TagRule[]) ?? DEFAULT_CONFIG.tags.customRules,
    },
    importance: {
      weights: {
        ...DEFAULT_CONFIG.importance.weights,
        ...((obj.importance as Record<string, unknown>)?.weights as Partial<ImportanceWeights> | undefined),
      },
    },
    security: {
      customSecretPatterns:
        ((obj.security as Record<string, unknown>)?.customSecretPatterns as string[]) ?? DEFAULT_CONFIG.security.customSecretPatterns,
      ignore:
        ((obj.security as Record<string, unknown>)?.ignore as string[]) ?? DEFAULT_CONFIG.security.ignore,
    },
    context: {
      defaultRadius: ((obj.context as Record<string, unknown>)?.defaultRadius as number) ?? DEFAULT_CONFIG.context.defaultRadius,
      defaultTokenBudget: ((obj.context as Record<string, unknown>)?.defaultTokenBudget as number) ?? DEFAULT_CONFIG.context.defaultTokenBudget,
      models: ((obj.context as Record<string, unknown>)?.models as Record<string, ModelConfig>) ?? DEFAULT_CONFIG.context.models,
    },
    clean: {
      maxChangesPerRun: ((obj.clean as Record<string, unknown>)?.maxChangesPerRun as number) ?? DEFAULT_CONFIG.clean.maxChangesPerRun,
    },
    limits: {
      maxFilesPerRun: ((obj.limits as Record<string, unknown>)?.maxFilesPerRun as number) ?? DEFAULT_CONFIG.limits.maxFilesPerRun,
    },
  };

  return config;
}

export async function loadConfig(
  projectRoot: string,
  configPath?: string,
  cliInclude?: string[],
  cliExclude?: string[]
): Promise<ResolvedConfig> {
  const filePath = configPath ?? join(projectRoot, '.vibeguard', 'config.json');

  let config: VibeguardConfig;

  try {
    const content = await readFile(filePath, 'utf-8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new VibeguardError(ErrorCodes.CONFIG_INVALID, 'Config file contains malformed JSON', { path: filePath });
    }
    config = validateConfig(parsed);
  } catch (err) {
    if (err instanceof VibeguardError) throw err;
    // File doesn't exist — use defaults
    config = { ...DEFAULT_CONFIG };
  }

  const effectiveSkipSet = [...config.ignore, ...(cliExclude ?? [])];
  const effectiveInclude = cliInclude && cliInclude.length > 0 ? cliInclude : DEFAULT_EXTENSIONS;

  return {
    ...config,
    effectiveSkipSet,
    effectiveInclude,
  };
}

/**
 * Add one or more finding IDs to `security.ignore` in `.vibeguard/config.json`,
 * creating the config from defaults if it does not yet exist. Existing user
 * settings are preserved; ignore IDs are de-duplicated. Returns the IDs that
 * were newly added (already-ignored IDs are skipped).
 */
export async function addIgnoredFindings(projectRoot: string, ids: string[]): Promise<string[]> {
  const filePath = join(projectRoot, '.vibeguard', 'config.json');

  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(await readFile(filePath, 'utf-8')) as Record<string, unknown>;
  } catch {
    // No config yet — start from defaults so the file is valid and complete.
    raw = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }

  const security = (typeof raw.security === 'object' && raw.security !== null)
    ? (raw.security as Record<string, unknown>)
    : {};
  const current = Array.isArray(security.ignore) ? (security.ignore as string[]) : [];
  const currentSet = new Set(current);

  const added: string[] = [];
  for (const id of ids) {
    if (!currentSet.has(id)) {
      currentSet.add(id);
      added.push(id);
    }
  }

  if (added.length === 0) return [];

  security.ignore = [...currentSet];
  if (!Array.isArray(security.customSecretPatterns)) {
    security.customSecretPatterns = DEFAULT_CONFIG.security.customSecretPatterns;
  }
  raw.security = security;

  const store = new FileStoreImpl(projectRoot);
  await store.write('config.json', raw);
  return added;
}

/** Remove finding IDs from `security.ignore`. Returns the IDs actually removed. */
export async function removeIgnoredFindings(projectRoot: string, ids: string[]): Promise<string[]> {
  const filePath = join(projectRoot, '.vibeguard', 'config.json');

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(await readFile(filePath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return [];
  }

  const security = (typeof raw.security === 'object' && raw.security !== null)
    ? (raw.security as Record<string, unknown>)
    : {};
  const current = Array.isArray(security.ignore) ? (security.ignore as string[]) : [];
  if (current.length === 0) return [];

  const removeSet = new Set(ids);
  const removed = current.filter((id) => removeSet.has(id));
  if (removed.length === 0) return [];

  security.ignore = current.filter((id) => !removeSet.has(id));
  raw.security = security;

  const store = new FileStoreImpl(projectRoot);
  await store.write('config.json', raw);
  return removed;
}
