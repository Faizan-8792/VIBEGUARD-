import type { CommandContext } from '../context.js';
import { VibeguardError, ErrorCodes } from '../utils/errors.js';
import { VIBEGUARD_TOOL_NAMES, type VibeGuardToolName } from '../mcp/server.js';

export interface ServeCommandOptions {
  tools?: string;
}

/**
 * Parse a comma-separated tool allowlist (from --tools or VIBEGUARD_TOOLS),
 * keeping only known tool names. Returns undefined when nothing valid is given,
 * which means "expose all tools".
 */
export function parseToolAllowlist(raw: string | undefined): VibeGuardToolName[] | undefined {
  if (!raw || raw.trim().length === 0) return undefined;
  const known = new Set<string>(VIBEGUARD_TOOL_NAMES);
  const selected = raw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && known.has(t)) as VibeGuardToolName[];
  return selected.length > 0 ? selected : undefined;
}

/**
 * Boot the VibeGuard MCP server over stdio.
 *
 * Note: the MCP protocol owns stdout, so this command never prints to stdout.
 * Status/diagnostics go to stderr to avoid corrupting the protocol stream.
 */
export async function runServe(ctx: CommandContext, opts: ServeCommandOptions): Promise<void> {
  const { projectRoot } = ctx;

  const allowedTools = parseToolAllowlist(opts.tools ?? process.env['VIBEGUARD_TOOLS']);

  // Diagnostics to stderr only — stdout is reserved for the MCP transport.
  const toolList = allowedTools ? allowedTools.join(', ') : 'all';
  process.stderr.write(`[vibeguard] MCP server starting (tools: ${toolList})\n`);

  try {
    const { startVibeGuardServer } = await import('../mcp/server.js');
    await startVibeGuardServer({ projectRoot, allowedTools });
  } catch (err) {
    throw new VibeguardError(
      ErrorCodes.INTERNAL_ERROR,
      `Failed to start MCP server: ${err instanceof Error ? err.message : 'unknown error'}`,
    );
  }
}
