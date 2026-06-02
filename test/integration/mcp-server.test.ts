import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createVibeGuardServer, VIBEGUARD_TOOL_NAMES } from '../../src/mcp/server.js';
import { parseToolAllowlist } from '../../src/commands/serve.js';

let projectRoot: string;

beforeAll(async () => {
  // Minimal real project so graph-backed tools have something to work with.
  projectRoot = await mkdtemp(join(tmpdir(), 'vibeguard-mcp-'));
  await mkdir(join(projectRoot, 'src'), { recursive: true });
  await writeFile(
    join(projectRoot, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '1.0.0', type: 'module', main: 'src/index.ts' }),
    'utf-8',
  );
  await writeFile(join(projectRoot, 'src', 'index.ts'), `import { greet } from './util.js';\nexport function main() { return greet('world'); }\n`, 'utf-8');
  await writeFile(join(projectRoot, 'src', 'util.ts'), `export function greet(name: string): string { return 'hi ' + name; }\n`, 'utf-8');
});

afterAll(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

async function connectedClient(allowedTools?: Parameters<typeof createVibeGuardServer>[0]['allowedTools']) {
  const server = createVibeGuardServer({ projectRoot, allowedTools });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client };
}

function parseToolJson(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  expect(content.length).toBeGreaterThan(0);
  expect(content[0].type).toBe('text');
  return JSON.parse(content[0].text);
}

describe('Integration: MCP server', () => {
  it('lists all registered tools', async () => {
    const { client } = await connectedClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...VIBEGUARD_TOOL_NAMES].sort());
    await client.close();
  });

  it('get_minimal_context returns valid JSON with schemaVersion', async () => {
    const { client } = await connectedClient();
    const result = await client.callTool({ name: 'get_minimal_context', arguments: {} });
    const payload = parseToolJson(result);
    expect(payload.schemaVersion).toBe('1.0.0');
    expect(payload).toHaveProperty('tools');
    await client.close();
  });

  it('build_graph then query_graph returns a graph-backed answer', async () => {
    const { client } = await connectedClient();
    const build = parseToolJson(await client.callTool({ name: 'build_graph', arguments: {} }));
    expect((build.summary as { nodes: number }).nodes).toBeGreaterThan(0);

    const query = parseToolJson(await client.callTool({ name: 'query_graph', arguments: { question: 'what is the entry point' } }));
    expect(query.schemaVersion).toBe('1.0.0');
    expect(query).toHaveProperty('answer');
    await client.close();
  });

  it('scan_security returns issues and counts', async () => {
    const { client } = await connectedClient();
    const payload = parseToolJson(await client.callTool({ name: 'scan_security', arguments: {} }));
    expect(payload).toHaveProperty('issues');
    expect(payload).toHaveProperty('counts');
    await client.close();
  });

  it('get_health returns a summary with sub-scores', async () => {
    const { client } = await connectedClient();
    const payload = parseToolJson(await client.callTool({ name: 'get_health', arguments: {} }));
    const summary = payload.summary as { projectHealth: number };
    expect(typeof summary.projectHealth).toBe('number');
    await client.close();
  });

  it('respects the tool allowlist', async () => {
    const { client } = await connectedClient(['get_minimal_context', 'scan_security']);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['get_minimal_context', 'scan_security']);
    await client.close();
  });
});

describe('parseToolAllowlist', () => {
  it('returns undefined for empty/missing input', () => {
    expect(parseToolAllowlist(undefined)).toBeUndefined();
    expect(parseToolAllowlist('')).toBeUndefined();
    expect(parseToolAllowlist('   ')).toBeUndefined();
  });

  it('keeps only known tool names', () => {
    expect(parseToolAllowlist('scan_security,bogus_tool,get_health')).toEqual(['scan_security', 'get_health']);
  });

  it('returns undefined when no valid names remain', () => {
    expect(parseToolAllowlist('bogus,nope')).toBeUndefined();
  });
});
