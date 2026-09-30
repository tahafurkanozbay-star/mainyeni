import type { NormalizedRecord } from './contracts';
import { normalizeSearchText, normalizeSearchToken } from './normalization';
import type { TextQueryAnalysis, TextQueryField } from './textQueryAnalysisRuntime';

export interface RelevanceFieldWeights {
  readonly title: number;
  readonly category: number;
  readonly type: number;
  readonly district: number;
  readonly neighborhood: number;
  readonly street: number;
  readonly address: number;
  readonly postalCode: number;
  readonly any: number;
}

export interface RelevanceIndexPolicy {
  readonly maximumRecords: number;
  readonly maximumDistinctTerms: number;
  readonly maximumPostingsPerTerm: number;
  readonly maximumCandidates: number;
  readonly maximumResults: number;
  readonly maximumPrefixExpansions: number;
  readonly minimumPrefixLength: number;
  readonly k1: number;
  readonly lengthNormalization: number;
  readonly phraseBoost: number;
  readonly exactTitleBoost: number;
  readonly prefixMultiplier: number;
  readonly fieldWeights: RelevanceFieldWeights;
}

export interface RelevanceTermContribution {
  readonly term: string;
  readonly score: number;
  readonly exact: boolean;
  readonly prefix: boolean;
  readonly documentFrequency: number;
}

export interface RelevanceHit {
  readonly record: NormalizedRecord;
  readonly recordIndex: number;
  readonly rank: number;
  readonly score: number;
  readonly matchedTerms: readonly string[];
  readonly contributions: readonly RelevanceTermContribution[];
  readonly phraseMatches: number;
  readonly fieldMatches: number;
}

export interface RelevanceSearchDiagnostics {
  readonly candidateCount: number;
  readonly scoredCount: number;
  readonly rejectedRequired: number;
  readonly rejectedExcluded: number;
  readonly rejectedField: number;
  readonly rejectedPhrase: number;
  readonly prefixExpansions: number;
  readonly candidateTruncated: boolean;
  readonly resultTruncated: boolean;
}

export interface RelevanceSearchResult {
  readonly hits: readonly RelevanceHit[];
  readonly diagnostics: RelevanceSearchDiagnostics;
}

export interface RelevanceIndexSnapshot {
  readonly revision: string;
  readonly recordCount: number;
  readonly distinctTerms: number;
  readonly postingCount: number;
  readonly averageDocumentLength: number;
  readonly truncatedTerms: number;
  readonly droppedPostings: number;
}

interface Posting {
  readonly recordIndex: number;
  readonly weightedFrequency: number;
}

interface IndexedDocument {
  readonly record: NormalizedRecord;
  readonly termWeights: ReadonlyMap<string, number>;
  readonly fieldTerms: Readonly<Record<TextQueryField, ReadonlySet<string>>>;
  readonly normalizedFields: Readonly<Record<TextQueryField, string>>;
  readonly searchBlob: string;
  readonly length: number;
}

interface MutableIndexStats {
  postingCount: number;
  truncatedTerms: number;
  droppedPostings: number;
  totalDocumentLength: number;
}

interface CandidateBuildState {
  readonly positions: Set<number>;
  prefixExpansions: number;
  truncated: boolean;
}

interface EvaluationState {
  rejectedRequired: number;
  rejectedExcluded: number;
  rejectedField: number;
  rejectedPhrase: number;
  scoredCount: number;
}

interface TermFamilyCache {
  readonly terms: Map<string, readonly string[]>;
  readonly documentFrequencies: Map<string, number>;
}

const DEFAULT_FIELD_WEIGHTS: RelevanceFieldWeights = Object.freeze({
  title: 8,
  category: 5,
  type: 5,
  district: 3,
  neighborhood: 3,
  street: 4,
  address: 2,
  postalCode: 4,
  any: 1,
});

const DEFAULT_POLICY: RelevanceIndexPolicy = Object.freeze({
  maximumRecords: 200_000,
  maximumDistinctTerms: 150_000,
  maximumPostingsPerTerm: 50_000,
  maximumCandidates: 20_000,
  maximumResults: 500,
  maximumPrefixExpansions: 64,
  minimumPrefixLength: 2,
  k1: 1.2,
  lengthNormalization: 0.75,
  phraseBoost: 5,
  exactTitleBoost: 8,
  prefixMultiplier: 0.65,
  fieldWeights: DEFAULT_FIELD_WEIGHTS,
});

const QUERY_FIELDS: readonly TextQueryField[] = Object.freeze([
  'title',
  'category',
  'type',
  'district',
  'neighborhood',
  'street',
  'address',
  'postalCode',
  'any',
]);

const normalizeInteger = (value: number | undefined, fallback: number, minimum: number, maximum: number): number => {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`index policy integer must be between ${minimum} and ${maximum}`);
  }
  return value;
};

const normalizeFinite = (value: number | undefined, fallback: number, minimum: number, maximum: number): number => {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`index policy number must be between ${minimum} and ${maximum}`);
  }
  return value;
};

const normalizeFieldWeight = (value: number | undefined, fallback: number): number => normalizeFinite(value, fallback, 0, 100);

const normalizeFieldWeights = (input: Partial<RelevanceFieldWeights> | undefined): RelevanceFieldWeights => Object.freeze({
  title: normalizeFieldWeight(input?.title, DEFAULT_FIELD_WEIGHTS.title),
  category: normalizeFieldWeight(input?.category, DEFAULT_FIELD_WEIGHTS.category),
  type: normalizeFieldWeight(input?.type, DEFAULT_FIELD_WEIGHTS.type),
  district: normalizeFieldWeight(input?.district, DEFAULT_FIELD_WEIGHTS.district),
  neighborhood: normalizeFieldWeight(input?.neighborhood, DEFAULT_FIELD_WEIGHTS.neighborhood),
  street: normalizeFieldWeight(input?.street, DEFAULT_FIELD_WEIGHTS.street),
  address: normalizeFieldWeight(input?.address, DEFAULT_FIELD_WEIGHTS.address),
  postalCode: normalizeFieldWeight(input?.postalCode, DEFAULT_FIELD_WEIGHTS.postalCode),
  any: normalizeFieldWeight(input?.any, DEFAULT_FIELD_WEIGHTS.any),
});

const normalizePolicy = (input: Partial<RelevanceIndexPolicy>): RelevanceIndexPolicy => Object.freeze({
  maximumRecords: normalizeInteger(input.maximumRecords, DEFAULT_POLICY.maximumRecords, 1, 1_000_000),
  maximumDistinctTerms: normalizeInteger(input.maximumDistinctTerms, DEFAULT_POLICY.maximumDistinctTerms, 128, 1_000_000),
  maximumPostingsPerTerm: normalizeInteger(input.maximumPostingsPerTerm, DEFAULT_POLICY.maximumPostingsPerTerm, 1, 1_000_000),
  maximumCandidates: normalizeInteger(input.maximumCandidates, DEFAULT_POLICY.maximumCandidates, 1, 1_000_000),
  maximumResults: normalizeInteger(input.maximumResults, DEFAULT_POLICY.maximumResults, 1, 10_000),
  maximumPrefixExpansions: normalizeInteger(input.maximumPrefixExpansions, DEFAULT_POLICY.maximumPrefixExpansions, 0, 2048),
  minimumPrefixLength: normalizeInteger(input.minimumPrefixLength, DEFAULT_POLICY.minimumPrefixLength, 1, 64),
  k1: normalizeFinite(input.k1, DEFAULT_POLICY.k1, 0.1, 10),
  lengthNormalization: normalizeFinite(input.lengthNormalization, DEFAULT_POLICY.lengthNormalization, 0, 1),
  phraseBoost: normalizeFinite(input.phraseBoost, DEFAULT_POLICY.phraseBoost, 0, 100),
  exactTitleBoost: normalizeFinite(input.exactTitleBoost, DEFAULT_POLICY.exactTitleBoost, 0, 100),
  prefixMultiplier: normalizeFinite(input.prefixMultiplier, DEFAULT_POLICY.prefixMultiplier, 0, 1),
  fieldWeights: normalizeFieldWeights(input.fieldWeights),
});

const tokenizeWithFrequency = (value: string): ReadonlyMap<string, number> => {
  const normalized = normalizeSearchText(value).replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  const frequencies = new Map<string, number>();
  if (!normalized) return frequencies;
  const tokens = normalized.split(' ');
  for (const token of tokens) {
    if (!token) continue;
    frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  }
  return frequencies;
};

const mergeFrequency = (target: Map<string, number>, source: ReadonlyMap<string, number>, weight: number): void => {
  if (weight <= 0) return;
  for (const [term, count] of source) target.set(term, (target.get(term) ?? 0) + count * weight);
};

const toTermSet = (value: string): ReadonlySet<string> => new Set(tokenizeWithFrequency(value).keys());

const documentFieldText = (record: NormalizedRecord): Record<TextQueryField, string> => ({
  title: record.title,
  category: record.category,
  type: record.type,
  district: record.district,
  neighborhood: record.neighborhood,
  street: record.street,
  address: record.address,
  postalCode: record.postalCode,
  any: record.searchText,
});

const normalizeFieldTexts = (record: NormalizedRecord): Readonly<Record<TextQueryField, string>> => {
  const fields = documentFieldText(record);
  return Object.freeze({
    title: normalizeSearchText(fields.title),
    category: normalizeSearchText(fields.category),
    type: normalizeSearchText(fields.type),
    district: normalizeSearchText(fields.district),
    neighborhood: normalizeSearchText(fields.neighborhood),
    street: normalizeSearchText(fields.street),
    address: normalizeSearchText(fields.address),
    postalCode: normalizeSearchText(fields.postalCode),
    any: normalizeSearchText(fields.any),
  });
};

const buildFieldTermSets = (normalizedFields: Readonly<Record<TextQueryField, string>>): Readonly<Record<TextQueryField, ReadonlySet<string>>> => Object.freeze({
  title: toTermSet(normalizedFields.title),
  category: toTermSet(normalizedFields.category),
  type: toTermSet(normalizedFields.type),
  district: toTermSet(normalizedFields.district),
  neighborhood: toTermSet(normalizedFields.neighborhood),
  street: toTermSet(normalizedFields.street),
  address: toTermSet(normalizedFields.address),
  postalCode: toTermSet(normalizedFields.postalCode),
  any: toTermSet(normalizedFields.any),
});

const addFieldWeights = (
  target: Map<string, number>,
  normalizedFields: Readonly<Record<TextQueryField, string>>,
  weights: RelevanceFieldWeights,
): void => {
  mergeFrequency(target, tokenizeWithFrequency(normalizedFields.title), weights.title);
  mergeFrequency(target, tokenizeWithFrequency(normalizedFields.category), weights.category);
  mergeFrequency(target, tokenizeWithFrequency(normalizedFields.type), weights.type);
  mergeFrequency(target, tokenizeWithFrequency(normalizedFields.district), weights.district);
  mergeFrequency(target, tokenizeWithFrequency(normalizedFields.neighborhood), weights.neighborhood);
  mergeFrequency(target, tokenizeWithFrequency(normalizedFields.street), weights.street);
  mergeFrequency(target, tokenizeWithFrequency(normalizedFields.address), weights.address);
  mergeFrequency(target, tokenizeWithFrequency(normalizedFields.postalCode), weights.postalCode);
  mergeFrequency(target, tokenizeWithFrequency(normalizedFields.any), weights.any);
};

const createDocument = (record: NormalizedRecord, weights: RelevanceFieldWeights): IndexedDocument => {
  const normalizedFields = normalizeFieldTexts(record);
  const termWeights = new Map<string, number>();
  addFieldWeights(termWeights, normalizedFields, weights);
  let length = 0;
  for (const weightedFrequency of termWeights.values()) length += weightedFrequency;
  const searchBlob = [
    normalizedFields.title,
    normalizedFields.category,
    normalizedFields.type,
    normalizedFields.district,
    normalizedFields.neighborhood,
    normalizedFields.street,
    normalizedFields.address,
    normalizedFields.postalCode,
    normalizedFields.any,
  ].filter(Boolean).join(' ');
  return Object.freeze({
    record,
    termWeights,
    fieldTerms: buildFieldTermSets(normalizedFields),
    normalizedFields,
    searchBlob,
    length: Math.max(1, length),
  });
};

const appendPosting = (
  postings: Map<string, Posting[]>,
  term: string,
  posting: Posting,
  policy: RelevanceIndexPolicy,
  stats: MutableIndexStats,
): void => {
  let list = postings.get(term);
  if (!list) {
    if (postings.size >= policy.maximumDistinctTerms) {
      stats.truncatedTerms += 1;
      return;
    }
    list = [];
    postings.set(term, list);
  }
  if (list.length >= policy.maximumPostingsPerTerm) {
    stats.droppedPostings += 1;
    return;
  }
  list.push(posting);
  stats.postingCount += 1;
};

const indexDocumentTerms = (
  postings: Map<string, Posting[]>,
  document: IndexedDocument,
  recordIndex: number,
  policy: RelevanceIndexPolicy,
  stats: MutableIndexStats,
): void => {
  for (const [term, weightedFrequency] of document.termWeights) {
    appendPosting(postings, term, Object.freeze({ recordIndex, weightedFrequency }), policy, stats);
  }
};

const freezePostings = (postings: Map<string, Posting[]>): ReadonlyMap<string, readonly Posting[]> => {
  const result = new Map<string, readonly Posting[]>();
  for (const [term, list] of postings) result.set(term, Object.freeze(list.slice()));
  return result;
};

const sortedDictionary = (postings: ReadonlyMap<string, readonly Posting[]>): readonly string[] => Object.freeze(Array.from(postings.keys()).sort());

const lowerBound = (values: readonly string[], target: string): number => {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if ((values[middle] ?? '') < target) low = middle + 1;
    else high = middle;
  }
  return low;
};

const expandPrefix = (
  dictionary: readonly string[],
  prefix: string,
  maximum: number,
): readonly string[] => {
  if (maximum <= 0) return Object.freeze([]);
  const start = lowerBound(dictionary, prefix);
  const result: string[] = [];
  let cursor = start;
  while (cursor < dictionary.length && result.length < maximum) {
    const term = dictionary[cursor];
    if (!term || !term.startsWith(prefix)) break;
    result.push(term);
    cursor += 1;
  }
  return Object.freeze(result);
};

const freeTextTerms = (analysis: TextQueryAnalysis): readonly string[] => Object.freeze(Array.from(new Set([
  ...analysis.requiredTerms,
  ...analysis.optionalTerms,
])));

const fieldSeedTerms = (analysis: TextQueryAnalysis): readonly string[] => {
  const values: string[] = [];
  for (const field of QUERY_FIELDS) values.push(...analysis.fieldTerms[field]);
  return Object.freeze(Array.from(new Set(values)));
};

const createTermFamilyCache = (): TermFamilyCache => ({
  terms: new Map<string, readonly string[]>(),
  documentFrequencies: new Map<string, number>(),
});

const termFamily = (
  term: string,
  postings: ReadonlyMap<string, readonly Posting[]>,
  dictionary: readonly string[],
  policy: RelevanceIndexPolicy,
  cache: TermFamilyCache,
): readonly string[] => {
  const cached = cache.terms.get(term);
  if (cached) return cached;
  const family: string[] = [];
  if (postings.has(term)) family.push(term);
  if (term.length >= policy.minimumPrefixLength && policy.maximumPrefixExpansions > 0) {
    const expanded = expandPrefix(dictionary, term, policy.maximumPrefixExpansions);
    for (const expandedTerm of expanded) {
      if (expandedTerm !== term) family.push(expandedTerm);
    }
  }
  const frozen = Object.freeze(Array.from(new Set(family)));
  cache.terms.set(term, frozen);
  return frozen;
};

const addPostingRecords = (target: Set<number>, list: readonly Posting[] | undefined): void => {
  if (!list) return;
  for (const posting of list) target.add(posting.recordIndex);
};

const familyDocumentFrequency = (
  term: string,
  postings: ReadonlyMap<string, readonly Posting[]>,
  dictionary: readonly string[],
  policy: RelevanceIndexPolicy,
  cache: TermFamilyCache,
): number => {
  const cached = cache.documentFrequencies.get(term);
  if (cached !== undefined) return cached;
  const records = new Set<number>();
  for (const familyTerm of termFamily(term, postings, dictionary, policy, cache)) {
    addPostingRecords(records, postings.get(familyTerm));
  }
  const frequency = records.size;
  cache.documentFrequencies.set(term, frequency);
  return frequency;
};

const addPostingsToCandidates = (state: CandidateBuildState, list: readonly Posting[] | undefined, maximum: number): void => {
  if (!list || state.truncated) return;
  for (const posting of list) {
    if (state.positions.has(posting.recordIndex)) continue;
    if (state.positions.size >= maximum) {
      state.truncated = true;
      return;
    }
    state.positions.add(posting.recordIndex);
  }
};

const addExactCandidateTerm = (
  state: CandidateBuildState,
  postings: ReadonlyMap<string, readonly Posting[]>,
  term: string,
  maximum: number,
): void => addPostingsToCandidates(state, postings.get(term), maximum);

const addTermFamilyCandidates = (
  state: CandidateBuildState,
  postings: ReadonlyMap<string, readonly Posting[]>,
  dictionary: readonly string[],
  term: string,
  policy: RelevanceIndexPolicy,
  cache: TermFamilyCache,
): void => {
  const family = termFamily(term, postings, dictionary, policy, cache);
  for (const familyTerm of family) {
    if (familyTerm !== term) state.prefixExpansions += 1;
    addPostingsToCandidates(state, postings.get(familyTerm), policy.maximumCandidates);
    if (state.truncated) return;
  }
};

const buildCandidates = (
  analysis: TextQueryAnalysis,
  postings: ReadonlyMap<string, readonly Posting[]>,
  dictionary: readonly string[],
  documentCount: number,
  policy: RelevanceIndexPolicy,
  cache: TermFamilyCache,
): CandidateBuildState => {
  const state: CandidateBuildState = { positions: new Set<number>(), prefixExpansions: 0, truncated: false };
  const freeTerms = freeTextTerms(analysis);
  if (freeTerms.length > 0) {
    for (const term of freeTerms) {
      addTermFamilyCandidates(state, postings, dictionary, term, policy, cache);
      if (state.truncated) break;
    }
    return state;
  }
  const fieldTerms = fieldSeedTerms(analysis);
  if (fieldTerms.length > 0) {
    for (const term of fieldTerms) {
      addExactCandidateTerm(state, postings, term, policy.maximumCandidates);
      if (state.truncated) break;
    }
    return state;
  }
  if (analysis.phrases.length > 0) {
    const bound = Math.min(documentCount, policy.maximumCandidates);
    for (let index = 0; index < bound; index += 1) state.positions.add(index);
    state.truncated = documentCount > bound;
  }
  return state;
};

const documentMatchesTermFamily = (
  document: IndexedDocument,
  term: string,
  postings: ReadonlyMap<string, readonly Posting[]>,
  dictionary: readonly string[],
  policy: RelevanceIndexPolicy,
  cache: TermFamilyCache,
): boolean => {
  for (const familyTerm of termFamily(term, postings, dictionary, policy, cache)) {
    if (document.termWeights.has(familyTerm)) return true;
  }
  return false;
};

const containsRequiredTerms = (
  document: IndexedDocument,
  terms: readonly string[],
  postings: ReadonlyMap<string, readonly Posting[]>,
  dictionary: readonly string[],
  policy: RelevanceIndexPolicy,
  cache: TermFamilyCache,
): boolean => {
  for (const term of terms) {
    if (!documentMatchesTermFamily(document, term, postings, dictionary, policy, cache)) return false;
  }
  return true;
};

const containsExcludedTerms = (
  document: IndexedDocument,
  terms: readonly string[],
  postings: ReadonlyMap<string, readonly Posting[]>,
  dictionary: readonly string[],
  policy: RelevanceIndexPolicy,
  cache: TermFamilyCache,
): boolean => {
  for (const term of terms) {
    if (documentMatchesTermFamily(document, term, postings, dictionary, policy, cache)) return true;
  }
  return false;
};

const matchesFieldTerms = (document: IndexedDocument, analysis: TextQueryAnalysis): boolean => {
  for (const field of QUERY_FIELDS) {
    const terms = analysis.fieldTerms[field];
    if (terms.length === 0) continue;
    const documentTerms = document.fieldTerms[field];
    for (const term of terms) if (!documentTerms.has(term)) return false;
  }
  return true;
};

const countFieldMatches = (document: IndexedDocument, analysis: TextQueryAnalysis): number => {
  let count = 0;
  for (const field of QUERY_FIELDS) {
    const terms = analysis.fieldTerms[field];
    if (terms.length === 0) continue;
    const documentTerms = document.fieldTerms[field];
    for (const term of terms) if (documentTerms.has(term)) count += 1;
  }
  return count;
};

const matchesPhrases = (document: IndexedDocument, phrases: readonly string[]): boolean => {
  for (const phrase of phrases) if (!document.searchBlob.includes(phrase)) return false;
  return true;
};

const countPhraseMatches = (document: IndexedDocument, phrases: readonly string[]): number => {
  let count = 0;
  for (const phrase of phrases) if (document.searchBlob.includes(phrase)) count += 1;
  return count;
};

const idf = (documentCount: number, documentFrequency: number): number => Math.log1p((documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5));

const postingForRecord = (list: readonly Posting[] | undefined, recordIndex: number): Posting | null => {
  if (!list) return null;
  for (const posting of list) if (posting.recordIndex === recordIndex) return posting;
  return null;
};

const scorePosting = (
  posting: Posting,
  documentLength: number,
  averageLength: number,
  documentFrequency: number,
  documentCount: number,
  policy: RelevanceIndexPolicy,
): number => {
  const normalizedLength = 1 - policy.lengthNormalization + policy.lengthNormalization * (documentLength / Math.max(1, averageLength));
  const denominator = posting.weightedFrequency + policy.k1 * normalizedLength;
  const saturation = (posting.weightedFrequency * (policy.k1 + 1)) / Math.max(Number.EPSILON, denominator);
  return idf(documentCount, documentFrequency) * saturation;
};

const exactContribution = (
  term: string,
  recordIndex: number,
  document: IndexedDocument,
  postings: ReadonlyMap<string, readonly Posting[]>,
  dictionary: readonly string[],
  documentCount: number,
  averageLength: number,
  policy: RelevanceIndexPolicy,
  cache: TermFamilyCache,
): RelevanceTermContribution | null => {
  const list = postings.get(term);
  const posting = postingForRecord(list, recordIndex);
  if (!posting || !list) return null;
  const semanticDocumentFrequency = Math.max(1, familyDocumentFrequency(term, postings, dictionary, policy, cache));
  return Object.freeze({
    term,
    score: scorePosting(posting, document.length, averageLength, semanticDocumentFrequency, documentCount, policy),
    exact: true,
    prefix: false,
    documentFrequency: semanticDocumentFrequency,
  });
};

const prefixContribution = (
  requestedTerm: string,
  recordIndex: number,
  document: IndexedDocument,
  postings: ReadonlyMap<string, readonly Posting[]>,
  dictionary: readonly string[],
  documentCount: number,
  averageLength: number,
  policy: RelevanceIndexPolicy,
  cache: TermFamilyCache,
): RelevanceTermContribution | null => {
  if (requestedTerm.length < policy.minimumPrefixLength) return null;
  const family = termFamily(requestedTerm, postings, dictionary, policy, cache);
  let bestTerm = '';
  let bestScore = 0;
  for (const term of family) {
    if (term === requestedTerm) continue;
    const list = postings.get(term);
    const posting = postingForRecord(list, recordIndex);
    if (!posting || !list) continue;
    const score = scorePosting(posting, document.length, averageLength, list.length, documentCount, policy) * policy.prefixMultiplier;
    if (score > bestScore) {
      bestTerm = term;
      bestScore = score;
    }
  }
  if (!bestTerm) return null;
  return Object.freeze({
    term: bestTerm,
    score: bestScore,
    exact: false,
    prefix: true,
    documentFrequency: Math.max(1, familyDocumentFrequency(requestedTerm, postings, dictionary, policy, cache)),
  });
};

const termContribution = (
  requestedTerm: string,
  recordIndex: number,
  document: IndexedDocument,
  postings: ReadonlyMap<string, readonly Posting[]>,
  dictionary: readonly string[],
  documentCount: number,
  averageLength: number,
  policy: RelevanceIndexPolicy,
  cache: TermFamilyCache,
): RelevanceTermContribution | null => exactContribution(
  requestedTerm,
  recordIndex,
  document,
  postings,
  dictionary,
  documentCount,
  averageLength,
  policy,
  cache,
) ?? prefixContribution(
  requestedTerm,
  recordIndex,
  document,
  postings,
  dictionary,
  documentCount,
  averageLength,
  policy,
  cache,
);

const buildContributions = (
  analysis: TextQueryAnalysis,
  recordIndex: number,
  document: IndexedDocument,
  postings: ReadonlyMap<string, readonly Posting[]>,
  dictionary: readonly string[],
  documentCount: number,
  averageLength: number,
  policy: RelevanceIndexPolicy,
  cache: TermFamilyCache,
): readonly RelevanceTermContribution[] => {
  const contributions: RelevanceTermContribution[] = [];
  for (const term of freeTextTerms(analysis)) {
    const contribution = termContribution(term, recordIndex, document, postings, dictionary, documentCount, averageLength, policy, cache);
    if (contribution) contributions.push(contribution);
  }
  return Object.freeze(contributions);
};

const sumContributionScore = (contributions: readonly RelevanceTermContribution[]): number => {
  let score = 0;
  for (const contribution of contributions) score += contribution.score;
  return score;
};

const exactTitleBonus = (document: IndexedDocument, analysis: TextQueryAnalysis, policy: RelevanceIndexPolicy): number => {
  if (!analysis.normalized) return 0;
  return document.normalizedFields.title === analysis.normalized ? policy.exactTitleBoost : 0;
};

const evaluateCandidate = (
  recordIndex: number,
  document: IndexedDocument,
  analysis: TextQueryAnalysis,
  postings: ReadonlyMap<string, readonly Posting[]>,
  dictionary: readonly string[],
  documentCount: number,
  averageLength: number,
  policy: RelevanceIndexPolicy,
  state: EvaluationState,
  cache: TermFamilyCache,
): RelevanceHit | null => {
  if (!containsRequiredTerms(document, analysis.requiredTerms, postings, dictionary, policy, cache)) {
    state.rejectedRequired += 1;
    return null;
  }
  if (containsExcludedTerms(document, analysis.excludedTerms, postings, dictionary, policy, cache)) {
    state.rejectedExcluded += 1;
    return null;
  }
  if (!matchesFieldTerms(document, analysis)) {
    state.rejectedField += 1;
    return null;
  }
  if (!matchesPhrases(document, analysis.phrases)) {
    state.rejectedPhrase += 1;
    return null;
  }
  const contributions = buildContributions(analysis, recordIndex, document, postings, dictionary, documentCount, averageLength, policy, cache);
  const phraseMatches = countPhraseMatches(document, analysis.phrases);
  const fieldMatches = countFieldMatches(document, analysis);
  const score = sumContributionScore(contributions)
    + phraseMatches * policy.phraseBoost
    + fieldMatches * 2
    + exactTitleBonus(document, analysis, policy);
  state.scoredCount += 1;
  return Object.freeze({
    record: document.record,
    recordIndex,
    rank: 0,
    score,
    matchedTerms: Object.freeze(contributions.map((contribution) => contribution.term)),
    contributions,
    phraseMatches,
    fieldMatches,
  });
};

const compareHits = (left: RelevanceHit, right: RelevanceHit): number => {
  const scoreDifference = right.score - left.score;
  if (Math.abs(scoreDifference) > Number.EPSILON) return scoreDifference;
  const title = left.record.title.localeCompare(right.record.title, 'tr-TR', { sensitivity: 'base' });
  if (title !== 0) return title;
  const source = left.record.sourceIndex - right.record.sourceIndex;
  if (source !== 0) return source;
  return left.record.fingerprint.localeCompare(right.record.fingerprint);
};

const assignRanks = (hits: readonly RelevanceHit[], maximum: number): readonly RelevanceHit[] => Object.freeze(hits.slice(0, maximum).map((hit, index) => Object.freeze({ ...hit, rank: index + 1 })));

export class RelevanceIndexRuntime {
  readonly #policy: RelevanceIndexPolicy;
  readonly #revision: string;
  readonly #documents: readonly IndexedDocument[];
  readonly #postings: ReadonlyMap<string, readonly Posting[]>;
  readonly #dictionary: readonly string[];
  readonly #snapshot: RelevanceIndexSnapshot;

  constructor(records: readonly NormalizedRecord[], revision = '1', policyInput: Partial<RelevanceIndexPolicy> = {}) {
    this.#policy = normalizePolicy(policyInput);
    if (records.length > this.#policy.maximumRecords) {
      throw new RangeError(`record count exceeds maximumRecords=${this.#policy.maximumRecords}`);
    }
    this.#revision = String(revision || '1');
    const documents: IndexedDocument[] = [];
    const postings = new Map<string, Posting[]>();
    const stats: MutableIndexStats = { postingCount: 0, truncatedTerms: 0, droppedPostings: 0, totalDocumentLength: 0 };
    let recordIndex = 0;
    for (const record of records) {
      const document = createDocument(record, this.#policy.fieldWeights);
      documents.push(document);
      stats.totalDocumentLength += document.length;
      indexDocumentTerms(postings, document, recordIndex, this.#policy, stats);
      recordIndex += 1;
    }
    this.#documents = Object.freeze(documents);
    this.#postings = freezePostings(postings);
    this.#dictionary = sortedDictionary(this.#postings);
    this.#snapshot = Object.freeze({
      revision: this.#revision,
      recordCount: this.#documents.length,
      distinctTerms: this.#postings.size,
      postingCount: stats.postingCount,
      averageDocumentLength: this.#documents.length === 0 ? 0 : stats.totalDocumentLength / this.#documents.length,
      truncatedTerms: stats.truncatedTerms,
      droppedPostings: stats.droppedPostings,
    });
  }

  policy(): RelevanceIndexPolicy {
    return this.#policy;
  }

  snapshot(): RelevanceIndexSnapshot {
    return this.#snapshot;
  }

  revision(): string {
    return this.#revision;
  }

  dictionary(prefix = '', limit = 50): readonly string[] {
    const boundedLimit = normalizeInteger(limit, 50, 1, 1000);
    const canonical = normalizeSearchToken(prefix);
    if (!canonical) return Object.freeze(this.#dictionary.slice(0, boundedLimit));
    return expandPrefix(this.#dictionary, canonical, boundedLimit);
  }

  documentFrequency(term: string): number {
    return this.#postings.get(normalizeSearchToken(term))?.length ?? 0;
  }

  search(analysis: TextQueryAnalysis, requestedLimit?: number): RelevanceSearchResult {
    const limit = normalizeInteger(requestedLimit, this.#policy.maximumResults, 1, this.#policy.maximumResults);
    if (analysis.diagnostics.empty || this.#documents.length === 0) {
      return Object.freeze({
        hits: Object.freeze([]),
        diagnostics: Object.freeze({
          candidateCount: 0,
          scoredCount: 0,
          rejectedRequired: 0,
          rejectedExcluded: 0,
          rejectedField: 0,
          rejectedPhrase: 0,
          prefixExpansions: 0,
          candidateTruncated: false,
          resultTruncated: false,
        }),
      });
    }
    const termCache = createTermFamilyCache();
    const candidates = buildCandidates(analysis, this.#postings, this.#dictionary, this.#documents.length, this.#policy, termCache);
    const evaluation: EvaluationState = { rejectedRequired: 0, rejectedExcluded: 0, rejectedField: 0, rejectedPhrase: 0, scoredCount: 0 };
    const hits: RelevanceHit[] = [];
    for (const recordIndex of candidates.positions) {
      const document = this.#documents[recordIndex];
      if (!document) continue;
      const hit = evaluateCandidate(
        recordIndex,
        document,
        analysis,
        this.#postings,
        this.#dictionary,
        this.#documents.length,
        this.#snapshot.averageDocumentLength,
        this.#policy,
        evaluation,
        termCache,
      );
      if (hit) hits.push(hit);
    }
    hits.sort(compareHits);
    const resultTruncated = hits.length > limit;
    return Object.freeze({
      hits: assignRanks(hits, limit),
      diagnostics: Object.freeze({
        candidateCount: candidates.positions.size,
        scoredCount: evaluation.scoredCount,
        rejectedRequired: evaluation.rejectedRequired,
        rejectedExcluded: evaluation.rejectedExcluded,
        rejectedField: evaluation.rejectedField,
        rejectedPhrase: evaluation.rejectedPhrase,
        prefixExpansions: candidates.prefixExpansions,
        candidateTruncated: candidates.truncated,
        resultTruncated,
      }),
    });
  }
}