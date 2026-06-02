// Comprehensive live smoke test — every command, JSON + human, plus MCP stdio.
import { execFileSync, spawn } from 'node:child_process';

const CLI = 'dist/cli.js';
const SCHEMA_VERSION = '1.0.0';
const EXEC_OPTS = { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 };

// MCP stdio timing (ms): give the server time to boot before list/call, then to respond.
const MCP_LIST_DELAY_MS = 200;
const MCP_CALL_DELAY_MS = 500;
const MCP_COLLECT_MS = 1400;
const MCP_EXPECTED_MARKERS = ['scan_security', 'query_graph', 'schemaVersion'];

let pass = 0;
let fail = 0;
const failures = [];

function recordPass(label, suffix = '') {
  console.log(`  PASS  ${label}${suffix ? ` ${suffix}` : ''}`);
  pass++;
}

function recordFail(label, detail) {
  console.log(`  FAIL  ${label}: ${detail}`);
  failures.push(label);
  fail++;
}

function runCli(args) {
  return execFileSync('node', [CLI, ...args], EXEC_OPTS);
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function stdoutOf(err) {
  return err.stdout ? err.stdout.toString().trim() : '';
}

function jsonOk(label, args) {
  try {
    const parsed = parseJson(runCli(args).trim());
    if (!parsed || parsed.schemaVersion !== SCHEMA_VERSION) {
      throw new Error('missing/wrong schemaVersion');
    }
    recordPass(label);
  } catch (err) {
    // A non-zero exit is acceptable as long as it still emitted a valid JSON document.
    const recovered = parseJson(stdoutOf(err));
    if (recovered && recovered.schemaVersion) {
      recordPass(label, '(nonzero+valid)');
      return;
    }
    recordFail(label, (err.message || '').split('\n')[0]);
  }
}

function humanOk(label, args) {
  try {
    runCli(args);
    recordPass(label);
  } catch (err) {
    recordFail(label, `exit ${err.status}`);
  }
}

function rpc(id, method, params = {}) {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
}

function mcpOk() {
  return new Promise((resolve) => {
    const server = spawn('node', [CLI, 'serve'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    server.stdout.on('data', (chunk) => (out += chunk));

    server.stdin.write(
      rpc(0, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 't', version: '1' },
      }),
    );
    setTimeout(() => server.stdin.write(rpc(1, 'tools/list')), MCP_LIST_DELAY_MS);
    setTimeout(
      () => server.stdin.write(rpc(2, 'tools/call', { name: 'get_minimal_context', arguments: {} })),
      MCP_CALL_DELAY_MS,
    );
    setTimeout(() => {
      server.kill();
      const ok = MCP_EXPECTED_MARKERS.every((marker) => out.includes(marker));
      const label = 'MCP serve (stdio: list + call)';
      if (ok) recordPass(label);
      else recordFail(label, 'missing expected tool/schema markers');
      resolve();
    }, MCP_COLLECT_MS);
  });
}

const JSON_CASES = [
  ['map', ['map', '--json']],
  ['doctor', ['doctor', '--json']],
  ['security', ['security', '--json']],
  ['attack', ['attack', '--json']],
  ['clean --plan', ['clean', '--plan', '--json']],
  ['pack', ['pack', 'add auth', '--json']],
  ['query', ['query', 'what does the cli do', '--json']],
  ['path', ['path', 'src/cli.ts', 'src/engines/graph-builder.ts', '--json']],
  ['explain', ['explain', 'src/cli.ts', '--json']],
  ['affected', ['affected', 'src/context.ts', '--json']],
  ['benchmark', ['benchmark', '--json']],
  ['trash list', ['trash', 'list', '--json']],
  ['config show', ['config', 'show', '--json']],
  ['review', ['review', '--json']],
  ['flows', ['flows', '--view', 'all', '--json']],
  ['search', ['search', 'security scanner', '--json']],
];

const HUMAN_CASES = [
  ['map', ['map']],
  ['doctor', ['doctor']],
  ['review', ['review']],
  ['review --brief', ['review', '--brief']],
  ['flows', ['flows']],
  ['search', ['search', 'graph']],
  ['config providers', ['config', 'providers']],
  ['hook status', ['hook', 'status']],
];

console.log('\n=== JSON mode (valid JSON + schemaVersion) ===');
for (const [label, args] of JSON_CASES) jsonOk(label, args);

console.log('\n=== Human mode (no crash) ===');
for (const [label, args] of HUMAN_CASES) humanOk(label, args);

console.log('\n=== MCP server (real stdio JSON-RPC) ===');
await mcpOk();

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
if (fail > 0) {
  console.log('FAILURES:', failures.join(', '));
  process.exit(1);
}
