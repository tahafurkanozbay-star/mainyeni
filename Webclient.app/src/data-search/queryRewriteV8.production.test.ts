import { describe, expect, it } from 'vitest';
import { normalizeRecordCollection } from './normalization';
import { TermLexiconRuntimeV8 } from './termLexiconRuntimeV8';
import { QueryRewriteRuntimeV8 } from './queryRewriteRuntimeV8';

const records = () => normalizeRecordCollection([
  { id: 1, name: 'Çankaya Atatürk Parkı', district: 'Çankaya', category: 'Park' },
  { id: 2, name: 'Bahçelievler Çocuk Parkı', district: 'Çankaya', category: 'Park' },
  { id: 3, name: 'Etlik Şehir Hastanesi', district: 'Keçiören', category: 'Sağlık' },
  { id: 4, name: 'Kızılay Sağlık Merkezi', district: 'Çankaya', category: 'Sağlık' },
  { id: 5, name: 'Ulus Kültür Merkezi', district: 'Altındağ', category: 'Kültür' },
  { id: 6, name: 'Mamak Kültür Merkezi', district: 'Mamak', category: 'Kültür' },
]).records;

const createRuntime = () => {
  const lexicon = new TermLexiconRuntimeV8(records(), 'rewrite-v8', {
    maximumDistance: 2,
    maximumCandidateComparisons: 128,
  });
  return new QueryRewriteRuntimeV8(lexicon, {
    mode: 'fallback',
    maximumTerms: 8,
    maximumCorrections: 3,
    minimumConfidence: 0.6,
    minimumScoreGap: 0.01,
    maximumDistance: 2,
  });
};

describe('QueryRewriteRuntimeV8 safe corrections', () => {
  it('rewrites a high-confidence one-character typo', () => {
    const plan = createRuntime().plan('hastene');
    expect(plan.eligible).toBe(true);
    expect(plan.changed).toBe(true);
    expect(plan.rewrittenQuery).toBe('hastane');
    expect(plan.correctionCount).toBe(1);
    expect(plan.blockReason).toBeNull();
  });

  it('rewrites adjacent-transposition typos', () => {
    const plan = createRuntime().plan('pakri');
    expect(plan.changed).toBe(true);
    expect(plan.rewrittenQuery).toBe('parki');
  });

  it('preserves already-correct query tokens', () => {
    const plan = createRuntime().plan('cankaya park');
    expect(plan.eligible).toBe(false);
    expect(plan.changed).toBe(false);
    expect(plan.blockReason).toBe('no-misspellings');
  });

  it('rewrites only misspelled tokens in a mixed query', () => {
    const plan = createRuntime().plan('cankaya hastene');
    expect(plan.changed).toBe(true);
    expect(plan.rewrittenQuery).toBe('cankaya hastane');
    expect(plan.correctionCount).toBe(1);
    expect(plan.decisions[0]?.exactInLexicon).toBe(true);
    expect(plan.decisions[1]?.accepted).toBe(true);
  });

  it('keeps deterministic token order', () => {
    const plan = createRuntime().plan('hastene cankaya');
    expect(plan.rewrittenQuery).toBe('hastane cankaya');
  });

  it('normalizes Turkish case before planning', () => {
    const plan = createRuntime().plan('ÇANKAYA HASTENE');
    expect(plan.rewrittenQuery).toBe('cankaya hastane');
  });

  it('does not accept more corrections than the configured budget', () => {
    const lexicon = new TermLexiconRuntimeV8(records(), 'budget', { maximumDistance: 2 });
    const runtime = new QueryRewriteRuntimeV8(lexicon, {
      maximumCorrections: 1,
      minimumConfidence: 0.5,
      minimumScoreGap: 0,
    });
    const plan = runtime.plan('hastene pakri');
    expect(plan.eligible).toBe(false);
    expect(plan.blockReason).toBe('correction-budget-exceeded');
  });

  it('rejects queries above the term budget', () => {
    const lexicon = new TermLexiconRuntimeV8(records(), 'terms');
    const runtime = new QueryRewriteRuntimeV8(lexicon, { maximumTerms: 2 });
    const plan = runtime.plan('cankaya park saglik merkezi');
    expect(plan.eligible).toBe(false);
    expect(plan.blockReason).toBe('term-budget-exceeded');
  });

  it('rejects truncated analyzer input', () => {
    const lexicon = new TermLexiconRuntimeV8(records(), 'truncated');
    const runtime = new QueryRewriteRuntimeV8(lexicon, {
      analyzer: { maximumQueryLength: 16 },
    });
    const plan = runtime.plan('cankaya hastene cok uzun sorgu');
    expect(plan.eligible).toBe(false);
    expect(plan.blockReason).toBe('query-truncated');
  });

  it('returns empty-query block for whitespace input', () => {
    const plan = createRuntime().plan('   ');
    expect(plan.blockReason).toBe('empty-query');
    expect(plan.changed).toBe(false);
  });
});

describe('QueryRewriteRuntimeV8 syntax preservation', () => {
  it('never rewrites field-qualified queries', () => {
    const plan = createRuntime().plan('title:hastene');
    expect(plan.eligible).toBe(false);
    expect(plan.blockReason).toBe('syntax-sensitive');
  });

  it('never rewrites required-term syntax', () => {
    const plan = createRuntime().plan('+hastene');
    expect(plan.eligible).toBe(false);
    expect(plan.blockReason).toBe('syntax-sensitive');
  });

  it('never rewrites excluded-term syntax', () => {
    const plan = createRuntime().plan('-hastene');
    expect(plan.eligible).toBe(false);
    expect(plan.blockReason).toBe('syntax-sensitive');
  });

  it('never rewrites quoted phrase syntax', () => {
    const plan = createRuntime().plan('"etlik hastene"');
    expect(plan.eligible).toBe(false);
    expect(plan.blockReason).toBe('syntax-sensitive');
  });

  it('fails closed on malformed quotes', () => {
    const plan = createRuntime().plan('"etlik hastene');
    expect(plan.eligible).toBe(false);
    expect(plan.blockReason).toBe('malformed-quotes');
  });

  it('honors disabled mode', () => {
    const lexicon = new TermLexiconRuntimeV8(records(), 'disabled');
    const runtime = new QueryRewriteRuntimeV8(lexicon, { mode: 'disabled' });
    const plan = runtime.plan('hastene');
    expect(plan.blockReason).toBe('disabled');
    expect(plan.changed).toBe(false);
  });

  it('reports suggestion mode without changing planner confidence behavior', () => {
    const lexicon = new TermLexiconRuntimeV8(records(), 'suggest');
    const runtime = new QueryRewriteRuntimeV8(lexicon, {
      mode: 'suggest',
      minimumConfidence: 0.5,
      minimumScoreGap: 0,
    });
    const plan = runtime.plan('hastene');
    expect(plan.mode).toBe('suggest');
    expect(plan.changed).toBe(true);
    expect(plan.rewrittenQuery).toBe('hastane');
  });
});

describe('QueryRewriteRuntimeV8 ambiguity and confidence', () => {
  it('rejects equally strong ambiguous corrections', () => {
    const custom = normalizeRecordCollection([
      { id: 1, name: 'Park' },
      { id: 2, name: 'Perk' },
    ]).records;
    const lexicon = new TermLexiconRuntimeV8(custom, 'ambiguous', { maximumDistance: 1 });
    const runtime = new QueryRewriteRuntimeV8(lexicon, {
      maximumDistance: 1,
      minimumConfidence: 0.4,
      minimumScoreGap: 0.01,
    });
    const plan = runtime.plan('pork');
    expect(plan.eligible).toBe(false);
    expect(plan.blockReason).toBe('ambiguous-correction');
  });

  it('rejects a candidate below the configured confidence', () => {
    const lexicon = new TermLexiconRuntimeV8(records(), 'confidence', { maximumDistance: 2 });
    const runtime = new QueryRewriteRuntimeV8(lexicon, {
      minimumConfidence: 0.9999,
      maximumDistance: 2,
    });
    const plan = runtime.plan('hastene');
    expect(plan.eligible).toBe(false);
    expect(plan.blockReason).toBe('low-confidence');
  });

  it('uses minimum document frequency as a correction guard', () => {
    const lexicon = new TermLexiconRuntimeV8(records(), 'frequency', {
      maximumDistance: 2,
      minimumDocumentFrequency: 1,
    });
    const runtime = new QueryRewriteRuntimeV8(lexicon, {
      minimumDocumentFrequency: 2,
      minimumConfidence: 0.4,
      minimumScoreGap: 0,
    });
    const plan = runtime.plan('hastene');
    expect(plan.changed).toBe(false);
  });

  it('does not try to correct tokens shorter than the configured length', () => {
    const lexicon = new TermLexiconRuntimeV8(records(), 'length');
    const runtime = new QueryRewriteRuntimeV8(lexicon, { minimumTermLength: 5 });
    const plan = runtime.plan('prk');
    expect(plan.changed).toBe(false);
  });
});

describe('QueryRewriteRuntimeV8 diagnostics and determinism', () => {
  it('generates stable plan signatures', () => {
    const runtime = createRuntime();
    expect(runtime.plan('hastene').signature).toBe(runtime.plan('hastene').signature);
  });

  it('changes signatures when the normalized query changes', () => {
    const runtime = createRuntime();
    expect(runtime.plan('hastene').signature).not.toBe(runtime.plan('pakri').signature);
  });

  it('tracks changed plans and corrections', () => {
    const runtime = createRuntime();
    runtime.plan('hastene');
    runtime.plan('cankaya');
    const snapshot = runtime.snapshot();
    expect(snapshot.plans).toBe(2);
    expect(snapshot.changedPlans).toBe(1);
    expect(snapshot.acceptedCorrections).toBe(1);
  });

  it('tracks syntax blocks', () => {
    const runtime = createRuntime();
    runtime.plan('title:hastene');
    expect(runtime.snapshot().blockedSyntax).toBe(1);
  });

  it('returns immutable decisions and plan', () => {
    const plan = createRuntime().plan('hastene');
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.decisions)).toBe(true);
    expect(Object.isFrozen(plan.decisions[0])).toBe(true);
  });
});
