import type { FilterOperator, NormalizedRecord, SearchFilter } from './contracts';
import {
  hashFingerprint,
  normalizeInteger,
  normalizeSearchText,
  normalizeText,
  stableSerialize,
} from './normalization';

export type FilterIndexValueKind = 'string' | 'number' | 'boolean';
export type FilterPlanStrategy =
  | 'all-records'
  | 'indexed-intersection'
  | 'indexed-union'
  | 'hybrid'
  | 'empty';

export interface FilterIndexFieldConfig {
  readonly field: string;
  readonly kind?: FilterIndexValueKind;
  readonly caseSensitive?: boolean;
  readonly prefixLength?: number;
  readonly maxDistinctValues?: number;
}

export interface FilterIndexOptions {
  readonly maxFields?: number;
  readonly maxDistinctValuesPerField?: number;
  readonly maxPrefixLength?: number;
  readonly maxPostingsPerValue?: number;
  readonly maxCandidatePositions?: number;
}

export interface FilterFieldDiagnostics {
  readonly field: string;
  readonly kind: FilterIndexValueKind;
  readonly recordCount: number;
  readonly indexedCount: number;
  readonly missingCount: number;
  readonly distinctValueCount: number;
  readonly prefixCount: number;
  readonly truncatedValueCount: number;
}

export interface FilterIndexSnapshot {
  readonly version: 1;
  readonly recordCount: number;
  readonly fieldCount: number;
  readonly postingCount: number;
  readonly fingerprint: string;
  readonly fields: Readonly<Record<string, FilterFieldDiagnostics>>;
}

export interface FilterPlanStep {
  readonly index: number;
  readonly field: string;
  readonly operator: FilterOperator;
  readonly indexed: boolean;
  readonly candidateCount: number;
  readonly reason: string;
}

export interface FilterExecutionPlan {
  readonly strategy: FilterPlanStrategy;
  readonly positions: readonly number[];
  readonly indexedFilterCount: number;
  readonly residualFilterCount: number;
  readonly estimatedScanCount: number;
  readonly truncated: boolean;
  readonly steps: readonly FilterPlanStep[];
  readonly fingerprint: string;
}

interface NormalizedFilterIndexOptions {
  readonly maxFields: number;
  readonly maxDistinctValuesPerField: number;
  readonly maxPrefixLength: number;
  readonly maxPostingsPerValue: number;
  readonly maxCandidatePositions: number;
}

interface NormalizedFieldConfig {
  readonly field: string;
  readonly kind: FilterIndexValueKind;
  readonly caseSensitive: boolean;
  readonly prefixLength: number;
  readonly maxDistinctValues: number;
}

interface NumericPosting {
  readonly value: number;
  readonly position: number;
}

interface FieldIndex {
  readonly config: NormalizedFieldConfig;
  readonly equality: ReadonlyMap<string, readonly number[]>;
  readonly prefixes: ReadonlyMap<string, readonly number[]>;
  readonly exists: readonly number[];
  readonly numeric: readonly NumericPosting[];
  readonly diagnostics: FilterFieldDiagnostics;
}

interface MutableFieldIndex {
  readonly config: NormalizedFieldConfig;
  readonly equality: Map<string, number[]>;
  readonly prefixes: Map<string, number[]>;
  readonly exists: number[];
  readonly numeric: NumericPosting[];
  indexedCount: number;
  missingCount: number;
  truncatedValueCount: number;
}

const DEFAULT_MAX_FIELDS = 32;
const DEFAULT_MAX_DISTINCT = 50_000;
const DEFAULT_MAX_PREFIX_LENGTH = 12;
const DEFAULT_MAX_POSTINGS = 100_000;
const DEFAULT_MAX_CANDIDATES = 250_000;

const SUPPORTED_OPERATORS = new Set<FilterOperator>([
  'eq',
  'in',
  'prefix',
  'exists',
  'gte',
  'lte',
  'between',
]);

const normalizeOptions = (options: FilterIndexOptions = {}): NormalizedFilterIndexOptions =>
  Object.freeze({
    maxFields: normalizeInteger(options.maxFields, {
      min: 1,
      max: 256,
      fallback: DEFAULT_MAX_FIELDS,
    }),
    maxDistinctValuesPerField: normalizeInteger(options.maxDistinctValuesPerField, {
      min: 1,
      max: 1_000_000,
      fallback: DEFAULT_MAX_DISTINCT,
    }),
    maxPrefixLength: normalizeInteger(options.maxPrefixLength, {
      min: 0,
      max: 64,
      fallback: DEFAULT_MAX_PREFIX_LENGTH,
    }),
    maxPostingsPerValue: normalizeInteger(options.maxPostingsPerValue, {
      min: 1,
      max: 1_000_000,
      fallback: DEFAULT_MAX_POSTINGS,
    }),
    maxCandidatePositions: normalizeInteger(options.maxCandidatePositions, {
      min: 1,
      max: 1_000_000,
      fallback: DEFAULT_MAX_CANDIDATES,
    }),
  });

const normalizeFieldName = (value: unknown): string => normalizeText(value).slice(0, 160);

const normalizeFieldConfig = (
  input: FilterIndexFieldConfig,
  options: NormalizedFilterIndexOptions,
): NormalizedFieldConfig => {
  const field = normalizeFieldName(input.field);
  if (!field) throw new TypeError('Filter index field is required');
  const kind: FilterIndexValueKind = input.kind === 'number' || input.kind === 'boolean'
    ? input.kind
    : 'string';
  return Object.freeze({
    field,
    kind,
    caseSensitive: input.caseSensitive === true,
    prefixLength: kind === 'string'
      ? normalizeInteger(input.prefixLength, {
        min: 0,
        max: options.maxPrefixLength,
        fallback: Math.min(8, options.maxPrefixLength),
      })
      : 0,
    maxDistinctValues: normalizeInteger(input.maxDistinctValues, {
      min: 1,
      max: options.maxDistinctValuesPerField,
      fallback: options.maxDistinctValuesPerField,
    }),
  });
};

const readField = (record: NormalizedRecord, field: string): unknown => {
  const direct = record as unknown as Readonly<Record<string, unknown>>;
  if (Object.prototype.hasOwnProperty.call(direct, field)) return direct[field];
  if (Object.prototype.hasOwnProperty.call(record.fields, field)) return record.fields[field];
  return null;
};

const normalizeString = (value: unknown, caseSensitive: boolean): string => {
  const text = normalizeText(value);
  return caseSensitive ? text : normalizeSearchText(text);
};

const valueKey = (
  value: unknown,
  config: NormalizedFieldConfig,
): string | null => {
  if (value === null || value === undefined || value === '') return null;
  if (config.kind === 'number') {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? `n:${numeric}` : null;
  }
  if (config.kind === 'boolean') {
    if (value === true || value === 'true' || value === 1 || value === '1') return 'b:true';
    if (value === false || value === 'false' || value === 0 || value === '0') return 'b:false';
    return null;
  }
  const text = normalizeString(value, config.caseSensitive);
  return text ? `s:${text}` : null;
};

const stringValueFromKey = (key: string): string => key.startsWith('s:') ? key.slice(2) : '';

const freezePostingMap = (source: Map<string, number[]>): ReadonlyMap<string, readonly number[]> => {
  const output = new Map<string, readonly number[]>();
  for (const [key, positions] of source) {
    output.set(key, Object.freeze([...positions]));
  }
  return output;
};

const appendPosting = (
  target: Map<string, number[]>,
  key: string,
  position: number,
  maxDistinct: number,
  maxPostings: number,
): 'added' | 'value-cap' | 'posting-cap' => {
  const existing = target.get(key);
  if (existing) {
    if (existing.length >= maxPostings) return 'posting-cap';
    existing.push(position);
    return 'added';
  }
  if (target.size >= maxDistinct) return 'value-cap';
  target.set(key, [position]);
  return 'added';
};

const buildPrefixes = (
  mutable: MutableFieldIndex,
  value: string,
  position: number,
  options: NormalizedFilterIndexOptions,
): void => {
  if (!value || mutable.config.prefixLength <= 0) return;
  const maximum = Math.min(value.length, mutable.config.prefixLength);
  for (let length = 1; length <= maximum; length += 1) {
    const prefix = value.slice(0, length);
    const result = appendPosting(
      mutable.prefixes,
      prefix,
      position,
      mutable.config.maxDistinctValues,
      options.maxPostingsPerValue,
    );
    if (result !== 'added') mutable.truncatedValueCount += 1;
  }
};

const createMutableField = (config: NormalizedFieldConfig): MutableFieldIndex => ({
  config,
  equality: new Map<string, number[]>(),
  prefixes: new Map<string, number[]>(),
  exists: [],
  numeric: [],
  indexedCount: 0,
  missingCount: 0,
  truncatedValueCount: 0,
});

const observeRecord = (
  mutable: MutableFieldIndex,
  record: NormalizedRecord,
  position: number,
  options: NormalizedFilterIndexOptions,
): void => {
  const raw = readField(record, mutable.config.field);
  const key = valueKey(raw, mutable.config);
  if (!key) {
    mutable.missingCount += 1;
    return;
  }
  mutable.indexedCount += 1;
  if (mutable.exists.length < options.maxPostingsPerValue) mutable.exists.push(position);
  else mutable.truncatedValueCount += 1;

  const equalityResult = appendPosting(
    mutable.equality,
    key,
    position,
    mutable.config.maxDistinctValues,
    options.maxPostingsPerValue,
  );
  if (equalityResult !== 'added') mutable.truncatedValueCount += 1;

  if (mutable.config.kind === 'string') {
    buildPrefixes(mutable, stringValueFromKey(key), position, options);
  } else if (mutable.config.kind === 'number') {
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) mutable.numeric.push(Object.freeze({ value: numeric, position }));
  }
};

const finalizeField = (
  mutable: MutableFieldIndex,
  recordCount: number,
): FieldIndex => {
  mutable.numeric.sort((left, right) => left.value - right.value || left.position - right.position);
  const diagnostics: FilterFieldDiagnostics = Object.freeze({
    field: mutable.config.field,
    kind: mutable.config.kind,
    recordCount,
    indexedCount: mutable.indexedCount,
    missingCount: mutable.missingCount,
    distinctValueCount: mutable.equality.size,
    prefixCount: mutable.prefixes.size,
    truncatedValueCount: mutable.truncatedValueCount,
  });
  return Object.freeze({
    config: mutable.config,
    equality: freezePostingMap(mutable.equality),
    prefixes: freezePostingMap(mutable.prefixes),
    exists: Object.freeze([...mutable.exists]),
    numeric: Object.freeze([...mutable.numeric]),
    diagnostics,
  });
};

const sortedUnique = (
  values: Iterable<number>,
  maximum: number,
): readonly number[] => {
  const set = new Set<number>();
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0) continue;
    set.add(value);
    if (set.size >= maximum) break;
  }
  return Object.freeze([...set].sort((left, right) => left - right));
};

const intersect = (
  left: readonly number[],
  right: readonly number[],
): readonly number[] => {
  if (!left.length || !right.length) return Object.freeze([]);
  const rightSet = new Set(right);
  const output: number[] = [];
  for (const position of left) {
    if (rightSet.has(position)) output.push(position);
  }
  return Object.freeze(output);
};

const union = (
  groups: readonly (readonly number[])[],
  maximum: number,
): readonly number[] => {
  const set = new Set<number>();
  outer: for (const group of groups) {
    for (const position of group) {
      if (!Number.isSafeInteger(position) || position < 0) continue;
      set.add(position);
      if (set.size >= maximum) break outer;
    }
  }
  return Object.freeze([...set].sort((left, right) => left - right));
};

const lowerBound = (values: readonly NumericPosting[], target: number): number => {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const candidate = values[middle];
    if (candidate && candidate.value < target) low = middle + 1;
    else high = middle;
  }
  return low;
};

const upperBound = (values: readonly NumericPosting[], target: number): number => {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const candidate = values[middle];
    if (candidate && candidate.value <= target) low = middle + 1;
    else high = middle;
  }
  return low;
};

const numericPositions = (
  field: FieldIndex,
  minimum: number | null,
  maximum: number | null,
  limit: number,
): readonly number[] => {
  const start = minimum === null ? 0 : lowerBound(field.numeric, minimum);
  const end = maximum === null ? field.numeric.length : upperBound(field.numeric, maximum);
  const output: number[] = [];
  for (let index = start; index < end; index += 1) {
    const posting = field.numeric[index];
    if (!posting) continue;
    output.push(posting.position);
    if (output.length >= limit) break;
  }
  return sortedUnique(output, limit);
};

const numberValue = (value: unknown): number | null => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const candidatesForFilter = (
  field: FieldIndex,
  filter: SearchFilter,
  maximum: number,
): readonly number[] | null => {
  if (!SUPPORTED_OPERATORS.has(filter.operator)) return null;
  if (field.diagnostics.truncatedValueCount > 0) return null;
  if (filter.operator === 'exists') return field.exists;

  if (filter.operator === 'eq' || filter.operator === 'in') {
    const groups: readonly (readonly number[])[] = filter.values
      .map(value => valueKey(value, field.config))
      .filter((value): value is string => Boolean(value))
      .map(key => field.equality.get(key) ?? Object.freeze([]));
    return union(groups, maximum);
  }

  if (filter.operator === 'prefix') {
    if (field.config.kind !== 'string') return null;
    const values = filter.values
      .map(value => normalizeString(value, field.config.caseSensitive))
      .filter(Boolean);
    if (values.some(value => value.length > field.config.prefixLength)) return null;
    const groups: readonly (readonly number[])[] = values
      .map(value => field.prefixes.get(value) ?? Object.freeze([]));
    return union(groups, maximum);
  }

  if (field.config.kind !== 'number') return null;
  if (filter.operator === 'gte') {
    const minimum = numberValue(filter.values[0]);
    return minimum === null ? Object.freeze([]) : numericPositions(field, minimum, null, maximum);
  }
  if (filter.operator === 'lte') {
    const maximumValue = numberValue(filter.values[0]);
    return maximumValue === null ? Object.freeze([]) : numericPositions(field, null, maximumValue, maximum);
  }
  if (filter.operator === 'between') {
    const first = numberValue(filter.values[0]);
    const second = numberValue(filter.values[1]);
    if (first === null || second === null) return Object.freeze([]);
    return numericPositions(field, Math.min(first, second), Math.max(first, second), maximum);
  }
  return null;
};

const freezeStep = (
  index: number,
  filter: SearchFilter,
  indexed: boolean,
  candidateCount: number,
  reason: string,
): FilterPlanStep => Object.freeze({
  index,
  field: filter.field,
  operator: filter.operator,
  indexed,
  candidateCount,
  reason,
});

export class FilterIndexRuntime {
  readonly #records: readonly NormalizedRecord[];
  readonly #options: NormalizedFilterIndexOptions;
  readonly #fields = new Map<string, FieldIndex>();
  readonly #snapshot: FilterIndexSnapshot;

  constructor(
    records: readonly NormalizedRecord[],
    fieldConfigs: readonly FilterIndexFieldConfig[],
    options: FilterIndexOptions = {},
  ) {
    this.#records = records;
    this.#options = normalizeOptions(options);
    const configs = fieldConfigs
      .slice(0, this.#options.maxFields)
      .map(config => normalizeFieldConfig(config, this.#options));
    const uniqueConfigs = new Map<string, NormalizedFieldConfig>();
    for (const config of configs) {
      if (!uniqueConfigs.has(config.field)) uniqueConfigs.set(config.field, config);
    }

    for (const config of uniqueConfigs.values()) {
      const mutable = createMutableField(config);
      for (let position = 0; position < records.length; position += 1) {
        const record = records[position];
        if (record) observeRecord(mutable, record, position, this.#options);
      }
      this.#fields.set(config.field, finalizeField(mutable, records.length));
    }
    this.#snapshot = this.#createSnapshot();
  }

  snapshot(): FilterIndexSnapshot {
    return this.#snapshot;
  }

  field(fieldInput: unknown): FilterFieldDiagnostics | null {
    const field = normalizeFieldName(fieldInput);
    return this.#fields.get(field)?.diagnostics ?? null;
  }

  plan(filters: readonly SearchFilter[]): FilterExecutionPlan {
    if (!filters.length) {
      const positions = Object.freeze(this.#records.map((_, index) => index));
      return this.#finalizePlan('all-records', positions, 0, 0, [], false);
    }

    let positions: readonly number[] | null = null;
    let indexedFilterCount = 0;
    let residualFilterCount = 0;
    let truncated = false;
    const steps: FilterPlanStep[] = [];

    filters.forEach((filter, index) => {
      const field = this.#fields.get(normalizeFieldName(filter.field));
      if (!field) {
        residualFilterCount += 1;
        steps.push(freezeStep(index, filter, false, this.#records.length, 'field-not-indexed'));
        return;
      }
      if (field.diagnostics.truncatedValueCount > 0) {
        residualFilterCount += 1;
        truncated = true;
        steps.push(freezeStep(index, filter, false, this.#records.length, 'index-truncated-fallback'));
        return;
      }
      const candidates = candidatesForFilter(field, filter, this.#options.maxCandidatePositions);
      if (candidates === null) {
        residualFilterCount += 1;
        steps.push(freezeStep(index, filter, false, this.#records.length, 'operator-not-indexed'));
        return;
      }
      if (candidates.length >= this.#options.maxCandidatePositions) {
        residualFilterCount += 1;
        truncated = true;
        steps.push(freezeStep(index, filter, false, candidates.length, 'candidate-budget-fallback'));
        return;
      }
      indexedFilterCount += 1;
      steps.push(freezeStep(index, filter, true, candidates.length, 'indexed'));
      positions = positions === null
        ? candidates
        : intersect(positions, candidates);
    });

    const resolved = positions ?? Object.freeze(this.#records.map((_, index) => index));
    const strategy: FilterPlanStrategy = resolved.length === 0
      ? 'empty'
      : indexedFilterCount === 0
        ? 'all-records'
        : residualFilterCount > 0
          ? 'hybrid'
          : filters.length > 1
            ? 'indexed-intersection'
            : 'indexed-union';
    return this.#finalizePlan(
      strategy,
      resolved,
      indexedFilterCount,
      residualFilterCount,
      steps,
      truncated,
    );
  }

  candidates(filters: readonly SearchFilter[]): readonly NormalizedRecord[] {
    const plan = this.plan(filters);
    return Object.freeze(plan.positions
      .map(position => this.#records[position])
      .filter((record): record is NormalizedRecord => Boolean(record)));
  }

  validate(): readonly string[] {
    const issues: string[] = [];
    for (const [fieldName, field] of this.#fields) {
      let previousNumeric = Number.NEGATIVE_INFINITY;
      for (const posting of field.numeric) {
        if (posting.value < previousNumeric) issues.push(`numeric-order:${fieldName}`);
        previousNumeric = posting.value;
        if (posting.position < 0 || posting.position >= this.#records.length) {
          issues.push(`numeric-position:${fieldName}:${String(posting.position)}`);
        }
      }
      for (const [key, positions] of field.equality) {
        let previous = -1;
        for (const position of positions) {
          if (position <= previous) issues.push(`equality-order:${fieldName}:${key}`);
          if (position < 0 || position >= this.#records.length) {
            issues.push(`equality-position:${fieldName}:${key}:${String(position)}`);
          }
          previous = position;
        }
      }
    }
    return Object.freeze(issues);
  }

  #finalizePlan(
    strategy: FilterPlanStrategy,
    positions: readonly number[],
    indexedFilterCount: number,
    residualFilterCount: number,
    steps: readonly FilterPlanStep[],
    truncated: boolean,
  ): FilterExecutionPlan {
    const fingerprint = hashFingerprint(stableSerialize({
      index: this.#snapshot.fingerprint,
      strategy,
      positions,
      indexedFilterCount,
      residualFilterCount,
      steps: steps.map(step => [step.field, step.operator, step.indexed, step.candidateCount]),
    }));
    return Object.freeze({
      strategy,
      positions: Object.freeze([...positions]),
      indexedFilterCount,
      residualFilterCount,
      estimatedScanCount: positions.length,
      truncated,
      steps: Object.freeze([...steps]),
      fingerprint,
    });
  }

  #createSnapshot(): FilterIndexSnapshot {
    const fields: Record<string, FilterFieldDiagnostics> = {};
    let postingCount = 0;
    for (const [name, field] of this.#fields) {
      fields[name] = field.diagnostics;
      for (const positions of field.equality.values()) postingCount += positions.length;
      for (const positions of field.prefixes.values()) postingCount += positions.length;
      postingCount += field.numeric.length;
    }
    const fingerprint = hashFingerprint(stableSerialize({
      recordCount: this.#records.length,
      fields: Object.keys(fields).sort().map(name => fields[name]),
    }));
    return Object.freeze({
      version: 1 as const,
      recordCount: this.#records.length,
      fieldCount: this.#fields.size,
      postingCount,
      fingerprint,
      fields: Object.freeze(fields),
    });
  }
}

export const createFilterIndexRuntime = (
  records: readonly NormalizedRecord[],
  fields: readonly FilterIndexFieldConfig[],
  options: FilterIndexOptions = {},
): FilterIndexRuntime => new FilterIndexRuntime(records, fields, options);

export const defaultSearchFilterFields = (): readonly FilterIndexFieldConfig[] => Object.freeze([
  Object.freeze({ field: 'categoryKey', kind: 'string' as const, prefixLength: 8 }),
  Object.freeze({ field: 'typeKey', kind: 'string' as const, prefixLength: 8 }),
  Object.freeze({ field: 'district', kind: 'string' as const, prefixLength: 12 }),
  Object.freeze({ field: 'neighborhood', kind: 'string' as const, prefixLength: 12 }),
  Object.freeze({ field: 'street', kind: 'string' as const, prefixLength: 12 }),
  Object.freeze({ field: 'postalCode', kind: 'string' as const, prefixLength: 5 }),
]);
