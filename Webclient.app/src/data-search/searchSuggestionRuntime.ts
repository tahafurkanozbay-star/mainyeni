import type { NormalizedRecord } from './contracts';
import { normalizeSearchText, normalizeSearchToken } from './normalization';

export type SearchSuggestionKind = 'title' | 'category' | 'type' | 'district' | 'neighborhood' | 'street' | 'term';

export interface SearchSuggestionPolicy {
  readonly maximumRecords: number;
  readonly maximumTerms: number;
  readonly maximumLabels: number;
  readonly maximumSuggestions: number;
  readonly maximumPrefixLength: number;
  readonly minimumPrefixLength: number;
  readonly maximumLabelLength: number;
}

export interface SearchSuggestion {
  readonly key: string;
  readonly value: string;
  readonly kind: SearchSuggestionKind;
  readonly score: number;
  readonly frequency: number;
  readonly documentFrequency: number;
  readonly exactPrefix: boolean;
}

export interface SearchSuggestionResult {
  readonly query: string;
  readonly canonicalQuery: string;
  readonly suggestions: readonly SearchSuggestion[];
  readonly scannedTerms: number;
  readonly truncated: boolean;
}

export interface SearchSuggestionSnapshot {
  readonly recordCount: number;
  readonly termCount: number;
  readonly labelCount: number;
  readonly droppedTerms: number;
  readonly droppedLabels: number;
}

interface MutableTerm {
  readonly key: string;
  display: string;
  kind: SearchSuggestionKind;
  frequency: number;
  documentFrequency: number;
  lastDocument: number;
}

interface CandidateSuggestion {
  readonly term: MutableTerm;
  readonly score: number;
  readonly exactPrefix: boolean;
}

const DEFAULT_POLICY: SearchSuggestionPolicy = Object.freeze({
  maximumRecords: 200_000,
  maximumTerms: 100_000,
  maximumLabels: 50_000,
  maximumSuggestions: 25,
  maximumPrefixLength: 80,
  minimumPrefixLength: 1,
  maximumLabelLength: 180,
});

const KIND_WEIGHT: Readonly<Record<SearchSuggestionKind, number>> = Object.freeze({
  title: 9,
  category: 7,
  type: 7,
  district: 6,
  neighborhood: 6,
  street: 5,
  term: 1,
});

const normalizeInteger = (value: number | undefined, fallback: number, minimum: number, maximum: number): number => {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`suggestion policy integer must be between ${minimum} and ${maximum}`);
  }
  return value;
};

const normalizePolicy = (input: Partial<SearchSuggestionPolicy>): SearchSuggestionPolicy => Object.freeze({
  maximumRecords: normalizeInteger(input.maximumRecords, DEFAULT_POLICY.maximumRecords, 1, 1_000_000),
  maximumTerms: normalizeInteger(input.maximumTerms, DEFAULT_POLICY.maximumTerms, 128, 1_000_000),
  maximumLabels: normalizeInteger(input.maximumLabels, DEFAULT_POLICY.maximumLabels, 64, 1_000_000),
  maximumSuggestions: normalizeInteger(input.maximumSuggestions, DEFAULT_POLICY.maximumSuggestions, 1, 500),
  maximumPrefixLength: normalizeInteger(input.maximumPrefixLength, DEFAULT_POLICY.maximumPrefixLength, 4, 512),
  minimumPrefixLength: normalizeInteger(input.minimumPrefixLength, DEFAULT_POLICY.minimumPrefixLength, 1, 32),
  maximumLabelLength: normalizeInteger(input.maximumLabelLength, DEFAULT_POLICY.maximumLabelLength, 8, 1024),
});

const tokenize = (value: string): readonly string[] => {
  const normalized = normalizeSearchText(value).replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  return normalized ? Object.freeze(normalized.split(' ').filter(Boolean)) : Object.freeze([]);
};

const boundedLabel = (value: string, maximum: number): string => value.trim().slice(0, maximum);

const termKey = (kind: SearchSuggestionKind, value: string): string => `${kind}:${normalizeSearchToken(value)}`;

const addTerm = (
  terms: Map<string, MutableTerm>,
  kind: SearchSuggestionKind,
  rawValue: string,
  documentIndex: number,
  maximumTerms: number,
  maximumLabelLength: number,
): boolean => {
  const display = boundedLabel(rawValue, maximumLabelLength);
  const canonical = normalizeSearchToken(display);
  if (!canonical) return false;
  const key = `${kind}:${canonical}`;
  const existing = terms.get(key);
  if (existing) {
    existing.frequency += 1;
    if (existing.lastDocument !== documentIndex) {
      existing.documentFrequency += 1;
      existing.lastDocument = documentIndex;
    }
    if (display.length < existing.display.length) existing.display = display;
    return true;
  }
  if (terms.size >= maximumTerms) return false;
  terms.set(key, { key, display, kind, frequency: 1, documentFrequency: 1, lastDocument: documentIndex });
  return true;
};

const addTokenTerms = (
  terms: Map<string, MutableTerm>,
  value: string,
  documentIndex: number,
  policy: SearchSuggestionPolicy,
): number => {
  let dropped = 0;
  const tokens = tokenize(value);
  const seen = new Set<string>();
  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    if (!addTerm(terms, 'term', token, documentIndex, policy.maximumTerms, policy.maximumLabelLength)) dropped += 1;
  }
  return dropped;
};

const addRecordLabels = (
  terms: Map<string, MutableTerm>,
  record: NormalizedRecord,
  documentIndex: number,
  policy: SearchSuggestionPolicy,
): number => {
  let dropped = 0;
  if (!addTerm(terms, 'title', record.title, documentIndex, policy.maximumTerms, policy.maximumLabelLength)) dropped += 1;
  if (record.category && !addTerm(terms, 'category', record.category, documentIndex, policy.maximumTerms, policy.maximumLabelLength)) dropped += 1;
  if (record.type && !addTerm(terms, 'type', record.type, documentIndex, policy.maximumTerms, policy.maximumLabelLength)) dropped += 1;
  if (record.district && !addTerm(terms, 'district', record.district, documentIndex, policy.maximumTerms, policy.maximumLabelLength)) dropped += 1;
  if (record.neighborhood && !addTerm(terms, 'neighborhood', record.neighborhood, documentIndex, policy.maximumTerms, policy.maximumLabelLength)) dropped += 1;
  if (record.street && !addTerm(terms, 'street', record.street, documentIndex, policy.maximumTerms, policy.maximumLabelLength)) dropped += 1;
  return dropped;
};

const addRecordToDictionary = (
  terms: Map<string, MutableTerm>,
  record: NormalizedRecord,
  documentIndex: number,
  policy: SearchSuggestionPolicy,
): number => addRecordLabels(terms, record, documentIndex, policy)
  + addTokenTerms(terms, record.searchText, documentIndex, policy);

const canonicalValueFromKey = (key: string): string => {
  const separator = key.indexOf(':');
  return separator >= 0 ? key.slice(separator + 1) : key;
};

const compareTerms = (left: MutableTerm, right: MutableTerm): number => {
  const canonicalLeft = canonicalValueFromKey(left.key);
  const canonicalRight = canonicalValueFromKey(right.key);
  const canonical = canonicalLeft.localeCompare(canonicalRight);
  if (canonical !== 0) return canonical;
  const weight = KIND_WEIGHT[right.kind] - KIND_WEIGHT[left.kind];
  if (weight !== 0) return weight;
  return left.display.localeCompare(right.display, 'tr-TR', { sensitivity: 'base' });
};

const lowerBound = (values: readonly MutableTerm[], target: string): number => {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const canonical = canonicalValueFromKey(values[middle]?.key ?? '');
    if (canonical < target) low = middle + 1;
    else high = middle;
  }
  return low;
};

const prefixCandidates = (
  values: readonly MutableTerm[],
  prefix: string,
  scanLimit: number,
): readonly MutableTerm[] => {
  const result: MutableTerm[] = [];
  let cursor = lowerBound(values, prefix);
  while (cursor < values.length && result.length < scanLimit) {
    const candidate = values[cursor];
    if (!candidate) break;
    const canonical = canonicalValueFromKey(candidate.key);
    if (!canonical.startsWith(prefix)) break;
    result.push(candidate);
    cursor += 1;
  }
  return Object.freeze(result);
};

const fuzzyPrefixScore = (query: string, candidate: string): number => {
  if (candidate === query) return 1;
  if (candidate.startsWith(query)) return 0.9;
  if (query.length < 3) return 0;
  let matched = 0;
  let cursor = 0;
  for (const character of query) {
    const found = candidate.indexOf(character, cursor);
    if (found < 0) return 0;
    matched += 1;
    cursor = found + 1;
  }
  return matched / Math.max(query.length, candidate.length) * 0.45;
};

const candidateScore = (term: MutableTerm, query: string, recordCount: number): CandidateSuggestion | null => {
  const canonical = canonicalValueFromKey(term.key);
  const prefixScore = fuzzyPrefixScore(query, canonical);
  if (prefixScore <= 0) return null;
  const popularity = Math.log1p(term.documentFrequency) / Math.log1p(Math.max(2, recordCount));
  const frequency = Math.log1p(term.frequency);
  const kindBoost = KIND_WEIGHT[term.kind] / 10;
  return Object.freeze({
    term,
    score: prefixScore * 10 + popularity * 3 + frequency * 0.2 + kindBoost,
    exactPrefix: canonical.startsWith(query),
  });
};

const compareCandidates = (left: CandidateSuggestion, right: CandidateSuggestion): number => {
  const score = right.score - left.score;
  if (Math.abs(score) > Number.EPSILON) return score;
  const documentFrequency = right.term.documentFrequency - left.term.documentFrequency;
  if (documentFrequency !== 0) return documentFrequency;
  const kind = KIND_WEIGHT[right.term.kind] - KIND_WEIGHT[left.term.kind];
  if (kind !== 0) return kind;
  return left.term.display.localeCompare(right.term.display, 'tr-TR', { sensitivity: 'base' });
};

const dedupeCandidateLabels = (candidates: readonly CandidateSuggestion[], maximum: number): readonly CandidateSuggestion[] => {
  const result: CandidateSuggestion[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const canonical = normalizeSearchToken(candidate.term.display);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    result.push(candidate);
    if (result.length >= maximum) break;
  }
  return Object.freeze(result);
};

const toSuggestion = (candidate: CandidateSuggestion): SearchSuggestion => Object.freeze({
  key: candidate.term.key,
  value: candidate.term.display,
  kind: candidate.term.kind,
  score: candidate.score,
  frequency: candidate.term.frequency,
  documentFrequency: candidate.term.documentFrequency,
  exactPrefix: candidate.exactPrefix,
});

const scoreCandidates = (
  candidates: readonly MutableTerm[],
  query: string,
  recordCount: number,
): readonly CandidateSuggestion[] => {
  const scored: CandidateSuggestion[] = [];
  for (const candidate of candidates) {
    const value = candidateScore(candidate, query, recordCount);
    if (value) scored.push(value);
  }
  scored.sort(compareCandidates);
  return Object.freeze(scored);
};

export class SearchSuggestionRuntime {
  readonly #policy: SearchSuggestionPolicy;
  readonly #recordCount: number;
  readonly #dictionary: readonly MutableTerm[];
  readonly #snapshot: SearchSuggestionSnapshot;

  constructor(records: readonly NormalizedRecord[], policyInput: Partial<SearchSuggestionPolicy> = {}) {
    this.#policy = normalizePolicy(policyInput);
    if (records.length > this.#policy.maximumRecords) {
      throw new RangeError(`record count exceeds maximumRecords=${this.#policy.maximumRecords}`);
    }
    const terms = new Map<string, MutableTerm>();
    let droppedTerms = 0;
    let documentIndex = 0;
    for (const record of records) {
      droppedTerms += addRecordToDictionary(terms, record, documentIndex, this.#policy);
      documentIndex += 1;
    }
    const dictionary = Array.from(terms.values());
    dictionary.sort(compareTerms);
    this.#recordCount = records.length;
    this.#dictionary = Object.freeze(dictionary);
    const labelCount = dictionary.filter((term) => term.kind !== 'term').length;
    this.#snapshot = Object.freeze({
      recordCount: records.length,
      termCount: dictionary.length,
      labelCount,
      droppedTerms,
      droppedLabels: Math.max(0, labelCount - this.#policy.maximumLabels),
    });
  }

  policy(): SearchSuggestionPolicy {
    return this.#policy;
  }

  snapshot(): SearchSuggestionSnapshot {
    return this.#snapshot;
  }

  suggest(input: unknown, requestedLimit?: number): SearchSuggestionResult {
    const raw = input === null || input === undefined ? '' : String(input);
    const bounded = raw.slice(0, this.#policy.maximumPrefixLength);
    const canonical = normalizeSearchToken(bounded);
    const limit = normalizeInteger(requestedLimit, this.#policy.maximumSuggestions, 1, this.#policy.maximumSuggestions);
    if (canonical.length < this.#policy.minimumPrefixLength) {
      return Object.freeze({
        query: raw,
        canonicalQuery: canonical,
        suggestions: Object.freeze([]),
        scannedTerms: 0,
        truncated: false,
      });
    }
    const scanLimit = Math.min(this.#dictionary.length, Math.max(limit * 20, 100));
    const exactPrefix = prefixCandidates(this.#dictionary, canonical, scanLimit);
    const candidates = exactPrefix.length >= limit
      ? exactPrefix
      : this.#dictionary.slice(0, scanLimit);
    const scored = scoreCandidates(candidates, canonical, this.#recordCount);
    const deduped = dedupeCandidateLabels(scored, limit);
    return Object.freeze({
      query: raw,
      canonicalQuery: canonical,
      suggestions: Object.freeze(deduped.map(toSuggestion)),
      scannedTerms: candidates.length,
      truncated: scored.length > deduped.length,
    });
  }
}

export const createSuggestionKey = (kind: SearchSuggestionKind, value: string): string => termKey(kind, value);
