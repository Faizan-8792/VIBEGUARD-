import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanSecurity } from '../../src/engines/security-scanner.js';
import { DEFAULT_CONFIG } from '../../src/storage/config-store.js';
import { loadConfig } from '../../src/storage/config-store.js';

describe('Security Scanner', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `vibeguard-sec-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(testDir, 'src'), { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('detects OpenAI API keys', async () => {
    await writeFile(
      join(testDir, 'src', 'config.ts'),
      `const apiKey = "sk-abcdefghijklmnopqrstuvwxyz1234567890";`,
      'utf-8'
    );

    const config = await loadConfig(testDir);
    const result = await scanSecurity(testDir, ['src/config.ts'], config);

    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues[0].category).toBe('hard-coded-secret');
    expect(result.issues[0].severity).toBe('critical');
    expect(result.issues[0].id).toMatch(/^SEC-001-/);
  });

  it('detects AWS Access Key IDs', async () => {
    await writeFile(
      join(testDir, 'src', 'aws.ts'),
      `const key = "AKIAIOSFODNN7EXAMPLE";`,
      'utf-8'
    );

    const config = await loadConfig(testDir);
    const result = await scanSecurity(testDir, ['src/aws.ts'], config);

    expect(result.issues.some((i) => i.id.startsWith('SEC-003-'))).toBe(true);
  });

  it('detects CORS wildcard origin', async () => {
    await writeFile(
      join(testDir, 'src', 'server.ts'),
      `app.use(cors({ origin: '*' }));`,
      'utf-8'
    );

    const config = await loadConfig(testDir);
    const result = await scanSecurity(testDir, ['src/server.ts'], config);

    expect(result.issues.some((i) => i.category === 'framework-misuse')).toBe(true);
  });

  it('detects CORS without config', async () => {
    await writeFile(
      join(testDir, 'src', 'app.ts'),
      `app.use(cors());`,
      'utf-8'
    );

    const config = await loadConfig(testDir);
    const result = await scanSecurity(testDir, ['src/app.ts'], config);

    expect(result.issues.some((i) => i.category === 'framework-misuse')).toBe(true);
  });

  it('detects database connection URLs', async () => {
    await writeFile(
      join(testDir, 'src', 'db.ts'),
      `const url = "postgresql://user:pass@localhost:5432/mydb";`,
      'utf-8'
    );

    const config = await loadConfig(testDir);
    const result = await scanSecurity(testDir, ['src/db.ts'], config);

    expect(result.issues.some((i) => i.id.startsWith('SEC-006-'))).toBe(true);
  });

  it('produces stable IDs across runs', async () => {
    await writeFile(
      join(testDir, 'src', 'secret.ts'),
      `const key = "sk-abcdefghijklmnopqrstuvwxyz1234567890";`,
      'utf-8'
    );

    const config = await loadConfig(testDir);
    const result1 = await scanSecurity(testDir, ['src/secret.ts'], config);
    const result2 = await scanSecurity(testDir, ['src/secret.ts'], config);

    expect(result1.issues[0].id).toBe(result2.issues[0].id);
  });

  it('skips test files', async () => {
    await writeFile(
      join(testDir, 'src', 'config.test.ts'),
      `const apiKey = "sk-abcdefghijklmnopqrstuvwxyz1234567890";`,
      'utf-8'
    );

    const config = await loadConfig(testDir);
    const result = await scanSecurity(testDir, ['src/config.test.ts'], config);

    expect(result.issues.length).toBe(0);
  });

  it('detects .env not in .gitignore', async () => {
    await writeFile(join(testDir, '.env'), 'SECRET=value', 'utf-8');
    await writeFile(join(testDir, '.gitignore'), 'node_modules\n', 'utf-8');

    const config = await loadConfig(testDir);
    const result = await scanSecurity(testDir, [], config);

    expect(result.issues.some((i) => i.category === 'secrets-gitignore')).toBe(true);
  });

  it('applies custom secret patterns', async () => {
    await writeFile(
      join(testDir, 'src', 'custom.ts'),
      `const token = "CUSTOM_SECRET_12345";`,
      'utf-8'
    );

    await mkdir(join(testDir, '.vibeguard'), { recursive: true });
    await writeFile(
      join(testDir, '.vibeguard', 'config.json'),
      JSON.stringify({
        ...DEFAULT_CONFIG,
        security: { customSecretPatterns: ['CUSTOM_SECRET_\\d+'] },
      }),
      'utf-8'
    );

    const config = await loadConfig(testDir);
    const result = await scanSecurity(testDir, ['src/custom.ts'], config);

    expect(result.issues.some((i) => i.category === 'custom-secret')).toBe(true);
  });

  it('counts issues by severity', async () => {
    await writeFile(
      join(testDir, 'src', 'multi.ts'),
      `const key = "sk-abcdefghijklmnopqrstuvwxyz1234567890";\nconst db = "postgresql://user:pass@host/db";`,
      'utf-8'
    );

    const config = await loadConfig(testDir);
    const result = await scanSecurity(testDir, ['src/multi.ts'], config);

    expect(result.counts.critical).toBeGreaterThan(0);
    expect(result.counts.high).toBeGreaterThan(0);
  });

  // ─── New secret detectors (013-018) ─────────────────────────────────────

  it('detects GitHub tokens', async () => {
    // Built at runtime so the source file contains no contiguous token literal
    // (keeps GitHub secret-scanning push protection happy on this test fixture).
    const token = 'ghp_' + 'a'.repeat(36);
    await writeFile(join(testDir, 'src', 'gh.ts'), `const t = "${token}";`, 'utf-8');
    const config = await loadConfig(testDir);
    const result = await scanSecurity(testDir, ['src/gh.ts'], config);
    expect(result.issues.some((i) => i.id.startsWith('SEC-013-'))).toBe(true);
  });

  it('detects Stripe secret keys', async () => {
    const key = 'sk_' + 'live_' + 'abcdefghijklmnopqrstuvwx';
    await writeFile(join(testDir, 'src', 'stripe.ts'), `const k = "${key}";`, 'utf-8');
    const config = await loadConfig(testDir);
    const result = await scanSecurity(testDir, ['src/stripe.ts'], config);
    expect(result.issues.some((i) => i.id.startsWith('SEC-014-'))).toBe(true);
  });

  it('detects private key blocks', async () => {
    await writeFile(
      join(testDir, 'src', 'key.ts'),
      `const pem = \`-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----\`;`,
      'utf-8'
    );
    const config = await loadConfig(testDir);
    const result = await scanSecurity(testDir, ['src/key.ts'], config);
    expect(result.issues.some((i) => i.id.startsWith('SEC-017-'))).toBe(true);
  });

  it('detects generic api key assignments', async () => {
    await writeFile(
      join(testDir, 'src', 'generic.ts'),
      `const client_secret = "abc123DEF456ghi789JKL";`,
      'utf-8'
    );
    const config = await loadConfig(testDir);
    const result = await scanSecurity(testDir, ['src/generic.ts'], config);
    expect(result.issues.some((i) => i.id.startsWith('SEC-018-'))).toBe(true);
  });

  // ─── False-positive regression tests ────────────────────────────────────

  it('does NOT flag arbitrary 40-char strings as AWS secret keys', async () => {
    // Git SHAs, base64 blobs, and long identifiers are NOT AWS keys
    await writeFile(
      join(testDir, 'src', 'fp.ts'),
      [
        'const sha = "a1b2c3d4e5f6071829304152637485960aabbccd";',
        'const blob = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2";',
        'const id = "MinimalIssueFieldValueSingleSelectOptionXYZ";',
      ].join('\n'),
      'utf-8'
    );

    const config = await loadConfig(testDir);
    const result = await scanSecurity(testDir, ['src/fp.ts'], config);

    expect(result.issues.some((i) => i.id.startsWith('SEC-004-'))).toBe(false);
  });

  it('DOES flag a real AWS secret key in assignment context', async () => {
    await writeFile(
      join(testDir, 'src', 'real.ts'),
      `const aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";`,
      'utf-8'
    );

    const config = await loadConfig(testDir);
    const result = await scanSecurity(testDir, ['src/real.ts'], config);

    expect(result.issues.some((i) => i.id.startsWith('SEC-004-'))).toBe(true);
  });

  it('does NOT flag a database URL without embedded credentials', async () => {
    await writeFile(
      join(testDir, 'src', 'dburl.ts'),
      `const url = "postgres://localhost:5432/mydb";`,
      'utf-8'
    );

    const config = await loadConfig(testDir);
    const result = await scanSecurity(testDir, ['src/dburl.ts'], config);

    expect(result.issues.some((i) => i.id.startsWith('SEC-006-'))).toBe(false);
  });

  // ─── Nested-dependency & generated-file false-positive regressions ──────

  it('does NOT scan files inside nested node_modules (monorepo client/server)', async () => {
    await mkdir(join(testDir, 'client', 'node_modules', 'keyv'), { recursive: true });
    await writeFile(
      join(testDir, 'client', 'node_modules', 'keyv', 'README.md'),
      `Connect with const uri = "postgres://user:pass@localhost:5432/db";`,
      'utf-8'
    );

    const config = await loadConfig(testDir);
    const result = await scanSecurity(
      testDir,
      ['client/node_modules/keyv/README.md'],
      config,
    );

    expect(result.issues.length).toBe(0);
  });

  it('does NOT flag a Twilio-looking hex run buried in a minified data table', async () => {
    // A long, whitespace-free generated line containing an AC+32hex substring.
    const blob = 'var d=[' + 'AC' + 'a'.repeat(32) + ('0123456789abcdef'.repeat(40)) + '];';
    await writeFile(join(testDir, 'src', 'data.ts'), blob, 'utf-8');

    const config = await loadConfig(testDir);
    const result = await scanSecurity(testDir, ['src/data.ts'], config);

    expect(result.issues.some((i) => i.id.startsWith('SEC-016-'))).toBe(false);
  });

  it('DOES flag a Twilio Account SID in a real assignment', async () => {
    const sid = 'AC' + '0a1b2c3d4e5f60718293a4b5c6d7e8f9';
    await writeFile(
      join(testDir, 'src', 'twilio.ts'),
      `const accountSid = "${sid}";`,
      'utf-8'
    );

    const config = await loadConfig(testDir);
    const result = await scanSecurity(testDir, ['src/twilio.ts'], config);

    expect(result.issues.some((i) => i.id.startsWith('SEC-016-'))).toBe(true);
  });

  it('does NOT flag a bare PRIVATE KEY header with no key body (docs/prose)', async () => {
    await writeFile(
      join(testDir, 'src', 'doc.ts'),
      `// Example: paste your key as -----BEGIN PRIVATE KEY----- ... -----END PRIVATE KEY-----`,
      'utf-8'
    );

    const config = await loadConfig(testDir);
    const result = await scanSecurity(testDir, ['src/doc.ts'], config);

    expect(result.issues.some((i) => i.id.startsWith('SEC-017-'))).toBe(false);
  });

  // ─── Per-finding ignore list ────────────────────────────────────────────

  it('suppresses a finding whose ID is in security.ignore', async () => {
    await writeFile(
      join(testDir, 'src', 'ig.ts'),
      `const key = "sk-abcdefghijklmnopqrstuvwxyz1234567890";`,
      'utf-8'
    );

    // First scan: discover the finding's ID.
    let config = await loadConfig(testDir);
    const first = await scanSecurity(testDir, ['src/ig.ts'], config);
    expect(first.issues.length).toBeGreaterThan(0);
    const ignoredId = first.issues[0].id;

    // Persist it to the ignore list, then re-scan — it must be gone.
    const { addIgnoredFindings } = await import('../../src/storage/config-store.js');
    await addIgnoredFindings(testDir, [ignoredId]);

    config = await loadConfig(testDir);
    const second = await scanSecurity(testDir, ['src/ig.ts'], config);
    expect(second.issues.some((i) => i.id === ignoredId)).toBe(false);
  });

  it('DOES flag a database URL with embedded credentials', async () => {
    await writeFile(
      join(testDir, 'src', 'dbcreds.ts'),
      `const url = "postgres://admin:s3cr3t@db.example.com:5432/prod";`,
      'utf-8'
    );

    const config = await loadConfig(testDir);
    const result = await scanSecurity(testDir, ['src/dbcreds.ts'], config);

    expect(result.issues.some((i) => i.id.startsWith('SEC-006-'))).toBe(true);
  });

  it('reports progress via the callback for large scans', async () => {
    // Create 60 files so the every-25 progress callback fires
    const fileList: string[] = [];
    for (let i = 0; i < 60; i++) {
      const name = `f${i}.ts`;
      await writeFile(join(testDir, 'src', name), 'export const x = 1;', 'utf-8');
      fileList.push(`src/${name}`);
    }

    const config = await loadConfig(testDir);
    let calls = 0;
    await scanSecurity(testDir, fileList, config, () => { calls++; });

    expect(calls).toBeGreaterThan(0);
  });
});
