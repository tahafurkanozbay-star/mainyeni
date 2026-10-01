import type { NormalizedRecord } from './contracts';
import {
  hashFingerprint,
  normalizeInteger,
  normalizeSearchToken,
  stableSerialize,
  tokenizeSearchText,
} from './normalization';

export const FUZZY_LEXICON_VERSION_V8 = 'search-fuzzy-v8' as const;

export interface FuzzyLexiconTermInputV8 {
  readonly term: string;
  readonly frequency?: number;
  readonly weight?: number;
  readonly source?: string | null;
}

export interface FuzzyLexiconPolicyV8 {
  readonly maximumTerms?: number;
  readonly maximumGramPostings?: number;
  readonly maximumCandidates?: number;
  readonly maximumSuggestions?: number;
  readonly minimumTokenLength?: number;
  readonly maximumTokenLength?: number;
  readonly maximumEditDistance?: number;
  readonly maximumLengthDelta?: number;
  readonly minimumGramSimilarity?: number;
  readonly exactBoost?: number;
  readonly prefixBoost?: number;
  readonly frequencyWeight?: number;
  readonly sourceLimitPerTerm?: number;
}

export interface FuzzyLexiconTermV8 {
  readonly term: string;
  readonly frequency: number;
  readonly weight: number;
  readonly grams: readonly string[];
  readonly sources: readonly string[];
  readonly ordinal: number;
}

export interface FuzzySuggestionV8 {
  readonly term: string;
  readonly editDistance: number;
  readonly gramSimilarity: number;
  readonly prefix: boolean;
  readonly exact: boolean;
  readonly frequency: number;
  readonly weight: number;
  readonly score: number;
  readonly sources: readonly string[];
}

export interface FuzzyLookupDiagnosticsV8 {
  readonly input: string;
  readonly canonical: string;
  readonly gramCount: number;
  readonly candidateCount: number;
  readonly evaluatedCount: number;
  readonly rejectedLength: number;
  readonly rejectedGram: number;
  readonly rejectedDistance: number;
  readonly candidateTruncated: boolean;
  readonly suggestionTruncated: boolean;
}

export interface FuzzyLookupResultV8 {
  readonly suggestions: readonly FuzzySuggestionV8[];
  readonly diagnostics: FuzzyLookupDiagnosticsV8;
}

export interface FuzzyLexiconSnapshotV8 {
  readonly version: typeof FUZZY_LEXICON_VERSION_V8;
  readonly termCount: number;
  readonly gramCount: number;
  readonly postingCount: number;
  readonly droppedTerms: number;
  readonly droppedPostings: number;
  readonly lookups: number;
  readonly candidateTruncations: number;
  readonly fingerprint: string;
}

interface NormalizedFuzzyPolicyV8 {
  readonly maximumTerms: number;
  readonly maximumGramPostings: number;
  readonly maximumCandidates: number;
  readonly maximumSuggestions: number;
  readonly minimumTokenLength: number;
  readonly maximumTokenLength: number;
  readonly maximumEditDistance: number;
  readonly maximumLengthDelta: number;
  readonly minimumGramSimilarity: number;
  readonly exactBoost: number;
  readonly prefixBoost: number;
  readonly frequencyWeight: number;
  readonly sourceLimitPerTerm: number;
}

interface MutableTermV8 {
  readonly term: string;
  frequency: number;
  weight: number;
  readonly sources: Set<string>;
  readonly ordinal: number;
}

interface MutableLexiconStatsV8 {
  droppedTerms: number;
  droppedPostings: number;
  lookups: number;
  candidateTruncations: number;
}

interface CandidateEvidenceV8 {
  readonly ordinal: number;
  readonly sharedGrams: number;
}

const DEFAULT_POLICY_V8: NormalizedFuzzyPolicyV8 = Object.freeze({
  maximumTerms: 100_000,
  maximumGramPostings: 20_000,
  maximumCandidates: 512,
  maximumSuggestions: 12,
  minimumTokenLength: 2,
  maximumTokenLength: 80,
  maximumEditDistance: 3,
  maximumLengthDelta: 3,
  minimumGramSimilarity: 0.18,
  exactBoost: 250,
  prefixBoost: 36,
  frequencyWeight: 8,
  sourceLimitPerTerm: 8,
});

const boundedFinite = (
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number => {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
};

const boundedInteger = (
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number => {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
};

const normalizePolicy = (input: FuzzyLexiconPolicyV8 = {}): NormalizedFuzzyPolicyV8 => Object.freeze({
  maximumTerms: boundedInteger(input.maximumTerms, DEFAULT_POLICY_V8.maximumTerms, 1, 1_000_000, 'maximumTerms'),
  maximumGramPostings: boundedInteger(
    input.maximumGramPostings,
    DEFAULT_POLICY_V8.maximumGramPostings,
    1,
    1_000_000,
    'maximumGramPostings',
  ),
  maximumCandidates: boundedInteger(
    input.maximumCandidates,
    DEFAULT_POLICY_V8.maximumCandidates,
    1,
    50_000,
    'maximumCandidates',
  ),
  maximumSuggestions: boundedInteger(
    input.maximumSuggestions,
    DEFAULT_POLICY_V8.maximumSuggestions,
    1,
    1_000,
    'maximumSuggestions',
  ),
  minimumTokenLength: boundedInteger(
    input.minimumTokenLength,
    DEFAULT_POLICY_V8.minimumTokenLength,
    1,
    32,
    'minimumTokenLength',
  ),
  maximumTokenLength: boundedInteger(
    input.maximumTokenLength,
    DEFAULT_POLICY_V8.maximumTokenLength,
    2,
    256,
    'maximumTokenLength',
  ),
  maximumEditDistance: boundedInteger(
    input.maximumEditDistance,
    DEFAULT_POLICY_V8.maximumEditDistance,
    0,
    8,
    'maximumEditDistance',
  ),
  maximumLengthDelta: boundedInteger(
    input.maximumLengthDelta,
    DEFAULT_POLICY_V8.maximumLengthDelta,
    0,
    16,
    'maximumLengthDelta',
  ),
  minimumGramSimilarity: boundedFinite(
    input.minimumGramSimilarity,
    DEFAULT_POLICY_V8.minimumGramSimilarity,
    0,
    1,
    'minimumGramSimilarity',
  ),
  exactBoost: boundedFinite(input.exactBoost, DEFAULT_POLICY_V8.exactBoost, 0, 10_000, 'exactBoost'),
  prefixBoost: boundedFinite(input.prefixBoost, DEFAULT_POLICY_V8.prefixBoost, 0, 10_000, 'prefixBoost'),
  frequencyWeight: boundedFinite(
    input.frequencyWeight,
    DEFAULT_POLICY_V8.frequencyWeight,
    0,
    1_000,
    'frequencyWeight',
  ),
  sourceLimitPerTerm: boundedInteger(
    input.sourceLimitPerTerm,
    DEFAULT_POLICY_V8.sourceLimitPerTerm,
    0,
    128,
    'sourceLimitPerTerm',
  ),
});

const canonicalTerm = (value: unknown, maximumLength = DEFAULT_POLICY_V8.maximumTokenLength): string =>
  normalizeSearchToken(value)
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, maximumLength);

const canonicalSource = (value: unknown): string => normalizeSearchToken(value)
  .replace(/[^a-z0-9._:-]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 120);

const gramsFor = (term: string): readonly string[] => {
  if (!term) return Object.freeze([]);
  if (term.length === 1) return Object.freeze([`^${term}$`]);
  const padded = `^${term}$`;
  const grams: string[] = [];
  for (let index = 0; index <= padded.length - 3; index += 1) {
    grams.push(padded.slice(index, index + 3));
  }
  return Object.freeze(Array.from(new Set(grams)));
};

const addSources = (
  target: Set<string>,
  sourceInput: unknown,
  maximum: number,
): void => {
  if (maximum <= 0 || target.size >= maximum) return;
  const source = canonicalSource(sourceInput);
  if (source) target.add(source);
};

const addTermInput = (
  terms: Map<string, MutableTermV8>,
  input: FuzzyLexiconTermInputV8,
  policy: NormalizedFuzzyPolicyV8,
  stats: MutableLexiconStatsV8,
): void => {
  const term = canonicalTerm(input.term, policy.maximumTokenLength);
  if (term.length < policy.minimumTokenLength) return;
  const existing = terms.get(term);
  const frequency = normalizeInteger(input.frequency, { min: 1, max: 1_000_000_000, fallback: 1 });
  const weight = boundedFinite(input.weight, 1, 0.01, 1_000, 'term weight');
  if (existing) {
    existing.frequency = Math.min(1_000_000_000, existing.frequency + frequency);
    existing.weight = Math.max(existing.weight, weight);
    addSources(existing.sources, input.source, policy.sourceLimitPerTerm);
    return;
  }
  if (terms.size >= policy.maximumTerms) {
    stats.droppedTerms += 1;
    return;
  }
  const sources = new Set<string>();
  addSources(sources, input.source, policy.sourceLimitPerTerm);
  terms.set(term, {
    term,
    frequency,
    weight,
    sources,
    ordinal: terms.size,
  });
};

const freezeTerm = (value: MutableTermV8): FuzzyLexiconTermV8 => Object.freeze({
  term: value.term,
  frequency: value.frequency,
  weight: value.weight,
  grams: gramsFor(value.term),
  sources: Object.freeze(Array.from(value.sources).sort()),
  ordinal: value.ordinal,
});

const appendGramPostings = (
  postings: Map<string, number[]>,
  term: FuzzyLexiconTermV8,
  maximum: number,
  stats: MutableLexiconStatsV8,
): void => {
  for (const gram of term.grams) {
    const values = postings.get(gram);
    if (values) {
      if (values.length < maximum) values.push(term.ordinal);
      else stats.droppedPostings += 1;
      continue;
    }
    postings.set(gram, [term.ordinal]);
  }
};

const freezePostings = (input: Map<string, number[]>): ReadonlyMap<string, readonly number[]> => {
  const result = new Map<string, readonly number[]>();
  for (const [gram, values] of input) result.set(gram, Object.freeze(values.slice()));
  return result;
};

const collectRecordTerms = (
  record: NormalizedRecord,
  source: string,
): readonly FuzzyLexiconTermInputV8[] => {
  const tokens = new Set<string>();
  const add = (value: string): void => {
    for (const token of tokenizeSearchText(value)) {
      const canonical = canonicalTerm(token);
      if (canonical) tokens.add(canonical);
    }
  };
  add(record.title);
  add(record.category);
  add(record.type);
  add(record.district);
  add(record.neighborhood);
  add(record.street);
  add(record.address);
  add(record.postalCode);
  return Object.freeze(Array.from(tokens).map(term => Object.freeze({ term, source })));
};

const accumulateRecordFrequencies = (
  frequencies: Map<string, number>,
  record: NormalizedRecord,
  source: string,
): void => {
  const terms = collectRecordTerms(record, source);
  for (const item of terms) frequencies.set(item.term, (frequencies.get(item.term) ?? 0) + 1);
};

export const createFuzzyLexiconTermsFromRecordsV8 = (
  records: readonly NormalizedRecord[],
  sourceInput = 'dataset',
  maximumRecordsInput = 200_000,
): readonly FuzzyLexiconTermInputV8[] => {
  const maximumRecords = normalizeInteger(maximumRecordsInput, {
    min: 1,
    max: 1_000_000,
    fallback: 200_000,
  });
  const source = canonicalSource(sourceInput) || 'dataset';
  const frequencies = new Map<string, number>();
  const limit = Math.min(records.length, maximumRecords);
  for (let index = 0; index < limit; index += 1) {
    const record = records[index];
    if (record) accumulateRecordFrequencies(frequencies, record, source);
  }
  return Object.freeze(Array.from(frequencies.entries())
    .map(([term, frequency]) => Object.freeze({ term, frequency, source }))
    .sort((left, right) => right.frequency - left.frequency || left.term.localeCompare(right.term)));
};

const nextDistanceRow = (
  leftCharacter: string,
  previousLeftCharacter: string,
  right: string,
  previous: readonly number[],
  previousPrevious: readonly number[] | null,
  rowIndex: number,
): readonly number[] => {
  const current = Array.from({ length: right.length + 1 }, () => 0);
  current[0] = rowIndex;
  for (let column = 1; column <= right.length; column += 1) {
    const rightCharacter = right[column - 1] ?? '';
    const insertion = (current[column - 1] ?? Number.MAX_SAFE_INTEGER) + 1;
    const deletion = (previous[column] ?? Number.MAX_SAFE_INTEGER) + 1;
    const substitution = (previous[column - 1] ?? Number.MAX_SAFE_INTEGER)
      + (leftCharacter === rightCharacter ? 0 : 1);
    let value = Math.min(insertion, deletion, substitution);
    if (previousPrevious && rowIndex > 1 && column > 1) {
      const transposed = leftCharacter === (right[column - 2] ?? '')
        && previousLeftCharacter === rightCharacter;
      if (transposed) value = Math.min(value, (previousPrevious[column - 2] ?? Number.MAX_SAFE_INTEGER) + 1);
    }
    current[column] = value;
  }
  return current;
};

const minimumValue = (values: readonly number[]): number => {
  let minimum = Number.POSITIVE_INFINITY;
  for (const value of values) minimum = Math.min(minimum, value);
  return minimum;
};

export const boundedDamerauLevenshteinV8 = (
  leftInput: unknown,
  rightInput: unknown,
  maximumDistanceInput = 3,
): number => {
  const left = canonicalTerm(leftInput, 256);
  const right = canonicalTerm(rightInput, 256);
  const maximumDistance = normalizeInteger(maximumDistanceInput, { min: 0, max: 32, fallback: 3 });
  if (left === right) return 0;
  if (!left) return right.length <= maximumDistance ? right.length : maximumDistance + 1;
  if (!right) return left.length <= maximumDistance ? left.length : maximumDistance + 1;
  if (Math.abs(left.length - right.length) > maximumDistance) return maximumDistance + 1;
  let previousPrevious: readonly number[] | null = null;
  let previous: readonly number[] = Array.from({ length: right.length + 1 }, (_value, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = nextDistanceRow(
      left[row - 1] ?? '',
      row > 1 ? left[row - 2] ?? '' : '',
      right,
      previous,
      previousPrevious,
      row,
    );
    if (minimumValue(current) > maximumDistance) return maximumDistance + 1;
    previousPrevious = previous;
    previous = current;
  }
  const distance = previous[right.length] ?? maximumDistance + 1;
  return distance <= maximumDistance ? distance : maximumDistance + 1;
};

const gramSimilarity = (
  inputGrams: readonly string[],
  candidateGrams: readonly string[],
  shared: number,
): number => {
  if (!inputGrams.length && !candidateGrams.length) return 1;
  const union = inputGrams.length + candidateGrams.length - shared;
  return union > 0 ? shared / union : 0;
};

const accumulateCandidateCounts = (
  counts: Map<number, number>,
  ordinals: readonly number[],
): void => {
  for (const ordinal of ordinals) counts.set(ordinal, (counts.get(ordinal) ?? 0) + 1);
};

const candidateEvidence = (
  grams: readonly string[],
  postings: ReadonlyMap<string, readonly number[]>,
  maximumCandidates: number,
): Readonly<{ values: readonly CandidateEvidenceV8[]; truncated: boolean }> => {
  const counts = new Map<number, number>();
  let truncated = false;
  for (const gram of grams) {
    accumulateCandidateCounts(counts, postings.get(gram) ?? []);
    if (counts.size > maximumCandidates * 4) {
      truncated = true;
      break;
    }
  }
  const values = Array.from(counts.entries())
    .map(([ordinal, sharedGrams]) => Object.freeze({ ordinal, sharedGrams }))
    .sort((left, right) => right.sharedGrams - left.sharedGrams || left.ordinal - right.ordinal)
    .slice(0, maximumCandidates);
  if (counts.size > maximumCandidates) truncated = true;
  return Object.freeze({ values: Object.freeze(values), truncated });
};

const suggestionScore = (
  term: FuzzyLexiconTermV8,
  distance: number,
  similarity: number,
  exact: boolean,
  prefix: boolean,
  policy: NormalizedFuzzyPolicyV8,
): number => {
  const distanceScore = Math.max(0, policy.maximumEditDistance + 1 - distance) * 100;
  const gramScore = similarity * 100;
  const frequencyScore = Math.log2(term.frequency + 1) * policy.frequencyWeight;
  const weightScore = Math.log2(term.weight + 1) * 10;
  return distanceScore
    + gramScore
    + frequencyScore
    + weightScore
    + (exact ? policy.exactBoost : 0)
    + (prefix ? policy.prefixBoost : 0);
};

const compareSuggestions = (left: FuzzySuggestionV8, right: FuzzySuggestionV8): number => {
  if (right.score !== left.score) return right.score - left.score;
  if (left.editDistance !== right.editDistance) return left.editDistance - right.editDistance;
  if (right.gramSimilarity !== left.gramSimilarity) return right.gramSimilarity - left.gramSimilarity;
  if (right.frequency !== left.frequency) return right.frequency - left.frequency;
  return left.term.localeCompare(right.term, 'tr-TR', { sensitivity: 'base', numeric: true });
};

const evaluateCandidate = (
  canonical: string,
  inputGrams: readonly string[],
  evidence: CandidateEvidenceV8,
  terms: readonly FuzzyLexiconTermV8[],
  policy: NormalizedFuzzyPolicyV8,
): Readonly<{ suggestion: FuzzySuggestionV8 | null; rejection: 'length' | 'gram' | 'distance' | null }> => {
  const term = terms[evidence.ordinal];
  if (!term) return Object.freeze({ suggestion: null, rejection: 'distance' });
  if (Math.abs(canonical.length - term.term.length) > policy.maximumLengthDelta) {
    return Object.freeze({ suggestion: null, rejection: 'length' });
  }
  const similarity = gramSimilarity(inputGrams, term.grams, evidence.sharedGrams);
  const exact = canonical === term.term;
  const prefix = !exact && (term.term.startsWith(canonical) || canonical.startsWith(term.term));
  if (!exact && !prefix && similarity < policy.minimumGramSimilarity) {
    return Object.freeze({ suggestion: null, rejection: 'gram' });
  }
  const distance = boundedDamerauLevenshteinV8(canonical, term.term, policy.maximumEditDistance);
  if (distance > policy.maximumEditDistance) {
    return Object.freeze({ suggestion: null, rejection: 'distance' });
  }
  const suggestion: FuzzySuggestionV8 = Object.freeze({
    term: term.term,
    editDistance: distance,
    gramSimilarity: similarity,
    prefix,
    exact,
    frequency: term.frequency,
    weight: term.weight,
    score: suggestionScore(term, distance, similarity, exact, prefix, policy),
    sources: term.sources,
  });
  return Object.freeze({ suggestion, rejection: null });
};

export class FuzzyLexiconRuntimeV8 {
  readonly #policy: NormalizedFuzzyPolicyV8;
  readonly #terms: readonly FuzzyLexiconTermV8[];
  readonly #byTerm: ReadonlyMap<string, FuzzyLexiconTermV8>;
  readonly #postings: ReadonlyMap<string, readonly number[]>;
  readonly #stats: MutableLexiconStatsV8;
  readonly #fingerprint: string;

  constructor(
    inputs: readonly FuzzyLexiconTermInputV8[] = [],
    policyInput: FuzzyLexiconPolicyV8 = {},
  ) {
    this.#policy = normalizePolicy(policyInput);
    this.#stats = {
      droppedTerms: 0,
      droppedPostings: 0,
      lookups: 0,
      candidateTruncations: 0,
    };
    const mutable = new Map<string, MutableTermV8>();
    for (const input of inputs) addTermInput(mutable, input, this.#policy, this.#stats);
    this.#terms = Object.freeze(Array.from(mutable.values()).map(freezeTerm));
    const byTerm = new Map<string, FuzzyLexiconTermV8>();
    for (const term of this.#terms) byTerm.set(term.term, term);
    this.#byTerm = byTerm;
    const postings = new Map<string, number[]>();
    for (const term of this.#terms) appendGramPostings(postings, term, this.#policy.maximumGramPostings, this.#stats);
    this.#postings = freezePostings(postings);
    this.#fingerprint = hashFingerprint(stableSerialize({
      version: FUZZY_LEXICON_VERSION_V8,
      policy: this.#policy,
      terms: this.#terms.map(term => [term.term, term.frequency, term.weight, term.sources]),
    }));
  }

  policy(): FuzzyLexiconPolicyV8 {
    return Object.freeze({ ...this.#policy });
  }

  term(value: unknown): FuzzyLexiconTermV8 | null {
    return this.#byTerm.get(canonicalTerm(value, this.#policy.maximumTokenLength)) ?? null;
  }

  has(value: unknown): boolean {
    return this.term(value) !== null;
  }

  lookup(value: unknown, maximumSuggestionsInput?: number): FuzzyLookupResultV8 {
    this.#stats.lookups += 1;
    const input = value === null || value === undefined ? '' : String(value);
    const canonical = canonicalTerm(input, this.#policy.maximumTokenLength);
    const maximumSuggestions = boundedInteger(
      maximumSuggestionsInput,
      this.#policy.maximumSuggestions,
      1,
      this.#policy.maximumSuggestions,
      'maximumSuggestions',
    );
    const inputGrams = gramsFor(canonical);
    if (canonical.length < this.#policy.minimumTokenLength || inputGrams.length === 0) {
      return Object.freeze({
        suggestions: Object.freeze([]),
        diagnostics: Object.freeze({
          input,
          canonical,
          gramCount: inputGrams.length,
          candidateCount: 0,
          evaluatedCount: 0,
          rejectedLength: 0,
          rejectedGram: 0,
          rejectedDistance: 0,
          candidateTruncated: false,
          suggestionTruncated: false,
        }),
      });
    }

    const direct = this.#byTerm.get(canonical);
    const evidence = candidateEvidence(inputGrams, this.#postings, this.#policy.maximumCandidates);
    if (evidence.truncated) this.#stats.candidateTruncations += 1;
    const suggestions: FuzzySuggestionV8[] = [];
    let rejectedLength = 0;
    let rejectedGram = 0;
    let rejectedDistance = 0;
    let evaluatedCount = 0;

    if (direct) {
      const similarity = gramSimilarity(inputGrams, direct.grams, direct.grams.length);
      suggestions.push(Object.freeze({
        term: direct.term,
        editDistance: 0,
        gramSimilarity: similarity,
        prefix: false,
        exact: true,
        frequency: direct.frequency,
        weight: direct.weight,
        score: suggestionScore(direct, 0, similarity, true, false, this.#policy),
        sources: direct.sources,
      }));
    }

    for (const candidate of evidence.values) {
      const term = this.#terms[candidate.ordinal];
      if (!term || term.term === canonical) continue;
      evaluatedCount += 1;
      const evaluated = evaluateCandidate(canonical, inputGrams, candidate, this.#terms, this.#policy);
      if (evaluated.suggestion) suggestions.push(evaluated.suggestion);
      else if (evaluated.rejection === 'length') rejectedLength += 1;
      else if (evaluated.rejection === 'gram') rejectedGram += 1;
      else rejectedDistance += 1;
    }

    suggestions.sort(compareSuggestions);
    const suggestionTruncated = suggestions.length > maximumSuggestions;
    const selected = Object.freeze(suggestions.slice(0, maximumSuggestions));
    return Object.freeze({
      suggestions: selected,
      diagnostics: Object.freeze({
        input,
        canonical,
        gramCount: inputGrams.length,
        candidateCount: evidence.values.length,
        evaluatedCount,
        rejectedLength,
        rejectedGram,
        rejectedDistance,
        candidateTruncated: evidence.truncated,
        suggestionTruncated,
      }),
    });
  }

  terms(): readonly FuzzyLexiconTermV8[] {
    return this.#terms;
  }

  snapshot(): FuzzyLexiconSnapshotV8 {
    let postingCount = 0;
    for (const values of this.#postings.values()) postingCount += values.length;
    return Object.freeze({
      version: FUZZY_LEXICON_VERSION_V8,
      termCount: this.#terms.length,
      gramCount: this.#postings.size,
      postingCount,
      droppedTerms: this.#stats.droppedTerms,
      droppedPostings: this.#stats.droppedPostings,
      lookups: this.#stats.lookups,
      candidateTruncations: this.#stats.candidateTruncations,
      fingerprint: this.#fingerprint,
    });
  }
}

export const createFuzzyLexiconRuntimeV8 = (
  inputs: readonly FuzzyLexiconTermInputV8[] = [],
  policy: FuzzyLexiconPolicyV8 = {},
): FuzzyLexiconRuntimeV8 => new FuzzyLexiconRuntimeV8(inputs, policy);
