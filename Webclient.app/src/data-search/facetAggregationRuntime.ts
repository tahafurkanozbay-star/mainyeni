import type { NormalizedRecord } from './contracts';
import { normalizeSearchText, normalizeSearchToken } from './normalization';
import type { RelevanceHit } from './relevanceIndexRuntime';

export type FacetField = 'category' | 'type' | 'district' | 'neighborhood' | 'street' | 'postalCode';
export type NumericFacetField = 'sourceIndex';

export interface FacetAggregationPolicy {
  readonly maximumDocuments: number;
  readonly maximumFields: number;
  readonly maximumBucketsPerField: number;
  readonly maximumDistinctValuesPerField: number;
  readonly minimumBucketCount: number;
  readonly includeMissingBucket: boolean;
}

export interface FacetBucketV6 {
  readonly key: string;
  readonly label: string;
  readonly count: number;
  readonly percentage: number;
  readonly selected: boolean;
}

export interface FacetFieldResult {
  readonly field: FacetField;
  readonly documentCount: number;
  readonly distinctCount: number;
  readonly missingCount: number;
  readonly truncated: boolean;
  readonly buckets: readonly FacetBucketV6[];
}

export interface NumericFacetStatistics {
  readonly field: NumericFacetField;
  readonly count: number;
  readonly minimum: number | null;
  readonly maximum: number | null;
  readonly average: number | null;
}

export interface FacetAggregationSelection {
  readonly category?: readonly string[];
  readonly type?: readonly string[];
  readonly district?: readonly string[];
  readonly neighborhood?: readonly string[];
  readonly street?: readonly string[];
  readonly postalCode?: readonly string[];
}

export interface FacetAggregationResult {
  readonly totalDocuments: number;
  readonly fields: Readonly<Record<FacetField, FacetFieldResult>>;
  readonly numeric: NumericFacetStatistics;
  readonly truncatedInput: boolean;
}

export interface FacetAggregationSnapshot {
  readonly aggregations: number;
  readonly documentsSeen: number;
  readonly truncatedInputs: number;
  readonly truncatedFields: number;
}

interface MutableBucket {
  key: string;
  label: string;
  count: number;
}

interface MutableFacetState {
  readonly field: FacetField;
  readonly buckets: Map<string, MutableBucket>;
  missingCount: number;
  truncated: boolean;
}

const FACET_FIELDS: readonly FacetField[] = Object.freeze([
  'category',
  'type',
  'district',
  'neighborhood',
  'street',
  'postalCode',
]);

const DEFAULT_POLICY: FacetAggregationPolicy = Object.freeze({
  maximumDocuments: 50_000,
  maximumFields: FACET_FIELDS.length,
  maximumBucketsPerField: 40,
  maximumDistinctValuesPerField: 2_000,
  minimumBucketCount: 1,
  includeMissingBucket: false,
});

const normalizeInteger = (value: number | undefined, fallback: number, minimum: number, maximum: number): number => {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`facet policy integer must be between ${minimum} and ${maximum}`);
  }
  return value;
};

const normalizePolicy = (input: Partial<FacetAggregationPolicy>): FacetAggregationPolicy => Object.freeze({
  maximumDocuments: normalizeInteger(input.maximumDocuments, DEFAULT_POLICY.maximumDocuments, 1, 1_000_000),
  maximumFields: normalizeInteger(input.maximumFields, DEFAULT_POLICY.maximumFields, 1, FACET_FIELDS.length),
  maximumBucketsPerField: normalizeInteger(input.maximumBucketsPerField, DEFAULT_POLICY.maximumBucketsPerField, 1, 1000),
  maximumDistinctValuesPerField: normalizeInteger(input.maximumDistinctValuesPerField, DEFAULT_POLICY.maximumDistinctValuesPerField, 1, 100_000),
  minimumBucketCount: normalizeInteger(input.minimumBucketCount, DEFAULT_POLICY.minimumBucketCount, 1, 1_000_000),
  includeMissingBucket: input.includeMissingBucket ?? DEFAULT_POLICY.includeMissingBucket,
});

const facetValue = (record: NormalizedRecord, field: FacetField): string => {
  if (field === 'category') return record.category;
  if (field === 'type') return record.type;
  if (field === 'district') return record.district;
  if (field === 'neighborhood') return record.neighborhood;
  if (field === 'street') return record.street;
  return record.postalCode;
};

const normalizeFacetKey = (value: string): string => normalizeSearchToken(value);

const createState = (field: FacetField): MutableFacetState => ({
  field,
  buckets: new Map<string, MutableBucket>(),
  missingCount: 0,
  truncated: false,
});

const createStates = (maximumFields: number): readonly MutableFacetState[] => Object.freeze(FACET_FIELDS.slice(0, maximumFields).map(createState));

const incrementState = (state: MutableFacetState, record: NormalizedRecord, policy: FacetAggregationPolicy): void => {
  const label = facetValue(record, state.field).trim();
  const key = normalizeFacetKey(label);
  if (!key) {
    state.missingCount += 1;
    return;
  }
  const existing = state.buckets.get(key);
  if (existing) {
    existing.count += 1;
    return;
  }
  if (state.buckets.size >= policy.maximumDistinctValuesPerField) {
    state.truncated = true;
    return;
  }
  state.buckets.set(key, { key, label, count: 1 });
};

const incrementAllStates = (states: readonly MutableFacetState[], record: NormalizedRecord, policy: FacetAggregationPolicy): void => {
  for (const state of states) incrementState(state, record, policy);
};

const selectedKeys = (selection: FacetAggregationSelection, field: FacetField): ReadonlySet<string> => {
  const values = selection[field] ?? [];
  const keys = new Set<string>();
  for (const value of values) {
    const key = normalizeFacetKey(value);
    if (key) keys.add(key);
  }
  return keys;
};

const compareBuckets = (left: MutableBucket, right: MutableBucket): number => {
  const countDifference = right.count - left.count;
  if (countDifference !== 0) return countDifference;
  return left.label.localeCompare(right.label, 'tr-TR', { sensitivity: 'base' });
};

const toBucket = (bucket: MutableBucket, total: number, selected: ReadonlySet<string>): FacetBucketV6 => Object.freeze({
  key: bucket.key,
  label: bucket.label,
  count: bucket.count,
  percentage: total === 0 ? 0 : bucket.count / total,
  selected: selected.has(bucket.key),
});

const selectedBucketsFirst = (buckets: readonly MutableBucket[], selected: ReadonlySet<string>): readonly MutableBucket[] => {
  const chosen: MutableBucket[] = [];
  const other: MutableBucket[] = [];
  for (const bucket of buckets) {
    if (selected.has(bucket.key)) chosen.push(bucket);
    else other.push(bucket);
  }
  chosen.sort(compareBuckets);
  other.sort(compareBuckets);
  return Object.freeze([...chosen, ...other]);
};

const fieldResult = (
  state: MutableFacetState,
  totalDocuments: number,
  selection: FacetAggregationSelection,
  policy: FacetAggregationPolicy,
): FacetFieldResult => {
  const selected = selectedKeys(selection, state.field);
  const eligible = Array.from(state.buckets.values()).filter((bucket) => bucket.count >= policy.minimumBucketCount);
  const ordered = selectedBucketsFirst(eligible, selected);
  const limited = ordered.slice(0, policy.maximumBucketsPerField);
  const buckets = limited.map((bucket) => toBucket(bucket, totalDocuments, selected));
  if (policy.includeMissingBucket && state.missingCount >= policy.minimumBucketCount && buckets.length < policy.maximumBucketsPerField) {
    buckets.push(Object.freeze({
      key: '__missing__',
      label: 'Belirtilmemiş',
      count: state.missingCount,
      percentage: totalDocuments === 0 ? 0 : state.missingCount / totalDocuments,
      selected: selected.has('__missing__'),
    }));
  }
  return Object.freeze({
    field: state.field,
    documentCount: totalDocuments,
    distinctCount: state.buckets.size,
    missingCount: state.missingCount,
    truncated: state.truncated || ordered.length > limited.length,
    buckets: Object.freeze(buckets),
  });
};

const emptyFieldResult = (field: FacetField): FacetFieldResult => Object.freeze({
  field,
  documentCount: 0,
  distinctCount: 0,
  missingCount: 0,
  truncated: false,
  buckets: Object.freeze([]),
});

const resultRecord = (
  states: readonly MutableFacetState[],
  totalDocuments: number,
  selection: FacetAggregationSelection,
  policy: FacetAggregationPolicy,
): Readonly<Record<FacetField, FacetFieldResult>> => {
  const result: Record<FacetField, FacetFieldResult> = {
    category: emptyFieldResult('category'),
    type: emptyFieldResult('type'),
    district: emptyFieldResult('district'),
    neighborhood: emptyFieldResult('neighborhood'),
    street: emptyFieldResult('street'),
    postalCode: emptyFieldResult('postalCode'),
  };
  for (const state of states) result[state.field] = fieldResult(state, totalDocuments, selection, policy);
  return Object.freeze(result);
};

const numericStatistics = (records: readonly NormalizedRecord[]): NumericFacetStatistics => {
  if (records.length === 0) return Object.freeze({ field: 'sourceIndex', count: 0, minimum: null, maximum: null, average: null });
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  let total = 0;
  for (const record of records) {
    minimum = Math.min(minimum, record.sourceIndex);
    maximum = Math.max(maximum, record.sourceIndex);
    total += record.sourceIndex;
  }
  return Object.freeze({
    field: 'sourceIndex',
    count: records.length,
    minimum,
    maximum,
    average: total / records.length,
  });
};

const recordsFromHits = (hits: readonly RelevanceHit[], maximum: number): readonly NormalizedRecord[] => Object.freeze(hits.slice(0, maximum).map((hit) => hit.record));

const sanitizeSelection = (selection: FacetAggregationSelection): FacetAggregationSelection => Object.freeze({
  category: selection.category ? Object.freeze(selection.category.slice()) : undefined,
  type: selection.type ? Object.freeze(selection.type.slice()) : undefined,
  district: selection.district ? Object.freeze(selection.district.slice()) : undefined,
  neighborhood: selection.neighborhood ? Object.freeze(selection.neighborhood.slice()) : undefined,
  street: selection.street ? Object.freeze(selection.street.slice()) : undefined,
  postalCode: selection.postalCode ? Object.freeze(selection.postalCode.slice()) : undefined,
});

export const facetSelectionFingerprint = (selection: FacetAggregationSelection): string => {
  const normalized: string[] = [];
  for (const field of FACET_FIELDS) {
    const values = selection[field] ?? [];
    const keys = Array.from(new Set(values.map(normalizeFacetKey).filter(Boolean))).sort();
    if (keys.length > 0) normalized.push(`${field}:${keys.join(',')}`);
  }
  return normalizeSearchText(normalized.join('|'));
};

export class FacetAggregationRuntime {
  readonly #policy: FacetAggregationPolicy;
  #aggregations = 0;
  #documentsSeen = 0;
  #truncatedInputs = 0;
  #truncatedFields = 0;

  constructor(policy: Partial<FacetAggregationPolicy> = {}) {
    this.#policy = normalizePolicy(policy);
  }

  policy(): FacetAggregationPolicy {
    return this.#policy;
  }

  aggregateRecords(
    records: readonly NormalizedRecord[],
    selectionInput: FacetAggregationSelection = {},
  ): FacetAggregationResult {
    const truncatedInput = records.length > this.#policy.maximumDocuments;
    const boundedRecords = truncatedInput ? records.slice(0, this.#policy.maximumDocuments) : records;
    const selection = sanitizeSelection(selectionInput);
    const states = createStates(this.#policy.maximumFields);
    for (const record of boundedRecords) incrementAllStates(states, record, this.#policy);
    const fields = resultRecord(states, boundedRecords.length, selection, this.#policy);
    let truncatedFields = 0;
    for (const field of FACET_FIELDS) if (fields[field].truncated) truncatedFields += 1;
    this.#aggregations += 1;
    this.#documentsSeen += boundedRecords.length;
    this.#truncatedFields += truncatedFields;
    if (truncatedInput) this.#truncatedInputs += 1;
    return Object.freeze({
      totalDocuments: boundedRecords.length,
      fields,
      numeric: numericStatistics(boundedRecords),
      truncatedInput,
    });
  }

  aggregateHits(
    hits: readonly RelevanceHit[],
    selection: FacetAggregationSelection = {},
  ): FacetAggregationResult {
    const records = recordsFromHits(hits, this.#policy.maximumDocuments);
    const result = this.aggregateRecords(records, selection);
    if (hits.length <= this.#policy.maximumDocuments) return result;
    return Object.freeze({ ...result, truncatedInput: true });
  }

  snapshot(): FacetAggregationSnapshot {
    return Object.freeze({
      aggregations: this.#aggregations,
      documentsSeen: this.#documentsSeen,
      truncatedInputs: this.#truncatedInputs,
      truncatedFields: this.#truncatedFields,
    });
  }

  reset(): void {
    this.#aggregations = 0;
    this.#documentsSeen = 0;
    this.#truncatedInputs = 0;
    this.#truncatedFields = 0;
  }
}
