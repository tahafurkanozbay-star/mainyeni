import type { SearchRequest } from './contracts';
import {
  hashFingerprint,
  normalizeInteger,
  normalizeSearchText,
  normalizeText,
  stableSerialize,
} from './normalization';
import type { SearchRecoveryResultV8 } from './searchRecoveryRuntimeV8';

export const SEARCH_HISTORY_VERSION_V9 = 'search-history-v9' as const;

export type SearchHistoryOutcomeV9 = 'success' | 'empty' | 'blocked' | 'recovered';

export interface SearchHistoryEntryV9 {
  readonly id: string;
  readonly datasetKey: string;
  readonly datasetRevision: number;
  readonly datasetFingerprint: string;
  readonly query: string;
  readonly normalizedQuery: string;
  readonly resultCount: number;
  readonly outcome: SearchHistoryOutcomeV9;
  readonly recovered: boolean;
  readonly recoveryMode: string;
  readonly filterCount: number;
  readonly hasSpatialConstraint: boolean;
  readonly hasAddressScope: boolean;
  readonly firstUsedAt: number;
  readonly lastUsedAt: number;
  readonly uses: number;
  readonly fingerprint: string;
}

export interface SearchHistorySuggestionV9 {
  readonly query: string;
  readonly normalizedQuery: string;
  readonly score: number;
  readonly uses: number;
  readonly lastUsedAt: number;
  readonly resultCount: number;
  readonly recovered: boolean;
  readonly label: string;
  readonly fingerprint: string;
}

export interface SearchHistoryPolicyV9 {
  readonly maxEntries?: number;
  readonly maxSuggestions?: number;
  readonly maxQueryLength?: number;
  readonly maxUses?: number;
  readonly recencyHalfLifeMs?: number;
  readonly excludeBlocked?: boolean;
  readonly excludeEmpty?: boolean;
  readonly clock?: () => number;
}

export interface SearchHistorySnapshotV9 {
  readonly version: typeof SEARCH_HISTORY_VERSION_V9;
  readonly entries: number;
  readonly records: number;
  readonly deduplicated: number;
  readonly evictions: number;
  readonly suggestionsBuilt: number;
  readonly newestAt: number | null;
  readonly fingerprint: string;
}

interface NormalizedHistoryPolicyV9 {
  readonly maxEntries: number;
  readonly maxSuggestions: number;
  readonly maxQueryLength: number;
  readonly maxUses: number;
  readonly recencyHalfLifeMs: number;
  readonly excludeBlocked: boolean;
  readonly excludeEmpty: boolean;
  readonly clock: () => number;
}

interface MutableHistoryEntryV9 {
  readonly id: string;
  readonly datasetKey: string;
  readonly datasetRevision: number;
  readonly datasetFingerprint: string;
  readonly query: string;
  readonly normalizedQuery: string;
  readonly outcome: SearchHistoryOutcomeV9;
  readonly recovered: boolean;
  readonly recoveryMode: string;
  readonly filterCount: number;
  readonly hasSpatialConstraint: boolean;
  readonly hasAddressScope: boolean;
  readonly firstUsedAt: number;
  resultCount: number;
  lastUsedAt: number;
  uses: number;
}

interface MutableHistoryStatsV9 {
  records: number;
  deduplicated: number;
  evictions: number;
  suggestionsBuilt: number;
}

const normalizePolicy = (
  policy: SearchHistoryPolicyV9 = {},
): NormalizedHistoryPolicyV9 => Object.freeze({
  maxEntries: normalizeInteger(policy.maxEntries, { min: 1, max: 2_000, fallback: 80 }),
  maxSuggestions: normalizeInteger(policy.maxSuggestions, { min: 1, max: 100, fallback: 12 }),
  maxQueryLength: normalizeInteger(policy.maxQueryLength, { min: 8, max: 1_000, fallback: 240 }),
  maxUses: normalizeInteger(policy.maxUses, { min: 1, max: 1_000_000, fallback: 100_000 }),
  recencyHalfLifeMs: normalizeInteger(policy.recencyHalfLifeMs, {
    min: 1_000,
    max: 365 * 24 * 60 * 60 * 1_000,
    fallback: 7 * 24 * 60 * 60 * 1_000,
  }),
  excludeBlocked: policy.excludeBlocked !== false,
  excludeEmpty: policy.excludeEmpty === true,
  clock: typeof policy.clock === 'function' ? policy.clock : () => Date.now(),
});

const safeNow = (clock: () => number): number => {
  const value = Number(clock());
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : Date.now();
};

const canonicalDatasetKey = (value: unknown): string => normalizeSearchText(value)
  .replace(/[^a-z0-9_-]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 160);

const boundedQuery = (value: unknown, maximum: number): string => {
  const text = normalizeText(value);
  return text.length <= maximum ? text : text.slice(0, maximum).trimEnd();
};

const hasSpatialConstraint = (request: SearchRequest): boolean => Boolean(
  request.center
  || (Number.isFinite(Number(request.radiusMeters)) && Number(request.radiusMeters) > 0),
);

const hasAddressScope = (request: SearchRequest): boolean => Boolean(
  request.level
  || normalizeText(request.district)
  || normalizeText(request.neighborhood)
  || normalizeText(request.street),
);

const outcomeFor = (recovery: SearchRecoveryResultV8): SearchHistoryOutcomeV9 => {
  if (recovery.final.result.diagnostics.blocked) return 'blocked';
  if (recovery.diagnostics.recovered) return 'recovered';
  return recovery.response.results.length > 0 ? 'success' : 'empty';
};

const entryId = (
  datasetKey: string,
  normalizedQuery: string,
  filterCount: number,
  spatial: boolean,
  addressScope: boolean,
): string => hashFingerprint(stableSerialize({
  version: SEARCH_HISTORY_VERSION_V9,
  datasetKey,
  normalizedQuery,
  filterCount,
  spatial,
  addressScope,
}));

const freezeEntry = (entry: MutableHistoryEntryV9): SearchHistoryEntryV9 => Object.freeze({
  id: entry.id,
  datasetKey: entry.datasetKey,
  datasetRevision: entry.datasetRevision,
  datasetFingerprint: entry.datasetFingerprint,
  query: entry.query,
  normalizedQuery: entry.normalizedQuery,
  resultCount: entry.resultCount,
  outcome: entry.outcome,
  recovered: entry.recovered,
  recoveryMode: entry.recoveryMode,
  filterCount: entry.filterCount,
  hasSpatialConstraint: entry.hasSpatialConstraint,
  hasAddressScope: entry.hasAddressScope,
  firstUsedAt: entry.firstUsedAt,
  lastUsedAt: entry.lastUsedAt,
  uses: entry.uses,
  fingerprint: hashFingerprint(stableSerialize({
    id: entry.id,
    datasetRevision: entry.datasetRevision,
    datasetFingerprint: entry.datasetFingerprint,
    resultCount: entry.resultCount,
    outcome: entry.outcome,
    recovered: entry.recovered,
    recoveryMode: entry.recoveryMode,
    firstUsedAt: entry.firstUsedAt,
    lastUsedAt: entry.lastUsedAt,
    uses: entry.uses,
  })),
});

const prefixMatches = (query: string, prefix: string): boolean => {
  if (!prefix) return true;
  if (query.startsWith(prefix)) return true;
  return query.split(/\s+/u).some(token => token.startsWith(prefix));
};

const recencyScore = (
  now: number,
  lastUsedAt: number,
  halfLifeMs: number,
): number => {
  const age = Math.max(0, now - lastUsedAt);
  return Math.pow(0.5, age / halfLifeMs);
};

const suggestionScore = (
  entry: MutableHistoryEntryV9,
  now: number,
  prefix: string,
  policy: NormalizedHistoryPolicyV9,
): number => {
  const recency = recencyScore(now, entry.lastUsedAt, policy.recencyHalfLifeMs);
  const frequency = Math.log2(entry.uses + 1) / 12;
  const resultSignal = entry.resultCount > 0 ? Math.min(1, Math.log2(entry.resultCount + 1) / 8) : 0;
  const recoveryPenalty = entry.recovered ? 0.02 : 0;
  const prefixBoost = prefix && entry.normalizedQuery.startsWith(prefix) ? 0.25 : 0;
  const score = recency * 0.55 + frequency * 0.25 + resultSignal * 0.2 + prefixBoost - recoveryPenalty;
  return Math.round(Math.max(0, score) * 1_000_000) / 1_000_000;
};

const suggestionLabel = (entry: MutableHistoryEntryV9): string => {
  const suffix = entry.resultCount === 1 ? '1 sonuç' : `${entry.resultCount} sonuç`;
  return entry.recovered
    ? `${entry.query} · ${suffix} · düzeltmeyle bulundu`
    : `${entry.query} · ${suffix}`;
};

export class SearchHistoryRuntimeV9 {
  readonly #policy: NormalizedHistoryPolicyV9;
  readonly #entries = new Map<string, MutableHistoryEntryV9>();
  readonly #stats: MutableHistoryStatsV9 = {
    records: 0,
    deduplicated: 0,
    evictions: 0,
    suggestionsBuilt: 0,
  };

  constructor(policy: SearchHistoryPolicyV9 = {}) {
    this.#policy = normalizePolicy(policy);
  }

  record(
    request: SearchRequest,
    recovery: SearchRecoveryResultV8,
  ): SearchHistoryEntryV9 | null {
    const query = boundedQuery(recovery.diagnostics.originalQuery || request.query, this.#policy.maxQueryLength);
    const normalizedQuery = normalizeSearchText(query);
    if (!normalizedQuery) return null;
    const outcome = outcomeFor(recovery);
    if (outcome === 'blocked' && this.#policy.excludeBlocked) return null;
    if (outcome === 'empty' && this.#policy.excludeEmpty) return null;

    const datasetKey = canonicalDatasetKey(recovery.diagnostics.datasetKey);
    if (!datasetKey) return null;
    const filterCount = Math.min(1_000, request.filters?.length ?? 0);
    const spatial = hasSpatialConstraint(request);
    const addressScope = hasAddressScope(request);
    const id = entryId(datasetKey, normalizedQuery, filterCount, spatial, addressScope);
    const now = safeNow(this.#policy.clock);
    const existing = this.#entries.get(id);
    if (existing) {
      existing.resultCount = recovery.response.results.length;
      existing.lastUsedAt = now;
      existing.uses = Math.min(this.#policy.maxUses, existing.uses + 1);
      this.#entries.delete(id);
      this.#entries.set(id, existing);
      this.#stats.records += 1;
      this.#stats.deduplicated += 1;
      return freezeEntry(existing);
    }

    const entry: MutableHistoryEntryV9 = {
      id,
      datasetKey,
      datasetRevision: recovery.diagnostics.datasetRevision,
      datasetFingerprint: recovery.diagnostics.datasetFingerprint,
      query,
      normalizedQuery,
      resultCount: recovery.response.results.length,
      outcome,
      recovered: recovery.diagnostics.recovered,
      recoveryMode: normalizeSearchText(recovery.diagnostics.mode),
      filterCount,
      hasSpatialConstraint: spatial,
      hasAddressScope: addressScope,
      firstUsedAt: now,
      lastUsedAt: now,
      uses: 1,
    };
    this.#entries.set(id, entry);
    this.#stats.records += 1;
    while (this.#entries.size > this.#policy.maxEntries) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#entries.delete(oldest);
      this.#stats.evictions += 1;
    }
    return freezeEntry(entry);
  }

  entries(datasetKeyInput?: unknown): readonly SearchHistoryEntryV9[] {
    const datasetKey = datasetKeyInput === undefined ? '' : canonicalDatasetKey(datasetKeyInput);
    const values = [...this.#entries.values()]
      .filter(entry => !datasetKey || entry.datasetKey === datasetKey)
      .sort((left, right) => right.lastUsedAt - left.lastUsedAt
        || right.uses - left.uses
        || left.normalizedQuery.localeCompare(right.normalizedQuery, 'tr-TR', { sensitivity: 'base' }));
    return Object.freeze(values.map(freezeEntry));
  }

  suggestions(
    datasetKeyInput: unknown,
    prefixInput: unknown = '',
    limitInput?: unknown,
  ): readonly SearchHistorySuggestionV9[] {
    const datasetKey = canonicalDatasetKey(datasetKeyInput);
    if (!datasetKey) return Object.freeze([]);
    const prefix = normalizeSearchText(prefixInput);
    const limit = normalizeInteger(limitInput, {
      min: 1,
      max: this.#policy.maxSuggestions,
      fallback: this.#policy.maxSuggestions,
    });
    const now = safeNow(this.#policy.clock);
    const candidates = [...this.#entries.values()]
      .filter(entry => entry.datasetKey === datasetKey)
      .filter(entry => prefixMatches(entry.normalizedQuery, prefix))
      .map(entry => Object.freeze({ entry, score: suggestionScore(entry, now, prefix, this.#policy) }))
      .sort((left, right) => right.score - left.score
        || right.entry.lastUsedAt - left.entry.lastUsedAt
        || right.entry.uses - left.entry.uses
        || left.entry.normalizedQuery.localeCompare(right.entry.normalizedQuery, 'tr-TR', { sensitivity: 'base' }))
      .slice(0, limit);
    const suggestions = candidates.map(({ entry, score }) => Object.freeze({
      query: entry.query,
      normalizedQuery: entry.normalizedQuery,
      score,
      uses: entry.uses,
      lastUsedAt: entry.lastUsedAt,
      resultCount: entry.resultCount,
      recovered: entry.recovered,
      label: suggestionLabel(entry),
      fingerprint: hashFingerprint(stableSerialize({
        version: SEARCH_HISTORY_VERSION_V9,
        entryId: entry.id,
        score,
        prefix,
      })),
    }));
    this.#stats.suggestionsBuilt += suggestions.length;
    return Object.freeze(suggestions);
  }

  clear(datasetKeyInput?: unknown): number {
    if (datasetKeyInput === undefined) {
      const count = this.#entries.size;
      this.#entries.clear();
      return count;
    }
    const datasetKey = canonicalDatasetKey(datasetKeyInput);
    if (!datasetKey) return 0;
    const ids = [...this.#entries.entries()]
      .filter(([, entry]) => entry.datasetKey === datasetKey)
      .map(([id]) => id);
    for (const id of ids) this.#entries.delete(id);
    return ids.length;
  }

  snapshot(): SearchHistorySnapshotV9 {
    let newestAt: number | null = null;
    for (const entry of this.#entries.values()) {
      if (newestAt === null || entry.lastUsedAt > newestAt) newestAt = entry.lastUsedAt;
    }
    return Object.freeze({
      version: SEARCH_HISTORY_VERSION_V9,
      entries: this.#entries.size,
      records: this.#stats.records,
      deduplicated: this.#stats.deduplicated,
      evictions: this.#stats.evictions,
      suggestionsBuilt: this.#stats.suggestionsBuilt,
      newestAt,
      fingerprint: hashFingerprint(stableSerialize({
        version: SEARCH_HISTORY_VERSION_V9,
        policy: {
          maxEntries: this.#policy.maxEntries,
          maxSuggestions: this.#policy.maxSuggestions,
          maxQueryLength: this.#policy.maxQueryLength,
          maxUses: this.#policy.maxUses,
          recencyHalfLifeMs: this.#policy.recencyHalfLifeMs,
          excludeBlocked: this.#policy.excludeBlocked,
          excludeEmpty: this.#policy.excludeEmpty,
        },
        stats: this.#stats,
        entries: [...this.#entries.values()].map(entry => [
          entry.id,
          entry.datasetKey,
          entry.datasetRevision,
          entry.datasetFingerprint,
          entry.lastUsedAt,
          entry.uses,
          entry.resultCount,
          entry.outcome,
        ]),
      })),
    });
  }
}

export const createSearchHistoryRuntimeV9 = (
  policy: SearchHistoryPolicyV9 = {},
): SearchHistoryRuntimeV9 => new SearchHistoryRuntimeV9(policy);
