import { describe, expect, it } from 'vitest';
import { normalizeRecordCollection } from './normalization';
import {
  TermLexiconRuntimeV8,
  createTermLexiconRuntimeV8,
} from './termLexiconRuntimeV8';

const rawRecords = () => [
  {
    id: 1,
    name: 'Çankaya Atatürk Parkı',
    category: 'Park',
    type: 'Kent Parkı',
    district: 'Çankaya',
    neighborhood: 'Kızılay',
    street: 'Atatürk Bulvarı',
    address: 'Kızılay Mahallesi Atatürk Bulvarı No 10 Çankaya Ankara',
    postalCode: '06420',
    lat: 39.9208,
    lon: 32.8541,
  },
  {
    id: 2,
    name: 'Bahçelievler Çocuk Parkı',
    category: 'Park',
    type: 'Çocuk Parkı',
    district: 'Çankaya',
    neighborhood: 'Bahçelievler',
    street: 'Aşkabat Caddesi',
    address: 'Bahçelievler Mahallesi Aşkabat Caddesi No 20 Çankaya Ankara',
    postalCode: '06490',
    lat: 39.914,
    lon: 32.824,
  },
  {
    id: 3,
    name: 'Ulus Kültür Merkezi',
    category: 'Kültür',
    type: 'Kültür Merkezi',
    district: 'Altındağ',
    neighborhood: 'Ulus',
    street: 'Anafartalar Caddesi',
    address: 'Ulus Anafartalar Caddesi No 15 Altındağ Ankara',
    postalCode: '06050',
    lat: 39.941,
    lon: 32.855,
  },
  {
    id: 4,
    name: 'Etlik Şehir Hastanesi',
    category: 'Sağlık',
    type: 'Hastane',
    district: 'Keçiören',
    neighborhood: 'Etlik',
    street: 'Halil Sezai Erkut Caddesi',
    address: 'Etlik Halil Sezai Erkut Caddesi Keçiören Ankara',
    postalCode: '06010',
    lat: 39.982,
    lon: 32.832,
  },
  {
    id: 5,
    name: 'Kızılay Sağlık Merkezi',
    category: 'Sağlık',
    type: 'Sağlık Merkezi',
    district: 'Çankaya',
    neighborhood: 'Kızılay',
    street: 'Ziya Gökalp Caddesi',
    address: 'Kızılay Ziya Gökalp Caddesi No 5 Çankaya Ankara',
    postalCode: '06420',
    lat: 39.9214,
    lon: 32.8532,
  },
] as const;

const records = () => normalizeRecordCollection(rawRecords()).records;

const runtime = () => createTermLexiconRuntimeV8(records(), 'rev-1', {
  maximumSuggestions: 8,
  maximumCandidateComparisons: 128,
  maximumDistance: 2,
});

describe('TermLexiconRuntimeV8 indexing', () => {
  it('indexes canonical Turkish search terms', () => {
    const lexicon = runtime();
    expect(lexicon.has('ÇANKAYA')).toBe(true);
    expect(lexicon.has('çankaya')).toBe(true);
    expect(lexicon.entry('çankaya')?.term).toBe('cankaya');
  });

  it('tracks document frequency across records', () => {
    const lexicon = runtime();
    const entry = lexicon.entry('cankaya');
    expect(entry?.documentFrequency).toBeGreaterThanOrEqual(3);
    expect(entry?.totalFrequency).toBeGreaterThanOrEqual(entry?.documentFrequency ?? 0);
  });

  it('tracks source fields without storing raw source records', () => {
    const lexicon = runtime();
    const entry = lexicon.entry('kizilay');
    expect(entry?.fields).toContain('neighborhood');
    expect(entry?.fields).toContain('address');
    expect(Object.isFrozen(entry?.fields)).toBe(true);
  });

  it('indexes postal code evidence', () => {
    const lexicon = runtime();
    expect(lexicon.entry('06420')?.documentFrequency).toBeGreaterThanOrEqual(2);
  });

  it('returns immutable term listings', () => {
    const lexicon = runtime();
    const terms = lexicon.terms();
    expect(terms.length).toBeGreaterThan(0);
    expect(Object.isFrozen(terms)).toBe(true);
    expect(Object.isFrozen(terms[0])).toBe(true);
  });

  it('records stable first record index for deterministic ties', () => {
    const lexicon = runtime();
    expect(lexicon.entry('park')?.firstRecordIndex).toBe(0);
  });

  it('caps record admission by policy', () => {
    const lexicon = new TermLexiconRuntimeV8(records(), 'limited', {
      maximumRecords: 2,
      maximumDistinctTerms: 10_000,
    });
    expect(lexicon.snapshot().recordCount).toBe(2);
    expect(lexicon.has('ulus')).toBe(false);
  });

  it('caps terms collected from a single record', () => {
    const lexicon = new TermLexiconRuntimeV8(records(), 'limited-terms', {
      maximumTermsPerRecord: 3,
      maximumDistinctTerms: 10_000,
    });
    expect(lexicon.snapshot().droppedRecordTerms).toBeGreaterThan(0);
  });

  it('caps distinct term growth', () => {
    const lexicon = new TermLexiconRuntimeV8(records(), 'limited-distinct', {
      maximumDistinctTerms: 128,
    });
    expect(lexicon.snapshot().distinctTerms).toBeLessThanOrEqual(128);
  });
});

describe('TermLexiconRuntimeV8 suggestions', () => {
  it('returns an exact suggestion without distance comparisons', () => {
    const lexicon = runtime();
    const result = lexicon.suggest('hastane');
    expect(result.exact).toBe(true);
    expect(result.compared).toBe(0);
    expect(result.suggestions[0]?.term).toBe('hastane');
  });

  it('repairs a one-character substitution', () => {
    const lexicon = runtime();
    const result = lexicon.suggest('hastene');
    expect(result.suggestions[0]?.term).toBe('hastane');
    expect(result.suggestions[0]?.distance).toBe(1);
  });

  it('repairs an adjacent transposition', () => {
    const lexicon = runtime();
    const result = lexicon.suggest('pakri');
    expect(result.suggestions.some(item => item.term === 'parki' && item.distance === 1)).toBe(true);
  });

  it('uses corpus frequency as a deterministic tie signal', () => {
    const custom = normalizeRecordCollection([
      { id: 1, name: 'Park' },
      { id: 2, name: 'Park' },
      { id: 3, name: 'Perk' },
    ]).records;
    const lexicon = new TermLexiconRuntimeV8(custom, 'ties', { maximumDistance: 1 });
    const result = lexicon.suggest('pork');
    expect(result.suggestions[0]?.term).toBe('park');
  });

  it('marks equally strong alternatives as ambiguous', () => {
    const custom = normalizeRecordCollection([
      { id: 1, name: 'Park' },
      { id: 2, name: 'Perk' },
    ]).records;
    const lexicon = new TermLexiconRuntimeV8(custom, 'ambiguous', { maximumDistance: 1 });
    const result = lexicon.suggest('pork');
    expect(result.suggestions[0]?.ambiguous).toBe(true);
  });

  it('does not suggest tokens shorter than the policy minimum', () => {
    const lexicon = new TermLexiconRuntimeV8(records(), 'short', {
      minimumSuggestionLength: 4,
    });
    const result = lexicon.suggest('ab');
    expect(result.suggestions).toEqual([]);
    expect(result.compared).toBe(0);
  });

  it('honors the requested suggestion limit', () => {
    const lexicon = runtime();
    const result = lexicon.suggest('merkez', 2);
    expect(result.suggestions.length).toBeLessThanOrEqual(2);
  });

  it('bounds candidate comparisons', () => {
    const custom = normalizeRecordCollection(Array.from({ length: 100 }, (_value, index) => ({
      id: index + 1,
      name: `park${String(index).padStart(3, '0')}`,
    }))).records;
    const lexicon = new TermLexiconRuntimeV8(custom, 'bounded', {
      maximumCandidateComparisons: 8,
      maximumDistance: 2,
    });
    const result = lexicon.suggest('park001x');
    expect(result.compared).toBeLessThanOrEqual(8);
  });

  it('filters suggestions below minimum document frequency', () => {
    const lexicon = new TermLexiconRuntimeV8(records(), 'freq', {
      minimumDocumentFrequency: 2,
      maximumDistance: 2,
    });
    const result = lexicon.suggest('hastene');
    expect(result.suggestions.some(item => item.term === 'hastane')).toBe(false);
  });

  it('returns no candidates for a lexically distant term', () => {
    const lexicon = runtime();
    const result = lexicon.suggest('zzzzzzzz');
    expect(result.suggestions).toEqual([]);
  });
});

describe('TermLexiconRuntimeV8 diagnostics', () => {
  it('reports bounded index facts and version', () => {
    const lexicon = runtime();
    const snapshot = lexicon.snapshot();
    expect(snapshot.version).toBe(8);
    expect(snapshot.recordCount).toBe(records().length);
    expect(snapshot.distinctTerms).toBeGreaterThan(0);
    expect(snapshot.lengthBuckets).toBeGreaterThan(0);
    expect(snapshot.prefixBuckets).toBeGreaterThan(0);
  });

  it('increments suggestion diagnostics', () => {
    const lexicon = runtime();
    const before = lexicon.snapshot();
    lexicon.suggest('hastene');
    const after = lexicon.snapshot();
    expect(after.suggestionRequests).toBe(before.suggestionRequests + 1);
    expect(after.suggestionComparisons).toBeGreaterThanOrEqual(before.suggestionComparisons);
  });

  it('produces stable fingerprints for the same corpus and revision', () => {
    const left = runtime().snapshot().fingerprint;
    const right = runtime().snapshot().fingerprint;
    expect(left).toBe(right);
  });

  it('changes fingerprint when revision identity changes', () => {
    const left = new TermLexiconRuntimeV8(records(), 'rev-a').snapshot().fingerprint;
    const right = new TermLexiconRuntimeV8(records(), 'rev-b').snapshot().fingerprint;
    expect(left).not.toBe(right);
  });

  it('rejects invalid maximum candidate comparison policy', () => {
    expect(() => new TermLexiconRuntimeV8(records(), 'invalid', {
      maximumCandidateComparisons: 0,
    })).toThrow(RangeError);
  });
});
