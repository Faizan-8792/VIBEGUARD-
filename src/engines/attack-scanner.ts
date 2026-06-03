import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { hashString } from '../utils/hash-utils.js';
import type { ResolvedConfig } from '../storage/config-store.js';

export type AttackSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface AttackFinding {
  id: string;
  category: string;
  attackType: string;
  severity: AttackSeverity;
  message: string;
  file: string;
  line: number;
  snippet?: string;
  recommendation: string;
}

export interface AttackScanResult {
  findings: AttackFinding[];
  counts: Record<AttackSeverity, number>;
  coverage: string[];
}

interface AttackDetector {
  attackType: string;
  detectorCode: string;
  category: string;
  severity: AttackSeverity;
  regex: RegExp;
  message: string;
  recommendation: string;
  /** Optional: a regex that, if also present in the file, suppresses the finding (mitigation present). */
  mitigatedBy?: RegExp;
}

const DETECTORS: AttackDetector[] = [
  // ─── DDoS / Rate Limiting ──────────────────────────────────────────────
  {
    attackType: 'DDoS / Resource Exhaustion',
    detectorCode: '101',
    category: 'availability',
    severity: 'high',
    regex: /\b(?:app|router|server)\.(?:get|post|put|delete|use|all)\s*\(/,
    mitigatedBy: /rate[\s-]?limit|express-rate-limit|rateLimit|slowDown|throttle/i,
    message: 'HTTP route handlers without rate limiting — vulnerable to DDoS/flooding',
    recommendation: 'Add rate limiting middleware (e.g. express-rate-limit) to throttle requests per IP',
  },
  // ─── Brute Force / OTP / Login ─────────────────────────────────────────
  {
    attackType: 'Brute Force / Credential Stuffing',
    detectorCode: '102',
    category: 'authentication',
    severity: 'high',
    regex: /\b(?:login|signin|authenticate|verifyOtp|verify_otp|checkPassword|comparePassword)\b/i,
    mitigatedBy: /rate[\s-]?limit|attempts|lockout|maxAttempts|backoff|captcha/i,
    message: 'Authentication endpoint without brute-force protection (no attempt limiting/lockout)',
    recommendation: 'Add login attempt limiting, account lockout, exponential backoff, or CAPTCHA',
  },
  {
    attackType: 'OTP Abuse / Flooding',
    detectorCode: '103',
    category: 'authentication',
    severity: 'high',
    regex: /\b(?:sendOtp|send_otp|sendOTP|generateOtp|sendVerificationCode|sendSms|sendSMS)\b/,
    mitigatedBy: /rate[\s-]?limit|cooldown|resend.*(?:delay|interval|timeout)|attempts/i,
    message: 'OTP/verification-code sender without rate limiting — vulnerable to OTP flooding/SMS bombing',
    recommendation: 'Add per-user/per-phone cooldown and daily send limits for OTP generation',
  },
  // ─── SQL Injection ─────────────────────────────────────────────────────
  {
    attackType: 'SQL Injection',
    detectorCode: '104',
    category: 'injection',
    severity: 'critical',
    regex: /(?:query|execute|raw)\s*\(\s*[`'"][^`'"]*(?:SELECT|INSERT|UPDATE|DELETE|DROP)[^`'"]*\$\{/i,
    message: 'SQL query built with string interpolation — SQL injection risk',
    recommendation: 'Use parameterized queries / prepared statements instead of string interpolation',
  },
  {
    attackType: 'SQL Injection',
    detectorCode: '105',
    category: 'injection',
    severity: 'critical',
    regex: /(?:query|execute)\s*\(\s*[`'"][^`'"]*(?:SELECT|INSERT|UPDATE|DELETE)[^`'"]*[`'"]\s*\+/i,
    message: 'SQL query concatenated with user input — SQL injection risk',
    recommendation: 'Use parameterized queries with placeholders ($1, ?) and bound values',
  },
  // ─── NoSQL Injection ───────────────────────────────────────────────────
  {
    attackType: 'NoSQL Injection',
    detectorCode: '106',
    category: 'injection',
    severity: 'high',
    regex: /\.(?:find|findOne|updateOne|deleteOne)\s*\(\s*\{\s*\$where/,
    message: 'MongoDB $where operator with potential user input — NoSQL injection risk',
    recommendation: 'Avoid $where with user input; use typed query operators and validate input',
  },
  // ─── XSS ───────────────────────────────────────────────────────────────
  {
    attackType: 'Cross-Site Scripting (XSS)',
    detectorCode: '107',
    category: 'injection',
    severity: 'high',
    regex: /\.innerHTML\s*=|dangerouslySetInnerHTML|document\.write\s*\(/,
    mitigatedBy: /DOMPurify|sanitize|escapeHtml|xss\(/i,
    message: 'Direct HTML injection without sanitization — XSS risk',
    recommendation: 'Sanitize with DOMPurify or use safe text APIs (textContent) instead of innerHTML',
  },
  // ─── Command Injection ─────────────────────────────────────────────────
  {
    attackType: 'Command Injection',
    detectorCode: '108',
    category: 'injection',
    severity: 'critical',
    regex: /\b(?:exec|execSync|spawn|spawnSync)\s*\(\s*[`'"][^`'"]*\$\{/,
    message: 'Shell command built with interpolated input — command injection risk',
    recommendation: 'Use execFile with an args array, never interpolate user input into shell strings',
  },
  // ─── Path Traversal ────────────────────────────────────────────────────
  {
    attackType: 'Path Traversal',
    detectorCode: '109',
    category: 'access-control',
    severity: 'high',
    regex: /(?:readFile|readFileSync|createReadStream|sendFile)\s*\([^)]*(?:req\.(?:params|query|body)|request\.)/,
    mitigatedBy: /path\.normalize|path\.resolve.*startsWith|sanitizePath/i,
    message: 'File path derived from user input without normalization — path traversal risk',
    recommendation: 'Normalize and validate paths; ensure resolved path stays within an allowed directory',
  },
  // ─── SSRF ──────────────────────────────────────────────────────────────
  {
    attackType: 'Server-Side Request Forgery (SSRF)',
    detectorCode: '110',
    category: 'access-control',
    severity: 'high',
    regex: /(?:fetch|axios\.(?:get|post)|http\.get|request)\s*\(\s*(?:req\.(?:params|query|body)|request\.)/,
    mitigatedBy: /allowlist|allowList|whitelist|isAllowedUrl|validateUrl/i,
    message: 'Outbound request to a user-controlled URL — SSRF risk',
    recommendation: 'Validate target URLs against an allowlist; block internal/metadata IP ranges',
  },
  // ─── CSRF ──────────────────────────────────────────────────────────────
  {
    attackType: 'Cross-Site Request Forgery (CSRF)',
    detectorCode: '111',
    category: 'authentication',
    severity: 'medium',
    regex: /\b(?:app|router)\.(?:post|put|delete)\s*\(/,
    mitigatedBy: /csrf|csurf|sameSite|x-csrf-token|csrfToken/i,
    message: 'State-changing routes without visible CSRF protection',
    recommendation: 'Use CSRF tokens or SameSite=strict cookies for state-changing requests',
  },
  // ─── Weak Crypto ───────────────────────────────────────────────────────
  {
    attackType: 'Weak Cryptography',
    detectorCode: '112',
    category: 'cryptography',
    severity: 'high',
    regex: /createHash\s*\(\s*['"](?:md5|sha1)['"]\)|crypto\.createCipher\s*\(/,
    message: 'Weak/broken hashing or deprecated cipher (MD5/SHA1/createCipher)',
    recommendation: 'Use SHA-256+ for hashing and createCipheriv with a random IV for encryption',
  },
  {
    attackType: 'Weak Password Hashing',
    detectorCode: '113',
    category: 'cryptography',
    severity: 'high',
    regex: /password.*createHash|createHash.*password/i,
    mitigatedBy: /bcrypt|argon2|scrypt|pbkdf2/i,
    message: 'Password hashed with a fast hash instead of a password-hashing function',
    recommendation: 'Use bcrypt, argon2, or scrypt for password hashing',
  },
  // ─── Insecure Randomness ───────────────────────────────────────────────
  {
    attackType: 'Insecure Randomness',
    detectorCode: '114',
    category: 'cryptography',
    severity: 'medium',
    regex: /Math\.random\s*\(\s*\)/,
    mitigatedBy: /crypto\.(?:randomBytes|randomUUID|randomInt)/,
    message: 'Math.random() used — not cryptographically secure for tokens/secrets',
    recommendation: 'Use crypto.randomBytes / crypto.randomUUID for security-sensitive randomness',
  },
  // ─── Open Redirect ─────────────────────────────────────────────────────
  {
    attackType: 'Open Redirect',
    detectorCode: '115',
    category: 'access-control',
    severity: 'medium',
    regex: /res\.redirect\s*\(\s*(?:req\.(?:query|params|body)|request\.)/,
    message: 'Redirect target taken directly from user input — open redirect risk',
    recommendation: 'Validate redirect targets against an allowlist of internal paths',
  },
  // ─── Missing Security Headers ──────────────────────────────────────────
  {
    attackType: 'Missing Security Headers',
    detectorCode: '116',
    category: 'hardening',
    severity: 'low',
    regex: /express\s*\(\s*\)|createServer\s*\(/,
    mitigatedBy: /helmet|Content-Security-Policy|X-Frame-Options|hsts/i,
    message: 'Server without security headers middleware (helmet/CSP)',
    recommendation: 'Add helmet() middleware to set CSP, HSTS, X-Frame-Options and other headers',
  },
  // ─── Prototype Pollution ───────────────────────────────────────────────
  {
    attackType: 'Prototype Pollution',
    detectorCode: '117',
    category: 'injection',
    severity: 'medium',
    regex: /(?:Object\.assign|_\.merge|deepMerge|extend)\s*\([^)]*(?:req\.body|JSON\.parse)/,
    message: 'Deep merge/assign of untrusted object — prototype pollution risk',
    recommendation: 'Reject __proto__/constructor keys or use a pollution-safe merge utility',
  },
  // ─── Eval / Dynamic Code ───────────────────────────────────────────────
  {
    attackType: 'Arbitrary Code Execution',
    detectorCode: '118',
    category: 'injection',
    severity: 'critical',
    regex: /\beval\s*\(|new\s+Function\s*\(/,
    message: 'Dynamic code execution (eval / new Function) — RCE risk if input is untrusted',
    recommendation: 'Avoid eval/new Function; use safe parsers (JSON.parse) or explicit logic',
  },
  // ─── Mass Assignment ───────────────────────────────────────────────────
  {
    attackType: 'Mass Assignment',
    detectorCode: '119',
    category: 'access-control',
    severity: 'medium',
    regex: /\b(?:create|update|save)\s*\(\s*req\.body\s*\)/,
    message: 'Model created/updated directly from req.body — mass assignment risk',
    recommendation: 'Whitelist allowed fields explicitly instead of passing req.body directly',
  },
  // ─── XML External Entity (XXE) ─────────────────────────────────────────
  {
    attackType: 'XML External Entity (XXE)',
    detectorCode: '120',
    category: 'injection',
    severity: 'high',
    regex: /noent\s*:\s*true|resolveExternalEntities\s*\(\s*true\s*\)|external-general-entities[^)\n]*true/i,
    message: 'XML parser set to expand external entities — XXE / file disclosure / SSRF risk',
    recommendation: 'Disable entity expansion (noent:false) and external DTD loading in the XML parser',
  },
  // ─── Insecure Deserialization ──────────────────────────────────────────
  {
    attackType: 'Insecure Deserialization',
    detectorCode: '121',
    category: 'injection',
    severity: 'critical',
    regex: /\bunserialize\s*\(|node-serialize|\byaml\.load\s*\(|\bvm\.runIn(?:New)?Context\s*\(/,
    mitigatedBy: /yaml\.safeLoad|DEFAULT_SAFE_SCHEMA|FAILSAFE_SCHEMA|JSON_SCHEMA/,
    message: 'Untrusted data deserialized with an unsafe loader — remote code execution risk',
    recommendation: 'Use safe parsers (JSON.parse, yaml.load with a safe schema); never deserialize untrusted input',
  },
  // ─── JWT Misuse ────────────────────────────────────────────────────────
  {
    attackType: 'JWT Algorithm Confusion',
    detectorCode: '122',
    category: 'authentication',
    severity: 'critical',
    regex: /algorithms?\s*:\s*\[?[^\]\n]*['"]none['"]/i,
    message: "JWT verification allows the 'none' algorithm — signatures can be bypassed",
    recommendation: "Pin an explicit allow-list of strong algorithms (e.g. ['RS256']); never permit 'none'",
  },
  {
    attackType: 'JWT Signature Not Verified',
    detectorCode: '123',
    category: 'authentication',
    severity: 'high',
    regex: /\bjwt\.decode\s*\(/,
    mitigatedBy: /jwt\.verify\s*\(/,
    message: 'jwt.decode() used without jwt.verify() — token signature is never validated',
    recommendation: 'Validate the signature with jwt.verify() and the secret/public key before trusting claims',
  },
  // ─── Server-Side Template Injection (SSTI) ─────────────────────────────
  {
    attackType: 'Server-Side Template Injection (SSTI)',
    detectorCode: '124',
    category: 'injection',
    severity: 'high',
    regex: /(?:handlebars|Handlebars|ejs|pug|nunjucks|_\.template)\s*\.?\s*(?:compile|render(?:String)?)?\s*\([^)]*(?:req\.(?:body|query|params)|request\.)/,
    message: 'User input compiled into a server-side template — template injection / RCE risk',
    recommendation: 'Never build templates from user input; pass user data as bound template variables only',
  },
  // ─── Insecure Cookies ──────────────────────────────────────────────────
  {
    attackType: 'Insecure Cookie Flags',
    detectorCode: '125',
    category: 'hardening',
    severity: 'medium',
    regex: /res\.cookie\s*\(/,
    mitigatedBy: /httpOnly\s*:\s*true[\s\S]*?secure\s*:\s*true|secure\s*:\s*true[\s\S]*?httpOnly\s*:\s*true/,
    message: 'Cookie set without both HttpOnly and Secure flags — session theft / XSS exposure',
    recommendation: 'Set { httpOnly: true, secure: true, sameSite: "strict" } on session cookies',
  },
  // ─── Hardcoded Session Secret ──────────────────────────────────────────
  {
    attackType: 'Hardcoded Session Secret',
    detectorCode: '126',
    category: 'cryptography',
    severity: 'high',
    regex: /session\s*\(\s*\{[^}]*secret\s*:\s*['"][^'"]+['"]/,
    mitigatedBy: /secret\s*:\s*process\.env/,
    message: 'Session/signing secret hard-coded in source — predictable and leakable',
    recommendation: 'Load the session secret from an environment variable, not source code',
  },
  // ─── HTTP Response Splitting (CRLF) ────────────────────────────────────
  {
    attackType: 'HTTP Response Splitting (CRLF Injection)',
    detectorCode: '127',
    category: 'injection',
    severity: 'medium',
    regex: /(?:setHeader|writeHead|res\.header|res\.set)\s*\([^)]*(?:req\.(?:query|params|body|headers)|request\.)/,
    message: 'Response header value derived from user input — CRLF / header injection risk',
    recommendation: 'Strip CR/LF from user-controlled header values, or keep user input out of headers',
  },
  // ─── Sensitive Data in Logs ────────────────────────────────────────────
  {
    attackType: 'Sensitive Data Exposure (Logging)',
    detectorCode: '128',
    category: 'information-disclosure',
    severity: 'low',
    regex: /console\.(?:log|info|debug|warn|error)\s*\([^)]*\b(?:password|passwd|secret|api[_-]?key|token|creditCard|ssn)\b/i,
    message: 'Secret/credential value written to logs — sensitive data exposure',
    recommendation: 'Redact secrets before logging; never log passwords, tokens, or keys',
  },
  // ─── Disabled TLS Verification ─────────────────────────────────────────
  {
    attackType: 'Disabled TLS Certificate Validation',
    detectorCode: '129',
    category: 'cryptography',
    severity: 'high',
    regex: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*[:=]\s*['"]?0/,
    message: 'TLS certificate validation disabled — man-in-the-middle risk',
    recommendation: 'Never disable certificate validation; trust the proper CA certificate instead',
  },
  // ─── Insecure File Upload ──────────────────────────────────────────────
  {
    attackType: 'Unrestricted File Upload',
    detectorCode: '130',
    category: 'access-control',
    severity: 'medium',
    regex: /\bmulter\s*\(/,
    mitigatedBy: /limits\s*:|fileFilter\s*:/,
    message: 'File upload handler without size limits or type filtering — DoS / malicious upload risk',
    recommendation: 'Configure multer with limits (fileSize) and a fileFilter allow-list of MIME types',
  },
  // ─── Timing-Unsafe Secret Comparison ───────────────────────────────────
  {
    attackType: 'Timing-Unsafe Secret Comparison',
    detectorCode: '131',
    category: 'cryptography',
    severity: 'medium',
    regex: /\b(?:token|secret|signature|hmac|apiKey|api_key|authToken|sessionId)\b\s*(?:===|!==)\s*req\.|req\.[^\s=!]*\s*(?:===|!==)\s*\b(?:token|secret|signature|hmac|apiKey|api_key|authToken|sessionId)\b/i,
    mitigatedBy: /timingSafeEqual/,
    message: 'Secret/token compared with ===/!== against user input — timing-attack risk',
    recommendation: 'Use crypto.timingSafeEqual() for constant-time comparison of secrets and tokens',
  },
  // ─── Stack Trace / Error Disclosure ────────────────────────────────────
  {
    attackType: 'Information Disclosure (Stack Trace)',
    detectorCode: '132',
    category: 'information-disclosure',
    severity: 'low',
    regex: /res\.(?:send|json|write)\s*\([^)]*(?:err|error|e)\.stack|stack\s*:\s*(?:err|error|e)\.stack/,
    message: 'Error stack trace returned in an HTTP response — leaks internal implementation details',
    recommendation: 'Return a generic error message to clients; log stack traces server-side only',
  },
  // ─── LDAP Injection ────────────────────────────────────────────────────
  {
    attackType: 'LDAP Injection',
    detectorCode: '133',
    category: 'injection',
    severity: 'high',
    regex: /(?:search|bind|findOne)\s*\(\s*[`'"][^`'"]*(?:\(|cn=|uid=|ou=)[^`'"]*(?:\$\{|['"]\s*\+)/i,
    message: 'LDAP filter built from interpolated/concatenated input — LDAP injection risk',
    recommendation: 'Escape LDAP special chars (RFC 4515) or use a parameterized LDAP query builder',
  },
  // ─── ReDoS — user input compiled into a RegExp ─────────────────────────
  {
    attackType: 'Regular Expression DoS (ReDoS)',
    detectorCode: '134',
    category: 'availability',
    severity: 'medium',
    regex: /new\s+RegExp\s*\(\s*(?:req\.(?:body|query|params)|request\.|[^)]*\binput\b)/,
    message: 'RegExp constructed from user input — a malicious pattern can hang the event loop (ReDoS)',
    recommendation: 'Never build regexes from user input; validate against a fixed pattern or use a safe matcher with a timeout',
  },
  // ─── CORS reflecting the request origin ────────────────────────────────
  {
    attackType: 'CORS Origin Reflection',
    detectorCode: '135',
    category: 'access-control',
    severity: 'high',
    regex: /Access-Control-Allow-Origin['"]?\s*[,:]\s*(?:req\.headers\.origin|request\.headers\.origin|origin)\b/i,
    mitigatedBy: /allowlist|allowedOrigins|whitelist|includes\(\s*origin/i,
    message: 'CORS echoes the request Origin back without an allowlist — defeats the same-origin policy',
    recommendation: 'Validate Origin against an explicit allowlist before reflecting it',
  },
  // ─── postMessage to wildcard target ────────────────────────────────────
  {
    attackType: 'Insecure postMessage Target',
    detectorCode: '136',
    category: 'access-control',
    severity: 'medium',
    regex: /\.postMessage\s*\([^,]+,\s*['"]\*['"]\s*\)/,
    message: "window.postMessage called with target origin '*' — any window can read the message",
    recommendation: 'Specify an explicit target origin instead of "*" in postMessage',
  },
  // ─── Server bound to all interfaces ────────────────────────────────────
  {
    attackType: 'Service Bound to All Interfaces',
    detectorCode: '137',
    category: 'hardening',
    severity: 'low',
    regex: /\.listen\s*\([^)]*['"]0\.0\.0\.0['"]/,
    message: 'Service explicitly bound to 0.0.0.0 — reachable on every network interface',
    recommendation: 'Bind to 127.0.0.1 (or a specific interface) unless external exposure is intended',
  },
];

const COVERAGE = [
  'DDoS / Resource Exhaustion',
  'Brute Force / Credential Stuffing',
  'OTP Abuse / SMS Bombing',
  'SQL Injection',
  'NoSQL Injection',
  'Cross-Site Scripting (XSS)',
  'Command Injection',
  'Path Traversal',
  'Server-Side Request Forgery (SSRF)',
  'Cross-Site Request Forgery (CSRF)',
  'Weak Cryptography',
  'Weak Password Hashing',
  'Insecure Randomness',
  'Open Redirect',
  'Missing Security Headers',
  'Prototype Pollution',
  'Arbitrary Code Execution (eval)',
  'Mass Assignment',
  'XML External Entity (XXE)',
  'Insecure Deserialization',
  'JWT Algorithm Confusion / Unverified Signature',
  'Server-Side Template Injection (SSTI)',
  'Insecure Cookie Flags',
  'Hardcoded Session Secret',
  'HTTP Response Splitting (CRLF Injection)',
  'Sensitive Data Exposure (Logging)',
  'Disabled TLS Certificate Validation',
  'Unrestricted File Upload',
  'Timing-Unsafe Secret Comparison',
  'Information Disclosure (Stack Trace)',
  'LDAP Injection',
  'Regular Expression DoS (ReDoS)',
  'CORS Origin Reflection',
  'Insecure postMessage Target',
  'Service Bound to All Interfaces',
];

/** File extensions the attack scanner inspects. Docs/markdown/text are excluded
 * so prose and example snippets in README/ROADMAP never produce findings. */
const SCANNABLE_EXT = new Set([
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts',
  'py', 'pyw', 'go', 'java', 'rb', 'php',
]);

function isScannableFile(file: string): boolean {
  const ext = file.split('.').pop()?.toLowerCase() ?? '';
  return SCANNABLE_EXT.has(ext);
}

/**
 * Defense-in-depth: skip vendored / generated files even if a caller passes
 * them in. The default ignore globs already exclude these, but the engine is
 * invoked directly from the MCP server and tests too.
 */
function isVendoredOrGenerated(file: string): boolean {
  const f = file.replace(/\\/g, '/');
  return (
    /(?:^|\/)node_modules\//.test(f) ||
    /(?:^|\/)(?:dist|build|out|coverage|vendor|third[_-]?party)\//.test(f) ||
    /\.min\.(?:js|css)$/.test(f) ||
    /\.bundle\.js$/.test(f) ||
    /\.map$/.test(f)
  );
}

/**
 * True for minified / generated single-line bundles: very long lines with
 * almost no whitespace. These pack patterns that masquerade as vulnerabilities
 * (e.g. `eval(` inside a bundle), so they're skipped line-by-line.
 */
function isLikelyMinifiedLine(line: string): boolean {
  if (line.length < 400) return false;
  const whitespace = (line.match(/\s/g) ?? []).length;
  return whitespace / line.length < 0.02;
}

/**
 * True when a line is a comment or a security-rule *definition* rather than real
 * executable code. This stops the scanner from flagging its own detector source
 * (regex/message/recommendation literals) and code comments as vulnerabilities.
 */
function isNonExecutableLine(line: string): boolean {
  const t = line.trim();
  if (t.length === 0) return true;
  // Comment lines (JS/TS, Python/Ruby/shell, block-comment continuations).
  if (t.startsWith('//') || t.startsWith('#') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('<!--')) {
    return true;
  }
  // Security-rule metadata lines (the scanners' own pattern/message tables).
  if (/^(?:regex|pattern|message|recommendation|suggestedFix|name|detectorCode|attackType|category|severity|mitigatedBy)\s*:/.test(t)) {
    return true;
  }
  return false;
}

export async function scanAttacks(
  projectRoot: string,
  files: string[],
  _config: ResolvedConfig,
): Promise<AttackScanResult> {
  const findings: AttackFinding[] = [];

  for (const file of files) {
    if (file.match(/\.(test|spec)\./)) continue;
    // Only scan real code files — never docs, markdown, or plain text.
    if (!isScannableFile(file)) continue;
    // Defense-in-depth: skip vendored / generated / minified files.
    if (isVendoredOrGenerated(file)) continue;

    let content: string;
    try {
      content = await readFile(resolve(projectRoot, file), 'utf-8');
    } catch {
      continue;
    }

    const lines = content.split('\n');

    for (const detector of DETECTORS) {
      // If a mitigation pattern is present anywhere in the file, skip this detector for the file
      if (detector.mitigatedBy && detector.mitigatedBy.test(content)) {
        continue;
      }

      const regex = new RegExp(detector.regex.source, detector.regex.flags.includes('g') ? detector.regex.flags : detector.regex.flags + 'g');
      let match: RegExpExecArray | null;
      let perFileCount = 0;

      while ((match = regex.exec(content)) !== null) {
        const lineNumber = content.substring(0, match.index).split('\n').length;
        const lineContent = lines[lineNumber - 1] ?? '';

        // Skip matches on comment lines and rule-definition/metadata lines.
        if (isNonExecutableLine(lineContent) || isLikelyMinifiedLine(lineContent)) {
          if (!regex.global) break;
          continue;
        }

        const contentHash = hashString(`${file}:${detector.detectorCode}:${lineNumber}`).substring(0, 8);

        findings.push({
          id: `ATK-${detector.detectorCode}-${contentHash}`,
          category: detector.category,
          attackType: detector.attackType,
          severity: detector.severity,
          message: detector.message,
          file,
          line: lineNumber,
          snippet: lineContent.trim().substring(0, 120),
          recommendation: detector.recommendation,
        });

        perFileCount++;
        if (perFileCount >= 5) break; // Cap findings per detector per file to reduce noise
        if (!regex.global) break;
      }
    }
  }

  const counts: Record<AttackSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;

  return { findings, counts, coverage: COVERAGE };
}
