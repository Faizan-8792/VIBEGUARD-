/**
 * Polyglot Security Scanner — language-specific vulnerability patterns for Python, Go, and Java.
 * These complement the existing TypeScript/JavaScript patterns in security-scanner.ts.
 */

import { extname } from 'node:path';
import type { Severity } from './security-types.js';

export interface PolyglotSecurityPattern {
  name: string;
  detectorCode: string;
  regex: RegExp;
  category: string;
  severity: Severity;
  message: string;
  suggestedFix?: string;
  languages: string[]; // which file extensions this applies to
}

// ─── Python Security Patterns ───────────────────────────────────────────────

const PYTHON_PATTERNS: PolyglotSecurityPattern[] = [
  {
    name: 'eval() usage',
    detectorCode: 'PY-001',
    regex: /\beval\s*\(/g,
    category: 'code-injection',
    severity: 'critical',
    message: 'Use of eval() allows arbitrary code execution',
    suggestedFix: 'Use ast.literal_eval() for safe evaluation, or avoid eval entirely',
    languages: ['py', 'pyw'],
  },
  {
    name: 'exec() usage',
    detectorCode: 'PY-002',
    regex: /\bexec\s*\(/g,
    category: 'code-injection',
    severity: 'critical',
    message: 'Use of exec() allows arbitrary code execution',
    suggestedFix: 'Avoid exec() — use safer alternatives or restricted execution environments',
    languages: ['py', 'pyw'],
  },
  {
    name: 'subprocess with shell=True',
    detectorCode: 'PY-003',
    regex: /subprocess\.(?:call|run|Popen|check_output|check_call)\s*\([^)]*shell\s*=\s*True/g,
    category: 'command-injection',
    severity: 'high',
    message: 'subprocess with shell=True enables shell injection attacks',
    suggestedFix: 'Use shell=False (default) and pass args as a list',
    languages: ['py', 'pyw'],
  },
  {
    name: 'os.system() usage',
    detectorCode: 'PY-004',
    regex: /\bos\.system\s*\(/g,
    category: 'command-injection',
    severity: 'high',
    message: 'os.system() is vulnerable to shell injection',
    suggestedFix: 'Use subprocess.run() with shell=False instead',
    languages: ['py', 'pyw'],
  },
  {
    name: 'pickle.loads() usage',
    detectorCode: 'PY-005',
    regex: /pickle\.(?:loads?|Unpickler)\s*\(/g,
    category: 'deserialization',
    severity: 'high',
    message: 'Pickle deserialization can execute arbitrary code',
    suggestedFix: 'Use JSON or a safe serialization format. Never unpickle untrusted data.',
    languages: ['py', 'pyw'],
  },
  {
    name: 'yaml.load() without SafeLoader',
    detectorCode: 'PY-006',
    regex: /yaml\.load\s*\([^)]*(?!Loader\s*=\s*(?:yaml\.)?SafeLoader)[^)]*\)/g,
    category: 'deserialization',
    severity: 'high',
    message: 'yaml.load() without SafeLoader can execute arbitrary Python objects',
    suggestedFix: 'Use yaml.safe_load() or yaml.load(data, Loader=yaml.SafeLoader)',
    languages: ['py', 'pyw'],
  },
  {
    name: 'SQL string formatting',
    detectorCode: 'PY-007',
    regex: /(?:execute|cursor\.execute)\s*\(\s*(?:f['"]|['"].*%s|['"].*\.format\()/g,
    category: 'sql-injection',
    severity: 'critical',
    message: 'SQL query built via string formatting — vulnerable to SQL injection',
    suggestedFix: 'Use parameterized queries: cursor.execute("SELECT * WHERE id = %s", (id,))',
    languages: ['py', 'pyw'],
  },
  {
    name: 'Flask debug mode',
    detectorCode: 'PY-008',
    regex: /app\.run\s*\([^)]*debug\s*=\s*True/g,
    category: 'framework-misuse',
    severity: 'medium',
    message: 'Flask running with debug=True exposes debugger in production',
    suggestedFix: 'Use environment variable: app.run(debug=os.getenv("FLASK_DEBUG"))',
    languages: ['py', 'pyw'],
  },
  {
    name: 'Hardcoded secret in Python',
    detectorCode: 'PY-009',
    regex: /(?:SECRET_KEY|PASSWORD|API_KEY|TOKEN)\s*=\s*['"][^'"]{8,}['"]/g,
    category: 'hard-coded-secret',
    severity: 'high',
    message: 'Hard-coded secret/password in Python source',
    suggestedFix: 'Use environment variables: os.environ.get("SECRET_KEY")',
    languages: ['py', 'pyw'],
  },
  {
    name: 'Requests without verify',
    detectorCode: 'PY-010',
    regex: /requests\.(?:get|post|put|delete|patch)\s*\([^)]*verify\s*=\s*False/g,
    category: 'insecure-transport',
    severity: 'medium',
    message: 'SSL verification disabled — vulnerable to MITM attacks',
    suggestedFix: 'Remove verify=False or use a proper CA bundle',
    languages: ['py', 'pyw'],
  },
  {
    name: 'Tempfile without secure creation',
    detectorCode: 'PY-011',
    regex: /\bopen\s*\(\s*['"]\/tmp\//g,
    category: 'insecure-file',
    severity: 'low',
    message: 'Direct /tmp file creation may be vulnerable to symlink attacks',
    suggestedFix: 'Use tempfile.mkstemp() or tempfile.NamedTemporaryFile()',
    languages: ['py', 'pyw'],
  },
  {
    name: 'assert for validation',
    detectorCode: 'PY-012',
    regex: /^assert\s+.*(request|user|input|param|arg)/gm,
    category: 'logic-flaw',
    severity: 'medium',
    message: 'assert used for input validation — disabled with python -O',
    suggestedFix: 'Use explicit if/raise for input validation instead of assert',
    languages: ['py', 'pyw'],
  },
];

// ─── Go Security Patterns ───────────────────────────────────────────────────

const GO_PATTERNS: PolyglotSecurityPattern[] = [
  {
    name: 'SQL string concatenation',
    detectorCode: 'GO-001',
    regex: /(?:db|tx)\.(?:Query|Exec|QueryRow)\s*\(\s*(?:fmt\.Sprintf|"[^"]*"\s*\+)/g,
    category: 'sql-injection',
    severity: 'critical',
    message: 'SQL query built via string concatenation — vulnerable to SQL injection',
    suggestedFix: 'Use parameterized queries: db.Query("SELECT * WHERE id = $1", id)',
    languages: ['go'],
  },
  {
    name: 'exec.Command with user input',
    detectorCode: 'GO-002',
    regex: /exec\.Command\s*\(\s*(?:fmt\.Sprintf|[^")\s]+\s*\+)/g,
    category: 'command-injection',
    severity: 'high',
    message: 'exec.Command with dynamic string — potential command injection',
    suggestedFix: 'Pass arguments as separate parameters, never interpolate user input into command strings',
    languages: ['go'],
  },
  {
    name: 'TLS InsecureSkipVerify',
    detectorCode: 'GO-003',
    regex: /InsecureSkipVerify\s*:\s*true/g,
    category: 'insecure-transport',
    severity: 'high',
    message: 'TLS certificate verification disabled — MITM vulnerability',
    suggestedFix: 'Remove InsecureSkipVerify or set to false in production',
    languages: ['go'],
  },
  {
    name: 'Unsafe pointer usage',
    detectorCode: 'GO-004',
    regex: /unsafe\.Pointer/g,
    category: 'memory-safety',
    severity: 'medium',
    message: 'Unsafe pointer usage bypasses Go memory safety',
    suggestedFix: 'Avoid unsafe.Pointer unless absolutely necessary for FFI/performance',
    languages: ['go'],
  },
  {
    name: 'Hardcoded credentials',
    detectorCode: 'GO-005',
    regex: /(?:password|secret|apiKey|token)\s*[:=]\s*"[^"]{8,}"/g,
    category: 'hard-coded-secret',
    severity: 'high',
    message: 'Hard-coded credential in Go source',
    suggestedFix: 'Use environment variables: os.Getenv("SECRET")',
    languages: ['go'],
  },
  {
    name: 'Weak crypto (MD5/SHA1)',
    detectorCode: 'GO-006',
    regex: /(?:md5|sha1)\.(?:New|Sum)/g,
    category: 'weak-crypto',
    severity: 'medium',
    message: 'MD5/SHA1 is cryptographically broken — not suitable for security',
    suggestedFix: 'Use sha256.New() or stronger hash functions',
    languages: ['go'],
  },
  {
    name: 'Unvalidated redirect',
    detectorCode: 'GO-007',
    regex: /http\.Redirect\s*\(\s*\w+\s*,\s*\w+\s*,\s*(?:r\.(?:URL|Form)|req)/g,
    category: 'open-redirect',
    severity: 'medium',
    message: 'Redirect using user-controlled input — open redirect vulnerability',
    suggestedFix: 'Validate redirect URL against allowlist before redirecting',
    languages: ['go'],
  },
  {
    name: 'CORS wildcard in Go',
    detectorCode: 'GO-008',
    regex: /(?:Access-Control-Allow-Origin|AllowOrigins).*['"]\*['"]/g,
    category: 'framework-misuse',
    severity: 'medium',
    message: 'CORS configured with wildcard origin',
    suggestedFix: 'Restrict allowed origins to specific domains',
    languages: ['go'],
  },
];

// ─── Java Security Patterns ─────────────────────────────────────────────────

const JAVA_PATTERNS: PolyglotSecurityPattern[] = [
  {
    name: 'SQL string concatenation',
    detectorCode: 'JAVA-001',
    regex: /(?:createStatement|executeQuery|executeUpdate|execute)\s*\(\s*(?:"[^"]*"\s*\+|String\.format)/g,
    category: 'sql-injection',
    severity: 'critical',
    message: 'SQL query built via string concatenation — vulnerable to SQL injection',
    suggestedFix: 'Use PreparedStatement with parameterized queries',
    languages: ['java'],
  },
  {
    name: 'ObjectInputStream deserialization',
    detectorCode: 'JAVA-002',
    regex: /new\s+ObjectInputStream\s*\(/g,
    category: 'deserialization',
    severity: 'critical',
    message: 'Java deserialization can lead to remote code execution',
    suggestedFix: 'Use a safe serialization format (JSON/Protocol Buffers) or implement ObjectInputFilter',
    languages: ['java'],
  },
  {
    name: 'Runtime.exec() usage',
    detectorCode: 'JAVA-003',
    regex: /Runtime\.getRuntime\(\)\.exec\s*\(/g,
    category: 'command-injection',
    severity: 'high',
    message: 'Runtime.exec() with dynamic input enables command injection',
    suggestedFix: 'Use ProcessBuilder with explicit argument list, never concatenate user input',
    languages: ['java'],
  },
  {
    name: 'ProcessBuilder with shell',
    detectorCode: 'JAVA-004',
    regex: /new\s+ProcessBuilder\s*\(\s*(?:Arrays\.asList\s*\()?(?:"(?:sh|bash|cmd)"|"\/bin\/)/g,
    category: 'command-injection',
    severity: 'high',
    message: 'ProcessBuilder launching a shell — potential command injection',
    suggestedFix: 'Pass commands as separate arguments without invoking a shell',
    languages: ['java'],
  },
  {
    name: 'Weak encryption (DES/RC4)',
    detectorCode: 'JAVA-005',
    regex: /Cipher\.getInstance\s*\(\s*"(?:DES|RC4|RC2|Blowfish|DESede)"/g,
    category: 'weak-crypto',
    severity: 'high',
    message: 'Weak encryption algorithm — cryptographically broken',
    suggestedFix: 'Use AES-256-GCM: Cipher.getInstance("AES/GCM/NoPadding")',
    languages: ['java'],
  },
  {
    name: 'ECB mode encryption',
    detectorCode: 'JAVA-006',
    regex: /Cipher\.getInstance\s*\(\s*"AES\/ECB/g,
    category: 'weak-crypto',
    severity: 'high',
    message: 'ECB mode does not provide semantic security',
    suggestedFix: 'Use AES/GCM/NoPadding or AES/CBC/PKCS5Padding with random IV',
    languages: ['java'],
  },
  {
    name: 'XXE vulnerability',
    detectorCode: 'JAVA-007',
    regex: /DocumentBuilderFactory\.newInstance\(\)/g,
    category: 'xxe',
    severity: 'high',
    message: 'XML parser may be vulnerable to XXE attacks without proper configuration',
    suggestedFix: 'Disable external entities: factory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true)',
    languages: ['java'],
  },
  {
    name: 'Hardcoded credentials',
    detectorCode: 'JAVA-008',
    regex: /(?:password|secret|apiKey|token)\s*=\s*"[^"]{8,}"/g,
    category: 'hard-coded-secret',
    severity: 'high',
    message: 'Hard-coded credential in Java source',
    suggestedFix: 'Use environment variables or a secrets manager',
    languages: ['java'],
  },
  {
    name: 'LDAP injection',
    detectorCode: 'JAVA-009',
    regex: /(?:search|lookup)\s*\(\s*(?:"[^"]*"\s*\+|String\.format)/g,
    category: 'injection',
    severity: 'high',
    message: 'LDAP query with string concatenation — injection vulnerability',
    suggestedFix: 'Sanitize LDAP special characters or use parameterized LDAP queries',
    languages: ['java'],
  },
  {
    name: 'Path traversal',
    detectorCode: 'JAVA-010',
    regex: /new\s+File\s*\(\s*(?:request\.getParameter|req\.getParam)/g,
    category: 'path-traversal',
    severity: 'high',
    message: 'File path constructed from user input — path traversal vulnerability',
    suggestedFix: 'Validate and canonicalize paths, use allowlist of permitted directories',
    languages: ['java'],
  },
  {
    name: 'Insecure random',
    detectorCode: 'JAVA-011',
    regex: /new\s+Random\s*\(\)/g,
    category: 'weak-crypto',
    severity: 'medium',
    message: 'java.util.Random is not cryptographically secure',
    suggestedFix: 'Use SecureRandom for security-sensitive operations',
    languages: ['java'],
  },
  {
    name: 'Trust all certificates',
    detectorCode: 'JAVA-012',
    regex: /TrustAllCerts|X509TrustManager\s*\(\s*\)\s*\{[^}]*return/g,
    category: 'insecure-transport',
    severity: 'high',
    message: 'Custom TrustManager that trusts all certificates — MITM vulnerability',
    suggestedFix: 'Use the default TrustManager or a properly configured trust store',
    languages: ['java'],
  },
];

// ─── Combined Export ────────────────────────────────────────────────────────

export const ALL_POLYGLOT_PATTERNS: PolyglotSecurityPattern[] = [
  ...PYTHON_PATTERNS,
  ...GO_PATTERNS,
  ...JAVA_PATTERNS,
];

/**
 * Get security patterns applicable to a specific file extension.
 */
export function getPatternsForFile(filePath: string): PolyglotSecurityPattern[] {
  const ext = extname(filePath).slice(1).toLowerCase();
  return ALL_POLYGLOT_PATTERNS.filter(p => p.languages.includes(ext));
}
