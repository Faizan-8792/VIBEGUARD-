/**
 * Shared security value-validation helpers.
 *
 * Lives in its own module (like security-types.ts) so both the core scanner
 * (security-scanner.ts) and the polyglot ruleset (polyglot-security.ts) can use
 * the same false-positive guards without importing each other — which would
 * create a dependency cycle.
 *
 * These helpers are the accuracy layer: they separate real, committed secrets
 * and genuine vulnerable code from placeholders, docs, low-entropy data, and
 * generated/minified noise that would otherwise drown a large project's scan
 * in false positives.
 */

/** Shannon entropy in bits/char — random secrets score high, words/IDs low. */
export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of value) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** Count distinct character classes present: lowercase, uppercase, digit, symbol. */
export function charClassCount(value: string): number {
  let classes = 0;
  if (/[a-z]/.test(value)) classes++;
  if (/[A-Z]/.test(value)) classes++;
  if (/[0-9]/.test(value)) classes++;
  if (/[^A-Za-z0-9]/.test(value)) classes++;
  return classes;
}

/**
 * Extract the inner string literal from a matched assignment/value. Detector
 * regexes often capture the whole `KEY = "value"` expression; the entropy check
 * must run on the assigned value, not the variable name. Falls back to the raw
 * input (quotes stripped) when there is no quoted literal.
 */
export function extractSecretLiteral(rawValue: string): string {
  const quoted = rawValue.match(/['"`]([^'"`]{4,})['"`]/);
  if (quoted?.[1]) return quoted[1];
  return rawValue.replace(/^['"`]|['"`]$/g, '').trim();
}

/**
 * True when a value is an obvious placeholder rather than a real secret:
 * repeated chars ("XXXXXXXX"), env-var references, angle-bracket templates,
 * or words like example/placeholder/your_key/changeme. Runs on the inner
 * literal so variable names don't mask a placeholder value.
 */
export function looksLikePlaceholder(rawValue: string): boolean {
  const value = extractSecretLiteral(rawValue);
  if (value.length === 0) return true;
  if (/^(.)\1{6,}$/.test(value)) return true; // "aaaaaaaa", "00000000"
  if (/^\$\{[^}]+\}$/.test(value)) return true; // ${ENV_VAR}
  if (/^<[^>]+>$/.test(value)) return true; // <your-key-here>
  if (/^process\.env\./.test(value)) return true;
  if (/^os\.(?:environ|getenv)/.test(value)) return true;
  if (/^(?:System\.getenv|os\.Getenv)/.test(value)) return true;
  if (/\b(?:placeholder|example|changeme|change[_-]?this|your[_-]?(?:api|key|token|secret|password|name)|my[_-]?(?:secret|password|key)|dummy|sample|redacted|insert[_-]?your|xxxx+|todo|test[_-]?(?:key|secret|token)|foo|bar|baz|lorem)\b/i.test(value)) {
    return true;
  }
  return false;
}

/**
 * True when a value has the statistical shape of a real secret: not a
 * placeholder, sufficiently high entropy, and a mix of character classes.
 * Random API keys/tokens clear this easily; dictionary words, sequential IDs,
 * and short low-diversity strings do not.
 */
export function hasHighSecretEntropy(rawValue: string, minEntropy = 3.5): boolean {
  if (looksLikePlaceholder(rawValue)) return false;
  const literal = extractSecretLiteral(rawValue);
  if (literal.length < 8) return false;
  if (charClassCount(literal) < 2) return false;
  return shannonEntropy(literal) >= minEntropy;
}

/**
 * True for minified / generated / single-line-bundle content: a very long line
 * with almost no whitespace (webpack bundles, embedded data tables). Such lines
 * pack high-entropy substrings that masquerade as secrets, so detectors skip
 * them. Line-scoped so normal source is never affected.
 */
export function isLikelyMinifiedLine(line: string): boolean {
  if (line.length < 400) return false;
  const whitespace = (line.match(/\s/g) ?? []).length;
  return whitespace / line.length < 0.02;
}

/**
 * True when a source line is purely a comment (single-line or block-body) across
 * the supported languages: JS/TS (slash-slash, slash-star), Python/shell (hash),
 * and block continuations (leading star). Used to skip CODE-pattern detectors
 * (eval, exec, SQL building, weak crypto, framework misuse) on commented-out or
 * example lines — those are not live code. Secret detectors deliberately do NOT
 * skip comments, because a real key pasted into a comment is still a leak.
 */
export function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('<!--')
  );
}

/**
 * Defense-in-depth: skip vendored / generated files even if a caller passes
 * them in (default ignore globs already exclude these, but engines are called
 * directly from the MCP server and tests too).
 */
export function isVendoredOrGenerated(file: string): boolean {
  const f = file.replace(/\\/g, '/');
  return (
    /(?:^|\/)node_modules\//.test(f) ||
    /(?:^|\/)(?:dist|build|out|coverage|vendor|third[_-]?party)\//.test(f) ||
    /\.min\.(?:js|css)$/.test(f) ||
    /\.bundle\.js$/.test(f) ||
    /\.map$/.test(f) ||
    /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(f)
  );
}
