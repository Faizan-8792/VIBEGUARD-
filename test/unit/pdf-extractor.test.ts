import { describe, it, expect } from 'vitest';
import {
  extractConceptsFromText,
  extractCodeReferencesFromText,
} from '../../src/engines/pdf-extractor.js';

describe('PDF Extractor — concept extraction', () => {
  it('extracts frequency-based single-word concepts', () => {
    const text = [
      'Database connection pooling improves performance.',
      'Database queries use pooling. Pooling reduces database load.',
      'The database layer handles connection pooling efficiently.',
    ].join('\n');

    const concepts = extractConceptsFromText(text);
    const terms = concepts.map((c) => c.term);

    // "database" appears >= 3 times → must be a concept
    expect(terms).toContain('database');
    // "pooling" appears >= 3 times → must be a concept
    expect(terms).toContain('pooling');
    // Concepts are weighted (sorted by frequency desc)
    expect(concepts[0].weight).toBeGreaterThanOrEqual(concepts[concepts.length - 1].weight);
  });

  it('filters out stop words and short tokens', () => {
    const text = 'the the the and and for for with with this this that that';
    const concepts = extractConceptsFromText(text);
    const terms = concepts.map((c) => c.term);
    expect(terms).not.toContain('the');
    expect(terms).not.toContain('and');
    expect(terms).not.toContain('with');
  });

  it('captures capitalized multi-word phrases', () => {
    const text = [
      'The Attention Mechanism is central.',
      'The Attention Mechanism scales well.',
      'Researchers studied the Attention Mechanism in depth.',
    ].join('\n');

    const concepts = extractConceptsFromText(text);
    const terms = concepts.map((c) => c.term);
    expect(terms.some((t) => t.includes('attention mechanism'))).toBe(true);
  });

  it('limits concept count to avoid noise', () => {
    const words = Array.from({ length: 200 }, (_, i) => `concept${i} concept${i} concept${i}`).join(' ');
    const concepts = extractConceptsFromText(words);
    expect(concepts.length).toBeLessThanOrEqual(25);
  });
});

describe('PDF Extractor — code reference extraction', () => {
  it('extracts file paths with code extensions', () => {
    const text = 'The entry point is src/main.py which imports from utils/helper.ts and lib/db.go.';
    const refs = extractCodeReferencesFromText(text);
    expect(refs).toContain('src/main.py');
    expect(refs).toContain('utils/helper.ts');
    expect(refs).toContain('lib/db.go');
  });

  it('extracts dotted module/class identifiers', () => {
    const text = 'See com.example.app.UserService and the app.models.user module for details.';
    const refs = extractCodeReferencesFromText(text);
    expect(refs.some((r) => r.includes('com.example.app'))).toBe(true);
    expect(refs.some((r) => r.includes('app.models.user'))).toBe(true);
  });

  it('returns empty array when no code references present', () => {
    const text = 'This document discusses general architecture principles without specifics.';
    const refs = extractCodeReferencesFromText(text);
    expect(refs).toEqual([]);
  });
});
