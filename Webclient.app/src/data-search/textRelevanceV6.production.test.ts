import { describe, expect, it } from 'vitest';
import type { NormalizedRecord } from './contracts';
import { normalizeRecordCollection } from './normalization';
import { RelevanceIndexRuntime } from './relevanceIndexRuntime';
import { TextQueryAnalysisRuntime, analyzeTextQuery } from './textQueryAnalysisRuntime';

const records = (): readonly NormalizedRecord[] => normalizeRecordCollection([
  {
    id: 1,
    name: 'Çankaya Atatürk Parkı',
    category: 'Park ve Yeşil Alan',
    type: 'Kent Parkı',
    district: 'Çankaya',
    neighborhood: 'Kızılay',
    street: 'Atatürk Bulvarı',
    address: 'Kızılay Mahallesi Atatürk Bulvarı No 10 Çankaya Ankara',
    postalCode: '06420',
  },
  {
    id: 2,
    name: 'Bahçelievler Çocuk Parkı',
    category: 'Yeşil Alan',
    type: 'Çocuk Parkı',
    district: 'Çankaya',
    neighborhood: 'Bahçelievler',
    street: 'Aşkabat Caddesi',
    address: 'Bahçelievler Mahallesi Aşkabat Caddesi Çankaya Ankara',
    postalCode: '06490',
  },
  {
    id: 3,
    name: 'Ulus Kültür Merkezi',
    category: 'Kültür Sanat',
    type: 'Kültür Merkezi',
    district: 'Altındağ',
    neighborhood: 'Ulus',
    street: 'Anafartalar Caddesi',
    address: 'Ulus Anafartalar Caddesi Altındağ Ankara',
    postalCode: '06050',
  },
  {
    id: 4,
    name: 'Etlik Şehir Hastanesi',
    category: 'Sağlık',
    type: 'Hastane',
    district: 'Keçiören',
    neighborhood: 'Etlik',
    street: 'Halil Sezai Erkut Caddesi',
    address: 'Etlik Keçiören Ankara',
    postalCode: '06010',
  },
  {
    id: 5,
    name: 'Çankaya Kültür Merkezi',
    category: 'Kültür Sanat',
    type: 'Kültür Merkezi',
    district: 'Çankaya',
    neighborhood: 'Yıldız',
    street: 'Turan Güneş Bulvarı',
    address: 'Yıldız Mahallesi Turan Güneş Bulvarı Çankaya Ankara',
    postalCode: '06550',
  },
  {
    id: 6,
    name: 'Kızılay Sağlık Merkezi',
    category: 'Sağlık',
    type: 'Sağlık Merkezi',
    district: 'Çankaya',
    neighborhood: 'Kızılay',
    street: 'Ziya Gökalp Caddesi',
    address: 'Kızılay Ziya Gökalp Caddesi Çankaya Ankara',
    postalCode: '06420',
  },
]).records;

const search = (query: string) => {
  const analysis = analyzeTextQuery(query);
  const runtime = new RelevanceIndexRuntime(records(), 'rev-1');
  return runtime.search(analysis, 50);
};

describe('TextQueryAnalysisRuntime v6', () => {
  it('normalizes Turkish dotted and dotless I consistently', () => {
    const analysis = analyzeTextQuery('KIZILAY IŞIK İSTASYON');
    expect(analysis.optionalTerms).toEqual(['kizilay', 'isik', 'istasyon']);
  });

  it('separates required optional and excluded terms', () => {
    const analysis = analyzeTextQuery('+park çankaya -çocuk');
    expect(analysis.requiredTerms).toEqual(['park']);
    expect(analysis.optionalTerms).toEqual(['cankaya']);
    expect(analysis.excludedTerms).toEqual(['cocuk']);
  });

  it('preserves quoted phrases as ordered canonical phrases', () => {
    const analysis = analyzeTextQuery('"Atatürk Bulvarı" park');
    expect(analysis.phrases).toEqual(['ataturk bulvari']);
    expect(analysis.optionalTerms).toEqual(['park']);
  });

  it('parses Turkish field aliases', () => {
    const analysis = analyzeTextQuery('ilce:Çankaya kategori:Sağlık mahalle:Kızılay');
    expect(analysis.fieldTerms.district).toEqual(['cankaya']);
    expect(analysis.fieldTerms.category).toEqual(['saglik']);
    expect(analysis.fieldTerms.neighborhood).toEqual(['kizilay']);
  });

  it('parses canonical field aliases', () => {
    const analysis = analyzeTextQuery('district:Altındağ type:Hastane postal:06010');
    expect(analysis.fieldTerms.district).toEqual(['altindag']);
    expect(analysis.fieldTerms.type).toEqual(['hastane']);
    expect(analysis.fieldTerms.postalCode).toEqual(['06010']);
  });

  it('drops optional stop words while preserving required stop words', () => {
    const analysis = analyzeTextQuery('ve ile +ve park');
    expect(analysis.optionalTerms).toEqual(['park']);
    expect(analysis.requiredTerms).toEqual(['ve']);
    expect(analysis.diagnostics.droppedStopWords).toBe(2);
  });

  it('can retain stop words when policy requests it', () => {
    const analysis = analyzeTextQuery('park ve bahçe', { ignoreStopWords: false });
    expect(analysis.optionalTerms).toEqual(['park', 've', 'bahce']);
  });

  it('marks malformed quotes without throwing', () => {
    const analysis = analyzeTextQuery('park "ataturk bulvari');
    expect(analysis.diagnostics.malformedQuotes).toBe(true);
    expect(analysis.phrases).toEqual(['ataturk bulvari']);
  });

  it('bounds query length', () => {
    const analysis = analyzeTextQuery('a'.repeat(80), { maximumQueryLength: 32 });
    expect(analysis.boundedRaw).toHaveLength(32);
    expect(analysis.diagnostics.truncated).toBe(true);
  });

  it('bounds accepted terms', () => {
    const analysis = analyzeTextQuery('ankara park kültür sağlık ulaşım belediye hizmet bina yol', { maximumTerms: 4, ignoreStopWords: false });
    expect(analysis.positiveTerms).toHaveLength(4);
    expect(analysis.diagnostics.droppedTerms).toBeGreaterThan(0);
  });

  it('bounds accepted phrases', () => {
    const analysis = analyzeTextQuery('"a b" "c d" "e f"', { maximumPhrases: 2 });
    expect(analysis.phrases).toHaveLength(2);
    expect(analysis.diagnostics.droppedPhrases).toBe(1);
  });

  it('bounds field clauses', () => {
    const analysis = analyzeTextQuery('ilce:Çankaya mahalle:Kızılay kategori:Sağlık', { maximumFieldClauses: 2 });
    expect(analysis.clauses.filter((clause) => clause.kind === 'field')).toHaveLength(2);
    expect(analysis.diagnostics.droppedFieldClauses).toBe(1);
  });

  it('creates stable signatures for canonically equivalent queries', () => {
    const left = analyzeTextQuery('ÇANKAYA park');
    const right = analyzeTextQuery('çankaya PARK');
    expect(left.signature).toBe(right.signature);
  });

  it('changes signature when exclusion semantics change', () => {
    const left = analyzeTextQuery('park çocuk');
    const right = analyzeTextQuery('park -çocuk');
    expect(left.signature).not.toBe(right.signature);
  });

  it('tracks analyzer lifecycle counters', () => {
    const runtime = new TextQueryAnalysisRuntime({ maximumQueryLength: 16 });
    runtime.analyze('park ve bahçe');
    runtime.analyze('x'.repeat(50));
    runtime.analyze('"malformed');
    const snapshot = runtime.snapshot();
    expect(snapshot.analyses).toBe(3);
    expect(snapshot.truncatedQueries).toBe(1);
    expect(snapshot.malformedQuotes).toBe(1);
    expect(snapshot.droppedStopWords).toBeGreaterThan(0);
    runtime.reset();
    expect(runtime.snapshot().analyses).toBe(0);
  });

  it('exposes prefix eligibility independently from short tokens', () => {
    const analysis = analyzeTextQuery('a park çankaya', { minimumPrefixLength: 3, ignoreStopWords: false });
    expect(analysis.prefixEligibleTerms).toEqual(['park', 'cankaya']);
  });
});

describe('RelevanceIndexRuntime v6', () => {
  it('ranks an exact title above partial field matches', () => {
    const result = search('Çankaya Atatürk Parkı');
    expect(result.hits[0]?.record.title).toBe('Çankaya Atatürk Parkı');
  });

  it('uses title field weight to prefer direct title evidence', () => {
    const result = search('kızılay');
    const titles = result.hits.map((hit) => hit.record.title);
    expect(titles).toContain('Kızılay Sağlık Merkezi');
    expect(result.hits[0]?.score).toBeGreaterThan(0);
  });

  it('supports prefix expansion when an exact term is absent', () => {
    const result = search('hast');
    expect(result.hits[0]?.record.title).toBe('Etlik Şehir Hastanesi');
    expect(result.hits[0]?.contributions.some((contribution) => contribution.prefix)).toBe(true);
  });

  it('does not use prefix expansion for one-character terms by default', () => {
    const result = search('h');
    expect(result.hits).toHaveLength(0);
  });

  it('requires required terms', () => {
    const result = search('+park +çankaya');
    expect(result.hits.map((hit) => hit.record.title)).toEqual([
      'Çankaya Atatürk Parkı',
      'Bahçelievler Çocuk Parkı',
    ]);
  });

  it('rejects excluded terms', () => {
    const result = search('park -çocuk');
    expect(result.hits.map((hit) => hit.record.title)).toEqual(['Çankaya Atatürk Parkı']);
    expect(result.diagnostics.rejectedExcluded).toBeGreaterThanOrEqual(1);
  });

  it('enforces field clauses before ranking', () => {
    const result = search('merkezi ilce:Çankaya');
    expect(result.hits.map((hit) => hit.record.title)).toEqual([
      'Çankaya Kültür Merkezi',
      'Kızılay Sağlık Merkezi',
    ]);
  });

  it('enforces quoted phrase order', () => {
    const result = search('"ataturk bulvari"');
    expect(result.hits.map((hit) => hit.record.title)).toEqual(['Çankaya Atatürk Parkı']);
  });

  it('counts field and phrase matches in hit evidence', () => {
    const result = search('"kizilay" ilce:Çankaya');
    expect(result.hits[0]?.fieldMatches).toBe(1);
    expect(result.hits[0]?.phraseMatches).toBe(1);
  });

  it('produces deterministic ranks', () => {
    const analysis = analyzeTextQuery('kültür merkezi');
    const runtime = new RelevanceIndexRuntime(records(), 'rev-1');
    const first = runtime.search(analysis, 20).hits.map((hit) => [hit.rank, hit.record.fingerprint]);
    const second = runtime.search(analysis, 20).hits.map((hit) => [hit.rank, hit.record.fingerprint]);
    expect(second).toEqual(first);
  });

  it('uses source index as a stable late tie breaker', () => {
    const duplicateLike = normalizeRecordCollection([
      { id: 'a', name: 'Aynı Başlık', category: 'Test', district: 'Çankaya' },
      { id: 'b', name: 'Aynı Başlık', category: 'Test', district: 'Çankaya' },
    ], { dedupe: false }).records;
    const runtime = new RelevanceIndexRuntime(duplicateLike, 'rev');
    const hits = runtime.search(analyzeTextQuery('aynı başlık'), 10).hits;
    expect(hits[0]?.record.sourceIndex).toBeLessThan(hits[1]?.record.sourceIndex ?? Number.MAX_SAFE_INTEGER);
  });

  it('exposes bounded dictionary prefix lookup', () => {
    const runtime = new RelevanceIndexRuntime(records(), 'rev');
    const values = runtime.dictionary('kul', 10);
    expect(values.some((value) => value.startsWith('kul'))).toBe(true);
    expect(values.length).toBeLessThanOrEqual(10);
  });

  it('reports document frequency', () => {
    const runtime = new RelevanceIndexRuntime(records(), 'rev');
    expect(runtime.documentFrequency('cankaya')).toBeGreaterThanOrEqual(3);
    expect(runtime.documentFrequency('olmayan')).toBe(0);
  });

  it('reports immutable index snapshot', () => {
    const runtime = new RelevanceIndexRuntime(records(), 'revision-42');
    const snapshot = runtime.snapshot();
    expect(snapshot.revision).toBe('revision-42');
    expect(snapshot.recordCount).toBe(6);
    expect(snapshot.distinctTerms).toBeGreaterThan(10);
    expect(snapshot.postingCount).toBeGreaterThan(snapshot.distinctTerms);
    expect(snapshot.averageDocumentLength).toBeGreaterThan(0);
  });

  it('rejects record sets over configured capacity', () => {
    expect(() => new RelevanceIndexRuntime(records(), 'rev', { maximumRecords: 2 })).toThrow(/maximumRecords/);
  });

  it('bounds result count', () => {
    const runtime = new RelevanceIndexRuntime(records(), 'rev', { maximumResults: 2 });
    const result = runtime.search(analyzeTextQuery('çankaya'), 2);
    expect(result.hits.length).toBeLessThanOrEqual(2);
  });

  it('marks result truncation when more ranked hits exist', () => {
    const runtime = new RelevanceIndexRuntime(records(), 'rev', { maximumResults: 2 });
    const result = runtime.search(analyzeTextQuery('merkezi'), 1);
    expect(result.hits).toHaveLength(1);
    expect(result.diagnostics.resultTruncated).toBe(true);
  });

  it('returns empty result for empty normalized query', () => {
    const runtime = new RelevanceIndexRuntime(records(), 'rev');
    const result = runtime.search(analyzeTextQuery(' ve ile '), 10);
    expect(result.hits).toHaveLength(0);
    expect(result.diagnostics.candidateCount).toBe(0);
  });

  it('does not mutate caller records', () => {
    const input = records();
    const before = input.map((record) => record.fingerprint);
    const runtime = new RelevanceIndexRuntime(input, 'rev');
    runtime.search(analyzeTextQuery('park'), 10);
    expect(input.map((record) => record.fingerprint)).toEqual(before);
  });

  it('can disable prefix expansions', () => {
    const runtime = new RelevanceIndexRuntime(records(), 'rev', { maximumPrefixExpansions: 0 });
    const result = runtime.search(analyzeTextQuery('hast'), 10);
    expect(result.hits).toHaveLength(0);
    expect(result.diagnostics.prefixExpansions).toBe(0);
  });

  it('records exact term contributions', () => {
    const result = search('park');
    expect(result.hits[0]?.contributions[0]?.exact).toBe(true);
    expect(result.hits[0]?.contributions[0]?.documentFrequency).toBeGreaterThanOrEqual(2);
  });

  it('keeps scores finite and non-negative', () => {
    const result = search('çankaya park kültür sağlık');
    for (const hit of result.hits) {
      expect(Number.isFinite(hit.score)).toBe(true);
      expect(hit.score).toBeGreaterThanOrEqual(0);
    }
  });
});
