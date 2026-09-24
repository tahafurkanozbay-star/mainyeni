import type {
  FacetBucket,
  NormalizedRecord,
  PageInfo,
  SearchHit,
  SearchRequest,
  SearchResponse,
} from './contracts';
import { throwIfAborted } from './contracts';
import {
  createPageInfo,
  hashFingerprint,
  normalizeInteger,
  normalizeSearchText,
  normalizeText,
} from './normalization';
import {
  assertSearchRequestAllowed,
  type SearchRequestPolicyDecision,
  type SearchRequestPolicyOptions,
} from './searchRequestPolicy';
import {
  SearchWorkloadGovernor,
  type SearchWorkPriority,
  type SearchWorkloadGovernorOptions,
} from './searchWorkloadGovernor';

export const FEDERATED_SEARCH_VERSION = '2026-09-24.v1';

export interface FederatedSearchSourceContext {
  readonly sourceKey: string;
  readonly requestFingerprint: string;
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
  readonly sequence: number;
}

export interface FederatedSearchSource {
  readonly key: string;
  readonly priority?: number;
  readonly weight?: number;
  readonly lane?: string;
  readonly timeoutMs?: number;
  readonly enabled?: boolean;
  readonly search: (
    request: SearchRequest,
    context: FederatedSearchSourceContext,
  ) => Promise<SearchResponse> | SearchResponse;
}

export interface FederatedSearchRuntimeOptions {
  readonly maxSources?: number;
  readonly maxResultsPerSource?: number;
  readonly maxMergedResults?: number;
  readonly maxEstimatedBytes?: number;
  readonly defaultDeadlineMs?: number;
  readonly sourceTimeoutMs?: number;
  readonly partialResults?: boolean;
  readonly clock?: () => number;
  readonly requestPolicy?: SearchRequestPolicyOptions;
  readonly workload?: SearchWorkloadGovernorOptions;
  readonly workloadGovernor?: SearchWorkloadGovernor;
}

export interface FederatedSearchRequest {
  readonly request?: SearchRequest | null;
  readonly sourceKeys?: readonly string[] | null;
  readonly deadlineMs?: number | null;
  readonly requireAllSources?: boolean;
  readonly signal?: AbortSignal | null;
}

export type FederatedSourceStatus =
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'timed-out'
  | 'skipped';

export interface FederatedSourceDiagnostic {
  readonly sourceKey: string;
  readonly status: FederatedSourceStatus;
  readonly elapsedMs: number;
  readonly resultCount: number;
  readonly total: number;
  readonly cacheHit: boolean;
  readonly priority: number;
  readonly weight: number;
  readonly errorName: string | null;
  readonly errorCode: string | null;
}

export interface FederatedSearchHit extends SearchHit {
  readonly sourceKey: string;
  readonly sourcePriority: number;
  readonly sourceWeight: number;
  readonly weightedScore: number;
  readonly stableKey: string;
}

export interface FederatedSearchDiagnostics {
  readonly version: string;
  readonly sequence: number;
  readonly requestFingerprint: string;
  readonly sourceCount: number;
  readonly completedSourceCount: number;
  readonly failedSourceCount: number;
  readonly timedOutSourceCount: number;
  readonly abortedSourceCount: number;
  readonly rawHitCount: number;
  readonly deduplicatedHitCount: number;
  readonly duplicateHitCount: number;
  readonly estimatedBytes: number;
  readonly truncatedByResultBudget: boolean;
  readonly truncatedByByteBudget: boolean;
  readonly stale: boolean;
  readonly elapsedMs: number;
  readonly sources: readonly FederatedSourceDiagnostic[];
  readonly policy: SearchRequestPolicyDecision;
}

export interface FederatedSearchResponse {
  readonly results: readonly FederatedSearchHit[];
  readonly page: PageInfo;
  readonly facets: Readonly<Record<string, readonly FacetBucket[]>>;
  readonly diagnostics: FederatedSearchDiagnostics;
}

interface NormalizedSource {
  readonly key: string;
  readonly priority: number;
  readonly weight: number;
  readonly lane: string;
  readonly timeoutMs: number;
  readonly search: FederatedSearchSource['search'];
}

interface NormalizedOptions {
  readonly maxSources: number;
  readonly maxResultsPerSource: number;
  readonly maxMergedResults: number;
  readonly maxEstimatedBytes: number;
  readonly defaultDeadlineMs: number;
  readonly sourceTimeoutMs: number;
  readonly partialResults: boolean;
  readonly clock: () => number;
  readonly requestPolicy: SearchRequestPolicyOptions;
}

interface SourceExecutionResult {
  readonly source: NormalizedSource;
  readonly response: SearchResponse | null;
  readonly diagnostic: FederatedSourceDiagnostic;
}

const SAFE_SOURCE_KEY = /^[a-z0-9][a-z0-9._:-]{0,119}$/;

const safeClock = (clock: () => number): number => {
  const value = Number(clock());
  return Number.isFinite(value) ? value : Date.now();
};

const normalizeSourceKey = (value: unknown): string => normalizeSearchText(value)
  .replace(/\s+/g, '-')
  .slice(0, 120);

const normalizeOptions = (
  options: FederatedSearchRuntimeOptions = {},
): NormalizedOptions => Object.freeze({
  maxSources: normalizeInteger(options.maxSources, { min: 1, max: 128, fallback: 12 }),
  maxResultsPerSource: normalizeInteger(options.maxResultsPerSource, { min: 1, max: 5_000, fallback: 500 }),
  maxMergedResults: normalizeInteger(options.maxMergedResults, { min: 1, max: 20_000, fallback: 2_000 }),
  maxEstimatedBytes: normalizeInteger(options.maxEstimatedBytes, { min: 16_384, max: 128 * 1024 * 1024, fallback: 8 * 1024 * 1024 }),
  defaultDeadlineMs: normalizeInteger(options.defaultDeadlineMs, { min: 100, max: 60_000, fallback: 5_000 }),
  sourceTimeoutMs: normalizeInteger(options.sourceTimeoutMs, { min: 100, max: 60_000, fallback: 3_000 }),
  partialResults: options.partialResults !== false,
  clock: typeof options.clock === 'function' ? options.clock : () => Date.now(),
  requestPolicy: options.requestPolicy ?? {},
});

const normalizeSource = (
  source: FederatedSearchSource,
  defaultTimeoutMs: number,
): NormalizedSource => {
  const key = normalizeSourceKey(source.key);
  if (!SAFE_SOURCE_KEY.test(key)) {
    throw new TypeError(`Federated search source key is invalid: ${normalizeText(source.key)}`);
  }
  if (typeof source.search !== 'function') {
    throw new TypeError(`Federated search source "${key}" must provide a search function.`);
  }
  const priority = normalizeInteger(source.priority, { min: -10_000, max: 10_000, fallback: 100 });
  const weightRaw = Number(source.weight);
  const weight = Number.isFinite(weightRaw) ? Math.min(10, Math.max(0.01, weightRaw)) : 1;
  const lane = normalizeSourceKey(source.lane || key) || key;
  const timeoutMs = normalizeInteger(source.timeoutMs, { min: 100, max: 60_000, fallback: defaultTimeoutMs });
  return Object.freeze({ key, priority, weight, lane, timeoutMs, search: source.search });
};

const workPriorityForSource = (priority: number): SearchWorkPriority => {
  if (priority <= 10) return 'critical';
  if (priority <= 50) return 'high';
  if (priority <= 150) return 'normal';
  if (priority <= 500) return 'low';
  return 'background';
};

const linkAbortSignals = (
  signals: readonly (AbortSignal | null | undefined)[],
): { readonly controller: AbortController; readonly cleanup: () => void } => {
  const controller = new AbortController();
  const cleanups: Array<() => void> = [];
  const abort = (signal: AbortSignal): void => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
  };
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      abort(signal);
      break;
    }
    const listener = (): void => abort(signal);
    signal.addEventListener('abort', listener, { once: true });
    cleanups.push(() => signal.removeEventListener('abort', listener));
  }
  return Object.freeze({
    controller,
    cleanup: () => {
      for (const cleanup of cleanups) cleanup();
    },
  });
};

const timeoutAbort = (
  controller: AbortController,
  timeoutMs: number,
  label: string,
): ReturnType<typeof setTimeout> => setTimeout(() => {
  if (!controller.signal.aborted) {
    const error = new Error(`${label} exceeded ${timeoutMs}ms.`);
    error.name = 'SearchSourceTimeoutError';
    controller.abort(error);
  }
}, timeoutMs);

const errorCode = (error: unknown): string | null => {
  if (!error || typeof error !== 'object') return null;
  const candidate = (error as { readonly code?: unknown }).code;
  return typeof candidate === 'string' ? candidate.slice(0, 80) : null;
};

const errorName = (error: unknown): string | null =>
  error instanceof Error ? normalizeText(error.name).slice(0, 80) || 'Error' : null;

const isTimeoutError = (error: unknown, signal: AbortSignal): boolean => {
  if (signal.reason instanceof Error && signal.reason.name === 'SearchSourceTimeoutError') return true;
  return error instanceof Error && error.name === 'SearchSourceTimeoutError';
};

const recordStableKey = (record: NormalizedRecord): string => {
  if (record.id) return `id:${normalizeSearchText(record.id)}`;
  if (record.fingerprint) return `fp:${record.fingerprint}`;
  return `derived:${hashFingerprint({
    title: normalizeSearchText(record.title),
    address: normalizeSearchText(record.address),
    category: record.categoryKey,
    type: record.typeKey,
    coordinates: record.coordinates,
  })}`;
};

const estimateHitBytes = (hit: SearchHit): number => {
  const record = hit.record;
  return 160
    + recordStableKey(record).length * 2
    + record.title.length * 2
    + record.address.length * 2
    + record.category.length * 2
    + record.type.length * 2
    + record.district.length * 2
    + record.neighborhood.length * 2
    + record.street.length * 2
    + hit.reasons.reduce((sum, reason) => sum + reason.length * 2, 0);
};

const compareFederatedHits = (left: FederatedSearchHit, right: FederatedSearchHit): number => {
  if (right.weightedScore !== left.weightedScore) return right.weightedScore - left.weightedScore;
  if (left.sourcePriority !== right.sourcePriority) return left.sourcePriority - right.sourcePriority;
  if (right.score !== left.score) return right.score - left.score;
  const leftDistance = left.distanceMeters ?? Number.POSITIVE_INFINITY;
  const rightDistance = right.distanceMeters ?? Number.POSITIVE_INFINITY;
  if (leftDistance !== rightDistance) return leftDistance - rightDistance;
  const title = left.record.title.localeCompare(right.record.title, 'tr-TR', { sensitivity: 'base', numeric: true });
  if (title !== 0) return title;
  if (left.sourceKey !== right.sourceKey) return left.sourceKey.localeCompare(right.sourceKey, 'en');
  return left.stableKey.localeCompare(right.stableKey, 'en');
};

const isBetterHit = (candidate: FederatedSearchHit, current: FederatedSearchHit): boolean =>
  compareFederatedHits(candidate, current) < 0;

const mergeFacets = (
  sourceResults: readonly SourceExecutionResult[],
  requestedFields: readonly string[],
): Readonly<Record<string, readonly FacetBucket[]>> => {
  const output: Record<string, readonly FacetBucket[]> = {};
  for (const field of requestedFields) {
    const counts = new Map<string, number>();
    for (const result of sourceResults) {
      const buckets = result.response?.facets[field] ?? [];
      for (const bucket of buckets) {
        const value = normalizeText(bucket.value);
        if (!value) continue;
        counts.set(value, (counts.get(value) ?? 0) + Math.max(0, bucket.count));
      }
    }
    output[field] = Object.freeze(Array.from(counts.entries())
      .map(([value, count]) => Object.freeze({ value, count }))
      .sort((left, right) => right.count - left.count
        || left.value.localeCompare(right.value, 'tr-TR', { sensitivity: 'base', numeric: true })));
  }
  return Object.freeze(output);
};

export class FederatedSearchRuntime {
  readonly #options: NormalizedOptions;
  readonly #sources = new Map<string, NormalizedSource>();
  readonly #governor: SearchWorkloadGovernor;
  readonly #ownsGovernor: boolean;
  #sequence = 0;
  #latestSequence = 0;
  #disposed = false;

  constructor(
    sources: readonly FederatedSearchSource[] = [],
    options: FederatedSearchRuntimeOptions = {},
  ) {
    this.#options = normalizeOptions(options);
    this.#governor = options.workloadGovernor ?? new SearchWorkloadGovernor(options.workload);
    this.#ownsGovernor = !options.workloadGovernor;
    for (const source of sources) {
      if (source.enabled === false) continue;
      this.registerSource(source);
    }
  }

  registerSource(source: FederatedSearchSource): void {
    if (this.#disposed) throw new Error('Federated search runtime is disposed.');
    const normalized = normalizeSource(source, this.#options.sourceTimeoutMs);
    if (!this.#sources.has(normalized.key) && this.#sources.size >= this.#options.maxSources) {
      throw new RangeError(`Federated search source capacity ${this.#options.maxSources} exceeded.`);
    }
    this.#sources.set(normalized.key, normalized);
  }

  unregisterSource(sourceKey: string): boolean {
    return this.#sources.delete(normalizeSourceKey(sourceKey));
  }

  listSourceKeys(): readonly string[] {
    return Object.freeze(Array.from(this.#sources.keys()).sort((left, right) => left.localeCompare(right, 'en')));
  }

  async search(input: FederatedSearchRequest = {}): Promise<FederatedSearchResponse> {
    if (this.#disposed) throw new Error('Federated search runtime is disposed.');
    throwIfAborted(input.signal ?? input.request?.signal);
    const startedAt = safeClock(this.#options.clock);
    const availableKeys = this.listSourceKeys();
    const requestedKeys = input.sourceKeys?.length ? input.sourceKeys : availableKeys;
    const policy = assertSearchRequestAllowed({
      request: {
        ...input.request,
        signal: input.signal ?? input.request?.signal ?? null,
      },
      sourceKeys: requestedKeys,
      deadlineMs: input.deadlineMs ?? this.#options.defaultDeadlineMs,
    }, {
      ...this.#options.requestPolicy,
      maxSourceKeys: Math.min(this.#options.maxSources, this.#options.requestPolicy.maxSourceKeys ?? this.#options.maxSources),
    });
    const sequence = ++this.#sequence;
    this.#latestSequence = sequence;
    const selected = policy.sourceKeys
      .map(key => this.#sources.get(key))
      .filter((source): source is NormalizedSource => Boolean(source))
      .sort((left, right) => left.priority - right.priority || left.key.localeCompare(right.key, 'en'));

    if (selected.length === 0) {
      return this.#emptyResponse(policy, sequence, startedAt, []);
    }

    const globalLink = linkAbortSignals([input.signal, policy.request.signal]);
    const globalTimer = timeoutAbort(globalLink.controller, policy.deadlineMs, 'Federated search deadline');
    try {
      const executions = selected.map(source => this.#executeSource(
        source,
        policy,
        sequence,
        startedAt + policy.deadlineMs,
        globalLink.controller.signal,
      ));
      const settled = await Promise.all(executions);
      const failures = settled.filter(result => result.diagnostic.status !== 'completed');
      const requireAllSources = input.requireAllSources === true || !this.#options.partialResults;
      if (requireAllSources && failures.length > 0) {
        const error = new Error(
          `Federated search requires every source, but ${failures.length} source(s) did not complete.`,
        );
        error.name = 'FederatedSearchPartialFailureError';
        throw error;
      }
      return this.#mergeResponses(policy, sequence, startedAt, settled);
    } finally {
      clearTimeout(globalTimer);
      globalLink.cleanup();
    }
  }

  getSnapshot(): Readonly<{
    version: string;
    sourceCount: number;
    sourceKeys: readonly string[];
    sequence: number;
    latestSequence: number;
    disposed: boolean;
    workload: ReturnType<SearchWorkloadGovernor['getSnapshot']>;
  }> {
    return Object.freeze({
      version: FEDERATED_SEARCH_VERSION,
      sourceCount: this.#sources.size,
      sourceKeys: this.listSourceKeys(),
      sequence: this.#sequence,
      latestSequence: this.#latestSequence,
      disposed: this.#disposed,
      workload: this.#governor.getSnapshot(),
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#sources.clear();
    if (this.#ownsGovernor) this.#governor.dispose('Federated search runtime disposed');
  }

  async #executeSource(
    source: NormalizedSource,
    policy: SearchRequestPolicyDecision,
    sequence: number,
    globalDeadlineAt: number,
    globalSignal: AbortSignal,
  ): Promise<SourceExecutionResult> {
    const sourceStartedAt = safeClock(this.#options.clock);
    if (globalSignal.aborted) {
      return Object.freeze({
        source,
        response: null,
        diagnostic: this.#diagnostic(source, 'aborted', sourceStartedAt, null, globalSignal.reason),
      });
    }
    const remaining = Math.max(100, globalDeadlineAt - sourceStartedAt);
    const timeoutMs = Math.min(source.timeoutMs, remaining);
    const link = linkAbortSignals([globalSignal]);
    const timer = timeoutAbort(link.controller, timeoutMs, `Federated source ${source.key}`);
    const context: FederatedSearchSourceContext = Object.freeze({
      sourceKey: source.key,
      requestFingerprint: policy.fingerprint,
      deadlineAt: sourceStartedAt + timeoutMs,
      signal: link.controller.signal,
      sequence,
    });
    try {
      const response = await this.#governor.run({
        key: `${source.key}:${policy.fingerprint}`,
        lane: source.lane,
        priority: workPriorityForSource(source.priority),
        signal: link.controller.signal,
        maxQueueWaitMs: Math.max(100, Math.min(timeoutMs, policy.deadlineMs)),
        dedupe: true,
      }, workload => source.search({
        ...policy.request,
        offset: 0,
        limit: this.#options.maxResultsPerSource,
        signal: workload.signal,
      }, Object.freeze({ ...context, signal: workload.signal })));
      throwIfAborted(link.controller.signal);
      return Object.freeze({
        source,
        response,
        diagnostic: this.#diagnostic(source, 'completed', sourceStartedAt, response, null),
      });
    } catch (error) {
      const status: FederatedSourceStatus = isTimeoutError(error, link.controller.signal)
        ? 'timed-out'
        : link.controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')
          ? 'aborted'
          : 'failed';
      return Object.freeze({
        source,
        response: null,
        diagnostic: this.#diagnostic(source, status, sourceStartedAt, null, error),
      });
    } finally {
      clearTimeout(timer);
      link.cleanup();
    }
  }

  #diagnostic(
    source: NormalizedSource,
    status: FederatedSourceStatus,
    startedAt: number,
    response: SearchResponse | null,
    error: unknown,
  ): FederatedSourceDiagnostic {
    const completedAt = safeClock(this.#options.clock);
    return Object.freeze({
      sourceKey: source.key,
      status,
      elapsedMs: Math.max(0, completedAt - startedAt),
      resultCount: response?.results.length ?? 0,
      total: response?.page.total ?? 0,
      cacheHit: response?.diagnostics.cacheHit ?? false,
      priority: source.priority,
      weight: source.weight,
      errorName: errorName(error),
      errorCode: errorCode(error),
    });
  }

  #mergeResponses(
    policy: SearchRequestPolicyDecision,
    sequence: number,
    startedAt: number,
    sourceResults: readonly SourceExecutionResult[],
  ): FederatedSearchResponse {
    const dedupe = new Map<string, FederatedSearchHit>();
    let rawHitCount = 0;
    let duplicateHitCount = 0;
    let estimatedBytes = 0;
    let truncatedByResultBudget = false;
    let truncatedByByteBudget = false;

    for (const sourceResult of sourceResults) {
      const response = sourceResult.response;
      if (!response) continue;
      const boundedHits = response.results.slice(0, this.#options.maxResultsPerSource);
      rawHitCount += boundedHits.length;
      for (const hit of boundedHits) {
        if (dedupe.size >= this.#options.maxMergedResults && !dedupe.has(recordStableKey(hit.record))) {
          truncatedByResultBudget = true;
          continue;
        }
        const bytes = estimateHitBytes(hit);
        if (estimatedBytes + bytes > this.#options.maxEstimatedBytes && !dedupe.has(recordStableKey(hit.record))) {
          truncatedByByteBudget = true;
          continue;
        }
        const stableKey = recordStableKey(hit.record);
        const weighted: FederatedSearchHit = Object.freeze({
          ...hit,
          sourceKey: sourceResult.source.key,
          sourcePriority: sourceResult.source.priority,
          sourceWeight: sourceResult.source.weight,
          weightedScore: hit.score * sourceResult.source.weight,
          stableKey,
        });
        const existing = dedupe.get(stableKey);
        if (existing) {
          duplicateHitCount += 1;
          if (isBetterHit(weighted, existing)) dedupe.set(stableKey, weighted);
          continue;
        }
        estimatedBytes += bytes;
        dedupe.set(stableKey, weighted);
      }
    }

    const ordered = Array.from(dedupe.values()).sort(compareFederatedHits);
    const offset = normalizeInteger(policy.request.offset, { min: 0, fallback: 0 });
    const limit = normalizeInteger(policy.request.limit, { min: 1, max: 2_000, fallback: 50 });
    const pageItems = Object.freeze(ordered.slice(offset, offset + limit));
    const page = createPageInfo(offset, limit, pageItems.length, ordered.length, limit);
    const diagnosticsBySource = Object.freeze([...sourceResults]
      .map(result => result.diagnostic)
      .sort((left, right) => left.priority - right.priority || left.sourceKey.localeCompare(right.sourceKey, 'en')));
    const completedSourceCount = diagnosticsBySource.filter(item => item.status === 'completed').length;
    const failedSourceCount = diagnosticsBySource.filter(item => item.status === 'failed').length;
    const timedOutSourceCount = diagnosticsBySource.filter(item => item.status === 'timed-out').length;
    const abortedSourceCount = diagnosticsBySource.filter(item => item.status === 'aborted').length;
    const stale = sequence !== this.#latestSequence;
    const diagnostics: FederatedSearchDiagnostics = Object.freeze({
      version: FEDERATED_SEARCH_VERSION,
      sequence,
      requestFingerprint: policy.fingerprint,
      sourceCount: sourceResults.length,
      completedSourceCount,
      failedSourceCount,
      timedOutSourceCount,
      abortedSourceCount,
      rawHitCount,
      deduplicatedHitCount: ordered.length,
      duplicateHitCount,
      estimatedBytes,
      truncatedByResultBudget,
      truncatedByByteBudget,
      stale,
      elapsedMs: Math.max(0, safeClock(this.#options.clock) - startedAt),
      sources: diagnosticsBySource,
      policy,
    });
    return Object.freeze({
      results: pageItems,
      page,
      facets: mergeFacets(sourceResults, policy.request.facetFields ?? []),
      diagnostics,
    });
  }

  #emptyResponse(
    policy: SearchRequestPolicyDecision,
    sequence: number,
    startedAt: number,
    sourceResults: readonly SourceExecutionResult[],
  ): FederatedSearchResponse {
    const page = createPageInfo(policy.request.offset, policy.request.limit, 0, 0, 50);
    return Object.freeze({
      results: Object.freeze([]),
      page,
      facets: Object.freeze({}),
      diagnostics: Object.freeze({
        version: FEDERATED_SEARCH_VERSION,
        sequence,
        requestFingerprint: policy.fingerprint,
        sourceCount: 0,
        completedSourceCount: 0,
        failedSourceCount: 0,
        timedOutSourceCount: 0,
        abortedSourceCount: 0,
        rawHitCount: 0,
        deduplicatedHitCount: 0,
        duplicateHitCount: 0,
        estimatedBytes: 0,
        truncatedByResultBudget: false,
        truncatedByByteBudget: false,
        stale: sequence !== this.#latestSequence,
        elapsedMs: Math.max(0, safeClock(this.#options.clock) - startedAt),
        sources: Object.freeze(sourceResults.map(result => result.diagnostic)),
        policy,
      }),
    });
  }
}

export const createFederatedSearchRuntime = (
  sources: readonly FederatedSearchSource[] = [],
  options: FederatedSearchRuntimeOptions = {},
): FederatedSearchRuntime => new FederatedSearchRuntime(sources, options);
