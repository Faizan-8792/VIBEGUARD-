import { describe, it, expect } from 'vitest';
import { createTools, filterTools, parseToolAllowlist } from '../../src/mcp/tools.js';
import { buildMcpServer } from '../../src/mcp/server.js';

describe('MCP tool registry', () => {
  it('exposes the core VibeGuard tools', () => {
    const names = createTools().map((t) => t.name);
    expect(names).toContain('get_minimal_context');
    expect(names).toContain('scan_security');
    expect(names).toContain('scan_attacks');
    expect(names).toContain('get_health');
    expect(names).toContain('build_graph');
    expect(names).toContain('query_graph');
    expect(names).toContain('find_path');
    expect(names).toContain('explain_node');
    expect(names).toContain('get_affected');
    expect(names).toContain('pack_context');
    expect(names).toContain('detect_dead_code');
    expect(names).toContain('set_caveman');
  });

  it('every tool has a name, description, and object input schema', () => {
    for (const tool of createTools()) {
      expect(tool.name).toMatch(/^[a-z_]+$/);
      expect(tool.description.length).toBeGreaterThan(10);
      expect(tool.inputSchema.type).toBe('object');
      expect(typeof tool.run).toBe('function');
    }
  });

  it('set_caveman toggles caveman state on/off/status and reports errors structurally', async () => {
    const { mkdtemp, rm, access } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'vg-mcp-caveman-'));
    try {
      const tool = createTools().find((t) => t.name === 'set_caveman');
      expect(tool).toBeDefined();

      const initial = await tool!.run({ action: 'status' }, { projectRoot: dir }) as { enabled: boolean };
      expect(initial.enabled).toBe(false);

      const on = await tool!.run({ action: 'on', level: 'ultra' }, { projectRoot: dir }) as { enabled: boolean; level: string };
      expect(on.enabled).toBe(true);
      expect(on.level).toBe('ultra');
      await access(join(dir, '.kiro', 'steering', 'vibeguard-caveman.md')); // throws if missing

      const off = await tool!.run({ action: 'off' }, { projectRoot: dir }) as { enabled: boolean };
      expect(off.enabled).toBe(false);

      const bad = await tool!.run({ action: 'on', level: 'turbo' }, { projectRoot: dir }) as { error?: string };
      expect(bad.error).toBeTruthy();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('tools requiring args declare them as required', () => {
    const byName = new Map(createTools().map((t) => [t.name, t]));
    expect(byName.get('query_graph')?.inputSchema.required).toContain('question');
    expect(byName.get('find_path')?.inputSchema.required).toEqual(expect.arrayContaining(['source', 'target']));
    expect(byName.get('pack_context')?.inputSchema.required).toContain('task');
  });
});

describe('filterTools / allowlist', () => {
  it('returns all tools when no allowlist is given', () => {
    const all = createTools();
    expect(filterTools(all).length).toBe(all.length);
    expect(filterTools(all, []).length).toBe(all.length);
  });

  it('restricts to the named tools and ignores unknown names', () => {
    const filtered = filterTools(createTools(), ['scan_security', 'nonexistent_tool']);
    expect(filtered.map((t) => t.name)).toEqual(['scan_security']);
  });

  it('parses comma-separated allowlists, keeping only known tool names', () => {
    expect(parseToolAllowlist('scan_security, get_health ,bogus')).toEqual(['scan_security', 'get_health']);
    expect(parseToolAllowlist('')).toBeUndefined();
    expect(parseToolAllowlist(undefined)).toBeUndefined();
  });
});

describe('buildMcpServer', () => {
  it('constructs a server with the filtered tool set', () => {
    const { server, tools } = buildMcpServer({ projectRoot: process.cwd(), allow: ['get_health', 'scan_security'] });
    expect(server).toBeDefined();
    expect(tools.map((t) => t.name).sort()).toEqual(['get_health', 'scan_security']);
  });

  it('exposes all tools when no allowlist is provided', () => {
    const { tools } = buildMcpServer({ projectRoot: process.cwd() });
    expect(tools.length).toBe(createTools().length);
  });
});
