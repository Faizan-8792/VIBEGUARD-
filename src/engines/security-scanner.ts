import { readFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { hashString } from '../utils/hash-utils.js';
import { getPatternsForFile } from './polyglot-security.js';
import {
  shannonEntropy,
  looksLikePlaceholder,
  hasHighSecretEntropy,
  isLikelyMinifiedLine,
  isCommentLine,
  isVendoredOrGenerated,
} from './security-validators.js';
import type { ResolvedConfig } from '../storage/config-store.js';
import type { Severity } from './security-types.js';

export type { Severity } from './security-types.js';

/**
 * Categories that represent *live code* behavior rather than committed secret
 * material. For these, a match inside a comment line is almost always a
 * commented-out snippet or example and should be skipped to avoid noise on big
 * projects. Secret categories (hard-coded-secret, custom-secret) are NEVER
 * skipped in comments — a real key pasted into a comment is still a leak.
 */
const CODE_BEHAVIOR_CATEGORIES = new Set<string>([
  'code-injection',
  'command-injection',
  'sql-injection',
  'deserialization',
  'framework-misuse',
  'weak-crypto',
  'insecure-transport',
  'open-redirect',
  'path-traversal',
  'xxe',
  'injection',
  'logic-flaw',
  'insecure-file',
  'memory-safety',
]);

export interface SecurityIssue {
  id: string;
  category: string;
  severity: Severity;
  message: string;
  file: string;
  line: number;
  column?: number;
  snippet?: string;
  suggestedFix?: string;
  /** Exact substring that matched the detector — used for accurate remediation. */
  match?: string;
}

export interface SecurityScanResult {
  issues: SecurityIssue[];
  counts: Record<Severity, number>;
}

interface DetectorPattern {
  name: string;
  detectorCode: string;
  regex: RegExp;
  category: string;
  severity: Severity;
  message: string;
  suggestedFix?: string;
  /**
   * Optional value-level validator. Runs on the exact matched substring after a
   * regex hit; returning false discards the match. Used to enforce real
   * key formats / entropy so structurally-correct-but-fake strings (docs,
   * placeholders, data tables) don't produce false positives.
   */
  validate?: (matchedValue: string, line: string) => boolean;
}

// Value-validation helpers (shannonEntropy, looksLikePlaceholder,
// isLikelyMinifiedLine, isVendoredOrGenerated, isCommentLine) are imported from
// ./security-validators.js so the scanner and the polyglot ruleset share one
// accuracy layer.

const BUILT_IN_PATTERNS: DetectorPattern[] = [
  {
    name: 'OpenAI API Key',
    detectorCode: '001',
    regex: /sk-[A-Za-z0-9]{20,}/g,
    category: 'hard-coded-secret',
    severity: 'critical',
    message: 'Hard-coded OpenAI API key detected',
    suggestedFix: 'Move to environment variable: process.env.OPENAI_API_KEY',
  },
  {
    name: 'Anthropic API Key',
    detectorCode: '002',
    regex: /sk-ant-[A-Za-z0-9\-]{20,}/g,
    category: 'hard-coded-secret',
    severity: 'critical',
    message: 'Hard-coded Anthropic API key detected',
    suggestedFix: 'Move to environment variable: process.env.ANTHROPIC_API_KEY',
  },
  {
    name: 'AWS Access Key ID',
    detectorCode: '003',
    regex: /AKIA[0-9A-Z]{16}/g,
    category: 'hard-coded-secret',
    severity: 'critical',
    message: 'Hard-coded AWS Access Key ID detected',
    suggestedFix: 'Move to environment variable: process.env.AWS_ACCESS_KEY_ID',
  },
  {
    name: 'AWS Secret Access Key',
    detectorCode: '004',
    regex: /(?:aws_secret_access_key|aws_secret_key|aws_secret|secret_access_key)['"]?\s*[:=]\s*['"][A-Za-z0-9/+=]{40}['"]/gi,
    category: 'hard-coded-secret',
    severity: 'high',
    message: 'Possible hard-coded AWS Secret Access Key detected',
    suggestedFix: 'Move to environment variable: process.env.AWS_SECRET_ACCESS_KEY',
  },
  {
    name: 'Generic JWT Secret',
    detectorCode: '005',
    regex: /(?:jwt[_-]?secret|JWT[_-]?SECRET)\s*[:=]\s*['"][^'"]{8,}['"]/g,
    category: 'hard-coded-secret',
    severity: 'high',
    message: 'Hard-coded JWT secret detected',
    suggestedFix: 'Move to environment variable: process.env.JWT_SECRET',
    validate: (value) => !looksLikePlaceholder(value),
  },
  {
    name: 'Database Connection URL',
    detectorCode: '006',
    regex: /(?:postgres|mysql|mongodb)(?:ql)?:\/\/[^\s'":/]+:[^\s'":/@]+@[^\s'"]+/g,
    category: 'hard-coded-secret',
    severity: 'high',
    message: 'Hard-coded database connection URL detected',
    suggestedFix: 'Move to environment variable: process.env.DATABASE_URL',
  },
  {
    name: 'Supabase Service Role Key',
    detectorCode: '007',
    regex: /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[A-Za-z0-9_-]{50,}/g,
    category: 'hard-coded-secret',
    severity: 'critical',
    message: 'Hard-coded Supabase service_role key detected',
    suggestedFix: 'Move to environment variable: process.env.SUPABASE_SERVICE_ROLE_KEY',
  },
  {
    name: 'Google Gemini Key',
    detectorCode: '008',
    regex: /AIza[A-Za-z0-9_-]{35}/g,
    category: 'hard-coded-secret',
    severity: 'critical',
    message: 'Hard-coded Google API/Gemini key detected',
    suggestedFix: 'Move to environment variable: process.env.GOOGLE_API_KEY',
    // Real Google keys are high-entropy; reject repeated/placeholder bodies.
    validate: (value) => !looksLikePlaceholder(value) && shannonEntropy(value.slice(4)) >= 3.0,
  },
  {
    name: 'GitHub Token',
    detectorCode: '013',
    regex: /gh[pousr]_[A-Za-z0-9]{36,}/g,
    category: 'hard-coded-secret',
    severity: 'critical',
    message: 'Hard-coded GitHub personal access / OAuth token detected',
    suggestedFix: 'Revoke the token and move it to an environment variable / secret store',
  },
  {
    name: 'Stripe Secret Key',
    detectorCode: '014',
    regex: /(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}/g,
    category: 'hard-coded-secret',
    severity: 'critical',
    message: 'Hard-coded Stripe secret key detected',
    suggestedFix: 'Move to environment variable: process.env.STRIPE_SECRET_KEY',
  },
  {
    name: 'Slack Token',
    detectorCode: '015',
    regex: /xox[baprs]-[A-Za-z0-9-]{10,}/g,
    category: 'hard-coded-secret',
    severity: 'high',
    message: 'Hard-coded Slack token detected',
    suggestedFix: 'Revoke the token and load it from an environment variable',
  },
  {
    name: 'Twilio Account SID',
    detectorCode: '016',
    // Bounded so it can't be a 34-char slice of a longer hex blob/data table,
    // and not preceded by another hex digit (avoids matching inside hashes).
    regex: /(?<![0-9a-fA-F])AC[0-9a-fA-F]{32}(?![0-9a-fA-F])/g,
    category: 'hard-coded-secret',
    severity: 'high',
    message: 'Hard-coded Twilio Account SID detected',
    suggestedFix: 'Move to environment variable: process.env.TWILIO_ACCOUNT_SID',
    // A real SID sits in an assignment/quoted context near a "twilio"/"sid"/"account"
    // hint, OR is a quoted standalone value — not buried in raw data/code tables.
    validate: (value, line) => {
      if (looksLikePlaceholder(value)) return false;
      // Mixed-case hex (typical of a real random SID) or a clear Twilio context.
      const hasTwilioContext = /twilio|account[_-]?sid|\bsid\b/i.test(line);
      const inQuotedOrAssignment = /['"]/.test(line) || /[:=]/.test(line);
      return hasTwilioContext || inQuotedOrAssignment;
    },
  },
  {
    name: 'Private Key Block',
    detectorCode: '017',
    // Require real key material: the BEGIN header followed by at least one line
    // of base64 body before the END marker. A bare header in prose/docs (with
    // no key bytes) is not a committed secret and must not be flagged.
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\r\n]+(?:[A-Za-z0-9/+=]\s*){4,}-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
    category: 'hard-coded-secret',
    severity: 'critical',
    message: 'Private key material committed in source',
    suggestedFix: 'Remove the key, rotate it, and load from a secret manager / env file',
  },
  {
    name: 'Generic API Key Assignment',
    detectorCode: '018',
    regex: /(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret)['"]?\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/gi,
    category: 'hard-coded-secret',
    severity: 'medium',
    message: 'Possible hard-coded API key / token assignment detected',
    suggestedFix: 'Move the value to an environment variable and reference it via process.env',
    // Reject placeholders/env refs and require the assigned value to be
    // high-entropy with mixed character classes (real keys are random, not
    // dictionary words or sequential IDs).
    validate: (value) => hasHighSecretEntropy(value, 3.2),
  },
];

const FRAMEWORK_PATTERNS: DetectorPattern[] = [
  {
    name: 'CORS wildcard origin',
    detectorCode: '010',
    regex: /cors\(\s*\{\s*origin:\s*['"]\*['"]/g,
    category: 'framework-misuse',
    severity: 'medium',
    message: 'CORS configured with wildcard origin',
    suggestedFix: 'Restrict origin to specific domains',
  },
  {
    name: 'CORS without config',
    detectorCode: '011',
    regex: /app\.use\(\s*cors\(\s*\)\s*\)/g,
    category: 'framework-misuse',
    severity: 'medium',
    message: 'CORS middleware used without configuration (allows all origins)',
    suggestedFix: 'Pass explicit origin configuration to cors()',
  },
  {
    name: 'Hard-coded ACAO header',
    detectorCode: '012',
    regex: /['"]Access-Control-Allow-Origin['"]\s*[,:]\s*['"]\*['"]/g,
    category: 'framework-misuse',
    severity: 'medium',
    message: 'Hard-coded Access-Control-Allow-Origin: * header',
    suggestedFix: 'Use a specific origin or environment-based configuration',
  },
];

export async function scanSecurity(
  projectRoot: string,
  files: string[],
  config: ResolvedConfig,
  onProgress?: (current: number, total: number) => void
): Promise<SecurityScanResult> {
  const issues: SecurityIssue[] = [];

  // Check .env + .gitignore gap
  const envIssues = await checkGitignoreGap(projectRoot);
  issues.push(...envIssues);

  // Compile custom regex detectors once — they are file-independent.
  const customDetectors = compileCustomDetectors(config.security.customSecretPatterns);

  // Scan files for secrets and framework misuse
  let scanned = 0;
  for (const file of files) {
    scanned++;
    // Report progress periodically so large scans show a moving percentage
    if (onProgress && (scanned === 1 || scanned % 10 === 0 || scanned === files.length)) {
      onProgress(scanned, files.length);
    }
    if (isTestFile(file)) continue;
    // Defense-in-depth: never scan vendored / generated / minified files even
    // if a caller passes them in (default ignores already exclude these).
    if (isVendoredOrGenerated(file)) continue;

    try {
      const content = await readFile(resolve(projectRoot, file), 'utf-8');
      const lines = content.split('\n');

      // Run all applicable detectors in a stable order so issue IDs and
      // ordering stay deterministic across runs.
      const detectors: DetectorPattern[] = [
        ...BUILT_IN_PATTERNS,
        ...FRAMEWORK_PATTERNS,
        ...customDetectors,
        ...getPatternsForFile(file),
      ];

      for (const detector of detectors) {
        issues.push(...findPatternMatches(content, lines, detector, file));
      }
    } catch {
      // File unreadable, skip
    }
  }

  // Suppress any findings the user has explicitly ignored (by exact ID).
  const ignoreSet = new Set(config.security.ignore ?? []);
  const visibleIssues = ignoreSet.size > 0 ? issues.filter((i) => !ignoreSet.has(i.id)) : issues;

  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const issue of visibleIssues) {
    counts[issue.severity]++;
  }

  return { issues: visibleIssues, counts };
}

/**
 * Returns true for files that follow test-naming conventions across the
 * supported languages (TS/JS, Go, Python, Java) and should be excluded from
 * secret detection to avoid flagging fixtures and sample data.
 */
function isTestFile(file: string): boolean {
  return (
    /\.(test|spec)\./.test(file) ||
    /_test\.(go|py)$/.test(file) ||
    /(^|\/)test_[^/]+\.py$/.test(file) ||
    /Tests?\.java$/.test(file) ||
    file.includes('/__tests__/') ||
    file.includes('/testdata/') ||
    file.includes('/fixtures/')
  );
}

/**
 * Compiles user-supplied custom secret regexes into detectors, skipping any
 * pattern that is not a valid regular expression.
 */
function compileCustomDetectors(customPatterns: string[]): DetectorPattern[] {
  const detectors: DetectorPattern[] = [];

  for (const source of customPatterns) {
    try {
      detectors.push({
        name: 'Custom pattern',
        detectorCode: '099',
        regex: new RegExp(source, 'g'),
        category: 'custom-secret',
        severity: 'high',
        message: `Custom secret pattern matched: ${source}`,
      });
    } catch {
      // Invalid regex, skip
    }
  }

  return detectors;
}

function findPatternMatches(
  content: string,
  lines: string[],
  pattern: DetectorPattern,
  file: string
): SecurityIssue[] {
  const issues: SecurityIssue[] = [];
  const regex = new RegExp(pattern.regex.source, pattern.regex.flags);

  let match;
  while ((match = regex.exec(content)) !== null) {
    const lineNumber = content.substring(0, match.index).split('\n').length;
    const lineContent = lines[lineNumber - 1] ?? '';

    // Skip minified / generated single-line bundles: they pack high-entropy
    // substrings that masquerade as secrets. Line-scoped so real source is safe.
    if (isLikelyMinifiedLine(lineContent)) {
      if (!regex.global) break;
      continue;
    }

    // Skip commented-out / example lines for CODE-behavior detectors (eval,
    // exec, SQL building, weak crypto, framework misuse, etc.). A commented
    // snippet is not live code. Secret detectors deliberately still scan
    // comments — a real key in a comment is a committed leak.
    if (CODE_BEHAVIOR_CATEGORIES.has(pattern.category) && isCommentLine(lineContent)) {
      if (!regex.global) break;
      continue;
    }

    // Value-level validation: discard structurally-matching but non-secret
    // values (placeholders, docs, low-entropy data) when the detector opts in.
    if (pattern.validate && !pattern.validate(match[0], lineContent)) {
      if (!regex.global) break;
      continue;
    }

    const column = match.index - content.lastIndexOf('\n', match.index - 1);

    const contentHash = hashString(match[0]).substring(0, 8);
    const id = `SEC-${pattern.detectorCode}-${contentHash}`;

    issues.push({
      id,
      category: pattern.category,
      severity: pattern.severity,
      message: pattern.message,
      file,
      line: lineNumber,
      column,
      snippet: lineContent.trim().substring(0, 100),
      suggestedFix: pattern.suggestedFix,
      match: match[0],
    });
  }

  return issues;
}

async function checkGitignoreGap(projectRoot: string): Promise<SecurityIssue[]> {
  const issues: SecurityIssue[] = [];

  // Check if .env exists
  let envExists = false;
  try {
    await access(join(projectRoot, '.env'));
    envExists = true;
  } catch {
    envExists = false;
  }

  if (!envExists) return issues;

  // Check if .gitignore covers .env
  let gitignoreContent = '';
  try {
    gitignoreContent = await readFile(join(projectRoot, '.gitignore'), 'utf-8');
  } catch {
    // No .gitignore at all
    issues.push({
      id: 'SEC-009-gitignore',
      category: 'secrets-gitignore',
      severity: 'high',
      message: '.env file exists but no .gitignore found',
      file: '.env',
      line: 1,
      suggestedFix: 'Create .gitignore with .env entry',
    });
    return issues;
  }

  const lines = gitignoreContent.split('\n').map((l) => l.trim());
  const coversEnv = lines.some((l) => l === '.env' || l === '.env*' || l === '*.env');

  if (!coversEnv) {
    issues.push({
      id: 'SEC-009-envgap',
      category: 'secrets-gitignore',
      severity: 'high',
      message: '.env file exists but is not covered by .gitignore',
      file: '.env',
      line: 1,
      suggestedFix: 'Add .env to .gitignore',
    });
  }

  return issues;
}
