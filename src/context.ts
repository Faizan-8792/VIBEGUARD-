import type { Logger } from './utils/logger.js';
import type { ResolvedConfig } from './storage/config-store.js';

/**
 * Global CLI options parsed from the command line, shared by every command.
 * Lives in its own module (rather than the CLI entry point) so command modules
 * can depend on the contract without importing the entry point that wires them
 * up — which would create a dependency cycle.
 */
export interface GlobalOptions {
  json: boolean;
  cwd: string;
  include: string[];
  exclude: string[];
  config: string | undefined;
  verbose: boolean;
  quiet: boolean;
}

/**
 * Runtime context handed to every command: resolved options, configuration,
 * logger, and the absolute project root.
 */
export interface CommandContext {
  options: GlobalOptions;
  config: ResolvedConfig;
  logger: Logger;
  projectRoot: string;
}
