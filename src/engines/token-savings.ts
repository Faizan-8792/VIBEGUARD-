/**
 * Token Savings — estimate how many tokens a graph-based response saves versus
 * handing an agent the full content of the changed files.
 *
 * The estimate is intentionally simple and deterministic (chars/4 heuristic),
 * and is clearly labelled as an estimate. An optional verifier can cross-check
 * against a real tokenizer when one is available.
 */

export interface TokenSavings {
  estimated: true;
  fullContextTokens: number;
  graphContextTokens: number;
  savedTokens: number;
  savedPercent: number;
}

const CHARS_PER_TOKEN = 4;

/** Rough token estimate for an arbitrary string (chars / 4). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Compute a token-savings estimate.
 *
 * @param fullContextChars total characters of the raw changed-file content
 *                         (the "naive" baseline an agent would otherwise read)
 * @param graphResponse    the actual graph-based response (object or string)
 */
export function computeTokenSavings(
  fullContextChars: number,
  graphResponse: unknown,
): TokenSavings {
  const fullContextTokens = Math.ceil(fullContextChars / CHARS_PER_TOKEN);
  const responseText = typeof graphResponse === 'string' ? graphResponse : JSON.stringify(graphResponse);
  const graphContextTokens = estimateTokens(responseText);
  const savedTokens = Math.max(0, fullContextTokens - graphContextTokens);
  const savedPercent = fullContextTokens > 0 ? Math.round((savedTokens / fullContextTokens) * 100) : 0;

  return {
    estimated: true,
    fullContextTokens,
    graphContextTokens,
    savedTokens,
    savedPercent,
  };
}
