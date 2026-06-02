import { readFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { hashString } from '../utils/hash-utils.js';
import { getPatternsForFile } from './polyglot-security.js';
import type { ResolvedConfig } from '../storage/config-store.js';
import type { Severity } from './security-types.js';

export type { Severity } from './security-types.js';

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
}

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

  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const issue of issues) {
    counts[issue.severity]++;
  }

  return { issues, counts };
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
