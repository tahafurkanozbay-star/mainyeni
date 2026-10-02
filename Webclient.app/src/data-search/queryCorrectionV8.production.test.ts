import { describe, expect, it } from 'vitest';
import { FuzzyLexiconRuntimeV8 } from './fuzzyLexiconRuntimeV8';
import {
  QueryCorrectionRuntimeV8,
  createQueryCorrectionRuntimeV8,
} from './queryCorrectionRuntimeV8';
import {
  SynonymRegistryRuntimeV8,
  createDefaultCivicSynonymsV8,
} from './synonymRegistryRuntimeV8';

const lexicon = () => new FuzzyLexiconRuntimeV8([
  { term: 'hastane', frequency: 100, source: 'dataset' },
  { term: 'hastanesi', frequency: 60, source: 'dataset' },
  { term: 'saglik', frequency: 90, source: 'dataset' },
  { term: 'merkezi', frequency: 80, source: 'dataset' },
  { term: 'belediye', frequency: 75, source: 'dataset' },
  { term: 'belediyesi', frequency: 55, source: 'dataset' },
  { term: 'park', frequency: 120, source: 'dataset' },
  { term: 'durak', frequency: 110, source: 'dataset' },
  { term: 'terminal', frequency: 50, source: 'dataset' },
  { term: 'kizilay', frequency: 100, source: 'dataset' },
  { term: 'cankaya', frequency: 100, source: 'dataset' },
  { term: 'ataturk', frequency: 100, source: 'dataset' },
  { term: 'bulvari', frequency: 70, source: 'dataset' },
  { term: 'kultur', frequency: 65, source: 'dataset' },
]);

const synonyms = () => new SynonymRegistryRuntimeV8(createDefaultCivicSynonymsV8());

const runtime = (overrides = {}) => new QueryCorrectionRuntimeV8(
  lexicon(),
  synonyms(),
  overrides,
);

describe('SynonymRegistryRuntimeV8', () => {
  it('maps civic aliases to a canonical group', () => {
    const registry = synonyms();
    const result = registry.expand('hastane', 'category');
    expect(result.matchedGroups).toContain('health-hospital');
    expect(result.expansions.some(item => item.value === 'saglik')).toBe(true);
  });

  it('supports bidirectional aliases', () => {
    const registry = synonyms();
    const result = registry.expand('saglik', 'category');
    expect(result.expansions.some(item => item.value === 'hastane')).toBe(true);
  });

  it('respects scope boundaries', () => {
    const registry = new SynonymRegistryRuntimeV8([{
      id: 'only-category',
      canonical: 'park',
      aliases: ['yesil alan'],
      scopes: ['category'],
    }]);
    expect(registry.expand('yesil alan', 'category').expansions).not.toHaveLength(0);
    expect(registry.expand('yesil alan', 'street').expansions).toHaveLength(0);
  });

  it('deduplicates alias values deterministically', () => {
    const registry = new SynonymRegistryRuntimeV8([{
      id: 'park',
      canonical: 'park',
      aliases: [
        { value: 'yesil alan', weight: 1 },
        { value: 'Yeşil Alan', weight: 2 },
      ],
    }]);
    expect(registry.group('park')?.aliases).toHaveLength(1);
    expect(registry.group('park')?.aliases[0]?.weight).toBe(2);
  });

  it('rejects duplicate group ids by dropping later groups', () => {
    const registry = new SynonymRegistryRuntimeV8([
      { id: 'same', canonical: 'park', aliases: ['yesil alan'] },
      { id: 'same', canonical: 'durak', aliases: ['istasyon'] },
    ]);
    expect(registry.snapshot().groupCount).toBe(1);
    expect(registry.snapshot().droppedGroups).toBe(1);
  });

  it('bounds number of groups', () => {
    const registry = new SynonymRegistryRuntimeV8([
      { id: 'a', canonical: 'park', aliases: ['yesil'] },
      { id: 'b', canonical: 'durak', aliases: ['istasyon'] },
    ], { maximumGroups: 1 });
    expect(registry.snapshot().groupCount).toBe(1);
    expect(registry.snapshot().droppedGroups).toBe(1);
  });

  it('bounds aliases per group', () => {
    const registry = new SynonymRegistryRuntimeV8([{
      id: 'transport',
      canonical: 'durak',
      aliases: ['istasyon', 'terminal', 'otogar'],
    }], { maximumAliasesPerGroup: 2 });
    expect(registry.group('transport')?.aliases.length).toBeLessThanOrEqual(2);
  });

  it('bounds expansion token count', () => {
    const registry = new SynonymRegistryRuntimeV8([{
      id: 'many',
      canonical: 'park',
      aliases: ['yesil alan', 'mesire alani', 'rekreasyon alani'],
    }], { maximumExpansionTokens: 3 });
    const result = registry.expandTokens(['park']);
    expect(result.length).toBeLessThanOrEqual(3);
  });

  it('produces stable fingerprint for same registry', () => {
    expect(synonyms().snapshot().fingerprint).toBe(synonyms().snapshot().fingerprint);
  });

  it('changes fingerprint when groups change', () => {
    const first = synonyms();
    const second = new SynonymRegistryRuntimeV8([
      ...createDefaultCivicSynonymsV8(),
      { id: 'culture', canonical: 'kultur', aliases: ['sanat'] },
    ]);
    expect(first.snapshot().fingerprint).not.toBe(second.snapshot().fingerprint);
  });
});

describe('QueryCorrectionRuntimeV8 grammar preservation', () => {
  it('corrects a high-confidence optional typo', () => {
    const result = runtime().correct('hastne');
    expect(result.changed).toBe(true);
    expect(result.correctedQuery).toBe('hastane');
    expect(result.terms[0]?.decision).toBe('corrected');
    expect(result.terms[0]?.applied).toBe(true);
  });

  it('corrects required terms while preserving plus marker', () => {
    const result = runtime().correct('+hastne');
    expect(result.changed).toBe(true);
    expect(result.correctedQuery).toBe('+hastane');
    expect(result.correctedAnalysis.requiredTerms).toEqual(['hastane']);
  });

  it('preserves excluded terms by default', () => {
    const result = runtime().correct('-hastne park');
    expect(result.correctedQuery).toContain('-hastne');
    const excluded = result.terms.find(item => item.kind === 'excluded');
    expect(excluded?.decision).toBe('preserved');
    expect(excluded?.applied).toBe(false);
  });

  it('can opt into excluded-term correction explicitly', () => {
    const result = runtime({ correctExcludedTerms: true }).correct('-hastne');
    expect(result.correctedQuery).toBe('-hastane');
    expect(result.correctedAnalysis.excludedTerms).toEqual(['hastane']);
  });

  it('preserves quoted phrases without term-level mutation', () => {
    const result = runtime().correct('"hastne merkezi"');
    expect(result.correctedQuery).toBe('"hastne merkezi"');
    expect(result.terms[0]?.decision).toBe('preserved');
    expect(result.correctedAnalysis.phrases).toEqual(['hastne merkezi']);
  });

  it('corrects field terms while preserving field authority', () => {
    const result = runtime().correct('category:hastne');
    expect(result.correctedQuery).toBe('category:hastane');
    expect(result.correctedAnalysis.fieldTerms.category).toEqual(['hastane']);
  });

  it('does not turn field clauses into free text', () => {
    const result = runtime().correct('district:cankya');
    expect(result.correctedQuery).toBe('district:cankaya');
    expect(result.correctedAnalysis.optionalTerms).toHaveLength(0);
    expect(result.correctedAnalysis.fieldTerms.district).toEqual(['cankaya']);
  });

  it('preserves already-known terms without fuzzy lookup replacement', () => {
    const result = runtime().correct('hastane');
    expect(result.changed).toBe(false);
    expect(result.terms[0]?.decision).toBe('known');
    expect(result.terms[0]?.output).toBe('hastane');
  });

  it('can disable known-term preservation while still retaining exact identity', () => {
    const result = runtime({ preserveKnownTerms: false }).correct('hastane');
    expect(result.changed).toBe(false);
    expect(result.terms[0]?.decision).toBe('known');
  });

  it('does not auto-apply below a high confidence threshold', () => {
    const result = runtime({ minimumAutoApplyScore: 100_000 }).correct('hastne');
    expect(result.changed).toBe(false);
    expect(['ambiguous', 'unknown']).toContain(result.terms[0]?.decision);
  });

  it('does not auto-apply when edit distance exceeds policy', () => {
    const result = runtime({ maximumAutoEditDistance: 0 }).correct('hastne');
    expect(result.changed).toBe(false);
  });

  it('stops auto-correcting after correction budget', () => {
    const result = runtime({ maximumCorrections: 1 }).correct('hastne beledyie');
    expect(result.terms.filter(item => item.applied)).toHaveLength(1);
  });

  it('preserves short tokens below correction threshold', () => {
    const result = runtime({ minimumTokenLength: 4 }).correct('par');
    expect(result.terms[0]?.decision).toBe('preserved');
  });

  it('exposes alternatives without forcing ambiguous choices', () => {
    const custom = new QueryCorrectionRuntimeV8(
      new FuzzyLexiconRuntimeV8([
        { term: 'park', frequency: 10 },
        { term: 'bark', frequency: 10 },
      ]),
      null,
      { minimumAutoApplyMargin: 10_000 },
    );
    const result = custom.correct('dark');
    expect(result.changed).toBe(false);
    expect(result.terms[0]?.alternatives.length).toBeGreaterThan(1);
    expect(result.terms[0]?.decision).toBe('ambiguous');
  });
});

describe('QueryCorrectionRuntimeV8 synonym expansion', () => {
  it('expands known civic synonyms without rewriting a correct query', () => {
    const result = runtime().correct('hastane');
    expect(result.changed).toBe(false);
    expect(result.expandedTerms).toContain('hastane');
    expect(result.expandedTerms).toContain('saglik');
  });

  it('expands synonyms from the corrected output', () => {
    const result = runtime().correct('hastne');
    expect(result.correctedQuery).toBe('hastane');
    expect(result.expandedTerms).toContain('saglik');
  });

  it('uses field scope for synonym expansion', () => {
    const customSynonyms = new SynonymRegistryRuntimeV8([{
      id: 'category-only',
      canonical: 'park',
      aliases: ['yesil'],
      scopes: ['category'],
    }]);
    const corrector = createQueryCorrectionRuntimeV8(lexicon(), customSynonyms);
    expect(corrector.correct('category:park').expandedTerms).toContain('yesil');
    expect(corrector.correct('street:park').expandedTerms).not.toContain('yesil');
  });

  it('can disable synonym expansion', () => {
    const result = runtime({ expandSynonyms: false }).correct('hastane');
    expect(result.expandedTerms).toEqual(['hastane']);
  });

  it('bounds expanded token count', () => {
    const result = runtime({ maximumExpandedTerms: 2 }).correct('hastane park');
    expect(result.expandedTerms.length).toBeLessThanOrEqual(2);
  });

  it('reports expansion budget saturation', () => {
    const result = runtime({ maximumExpandedTerms: 1 }).correct('hastane park');
    expect(result.diagnostics.expansionBudgetReached).toBe(true);
  });
});

describe('QueryCorrectionRuntimeV8 diagnostics and fingerprints', () => {
  it('reports malformed quote state from canonical v6 analyzer', () => {
    const result = runtime().correct('"hastane');
    expect(result.diagnostics.malformedQuotes).toBe(true);
  });

  it('reports corrected term counts', () => {
    const result = runtime().correct('hastne beledyie');
    expect(result.diagnostics.correctedTerms).toBeGreaterThan(0);
    expect(result.diagnostics.inputTerms).toBe(2);
  });

  it('produces stable fingerprint for equivalent correction', () => {
    const corrector = runtime();
    const first = corrector.correct('hastne');
    const second = corrector.correct('hastne');
    expect(first.fingerprint).toBe(second.fingerprint);
  });

  it('changes fingerprint when semantic query changes', () => {
    const corrector = runtime();
    expect(corrector.correct('hastne').fingerprint)
      .not.toBe(corrector.correct('beledyie').fingerprint);
  });

  it('tracks aggregate correction statistics', () => {
    const corrector = runtime();
    corrector.correct('hastne');
    corrector.correct('hastane');
    corrector.correct('zzzzzz');
    const snapshot = corrector.snapshot();
    expect(snapshot.corrections).toBe(3);
    expect(snapshot.changedQueries).toBeGreaterThanOrEqual(1);
    expect(snapshot.autoAppliedTerms).toBeGreaterThanOrEqual(1);
  });
});
