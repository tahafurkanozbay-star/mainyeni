import { describe, expect, it } from 'vitest';
import { createDataSearchRuntime } from './searchRuntime';
import { FuzzyLexiconRuntimeV8 } from './fuzzyLexiconRuntimeV8';
import { SynonymRegistryRuntimeV8 } from './synonymRegistryRuntimeV8';
import { QueryCorrectionRuntimeV8 } from './queryCorrectionRuntimeV8';
import { createSearchRecoveryRuntimeV8 } from './searchRecoveryRuntimeV8';

const largeRows = (count: number) => Array.from({ length: count }, (_value, index) => ({
  id: `poi-${index}`,
  name: index % 5 === 0 ? `Çankaya Hastanesi ${index}` : `Ankara Hizmet Noktası ${index}`,
  category: index % 5 === 0 ? 'Sağlık' : index % 3 === 0 ? 'Park' : 'Kamu',
  type: index % 5 === 0 ? 'Hastane' : index % 3 === 0 ? 'Kent Parkı' : 'Hizmet',
  district: index % 2 === 0 ? 'Çankaya' : 'Altındağ',
  neighborhood: index % 2 === 0 ? 'Kızılay' : 'Ulus',
  street: index % 2 === 0 ? 'Atatürk Bulvarı' : 'Anafartalar Caddesi',
  address: `Ankara ${index} numara`,
  lat: 39.90 + (index % 100) / 10_000,
  lon: 32.80 + (index % 100) / 10_000,
}));

const largeDataset = (count: number) => createDataSearchRuntime({
  candidatePlanner: { fallbackScanThreshold: Math.max(2_000, count) },
}).register('scale', largeRows(count), { maxRecords: count });

describe('v8 fuzzy lexicon scale budgets', () => {
  it('caps term cardinality under dense unique input', () => {
    const runtime = new FuzzyLexiconRuntimeV8(
      Array.from({ length: 10_000 }, (_value, index) => ({ term: `term${index}` })),
      { maximumTerms: 500 },
    );
    expect(runtime.snapshot().termCount).toBe(500);
    expect(runtime.snapshot().droppedTerms).toBe(9_500);
  });

  it('caps each gram posting list', () => {
    const runtime = new FuzzyLexiconRuntimeV8(
      Array.from({ length: 1_000 }, (_value, index) => ({ term: `park${index}` })),
      { maximumGramPostings: 10 },
    );
    expect(runtime.snapshot().droppedPostings).toBeGreaterThan(0);
  });

  it('caps fuzzy candidates independently of lexicon size', () => {
    const runtime = new FuzzyLexiconRuntimeV8(
      Array.from({ length: 5_000 }, (_value, index) => ({ term: `hastane${index}` })),
      { maximumCandidates: 16, maximumSuggestions: 8 },
    );
    const result = runtime.lookup('hastane999');
    expect(result.diagnostics.candidateCount).toBeLessThanOrEqual(16);
    expect(result.suggestions.length).toBeLessThanOrEqual(8);
  });

  it('produces deterministic ranking for repeated dense lookup', () => {
    const runtime = new FuzzyLexiconRuntimeV8(
      Array.from({ length: 300 }, (_value, index) => ({
        term: `belediye${index}`,
        frequency: 300 - index,
      })),
      { maximumCandidates: 64, maximumSuggestions: 10 },
    );
    const first = runtime.lookup('belediye30').suggestions.map(item => item.term);
    const second = runtime.lookup('belediye30').suggestions.map(item => item.term);
    expect(second).toEqual(first);
  });

  it('does not inflate terms when the same canonical value repeats', () => {
    const runtime = new FuzzyLexiconRuntimeV8(
      Array.from({ length: 10_000 }, () => ({ term: 'Hastane', frequency: 1 })),
      { maximumTerms: 10 },
    );
    expect(runtime.snapshot().termCount).toBe(1);
    expect(runtime.term('hastane')?.frequency).toBe(10_000);
  });
});

describe('v8 synonym scale budgets', () => {
  it('caps registry groups', () => {
    const registry = new SynonymRegistryRuntimeV8(
      Array.from({ length: 100 }, (_value, index) => ({
        id: `group-${index}`,
        canonical: `canonical-${index}`,
        aliases: [`alias-${index}`],
      })),
      { maximumGroups: 20 },
    );
    expect(registry.snapshot().groupCount).toBe(20);
    expect(registry.snapshot().droppedGroups).toBe(80);
  });

  it('caps expansion results for high fan-out group', () => {
    const registry = new SynonymRegistryRuntimeV8([{
      id: 'fanout',
      canonical: 'park',
      aliases: Array.from({ length: 100 }, (_value, index) => `park-alias-${index}`),
    }], {
      maximumAliasesPerGroup: 100,
      maximumExpansionsPerToken: 7,
    });
    expect(registry.expand('park').expansions.length).toBeLessThanOrEqual(7);
  });

  it('keeps expansion tokens globally bounded', () => {
    const registry = new SynonymRegistryRuntimeV8([{
      id: 'tokens',
      canonical: 'park',
      aliases: Array.from({ length: 30 }, (_value, index) => `yesil alan ${index}`),
    }], {
      maximumAliasesPerGroup: 30,
      maximumExpansionTokens: 5,
    });
    expect(registry.expandTokens(['park']).length).toBeLessThanOrEqual(5);
  });
});

describe('v8 correction scale budgets', () => {
  it('caps automatic corrections in a long query', () => {
    const lexicon = new FuzzyLexiconRuntimeV8([
      { term: 'hastane', frequency: 100 },
      { term: 'belediye', frequency: 100 },
      { term: 'cankaya', frequency: 100 },
      { term: 'kizilay', frequency: 100 },
    ]);
    const corrector = new QueryCorrectionRuntimeV8(lexicon, null, {
      maximumCorrections: 2,
      minimumAutoApplyScore: 100,
      minimumAutoApplyMargin: 1,
    });
    const result = corrector.correct('hastne beledyie cankya kizlay');
    expect(result.terms.filter(item => item.applied).length).toBeLessThanOrEqual(2);
  });

  it('caps alternatives reported per token', () => {
    const lexicon = new FuzzyLexiconRuntimeV8([
      { term: 'park', frequency: 10 },
      { term: 'bark', frequency: 10 },
      { term: 'dark', frequency: 10 },
      { term: 'mark', frequency: 10 },
      { term: 'lark', frequency: 10 },
    ], { maximumSuggestions: 5 });
    const corrector = new QueryCorrectionRuntimeV8(lexicon, null, {
      maximumAlternativesPerTerm: 2,
      minimumAutoApplyMargin: 10_000,
    });
    expect(corrector.correct('zark').terms[0]?.alternatives.length).toBeLessThanOrEqual(2);
  });
});

describe('v8 recovery scale and attempt budgets', () => {
  it('builds a bounded companion index over a larger dataset', () => {
    const runtime = createSearchRecoveryRuntimeV8({
      fuzzy: { maximumTerms: 2_000, maximumCandidates: 128 },
    });
    const registration = runtime.register(largeDataset(2_500));
    expect(registration.lexiconTerms).toBeLessThanOrEqual(2_000);
    expect(runtime.snapshot().datasets).toBe(1);
  });

  it('recovers typo against larger corpus without exceeding attempt budget', () => {
    const runtime = createSearchRecoveryRuntimeV8({
      maxAttempts: 2,
      fuzzy: { maximumCandidates: 128 },
      correction: {
        minimumAutoApplyScore: 100,
        minimumAutoApplyMargin: 1,
      },
    });
    runtime.register(largeDataset(2_500));
    const result = runtime.search('scale', { query: 'hastne', limit: 10 });
    expect(result.diagnostics.attempts.length).toBeLessThanOrEqual(2);
    expect(result.response.results.length).toBeLessThanOrEqual(10);
  });

  it('does not recursively recover a successful recovered query', () => {
    const runtime = createSearchRecoveryRuntimeV8({
      maxAttempts: 3,
      correction: {
        minimumAutoApplyScore: 100,
        minimumAutoApplyMargin: 1,
      },
    });
    runtime.register(largeDataset(1_000));
    const result = runtime.search('scale', { query: 'hastne' });
    expect(result.diagnostics.attempts.length).toBeLessThanOrEqual(3);
    expect(result.diagnostics.attempts.map(item => item.ordinal))
      .toEqual(result.diagnostics.attempts.map((_item, index) => index + 1));
  });

  it('preserves deterministic recovered hit order', () => {
    const runtime = createSearchRecoveryRuntimeV8({
      correction: { minimumAutoApplyScore: 100, minimumAutoApplyMargin: 1 },
    });
    runtime.register(largeDataset(800));
    const first = runtime.search('scale', { query: 'hastne', limit: 20 });
    const second = runtime.search('scale', { query: 'hastne', limit: 20 });
    expect(second.response.results.map(hit => hit.record.fingerprint))
      .toEqual(first.response.results.map(hit => hit.record.fingerprint));
  });

  it('keeps dataset cardinality bounded', () => {
    const runtime = createSearchRecoveryRuntimeV8({ maximumDatasets: 3 });
    runtime.register(createDataSearchRuntime().register('a', largeRows(10)));
    runtime.register(createDataSearchRuntime().register('b', largeRows(10)));
    runtime.register(createDataSearchRuntime().register('c', largeRows(10)));
    runtime.register(createDataSearchRuntime().register('d', largeRows(10)));
    expect(runtime.datasetKeys().length).toBeLessThanOrEqual(3);
    expect(runtime.snapshot().datasets).toBeLessThanOrEqual(3);
  });

  it('keeps recovery disabled for spatial query even at scale', () => {
    const runtime = createSearchRecoveryRuntimeV8();
    runtime.register(largeDataset(1_000));
    const result = runtime.search('scale', {
      query: 'hastne',
      center: { latitude: 39.92, longitude: 32.85 },
      radiusMeters: 2_000,
      limit: 20,
    });
    expect(result.diagnostics.attempts).toHaveLength(1);
    expect(result.diagnostics.skipReason).toBe('explicit-center');
  });
});
