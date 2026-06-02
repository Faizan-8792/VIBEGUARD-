import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

export interface PdfConcept {
  term: string;
  weight: number; // frequency-based relevance score
}

export interface PdfExtraction {
  file: string;
  title: string;
  pageCount: number;
  textLength: number;
  concepts: PdfConcept[];
  /** Code-like references found in the PDF (file paths, identifiers) */
  codeReferences: string[];
  /** First ~500 chars of extracted text as a preview */
  preview: string;
}

// Tuning constants for extraction heuristics
const PREVIEW_CHAR_LIMIT = 500;
const MAX_CONCEPTS = 25;
const MAX_CODE_REFERENCES = 50;
const MIN_WORD_LENGTH = 4;
const MAX_WORD_LENGTH = 30;
const MIN_WORD_OCCURRENCES = 3;
const MIN_PHRASE_OCCURRENCES = 2;
const PHRASE_WEIGHT_MULTIPLIER = 2;
const TITLE_MIN_LENGTH = 3;
const TITLE_MAX_LENGTH = 120;

/**
 * Extract text and concepts from a PDF file. Fully local — no network calls.
 * Uses pdf-parse for text extraction, then derives concepts via frequency analysis.
 */
export async function extractPdf(filePath: string): Promise<PdfExtraction> {
  const buffer = await readFile(filePath);

  // pdf-parse's package index runs debug code on import; import the lib module directly.
  const pdfParseModule = await import('pdf-parse/lib/pdf-parse.js');
  const pdfParse = (pdfParseModule.default ?? pdfParseModule) as (
    data: Buffer,
  ) => Promise<{ text: string; numpages: number; info?: Record<string, unknown> }>;

  const parsed = await pdfParse(buffer);
  const text = parsed.text ?? '';

  const title = deriveTitle(parsed.info, text, filePath);
  const concepts = extractConceptsFromText(text);
  const codeReferences = extractCodeReferencesFromText(text);

  return {
    file: filePath,
    title,
    pageCount: parsed.numpages ?? 0,
    textLength: text.length,
    concepts,
    codeReferences,
    preview: text.trim().slice(0, PREVIEW_CHAR_LIMIT),
  };
}

function deriveTitle(info: Record<string, unknown> | undefined, text: string, filePath: string): string {
  // Prefer PDF metadata title
  if (info && typeof info.Title === 'string' && info.Title.trim().length > 0) {
    return info.Title.trim();
  }
  // Fall back to first non-empty line of text
  const firstLine = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > TITLE_MIN_LENGTH && l.length < TITLE_MAX_LENGTH);
  if (firstLine) return firstLine;

  // Last resort: filename without extension
  return basename(filePath).replace(/\.pdf$/i, '');
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'her', 'was', 'one', 'our', 'out',
  'his', 'has', 'had', 'how', 'man', 'new', 'now', 'old', 'see', 'two', 'way', 'who', 'did', 'its',
  'let', 'put', 'say', 'she', 'too', 'use', 'this', 'that', 'with', 'from', 'they', 'will', 'would',
  'there', 'their', 'what', 'about', 'which', 'when', 'were', 'been', 'have', 'more', 'than', 'then',
  'them', 'these', 'some', 'into', 'only', 'other', 'such', 'also', 'each', 'most', 'over', 'after',
  'where', 'page', 'figure', 'table', 'section', 'using', 'used', 'within', 'between', 'shown',
]);

/**
 * Extract significant concepts from text via frequency analysis.
 * Returns the top weighted multi-occurrence terms. Exported for testability.
 */
export function extractConceptsFromText(text: string): PdfConcept[] {
  // Single words: tokenize, filter noise, count frequency
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(
      (w) =>
        w.length >= MIN_WORD_LENGTH &&
        w.length <= MAX_WORD_LENGTH &&
        !STOP_WORDS.has(w) &&
        !/^\d+$/.test(w),
    );
  const wordFreq = countOccurrences(words);

  // Capitalized multi-word phrases (likely proper concepts/titles)
  const phraseRegex = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\b/g;
  const phrases = [...text.matchAll(phraseRegex)].map((match) => match[1].toLowerCase());
  const phraseFreq = countOccurrences(phrases);

  const concepts: PdfConcept[] = [
    ...collectWeightedTerms(wordFreq, MIN_WORD_OCCURRENCES),
    ...collectWeightedTerms(phraseFreq, MIN_PHRASE_OCCURRENCES, PHRASE_WEIGHT_MULTIPLIER),
  ];

  return concepts.sort((a, b) => b.weight - a.weight).slice(0, MAX_CONCEPTS);
}

/** Count how often each term appears in a list. */
function countOccurrences(terms: string[]): Map<string, number> {
  const freq = new Map<string, number>();
  for (const term of terms) {
    freq.set(term, (freq.get(term) ?? 0) + 1);
  }
  return freq;
}

/** Build concepts for terms meeting a minimum count, scaling weight by a multiplier. */
function collectWeightedTerms(
  freq: Map<string, number>,
  minCount: number,
  weightMultiplier = 1,
): PdfConcept[] {
  const concepts: PdfConcept[] = [];
  for (const [term, count] of freq) {
    if (count >= minCount) {
      concepts.push({ term, weight: count * weightMultiplier });
    }
  }
  return concepts;
}

/**
 * Find code-like references (file paths, dotted identifiers) within text.
 * These let us link a PDF to actual code nodes in the graph. Exported for testability.
 */
export function extractCodeReferencesFromText(text: string): string[] {
  const refs = new Set<string>();

  // File paths / filenames with code extensions
  const fileRegex = /\b([\w-]+(?:\/[\w-]+)*\.(?:ts|tsx|js|jsx|py|go|java|rs|rb|c|cpp|h|md))\b/g;
  for (const match of text.matchAll(fileRegex)) {
    refs.add(match[1]);
  }

  // Dotted module/class identifiers (e.g. com.example.Foo, app.models)
  const dottedRegex = /\b([a-z][a-z0-9]+(?:\.[a-z][a-z0-9]+){2,})\b/g;
  for (const match of text.matchAll(dottedRegex)) {
    refs.add(match[1]);
  }

  return [...refs].slice(0, MAX_CODE_REFERENCES);
}
