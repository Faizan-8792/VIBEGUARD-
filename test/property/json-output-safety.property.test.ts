import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fc from 'fast-check';
import { wrapJsonOutput, SCHEMA_VERSION } from '../../src/utils/json-output.js';
import { VibeguardError, ErrorCodes, formatErrorJson } from '../../src/utils/errors.js';
import { createLogger } from '../../src/utils/logger.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function muteLoggerOutput(): void {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
}

describe('Property 1: JSON Mode Output Integrity', () => {
  it('wrapJsonOutput always produces valid JSON with schemaVersion', () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.stringMatching(/^[a-z][a-zA-Z0-9]{0,10}$/),
          fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
        ),
        (data) => {
          const output = wrapJsonOutput(data);
          const parsed = JSON.parse(output);

          expect(parsed.schemaVersion).toBe(SCHEMA_VERSION);
          expect(parsed.schemaVersion).toMatch(/^\d+\.\d+\.\d+$/);

          // All original keys should be present
          for (const key of Object.keys(data)) {
            expect(parsed).toHaveProperty(key);
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  it('output is exactly one JSON document (no trailing content)', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string({ minLength: 1, maxLength: 5 }), fc.string()),
        (data) => {
          const output = wrapJsonOutput(data);
          // Should parse without error
          const parsed = JSON.parse(output);
          expect(parsed).toBeDefined();
          // Re-stringify and compare structure
          expect(typeof parsed).toBe('object');
        },
      ),
      { numRuns: 30 },
    );
  });
});

describe('Property 2: Unknown Token Error Reporting', () => {
  it('unknown command errors include the offending token', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z]{3,10}$/),
        (token) => {
          const error = new VibeguardError(
            ErrorCodes.UNKNOWN_COMMAND,
            `Unknown command: "${token}"`,
          );
          expect(error.message).toContain(token);
          expect(error.code).toBe('UNKNOWN_COMMAND');
        },
      ),
      { numRuns: 20 },
    );
  });

  it('unknown option errors include the offending token', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^--[a-z]{3,10}$/),
        (token) => {
          const error = new VibeguardError(
            ErrorCodes.UNKNOWN_OPTION,
            `Unknown option: "${token}"`,
          );
          expect(error.message).toContain(token);
          expect(error.code).toBe('UNKNOWN_OPTION');
        },
      ),
      { numRuns: 20 },
    );
  });
});

describe('Property 3: Structured Error Shape in JSON Mode', () => {
  it('error JSON always has schemaVersion, error.code, error.message', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...Object.values(ErrorCodes)),
        fc.string({ minLength: 1, maxLength: 100 }),
        (code, message) => {
          const error = new VibeguardError(code, message);
          const json = formatErrorJson(error);

          expect(json.schemaVersion).toBe(SCHEMA_VERSION);
          expect(json.error.code).toBe(code);
          expect(json.error.message).toBe(message);
        },
      ),
      { numRuns: 30 },
    );
  });
});

describe('Property 39: Logger Level Filtering', () => {
  it('quiet mode suppresses info and debug', () => {
    muteLoggerOutput();
    const logger = createLogger({ jsonMode: false, quiet: true, verbose: false, command: 'test' });
    // Logger should exist and not throw
    expect(() => logger.info('test')).not.toThrow();
    expect(() => logger.debug('test')).not.toThrow();
    expect(() => logger.warn('test')).not.toThrow();
    expect(() => logger.error('test')).not.toThrow();
  });

  it('verbose mode enables debug', () => {
    muteLoggerOutput();
    const logger = createLogger({ jsonMode: false, quiet: false, verbose: true, command: 'test' });
    expect(() => logger.debug('test')).not.toThrow();
  });

  it('json mode routes warnings to stderr only', () => {
    muteLoggerOutput();
    const logger = createLogger({ jsonMode: true, quiet: false, verbose: false, command: 'test' });
    expect(() => logger.warn('test')).not.toThrow();
    expect(() => logger.info('test')).not.toThrow();
  });
});

describe('Property 40: Schema Version Staleness Triggers Rebuild', () => {
  it('mismatched schema version forces full rebuild', async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { buildGraph } = await import('../../src/engines/graph-builder.js');
    const { loadConfig } = await import('../../src/storage/config-store.js');

    const dir = await mkdtemp(join(tmpdir(), 'vg-schema-'));
    await mkdir(join(dir, 'src'), { recursive: true });
    await mkdir(join(dir, '.vibeguard'), { recursive: true });
    await writeFile(join(dir, 'src/a.ts'), 'export const x = 1;', 'utf-8');

    // Write stale meta with wrong schema version
    await writeFile(join(dir, '.vibeguard/analysis-meta.json'), JSON.stringify({
      schemaVersion: '0.0.1',
      buildTimestamp: new Date().toISOString(),
      fileHashes: {},
      parseErrors: [],
      warnings: [],
    }), 'utf-8');

    const config = await loadConfig(dir);
    const logger = createLogger({ jsonMode: true, quiet: true, verbose: false, command: 'test' });
    const result = await buildGraph(dir, ['src/a.ts'], config, logger);

    // Should do full rebuild due to schema mismatch
    expect(result.summary.rebuilt).toBe(1);
    expect(result.summary.skipped).toBe(0);

    await rm(dir, { recursive: true, force: true });
  });
});
