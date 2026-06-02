import { CredentialsStore, PROVIDER_DEFAULTS, LLM_PROVIDERS, inferProvider, type LLMProvider, type LLMCredentials } from '../storage/credentials-store.js';
import { LLMClient } from '../engines/llm-provider.js';
import { emitJson } from '../utils/json-output.js';
import { header, statusIcon, brand, keyValue, divider } from '../utils/ui.js';
import { VibeguardError, ErrorCodes } from '../utils/errors.js';
import type { CommandContext } from '../context.js';
import type { Logger } from '../utils/logger.js';

export interface ConfigCommandOptions {
  action: string;
  value?: string;
  provider?: string;
  model?: string;
  baseUrl?: string;
  test?: boolean;
}

const VALID_PROVIDERS = LLM_PROVIDERS;

const CONFIG_HEADER_ICON = '🔑';
const CONFIG_HEADER_TITLE = 'LLM Configuration';

export async function runConfig(ctx: CommandContext, opts: ConfigCommandOptions): Promise<void> {
  const { projectRoot, options, logger } = ctx;
  const store = new CredentialsStore(projectRoot);
  const jsonMode = options.json;

  switch (opts.action) {
    case 'set-key':
      await setKey(store, opts, jsonMode, projectRoot, logger);
      break;
    case 'show':
      await showConfig(store, jsonMode);
      break;
    case 'test':
      await testConfig(store, jsonMode, logger);
      break;
    case 'clear':
      await clearConfig(store, jsonMode);
      break;
    case 'providers':
      listProviders(jsonMode);
      break;
    default:
      throw new VibeguardError(
        ErrorCodes.UNKNOWN_COMMAND,
        `Unknown config action "${opts.action}". Valid: set-key, show, test, clear, providers`,
      );
  }
}

async function setKey(
  store: CredentialsStore,
  opts: ConfigCommandOptions,
  jsonMode: boolean,
  projectRoot: string,
  logger: Logger,
): Promise<void> {
  const credentials = buildCredentials(opts);

  let tested = false;
  if (opts.test) {
    if (!jsonMode) logger.startSpinner(`Testing connection to ${credentials.provider} (${credentials.model})...`);
    const status = await new LLMClient(credentials).testConnection();
    if (!status.ok) {
      if (!jsonMode) logger.stopSpinner(false);
      throw new VibeguardError(ErrorCodes.CONFIG_INVALID, `API key test failed: ${status.error}`);
    }
    if (!jsonMode) logger.stopSpinner(true);
    tested = true;
  }

  await store.save(credentials);
  await ensureGitignore(projectRoot);

  if (jsonMode) {
    emitJson({ saved: true, provider: credentials.provider, model: credentials.model, tested });
    return;
  }

  const out: string[] = [];
  out.push(header(CONFIG_HEADER_TITLE, CONFIG_HEADER_ICON));
  out.push('');
  out.push(`  ${statusIcon('success')} ${brand.success('API key saved')} ${brand.muted('(.vibeguard/credentials.json, gitignored)')}`);
  out.push(keyValue('Provider', brand.info(credentials.provider)));
  out.push(keyValue('Model', brand.secondary(credentials.model)));
  if (tested) {
    out.push(keyValue('Connection', brand.success('✓ Verified')));
  }
  out.push('');
  out.push(`  ${brand.muted('Now run:')} ${brand.secondary('vibeguard attack --ai')} ${brand.muted('for AI-powered deep scan')}`);
  out.push('');
  process.stdout.write(out.join('\n') + '\n');
}

/**
 * Validate options and resolve the full set of credentials, applying provider defaults.
 */
function buildCredentials(opts: ConfigCommandOptions): LLMCredentials {
  if (!opts.value) {
    throw new VibeguardError(
      ErrorCodes.CONFIG_INVALID,
      'API key required. Usage: vibeguard config set-key <api-key> [--provider <name>] [--model <name>]',
    );
  }

  const provider: LLMProvider = (opts.provider as LLMProvider | undefined) ?? inferProvider(opts.value);
  if (!VALID_PROVIDERS.includes(provider)) {
    throw new VibeguardError(
      ErrorCodes.CONFIG_INVALID,
      `Invalid provider "${provider}". Valid: ${VALID_PROVIDERS.join(', ')}`,
    );
  }

  const defaults = PROVIDER_DEFAULTS[provider];
  const credentials: LLMCredentials = {
    provider,
    apiKey: opts.value,
    model: opts.model ?? defaults.model,
    baseUrl: opts.baseUrl ?? defaults.baseUrl,
  };

  if (provider === 'custom' && !credentials.baseUrl) {
    throw new VibeguardError(
      ErrorCodes.CONFIG_INVALID,
      'Custom provider requires --base-url. Example: --base-url https://my-llm.example.com/v1',
    );
  }
  if (provider === 'custom' && !credentials.model) {
    throw new VibeguardError(ErrorCodes.CONFIG_INVALID, 'Custom provider requires --model.');
  }

  return credentials;
}

async function showConfig(store: CredentialsStore, jsonMode: boolean): Promise<void> {
  const creds = await store.load();

  if (jsonMode) {
    emitJson({
      configured: creds !== null,
      provider: creds?.provider,
      model: creds?.model,
      baseUrl: creds?.baseUrl,
      apiKey: creds ? maskKey(creds.apiKey) : null,
    });
    return;
  }

  const out: string[] = [];
  out.push(header(CONFIG_HEADER_TITLE, CONFIG_HEADER_ICON));
  out.push('');
  if (!creds) {
    out.push(`  ${statusIcon('info')} ${brand.muted('No LLM configured.')}`);
    out.push('');
    out.push(`  ${brand.muted('Set one with:')} ${brand.secondary('vibeguard config set-key <api-key>')}`);
  } else {
    out.push(keyValue('Provider', brand.info(creds.provider)));
    out.push(keyValue('Model', brand.secondary(creds.model)));
    out.push(keyValue('API Key', brand.muted(maskKey(creds.apiKey))));
    if (creds.baseUrl) out.push(keyValue('Base URL', brand.muted(creds.baseUrl)));
  }
  out.push('');
  process.stdout.write(out.join('\n') + '\n');
}

async function testConfig(store: CredentialsStore, jsonMode: boolean, logger: Logger): Promise<void> {
  const creds = await store.resolve();
  if (!creds) {
    throw new VibeguardError(ErrorCodes.CONFIG_NOT_FOUND, 'No LLM configured. Run `vibeguard config set-key <key>` first.');
  }

  if (!jsonMode) logger.startSpinner(`Testing connection to ${creds.provider} (${creds.model})...`);
  const result = await new LLMClient(creds).testConnection();
  if (!jsonMode) logger.stopSpinner(result.ok);

  if (jsonMode) {
    emitJson({ ok: result.ok, model: result.model, error: result.error });
    return;
  }

  if (result.ok) {
    process.stdout.write(`\n  ${statusIcon('success')} ${brand.success.bold('Connection OK')} ${brand.muted(`(${result.model})`)}\n\n`);
  } else {
    process.stdout.write(`\n  ${statusIcon('error')} ${brand.danger('Connection failed:')} ${result.error}\n\n`);
  }
}

async function clearConfig(store: CredentialsStore, jsonMode: boolean): Promise<void> {
  await store.clear();
  if (jsonMode) {
    emitJson({ cleared: true });
  } else {
    process.stdout.write(`\n  ${statusIcon('success')} ${brand.success('LLM credentials cleared')}\n\n`);
  }
}

function listProviders(jsonMode: boolean): void {
  if (jsonMode) {
    emitJson({ providers: VALID_PROVIDERS, defaults: PROVIDER_DEFAULTS });
    return;
  }

  const out: string[] = [];
  out.push(header('Supported LLM Providers', '🌐'));
  out.push('');
  for (const p of VALID_PROVIDERS) {
    const d = PROVIDER_DEFAULTS[p];
    out.push(`  ${brand.primary.bold(p)}`);
    if (d.model) out.push(`    ${brand.muted('default model:')} ${brand.secondary(d.model)}`);
    if (d.baseUrl) out.push(`    ${brand.muted('endpoint:')} ${brand.muted(d.baseUrl)}`);
    out.push('');
  }
  out.push(divider());
  out.push('');
  out.push(`  ${brand.muted('Set a key:')} ${brand.secondary('vibeguard config set-key <key> --provider <name>')}`);
  out.push(`  ${brand.muted('Custom:')} ${brand.secondary('vibeguard config set-key <key> --provider custom --base-url <url> --model <name>')}`);
  out.push('');
  process.stdout.write(out.join('\n') + '\n');
}

function maskKey(key: string): string {
  if (key.length <= 12) return '****';
  return `${key.slice(0, 8)}...${key.slice(-4)}`;
}

async function ensureGitignore(projectRoot: string): Promise<void> {
  const { readFile, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const gitignorePath = join(projectRoot, '.gitignore');

  let content = '';
  try {
    content = await readFile(gitignorePath, 'utf-8');
  } catch {
    // No gitignore yet
  }

  const required = ['.vibeguard/credentials.json'];
  const existing = content.split('\n').map((l) => l.trim());
  const toAdd = required.filter((r) => !existing.includes(r) && !existing.includes('.vibeguard/'));

  if (toAdd.length > 0) {
    const newContent = content.length === 0 || content.endsWith('\n')
      ? content + toAdd.join('\n') + '\n'
      : content + '\n' + toAdd.join('\n') + '\n';
    await writeFile(gitignorePath, newContent, 'utf-8');
  }
}
