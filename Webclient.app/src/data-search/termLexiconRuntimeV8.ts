import type { NormalizedRecord } from './contracts';
import {
  hashFingerprint,
  normalizeInteger,
  normalizeSearchToken,
  stableSerialize,
  tokenizeSearchText,
} from './normalization';
import {
  BoundedEditDistanceRuntimeV8,
  type BoundedEditDistancePolicyV8,
} from './boundedEditDistanceRuntimeV8';

export type LexiconFieldV8 =
  | 'title'
  | 'category'
  | 'type'
  | 'district'
  | 'neighborhood'
  | 'street'
  | 'address'
  | 'postalCode'
  | 'searchText';

export interface TermLexiconPolicyV8 {
  readonly maximumRecords?: number;
  readonly maximumDistinctTerms?: number;
  readonly maximumTermLength?: number;
  readonly maximumTermsPerRecord?: number;
  readonly maximumSuggestions?: number;
  readonly maximumCandidateComparisons?: number;
  readonly minimumDocumentFrequency?: number;
  readonly minimumSuggestionLength?: number;
  readonly maximumDistance?: number;
  readonly prefixBucketLength?: number;
  readonly distance?: BoundedEditDistancePolicyV8;
}

export interface TermLexiconEntryV8 {
  readonly term: string;
  readonly documentFrequency: number;
  readonly totalFrequency: number;
  readonly firstRecordIndex: number;
  readonly fields: readonly LexiconFieldV8[];
}

export interface TermSuggestionV8 {
  readonly input: string;
  readonly term: string;
  readonly distance: number;
  readonly similarity: number;
  readonly documentFrequency: number;
  readonly totalFrequency: number;
  readonly prefixRelated: boolean;
  readonly score: number;
  readonly ambiguous: boolean;
  readonly fields: readonly LexiconFieldV8[];
}

export interface TermSuggestionResultV8 {
  readonly input: string;
  readonly exact: boolean;
  readonly suggestions: readonly TermSuggestionV8[];
  readonly compared: number;
  readonly truncated: boolean;
  readonly candidateCount: number;
}

export interface TermLexiconSnapshotV8 {
  readonly version: 8;
  readonly revision: string;
  readonly recordCount: number;
  readonly distinctTerms: number;
  readonly indexedOccurrences: number;
  readonly droppedTerms: number;
  readonly droppedRecordTerms: number;
  readonly longestTermLength: number;
  readonly maximumDocumentFrequency: number;
  readonly prefixBuckets: number;
  readonly lengthBuckets: number;
  readonly suggestionRequests: number;
  readonly suggestionComparisons: number;
  readonly fingerprint: string;
}

interface NormalizedPolicyV8 {
  readonly maximumRecords: number;
  readonly maximumDistinctTerms: number;
  readonly maximumTermLength: number;
  readonly maximumTermsPerRecord: number;
  readonly maximumSuggestions: number;
  readonly maximumCandidateComparisons: number;
  readonly minimumDocumentFrequency: number;
  readonly minimumSuggestionLength: number;
  readonly maximumDistance: number;
  readonly prefixBucketLength: number;
  readonly distance: BoundedEditDistancePolicyV8;
}

interface MutableEntryV8 {
  readonly term: string;
  documentFrequency: number;
  totalFrequency: number;
  readonly firstRecordIndex: number;
  readonly fields: Set<LexiconFieldV8>;
}

interface MutableBuildStatsV8 {
  indexedOccurrences: number;
  droppedTerms: number;
  droppedRecordTerms: number;
  longestTermLength: number;
  maximumDocumentFrequency: number;
  suggestionRequests: number;
  suggestionComparisons: number;
}

interface RecordTermV8 {
  readonly term: string;
  readonly field: LexiconFieldV8;
}

interface CandidateScoreV8 {
  readonly entry: TermLexiconEntryV8;
  readonly distance: number;
  readonly similarity: number;
  readonly prefixRelated: boolean;
  readonly score: number;
}

const VERSION = 8 as const;
const FIELDS: readonly LexiconFieldV8[] = Object.freeze([
  'title',
  'category',
  'type',
  'district',
  'neighborhood',
  'street',
  'address',
  'postalCode',
  'searchText',
]);

const normalizePolicy = (input: TermLexiconPolicyV8 = {}): NormalizedPolicyV8 => {
  const maximumTermLength = normalizeInteger(input.maximumTermLength, {
    min: 2,
    max: 128,
    fallback: 64,
  });
  const maximumDistance = normalizeInteger(input.maximumDistance, {
    min: 0,
    max: 4,
    fallback: 2,
  });
  return Object.freeze({
    maximumRecords: normalizeInteger(input.maximumRecords, {
      min: 1,
      max: 1_000_000,
      fallback: 200_000,
    }),
    maximumDistinctTerms: normalizeInteger(input.maximumDistinctTerms, {
      min: 128,
      max: 1_000_000,
      fallback: 150_000,
    }),
    maximumTermLength,
    maximumTermsPerRecord: normalizeInteger(input.maximumTermsPerRecord, {
      min: 1,
      max: 4_096,
      fallback: 256,
    }),
    maximumSuggestions: normalizeInteger(input.maximumSuggestions, {
      min: 1,
      max: 100,
      fallback: 8,
    }),
    maximumCandidateComparisons: normalizeInteger(input.maximumCandidateComparisons, {
      min: 8,
      max: 100_000,
      fallback: 1_024,
    }),
    minimumDocumentFrequency: normalizeInteger(input.minimumDocumentFrequency, {
      min: 1,
      max: 100_000,
      fallback: 1,
    }),
    minimumSuggestionLength: normalizeInteger(input.minimumSuggestionLength, {
      min: 1,
      max: maximumTermLength,
      fallback: 3,
    }),
    maximumDistance,
    prefixBucketLength: normalizeInteger(input.prefixBucketLength, {
      min: 1,
      max: 8,
      fallback: 2,
    }),
    distance: Object.freeze({
      maximumTokenLength: input.distance?.maximumTokenLength ?? maximumTermLength,
      maximumDistance: input.distance?.maximumDistance ?? maximumDistance,
      allowAdjacentTransposition: input.distance?.allowAdjacentTransposition ?? true,
    }),
  });
};

const fieldValue = (record: NormalizedRecord, field: LexiconFieldV8): string => {
  if (field === 'title') return record.title;
  if (field === 'category') return record.category;
  if (field === 'type') return record.type;
  if (field === 'district') return record.district;
  if (field === 'neighborhood') return record.neighborhood;
  if (field === 'street') return record.street;
  if (field === 'address') return record.address;
  if (field === 'postalCode') return record.postalCode;
  return record.searchText;
};

const appendFieldTerms = (
  output: RecordTermV8[],
  value: string,
  field: LexiconFieldV8,
  maximumTermLength: number,
  maximumTerms: number,
): number => {
  let dropped = 0;
  for (const raw of tokenizeSearchText(value)) {
    if (output.length >= maximumTerms) {
      dropped += 1;
      continue;
    }
    const term = normalizeSearchToken(raw).slice(0, maximumTermLength);
    if (!term) continue;
    output.push(Object.freeze({ term, field }));
  }
  return dropped;
};

const recordTerms = (
  record: NormalizedRecord,
  policy: NormalizedPolicyV8,
): Readonly<{ terms: readonly RecordTermV8[]; dropped: number }> => {
  const output: RecordTermV8[] = [];
  let dropped = 0;
  for (const field of FIELDS) {
    dropped += appendFieldTerms(
      output,
      fieldValue(record, field),
      field,
      policy.maximumTermLength,
      policy.maximumTermsPerRecord,
    );
    if (output.length >= policy.maximumTermsPerRecord) break;
  }
  return Object.freeze({ terms: Object.freeze(output), dropped });
};

const frequencyMap = (terms: readonly RecordTermV8[]): ReadonlyMap<string, number> => {
  const frequencies = new Map<string, number>();
  for (const item of terms) {
    frequencies.set(item.term, (frequencies.get(item.term) ?? 0) + 1);
  }
  return frequencies;
};

const fieldMap = (terms: readonly RecordTermV8[]): ReadonlyMap<string, ReadonlySet<LexiconFieldV8>> => {
  const fields = new Map<string, Set<LexiconFieldV8>>();
  for (const item of terms) {
    const existing = fields.get(item.term) ?? new Set<LexiconFieldV8>();
    existing.add(item.field);
    fields.set(item.term, existing);
  }
  return fields;
};

const ingestRecord = (
  entries: Map<string, MutableEntryV8>,
  record: NormalizedRecord,
  recordIndex: number,
  policy: NormalizedPolicyV8,
  stats: MutableBuildStatsV8,
): void => {
  const extracted = recordTerms(record, policy);
  stats.droppedRecordTerms += extracted.dropped;
  const frequencies = frequencyMap(extracted.terms);
  const fields = fieldMap(extracted.terms);
  for (const [term, totalFrequency] of frequencies) {
    const existing = entries.get(term);
    if (!existing && entries.size >= policy.maximumDistinctTerms) {
      stats.droppedTerms += 1;
      continue;
    }
    const entry = existing ?? {
      term,
      documentFrequency: 0,
      totalFrequency: 0,
      firstRecordIndex: recordIndex,
      fields: new Set<LexiconFieldV8>(),
    };
    entry.documentFrequency += 1;
    entry.totalFrequency += totalFrequency;
    const termFields = fields.get(term);
    if (termFields) {
      for (const field of termFields) entry.fields.add(field);
    }
    entries.set(term, entry);
    stats.indexedOccurrences += totalFrequency;
    stats.longestTermLength = Math.max(stats.longestTermLength, term.length);
    stats.maximumDocumentFrequency = Math.max(stats.maximumDocumentFrequency, entry.documentFrequency);
  }
};

const freezeEntry = (entry: MutableEntryV8): TermLexiconEntryV8 => Object.freeze({
  term: entry.term,
  documentFrequency: entry.documentFrequency,
  totalFrequency: entry.totalFrequency,
  firstRecordIndex: entry.firstRecordIndex,
  fields: Object.freeze(Array.from(entry.fields).sort()),
});

const prefixKey = (term: string, length: number): string => term.slice(0, Math.min(length, term.length));

const appendBucketValue = (
  map: Map<string, string[]>,
  key: string,
  term: string,
): void => {
  const bucket = map.get(key);
  if (bucket) bucket.push(term);
  else map.set(key, [term]);
};

const buildBuckets = (
  entries: ReadonlyMap<string, TermLexiconEntryV8>,
  prefixLength: number,
): Readonly<{
  prefix: ReadonlyMap<string, readonly string[]>;
  length: ReadonlyMap<number, readonly string[]>;
}> => {
  const prefix = new Map<string, string[]>();
  const length = new Map<string, string[]>();
  for (const term of entries.keys()) {
    appendBucketValue(prefix, prefixKey(term, prefixLength), term);
    appendBucketValue(length, String(term.length), term);
  }
  return Object.freeze({
    prefix: new Map(Array.from(prefix.entries()).map(([key, values]) => [key, Object.freeze(values)])),
    length: new Map(Array.from(length.entries()).map(([key, values]) => [Number(key), Object.freeze(values)])),
  });
};

const appendTerms = (
  target: Set<string>,
  terms: readonly string[] | undefined,
  maximum: number,
): void => {
  if (!terms) return;
  for (const term of terms) {
    if (target.size >= maximum) return;
    target.add(term);
  }
};

const candidateTerms = (
  input: string,
  prefixBuckets: ReadonlyMap<string, readonly string[]>,
  lengthBuckets: ReadonlyMap<number, readonly string[]>,
  policy: NormalizedPolicyV8,
): Readonly<{ terms: readonly string[]; truncated: boolean }> => {
  const candidates = new Set<string>();
  const maximum = policy.maximumCandidateComparisons;
  appendTerms(candidates, prefixBuckets.get(prefixKey(input, policy.prefixBucketLength)), maximum);
  appendTerms(candidates, lengthBuckets.get(input.length), maximum);
  appendTerms(candidates, lengthBuckets.get(input.length - 1), maximum);
  appendTerms(candidates, lengthBuckets.get(input.length + 1), maximum);
  if (policy.maximumDistance >= 2) {
    appendTerms(candidates, lengthBuckets.get(input.length - 2), maximum);
    appendTerms(candidates, lengthBuckets.get(input.length + 2), maximum);
  }
  return Object.freeze({
    terms: Object.freeze(Array.from(candidates).slice(0, maximum)),
    truncated: candidates.size >= maximum,
  });
};

const suggestionScore = (
  similarity: number,
  entry: TermLexiconEntryV8,
  maximumDocumentFrequency: number,
  prefixRelated: boolean,
): number => {
  const frequencySignal = Math.log1p(entry.documentFrequency) / Math.log1p(Math.max(1, maximumDocumentFrequency));
  const prefixBonus = prefixRelated ? 0.04 : 0;
  return Math.max(0, Math.min(1, similarity * 0.82 + frequencySignal * 0.14 + prefixBonus));
};

const compareCandidate = (left: CandidateScoreV8, right: CandidateScoreV8): number =>
  right.score - left.score
  || left.distance - right.distance
  || right.entry.documentFrequency - left.entry.documentFrequency
  || right.entry.totalFrequency - left.entry.totalFrequency
  || left.entry.firstRecordIndex - right.entry.firstRecordIndex
  || left.entry.term.localeCompare(right.entry.term, 'tr-TR', { sensitivity: 'base', numeric: true });

const ambiguity = (
  candidates: readonly CandidateScoreV8[],
  index: number,
): boolean => {
  const current = candidates[index];
  if (!current) return false;
  const alternative = index === 0 ? candidates[1] : candidates[0];
  if (!alternative) return false;
  return Math.abs(current.score - alternative.score) < 0.025
    && current.distance === alternative.distance;
};

export class TermLexiconRuntimeV8 {
  readonly #policy: NormalizedPolicyV8;
  readonly #distance: BoundedEditDistanceRuntimeV8;
  readonly #entries: ReadonlyMap<string, TermLexiconEntryV8>;
  readonly #prefixBuckets: ReadonlyMap<string, readonly string[]>;
  readonly #lengthBuckets: ReadonlyMap<number, readonly string[]>;
  readonly #revision: string;
  readonly #recordCount: number;
  readonly #stats: MutableBuildStatsV8 = {
    indexedOccurrences: 0,
    droppedTerms: 0,
    droppedRecordTerms: 0,
    longestTermLength: 0,
    maximumDocumentFrequency: 0,
    suggestionRequests: 0,
    suggestionComparisons: 0,
  };

  constructor(
    records: readonly NormalizedRecord[],
    revision: string,
    policyInput: TermLexiconPolicyV8 = {},
  ) {
    this.#policy = normalizePolicy(policyInput);
    this.#distance = new BoundedEditDistanceRuntimeV8(this.#policy.distance);
    this.#revision = String(revision).slice(0, 160);
    this.#recordCount = Math.min(records.length, this.#policy.maximumRecords);
    const mutable = new Map<string, MutableEntryV8>();
    for (let recordIndex = 0; recordIndex < this.#recordCount; recordIndex += 1) {
      const record = records[recordIndex];
      if (!record) continue;
      ingestRecord(mutable, record, recordIndex, this.#policy, this.#stats);
    }
    const frozen = new Map<string, TermLexiconEntryV8>();
    for (const [term, entry] of mutable) frozen.set(term, freezeEntry(entry));
    this.#entries = frozen;
    const buckets = buildBuckets(this.#entries, this.#policy.prefixBucketLength);
    this.#prefixBuckets = buckets.prefix;
    this.#lengthBuckets = buckets.length;
  }

  has(termInput: unknown): boolean {
    const term = normalizeSearchToken(termInput).slice(0, this.#policy.maximumTermLength);
    return Boolean(term) && this.#entries.has(term);
  }

  entry(termInput: unknown): TermLexiconEntryV8 | null {
    const term = normalizeSearchToken(termInput).slice(0, this.#policy.maximumTermLength);
    return term ? this.#entries.get(term) ?? null : null;
  }

  suggest(
    termInput: unknown,
    limitInput?: number,
  ): TermSuggestionResultV8 {
    const input = normalizeSearchToken(termInput).slice(0, this.#policy.maximumTermLength);
    const limit = normalizeInteger(limitInput, {
      min: 1,
      max: this.#policy.maximumSuggestions,
      fallback: this.#policy.maximumSuggestions,
    });
    this.#stats.suggestionRequests += 1;
    if (!input || input.length < this.#policy.minimumSuggestionLength) {
      return Object.freeze({
        input,
        exact: false,
        suggestions: Object.freeze([]),
        compared: 0,
        truncated: false,
        candidateCount: 0,
      });
    }
    const exact = this.#entries.get(input);
    if (exact) {
      const suggestion: TermSuggestionV8 = Object.freeze({
        input,
        term: exact.term,
        distance: 0,
        similarity: 1,
        documentFrequency: exact.documentFrequency,
        totalFrequency: exact.totalFrequency,
        prefixRelated: true,
        score: 1,
        ambiguous: false,
        fields: exact.fields,
      });
      return Object.freeze({
        input,
        exact: true,
        suggestions: Object.freeze([suggestion]),
        compared: 0,
        truncated: false,
        candidateCount: 1,
      });
    }

    const candidates = candidateTerms(
      input,
      this.#prefixBuckets,
      this.#lengthBuckets,
      this.#policy,
    );
    const scored: CandidateScoreV8[] = [];
    let compared = 0;
    for (const candidate of candidates.terms) {
      if (compared >= this.#policy.maximumCandidateComparisons) break;
      const entry = this.#entries.get(candidate);
      if (!entry || entry.documentFrequency < this.#policy.minimumDocumentFrequency) continue;
      const distance = this.#distance.evaluate(input, candidate, this.#policy.maximumDistance);
      compared += 1;
      if (!distance.withinThreshold) continue;
      scored.push(Object.freeze({
        entry,
        distance: distance.distance,
        similarity: distance.similarity,
        prefixRelated: distance.prefixRelated,
        score: suggestionScore(
          distance.similarity,
          entry,
          this.#stats.maximumDocumentFrequency,
          distance.prefixRelated,
        ),
      }));
    }
    this.#stats.suggestionComparisons += compared;
    scored.sort(compareCandidate);
    const bounded = scored.slice(0, limit);
    const suggestions = bounded.map((candidate, index): TermSuggestionV8 => Object.freeze({
      input,
      term: candidate.entry.term,
      distance: candidate.distance,
      similarity: candidate.similarity,
      documentFrequency: candidate.entry.documentFrequency,
      totalFrequency: candidate.entry.totalFrequency,
      prefixRelated: candidate.prefixRelated,
      score: candidate.score,
      ambiguous: ambiguity(scored, index),
      fields: candidate.entry.fields,
    }));
    return Object.freeze({
      input,
      exact: false,
      suggestions: Object.freeze(suggestions),
      compared,
      truncated: candidates.truncated || scored.length > limit,
      candidateCount: candidates.terms.length,
    });
  }

  terms(): readonly TermLexiconEntryV8[] {
    return Object.freeze(Array.from(this.#entries.values()));
  }

  snapshot(): TermLexiconSnapshotV8 {
    const fingerprint = hashFingerprint(stableSerialize({
      revision: this.#revision,
      recordCount: this.#recordCount,
      entries: Array.from(this.#entries.values()).map(entry => [
        entry.term,
        entry.documentFrequency,
        entry.totalFrequency,
        entry.firstRecordIndex,
        entry.fields,
      ]),
    }));
    return Object.freeze({
      version: VERSION,
      revision: this.#revision,
      recordCount: this.#recordCount,
      distinctTerms: this.#entries.size,
      indexedOccurrences: this.#stats.indexedOccurrences,
      droppedTerms: this.#stats.droppedTerms,
      droppedRecordTerms: this.#stats.droppedRecordTerms,
      longestTermLength: this.#stats.longestTermLength,
      maximumDocumentFrequency: this.#stats.maximumDocumentFrequency,
      prefixBuckets: this.#prefixBuckets.size,
      lengthBuckets: this.#lengthBuckets.size,
      suggestionRequests: this.#stats.suggestionRequests,
      suggestionComparisons: this.#stats.suggestionComparisons,
      fingerprint,
    });
  }
}

export const createTermLexiconRuntimeV8 = (
  records: readonly NormalizedRecord[],
  revision: string,
  policy: TermLexiconPolicyV8 = {},
): TermLexiconRuntimeV8 => new TermLexiconRuntimeV8(records, revision, policy);
