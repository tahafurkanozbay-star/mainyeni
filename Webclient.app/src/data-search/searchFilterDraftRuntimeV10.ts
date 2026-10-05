import type { FilterOperator, SearchFilter, SearchRequest } from './contracts';
import {
  hashFingerprint,
  normalizeInteger,
  normalizeSearchText,
  normalizeText,
  stableSerialize,
} from './normalization';

export const SEARCH_FILTER_DRAFT_VERSION_V10 = 'search-filter-draft-v10' as const;

export interface SearchFilterDraftPolicyV10 {
  readonly maximumFilters?: number;
  readonly maximumValuesPerFilter?: number;
  readonly maximumFieldLength?: number;
  readonly maximumValueLength?: number;
  readonly maximumUndoDepth?: number;
}

export interface SearchFilterDraftIssueV10 {
  readonly code:
    | 'invalid-field'
    | 'invalid-operator'
    | 'missing-value'
    | 'between-needs-two-values'
    | 'too-many-filters'
    | 'too-many-values'
    | 'duplicate-filter';
  readonly field: string;
  readonly detail: string;
}

export interface SearchFilterDraftSnapshotV10 {
  readonly version: typeof SEARCH_FILTER_DRAFT_VERSION_V10;
  readonly draft: readonly SearchFilter[];
  readonly applied: readonly SearchFilter[];
  readonly issues: readonly SearchFilterDraftIssueV10[];
  readonly dirty: boolean;
  readonly valid: boolean;
  readonly filterCount: number;
  readonly selectedValueCount: number;
  readonly undoDepth: number;
  readonly redoDepth: number;
  readonly draftFingerprint: string;
  readonly appliedFingerprint: string;
  readonly fingerprint: string;
}

interface NormalizedFilterDraftPolicyV10 {
  readonly maximumFilters: number;
  readonly maximumValuesPerFilter: number;
  readonly maximumFieldLength: number;
  readonly maximumValueLength: number;
  readonly maximumUndoDepth: number;
}

interface HistoryEntryV10 {
  readonly filters: readonly SearchFilter[];
  readonly fingerprint: string;
}

const OPERATORS = new Set<FilterOperator>([
  'eq',
  'neq',
  'in',
  'prefix',
  'contains',
  'exists',
  'gte',
  'lte',
  'between',
]);

const normalizePolicy = (
  policy: SearchFilterDraftPolicyV10 = {},
): NormalizedFilterDraftPolicyV10 => Object.freeze({
  maximumFilters: normalizeInteger(policy.maximumFilters, { min: 1, max: 128, fallback: 32 }),
  maximumValuesPerFilter: normalizeInteger(policy.maximumValuesPerFilter, { min: 1, max: 256, fallback: 64 }),
  maximumFieldLength: normalizeInteger(policy.maximumFieldLength, { min: 8, max: 256, fallback: 96 }),
  maximumValueLength: normalizeInteger(policy.maximumValueLength, { min: 8, max: 2_048, fallback: 256 }),
  maximumUndoDepth: normalizeInteger(policy.maximumUndoDepth, { min: 0, max: 500, fallback: 50 }),
});

const normalizeField = (value: unknown, policy: NormalizedFilterDraftPolicyV10): string =>
  normalizeText(value).slice(0, policy.maximumFieldLength);

const normalizeOperator = (value: unknown): FilterOperator | null => {
  const normalized = normalizeSearchText(value) as FilterOperator;
  return OPERATORS.has(normalized) ? normalized : null;
};

const normalizeValue = (
  value: unknown,
  policy: NormalizedFilterDraftPolicyV10,
): string | number | boolean | null => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = normalizeText(value).slice(0, policy.maximumValueLength);
  return text ? text : null;
};

const valueKey = (value: string | number | boolean): string => `${typeof value}:${String(value)}`;

const normalizeValues = (
  values: readonly unknown[],
  policy: NormalizedFilterDraftPolicyV10,
): readonly (string | number | boolean)[] => {
  const output: (string | number | boolean)[] = [];
  const seen = new Set<string>();
  for (const input of values) {
    const value = normalizeValue(input, policy);
    if (value === null) continue;
    const key = valueKey(value);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(value);
    if (output.length >= policy.maximumValuesPerFilter) break;
  }
  return Object.freeze(output);
};

const freezeFilter = (
  field: string,
  operator: FilterOperator,
  values: readonly (string | number | boolean)[],
  caseSensitive: boolean,
): SearchFilter => Object.freeze({
  field,
  operator,
  values: Object.freeze([...values]),
  ...(caseSensitive ? { caseSensitive: true } : {}),
});

const normalizeFilter = (
  input: SearchFilter,
  policy: NormalizedFilterDraftPolicyV10,
): SearchFilter | null => {
  const field = normalizeField(input.field, policy);
  const operator = normalizeOperator(input.operator);
  if (!field || !operator) return null;
  const values = normalizeValues(input.values, policy);
  if (operator !== 'exists' && values.length === 0) return null;
  if (operator === 'between' && values.length < 2) return null;
  return freezeFilter(field, operator, values, input.caseSensitive === true);
};

const filterIdentity = (filter: SearchFilter): string => `${normalizeSearchText(filter.field)}|${filter.operator}|${filter.caseSensitive === true ? '1' : '0'}`;

const filterFingerprint = (filters: readonly SearchFilter[]): string => hashFingerprint(stableSerialize(filters));

const validateFilter = (
  filter: SearchFilter,
  policy: NormalizedFilterDraftPolicyV10,
): readonly SearchFilterDraftIssueV10[] => {
  const issues: SearchFilterDraftIssueV10[] = [];
  const field = normalizeField(filter.field, policy);
  if (!field) {
    issues.push(Object.freeze({ code: 'invalid-field', field: '', detail: 'Filter field is required.' }));
    return Object.freeze(issues);
  }
  if (!normalizeOperator(filter.operator)) {
    issues.push(Object.freeze({
      code: 'invalid-operator',
      field,
      detail: `Unsupported filter operator: ${String(filter.operator)}`,
    }));
    return Object.freeze(issues);
  }
  if (filter.values.length > policy.maximumValuesPerFilter) {
    issues.push(Object.freeze({
      code: 'too-many-values',
      field,
      detail: `Filter values exceed ${policy.maximumValuesPerFilter}.`,
    }));
  }
  if (filter.operator !== 'exists' && filter.values.length === 0) {
    issues.push(Object.freeze({ code: 'missing-value', field, detail: 'Filter requires at least one value.' }));
  }
  if (filter.operator === 'between' && filter.values.length < 2) {
    issues.push(Object.freeze({ code: 'between-needs-two-values', field, detail: 'Between requires two values.' }));
  }
  return Object.freeze(issues);
};

const validateFilters = (
  filters: readonly SearchFilter[],
  policy: NormalizedFilterDraftPolicyV10,
): readonly SearchFilterDraftIssueV10[] => {
  const issues: SearchFilterDraftIssueV10[] = [];
  if (filters.length > policy.maximumFilters) {
    issues.push(Object.freeze({
      code: 'too-many-filters',
      field: '',
      detail: `Filter count exceeds ${policy.maximumFilters}.`,
    }));
  }
  const seen = new Set<string>();
  for (const filter of filters) {
    issues.push(...validateFilter(filter, policy));
    const identity = filterIdentity(filter);
    if (seen.has(identity)) {
      issues.push(Object.freeze({
        code: 'duplicate-filter',
        field: normalizeText(filter.field),
        detail: 'A filter with the same field/operator/case contract already exists.',
      }));
    }
    seen.add(identity);
  }
  return Object.freeze(issues);
};

const normalizeFilters = (
  filters: readonly SearchFilter[],
  policy: NormalizedFilterDraftPolicyV10,
): readonly SearchFilter[] => {
  const output: SearchFilter[] = [];
  const seen = new Set<string>();
  for (const input of filters) {
    if (output.length >= policy.maximumFilters) break;
    const filter = normalizeFilter(input, policy);
    if (!filter) continue;
    const identity = filterIdentity(filter);
    if (seen.has(identity)) continue;
    seen.add(identity);
    output.push(filter);
  }
  return Object.freeze(output);
};

const historyEntry = (filters: readonly SearchFilter[]): HistoryEntryV10 => Object.freeze({
  filters: Object.freeze([...filters]),
  fingerprint: filterFingerprint(filters),
});

export class SearchFilterDraftRuntimeV10 {
  readonly #policy: NormalizedFilterDraftPolicyV10;
  readonly #undo: HistoryEntryV10[] = [];
  readonly #redo: HistoryEntryV10[] = [];
  #draft: readonly SearchFilter[];
  #applied: readonly SearchFilter[];

  constructor(
    initial: readonly SearchFilter[] = [],
    policy: SearchFilterDraftPolicyV10 = {},
  ) {
    this.#policy = normalizePolicy(policy);
    this.#draft = normalizeFilters(initial, this.#policy);
    this.#applied = this.#draft;
  }

  #recordUndo(): void {
    if (this.#policy.maximumUndoDepth <= 0) return;
    this.#undo.push(historyEntry(this.#draft));
    while (this.#undo.length > this.#policy.maximumUndoDepth) this.#undo.shift();
    this.#redo.length = 0;
  }

  #replaceDraft(next: readonly SearchFilter[], record = true): SearchFilterDraftSnapshotV10 {
    const normalized = normalizeFilters(next, this.#policy);
    if (filterFingerprint(normalized) === filterFingerprint(this.#draft)) return this.snapshot();
    if (record) this.#recordUndo();
    this.#draft = normalized;
    return this.snapshot();
  }

  replace(filters: readonly SearchFilter[]): SearchFilterDraftSnapshotV10 {
    return this.#replaceDraft(filters);
  }

  upsert(filterInput: SearchFilter): SearchFilterDraftSnapshotV10 {
    const filter = normalizeFilter(filterInput, this.#policy);
    if (!filter) return this.snapshot();
    const identity = filterIdentity(filter);
    const next = this.#draft.filter(existing => filterIdentity(existing) !== identity);
    next.push(filter);
    return this.#replaceDraft(next);
  }

  remove(fieldInput: unknown, operatorInput?: unknown): SearchFilterDraftSnapshotV10 {
    const field = normalizeField(fieldInput, this.#policy);
    const operator = operatorInput === undefined ? null : normalizeOperator(operatorInput);
    if (!field) return this.snapshot();
    return this.#replaceDraft(this.#draft.filter(filter => {
      if (normalizeSearchText(filter.field) !== normalizeSearchText(field)) return true;
      return operator !== null && filter.operator !== operator;
    }));
  }

  clear(): SearchFilterDraftSnapshotV10 {
    return this.#replaceDraft(Object.freeze([]));
  }

  toggleFacetValue(
    fieldInput: unknown,
    valueInput: unknown,
    operatorInput: FilterOperator = 'in',
  ): SearchFilterDraftSnapshotV10 {
    const field = normalizeField(fieldInput, this.#policy);
    const operator = normalizeOperator(operatorInput) ?? 'in';
    const value = normalizeValue(valueInput, this.#policy);
    if (!field || value === null) return this.snapshot();
    const identity = `${normalizeSearchText(field)}|${operator}|0`;
    const existing = this.#draft.find(filter => filterIdentity(filter) === identity) ?? null;
    const values = existing ? [...existing.values] : [];
    const key = valueKey(value);
    const index = values.findIndex(candidate => {
      const normalized = normalizeValue(candidate, this.#policy);
      return normalized !== null && valueKey(normalized) === key;
    });
    if (index >= 0) values.splice(index, 1);
    else values.push(value);
    if (values.length === 0) return this.remove(field, operator);
    return this.upsert(freezeFilter(field, operator, normalizeValues(values, this.#policy), false));
  }

  setExists(fieldInput: unknown, enabled: boolean): SearchFilterDraftSnapshotV10 {
    const field = normalizeField(fieldInput, this.#policy);
    if (!field) return this.snapshot();
    return enabled
      ? this.upsert(freezeFilter(field, 'exists', Object.freeze([]), false))
      : this.remove(field, 'exists');
  }

  setRange(
    fieldInput: unknown,
    minimum: unknown,
    maximum: unknown,
  ): SearchFilterDraftSnapshotV10 {
    const field = normalizeField(fieldInput, this.#policy);
    const min = normalizeValue(minimum, this.#policy);
    const max = normalizeValue(maximum, this.#policy);
    if (!field || min === null || max === null) return this.snapshot();
    return this.upsert(freezeFilter(field, 'between', Object.freeze([min, max]), false));
  }

  apply(): SearchFilterDraftSnapshotV10 {
    const issues = validateFilters(this.#draft, this.#policy);
    if (issues.length > 0) return this.snapshot();
    this.#applied = Object.freeze([...this.#draft]);
    return this.snapshot();
  }

  revert(): SearchFilterDraftSnapshotV10 {
    return this.#replaceDraft(this.#applied);
  }

  reset(filters: readonly SearchFilter[] = []): SearchFilterDraftSnapshotV10 {
    const normalized = normalizeFilters(filters, this.#policy);
    this.#draft = normalized;
    this.#applied = normalized;
    this.#undo.length = 0;
    this.#redo.length = 0;
    return this.snapshot();
  }

  undo(): SearchFilterDraftSnapshotV10 {
    const previous = this.#undo.pop();
    if (!previous) return this.snapshot();
    if (this.#policy.maximumUndoDepth > 0) {
      this.#redo.push(historyEntry(this.#draft));
      while (this.#redo.length > this.#policy.maximumUndoDepth) this.#redo.shift();
    }
    this.#draft = previous.filters;
    return this.snapshot();
  }

  redo(): SearchFilterDraftSnapshotV10 {
    const next = this.#redo.pop();
    if (!next) return this.snapshot();
    if (this.#policy.maximumUndoDepth > 0) {
      this.#undo.push(historyEntry(this.#draft));
      while (this.#undo.length > this.#policy.maximumUndoDepth) this.#undo.shift();
    }
    this.#draft = next.filters;
    return this.snapshot();
  }

  toRequest(base: SearchRequest = {}, applied = true): SearchRequest {
    const filters = applied ? this.#applied : this.#draft;
    return Object.freeze({
      ...base,
      ...(filters.length ? { filters } : { filters: Object.freeze([]) }),
      offset: 0,
    });
  }

  draft(): readonly SearchFilter[] {
    return this.#draft;
  }

  applied(): readonly SearchFilter[] {
    return this.#applied;
  }

  snapshot(): SearchFilterDraftSnapshotV10 {
    const issues = validateFilters(this.#draft, this.#policy);
    const draftFingerprint = filterFingerprint(this.#draft);
    const appliedFingerprint = filterFingerprint(this.#applied);
    const selectedValueCount = this.#draft.reduce((total, filter) => total + Math.max(1, filter.values.length), 0);
    const fingerprint = hashFingerprint(stableSerialize({
      version: SEARCH_FILTER_DRAFT_VERSION_V10,
      draftFingerprint,
      appliedFingerprint,
      undo: this.#undo.map(entry => entry.fingerprint),
      redo: this.#redo.map(entry => entry.fingerprint),
    }));
    return Object.freeze({
      version: SEARCH_FILTER_DRAFT_VERSION_V10,
      draft: this.#draft,
      applied: this.#applied,
      issues,
      dirty: draftFingerprint !== appliedFingerprint,
      valid: issues.length === 0,
      filterCount: this.#draft.length,
      selectedValueCount,
      undoDepth: this.#undo.length,
      redoDepth: this.#redo.length,
      draftFingerprint,
      appliedFingerprint,
      fingerprint,
    });
  }
}

export const createSearchFilterDraftRuntimeV10 = (
  initial: readonly SearchFilter[] = [],
  policy: SearchFilterDraftPolicyV10 = {},
): SearchFilterDraftRuntimeV10 => new SearchFilterDraftRuntimeV10(initial, policy);
