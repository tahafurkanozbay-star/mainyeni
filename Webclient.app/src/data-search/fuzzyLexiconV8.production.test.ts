import { describe, expect, it } from 'vitest';
import { createDataSearchRuntime } from './searchRuntime';
import {
  FuzzyLexiconRuntimeV8,
  boundedDamerauLevenshteinV8,
  createFuzzyLexiconRuntimeV8,
  createFuzzyLexiconTermsFromRecordsV8,
} from './fuzzyLexiconRuntimeV8';

const terms = () => [
  { term: 'hastane', frequency: 40, source: 'category' },
  { term: 'hastanesi', frequency: 20, source: 'title' },
  { term: 'belediye', frequency: 35, source: 'title' },
  { term: 'belediyesi', frequency: 14, source: 'title' },
  { term: 'kizilay', frequency: 30, source: 'neighborhood' },
  { term: 'cankaya', frequency: 25, source: 'district' },
  { term: 'ataturk', frequency: 28, source: 'street' },
  { term: 'bulvari', frequency: 18, source: 'street' },
  { term: 'saglik', frequency: 22, source: 'category' },
  { term: 'merkezi', frequency: 16, source: 'type' },
  { term: 'kultur', frequency: 15, source: 'category' },
  { term: 'park', frequency: 50, source: 'category' },
  { term: 'durak', frequency: 45, source: 'category' },
  { term: 'terminal', frequency: 12, source: 'category' },
] as const;

const records = () => createDataSearchRuntime().register('ankara', [
  {
    id: 'health-1',
    name: 'Çankaya Devlet Hastanesi',
    category: 'Sağlık',
    type: 'Hastane',
    district: 'Çankaya',
    neighborhood: 'Kızılay',
    street: 'Atatürk Bulvarı',
    address: 'Atatürk Bulvarı No 10 Çankaya Ankara',
    lat: 39.9208,
    lon: 32.8541,
  },
  {
    id: 'municipality-1',
    name: 'Çankaya Belediyesi',
    category: 'Kamu',
    type: 'Belediye',
    district: 'Çankaya',
    neighborhood: 'Kızılay',
    street: 'Ziya Gökalp Caddesi',
    address: 'Ziya Gökalp Caddesi No 5 Çankaya Ankara',
    lat: 39.9214,
    lon: 32.8532,
  },
  {
    id: 'park-1',
    name: 'Atatürk Parkı',
    category: 'Park',
    type: 'Kent Parkı',
    district: 'Altındağ',
    neighborhood: 'Ulus',
    street: 'Cumhuriyet Caddesi',
    address: 'Cumhuriyet Caddesi Altındağ Ankara',
    lat: 39.941,
    lon: 32.855,
  },
]).records;

describe('boundedDamerauLevenshteinV8', () => {
  it('returns zero for canonical equality', () => {
    expect(boundedDamerauLevenshteinV8('HASTANE', 'hastane', 2)).toBe(0);
  });

  it('handles one insertion', () => {
    expect(boundedDamerauLevenshteinV8('hastne', 'hastane', 2)).toBe(1);
  });

  it('handles adjacent transposition', () => {
    expect(boundedDamerauLevenshteinV8('beledyie', 'belediye', 2)).toBe(1);
  });

  it('returns maximum plus one when length difference is out of budget', () => {
    expect(boundedDamerauLevenshteinV8('park', 'belediye', 2)).toBe(3);
  });

  it('does not report an edit outside the configured budget', () => {
    expect(boundedDamerauLevenshteinV8('hxtxne', 'hastane', 1)).toBe(2);
  });

  it('normalizes Turkish diacritics through the canonical token boundary', () => {
    expect(boundedDamerauLevenshteinV8('Çankaya', 'cankaya', 2)).toBe(0);
  });

  it('keeps empty input bounded', () => {
    expect(boundedDamerauLevenshteinV8('', 'ab', 2)).toBe(2);
    expect(boundedDamerauLevenshteinV8('', 'abcd', 2)).toBe(3);
  });
});

describe('FuzzyLexiconRuntimeV8 lookup', () => {
  it('prefers exact terms over fuzzy alternatives', () => {
    const runtime = createFuzzyLexiconRuntimeV8(terms());
    const result = runtime.lookup('hastane');
    expect(result.suggestions[0]?.term).toBe('hastane');
    expect(result.suggestions[0]?.exact).toBe(true);
    expect(result.suggestions[0]?.editDistance).toBe(0);
  });

  it('recovers a one-character omission', () => {
    const runtime = createFuzzyLexiconRuntimeV8(terms());
    const result = runtime.lookup('hastne');
    expect(result.suggestions[0]?.term).toBe('hastane');
    expect(result.suggestions[0]?.editDistance).toBe(1);
  });

  it('recovers a transposition deterministically', () => {
    const runtime = createFuzzyLexiconRuntimeV8(terms());
    const first = runtime.lookup('beledyie');
    const second = runtime.lookup('beledyie');
    expect(first.suggestions[0]?.term).toBe('belediye');
    expect(second.suggestions.map(item => item.term)).toEqual(first.suggestions.map(item => item.term));
  });

  it('keeps lookup output bounded by maximumSuggestions', () => {
    const runtime = createFuzzyLexiconRuntimeV8(terms(), { maximumSuggestions: 3 });
    expect(runtime.lookup('beledi').suggestions.length).toBeLessThanOrEqual(3);
  });

  it('accepts a stricter per-call output bound', () => {
    const runtime = createFuzzyLexiconRuntimeV8(terms(), { maximumSuggestions: 5 });
    expect(runtime.lookup('hastan', 1).suggestions).toHaveLength(1);
  });

  it('rejects tokens below minimum length without scanning the lexicon', () => {
    const runtime = createFuzzyLexiconRuntimeV8(terms(), { minimumTokenLength: 3 });
    const result = runtime.lookup('a');
    expect(result.suggestions).toHaveLength(0);
    expect(result.diagnostics.candidateCount).toBe(0);
    expect(result.diagnostics.evaluatedCount).toBe(0);
  });

  it('rejects candidates outside length delta', () => {
    const runtime = createFuzzyLexiconRuntimeV8(terms(), {
      maximumLengthDelta: 1,
      maximumEditDistance: 3,
    });
    const result = runtime.lookup('terminalxx');
    expect(result.suggestions.some(item => item.term === 'terminal')).toBe(false);
  });

  it('does not broad-scan unrelated terms when there are no shared grams', () => {
    const runtime = createFuzzyLexiconRuntimeV8(terms(), { maximumCandidates: 4 });
    const result = runtime.lookup('zzzzzz');
    expect(result.suggestions).toHaveLength(0);
    expect(result.diagnostics.candidateCount).toBe(0);
  });

  it('reports candidate truncation under a hard candidate budget', () => {
    const dense = Array.from({ length: 100 }, (_value, index) => ({
      term: `park${index}`,
      frequency: 100 - index,
      source: 'dense',
    }));
    const runtime = createFuzzyLexiconRuntimeV8(dense, {
      maximumCandidates: 5,
      maximumSuggestions: 5,
      maximumEditDistance: 3,
    });
    const result = runtime.lookup('parkx');
    expect(result.diagnostics.candidateCount).toBeLessThanOrEqual(5);
    expect(result.diagnostics.candidateTruncated).toBe(true);
  });

  it('counts repeated input terms instead of duplicating lexicon rows', () => {
    const runtime = createFuzzyLexiconRuntimeV8([
      { term: 'park', frequency: 2, source: 'a' },
      { term: 'Park', frequency: 3, source: 'b' },
    ]);
    expect(runtime.snapshot().termCount).toBe(1);
    expect(runtime.term('park')?.frequency).toBe(5);
    expect(runtime.term('park')?.sources).toEqual(['a', 'b']);
  });

  it('keeps source metadata bounded per term', () => {
    const runtime = createFuzzyLexiconRuntimeV8([
      { term: 'park', source: 'a' },
      { term: 'park', source: 'b' },
      { term: 'park', source: 'c' },
    ], { sourceLimitPerTerm: 2 });
    expect(runtime.term('park')?.sources).toHaveLength(2);
  });

  it('drops new terms after maximumTerms without corrupting existing terms', () => {
    const runtime = createFuzzyLexiconRuntimeV8(terms(), { maximumTerms: 3 });
    expect(runtime.snapshot().termCount).toBe(3);
    expect(runtime.snapshot().droppedTerms).toBeGreaterThan(0);
    expect(runtime.terms().map(item => item.ordinal)).toEqual([0, 1, 2]);
  });

  it('exposes stable snapshot fingerprint for identical input', () => {
    const first = createFuzzyLexiconRuntimeV8(terms());
    const second = createFuzzyLexiconRuntimeV8(terms());
    expect(first.snapshot().fingerprint).toBe(second.snapshot().fingerprint);
  });

  it('changes snapshot fingerprint when policy changes', () => {
    const first = createFuzzyLexiconRuntimeV8(terms());
    const second = createFuzzyLexiconRuntimeV8(terms(), { maximumCandidates: 32 });
    expect(first.snapshot().fingerprint).not.toBe(second.snapshot().fingerprint);
  });

  it('tracks lookups and truncation diagnostics', () => {
    const runtime = createFuzzyLexiconRuntimeV8(
      Array.from({ length: 50 }, (_value, index) => ({ term: `belediye${index}` })),
      { maximumCandidates: 2 },
    );
    runtime.lookup('belediye');
    runtime.lookup('hastane');
    expect(runtime.snapshot().lookups).toBe(2);
    expect(runtime.snapshot().candidateTruncations).toBeGreaterThanOrEqual(0);
  });
});

describe('createFuzzyLexiconTermsFromRecordsV8', () => {
  it('extracts canonical terms from normalized searchable fields', () => {
    const extracted = createFuzzyLexiconTermsFromRecordsV8(records(), 'ankara');
    const values = new Set(extracted.map(item => item.term));
    expect(values.has('hastane')).toBe(true);
    expect(values.has('cankaya')).toBe(true);
    expect(values.has('kizilay')).toBe(true);
    expect(values.has('ataturk')).toBe(true);
  });

  it('aggregates document frequency once per record', () => {
    const extracted = createFuzzyLexiconTermsFromRecordsV8(records(), 'ankara');
    const cankaya = extracted.find(item => item.term === 'cankaya');
    expect(cankaya?.frequency).toBeGreaterThanOrEqual(2);
  });

  it('attaches dataset source provenance', () => {
    const extracted = createFuzzyLexiconTermsFromRecordsV8(records(), 'ANKARA DATASET');
    expect(extracted.every(item => item.source === 'ankara-dataset')).toBe(true);
  });

  it('respects maximum record budget', () => {
    const extracted = createFuzzyLexiconTermsFromRecordsV8(records(), 'ankara', 1);
    const values = new Set(extracted.map(item => item.term));
    expect(values.has('hastane')).toBe(true);
    expect(values.has('belediye')).toBe(false);
  });

  it('can build a full fuzzy runtime from extracted record terms', () => {
    const extracted = createFuzzyLexiconTermsFromRecordsV8(records(), 'ankara');
    const runtime = new FuzzyLexiconRuntimeV8(extracted);
    expect(runtime.lookup('hastne').suggestions[0]?.term).toBe('hastane');
  });
});
