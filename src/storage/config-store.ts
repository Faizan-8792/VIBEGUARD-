import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { VibeguardError, ErrorCodes } from '../utils/errors.js';

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
  security: { customSecretPatterns: string[] };
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
    'node_modules/**',
    'dist/**',
    'build/**',
    'coverage/**',
    'vendor/**',
    'third_party/**',
    'third-party/**',
    'takeinspiration/**',
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
  security: { customSecretPatterns: [] },
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
