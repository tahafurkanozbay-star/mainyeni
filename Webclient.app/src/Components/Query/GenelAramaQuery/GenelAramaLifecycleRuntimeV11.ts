import {
  BusinessAbortError,
  type QueryExecutionControl,
} from '../../../Business/contracts';
import {
  hashFingerprint,
  normalizeInteger,
  normalizeText,
  stableSerialize,
} from '../../../data-search/normalization';
import {
  GENERAL_SEARCH_LIFECYCLE_VERSION_V11,
  type GeneralSearchDetailRequestV11,
  type GeneralSearchExecutionEnvelopeV11,
  type GeneralSearchExecutionOptionsV11,
  type GeneralSearchFailureEnvelopeV11,
  type GeneralSearchHistoryEntryV11,
  type GeneralSearchLaneStateV11,
  type GeneralSearchLaneV11,
  type GeneralSearchLifecycleAuditReportV11,
  type GeneralSearchLifecycleDependenciesV11,
  type GeneralSearchLifecyclePolicyV11,
  type GeneralSearchLifecycleSnapshotV11,
  type GeneralSearchMutableCountersV11,
  type GeneralSearchNormalizedLifecyclePolicyV11,
  type GeneralSearchRuntimeClockV11,
  type GeneralSearchScheduleOptionsV11,
} from './GenelAramaLifecycleContractsV11';
import {
  GeneralSearchAdmissionErrorV11,
  admitGeneralSearchQueryV11,
  admitGeneralSearchServiceResultV11,
  auditGeneralSearchLifecycleV11,
  normalizeGeneralSearchErrorV11,
  normalizeGeneralSearchLifecyclePolicyV11,
  retryDecisionForGeneralSearchV11,
} from './GenelAramaLifecyclePolicyV11';

interface LaneRuntimeV11 {
  readonly lane: GeneralSearchLaneV11;
  sequence: number;
  state: GeneralSearchLaneStateV11;
  activeController: AbortController | null;
  scheduledTimer: ReturnType<typeof globalThis.setTimeout> | null;
  scheduledReject: ((reason: unknown) => void) | null;
  scheduledRequestId: number | null;
}

interface NormalizedExecutionV11 {
  readonly signal: AbortSignal | null;
  readonly timeoutMs: number;
  readonly cacheTtlMs: number;
  readonly cacheEnabled: boolean;
  readonly deduplicateEnabled: boolean;
  readonly bypassRetry: boolean;
  readonly now: number | null;
}

interface ExecuteInputV11 {
  readonly lane: GeneralSearchLaneV11;
  readonly query: Readonly<Record<string, unknown>>;
  readonly fingerprint: string;
  readonly returnGeometry: boolean;
  readonly options: NormalizedExecutionV11;
  readonly requestId: number;
}

const createClock = (): GeneralSearchRuntimeClockV11 => Object.freeze({
  now: () => Date.now(),
  setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeout: timer => globalThis.clearTimeout(timer),
});

const safeNow = (clock: GeneralSearchRuntimeClockV11): number => {
  const value = Number(clock.now());
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : Date.now();
};

const initialLaneState = (lane: GeneralSearchLaneV11): GeneralSearchLaneStateV11 => Object.freeze({
  lane,
  status: 'idle',
  requestId: 0,
  requestKey: null,
  fingerprint: null,
  scheduledAt: null,
  startedAt: null,
  completedAt: null,
  attemptCount: 0,
  resultCount: 0,
  errorName: null,
  errorCode: null,
});

const createLane = (lane: GeneralSearchLaneV11): LaneRuntimeV11 => ({
  lane,
  sequence: 0,
  state: initialLaneState(lane),
  activeController: null,
  scheduledTimer: null,
  scheduledReject: null,
  scheduledRequestId: null,
});

const initialCounters = (): GeneralSearchMutableCountersV11 => ({
  scheduled: 0,
  started: 0,
  succeeded: 0,
  failed: 0,
  cancelled: 0,
  stale: 0,
  rejected: 0,
  retries: 0,
  admittedSearchRecords: 0,
  admittedDetailRecords: 0,
  truncatedResponses: 0,
});

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'AbortError';

const boundedId = (value: unknown): string | number | null => {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    return value;
  }
  const text = normalizeText(value);
  if (!text || text.length > 160) return null;
  return text;
};

const normalizedNowOverride = (value: unknown): number | null => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.trunc(numeric) : null;
};

const cloneState = (state: GeneralSearchLaneStateV11): GeneralSearchLaneStateV11 =>
  Object.freeze({ ...state });

const delay = (
  clock: GeneralSearchRuntimeClockV11,
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> => {
  if (milliseconds <= 0) return Promise.resolve();
  if (signal.aborted) return Promise.reject(new BusinessAbortError());
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = clock.setTimeout(() => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      clock.clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new BusinessAbortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
};

const attachAbort = (
  external: AbortSignal | null,
  internal: AbortController,
): (() => void) => {
  if (!external) return () => undefined;
  if (external.aborted) {
    internal.abort();
    return () => undefined;
  }
  const handler = (): void => internal.abort();
  external.addEventListener('abort', handler, { once: true });
  return () => external.removeEventListener('abort', handler);
};

const historyFingerprint = (
  history: readonly GeneralSearchHistoryEntryV11[],
): string => hashFingerprint(stableSerialize(history.map(entry => [
  entry.lane,
  entry.requestId,
  entry.fingerprint,
  entry.outcome,
  entry.elapsedMs,
  entry.attemptCount,
  entry.resultCount,
  entry.stale,
  entry.errorCode,
])));

export class GeneralSearchLifecycleRuntimeV11 {
  readonly #transport: GeneralSearchLifecycleDependenciesV11['transport'];
  readonly #policy: GeneralSearchNormalizedLifecyclePolicyV11;
  readonly #clock: GeneralSearchRuntimeClockV11;
  readonly #search = createLane('search');
  readonly #detail = createLane('detail');
  readonly #history: GeneralSearchHistoryEntryV11[] = [];
  readonly #counters = initialCounters();
  #disposed = false;

  constructor(
    dependencies: GeneralSearchLifecycleDependenciesV11,
    policy: GeneralSearchLifecyclePolicyV11 = {},
  ) {
    if (!dependencies?.transport || typeof dependencies.transport.Query !== 'function') {
      throw new TypeError('General search lifecycle transport is required.');
    }
    this.#transport = dependencies.transport;
    this.#policy = normalizeGeneralSearchLifecyclePolicyV11(policy);
    this.#clock = dependencies.clock ?? createClock();
  }

  policy(): GeneralSearchNormalizedLifecyclePolicyV11 {
    return this.#policy;
  }

  history(): readonly GeneralSearchHistoryEntryV11[] {
    return Object.freeze([...this.#history]);
  }

  searchState(): GeneralSearchLaneStateV11 {
    return cloneState(this.#search.state);
  }

  detailState(): GeneralSearchLaneStateV11 {
    return cloneState(this.#detail.state);
  }

  snapshot(): GeneralSearchLifecycleSnapshotV11 {
    const base = {
      version: GENERAL_SEARCH_LIFECYCLE_VERSION_V11,
      disposed: this.#disposed,
      search: cloneState(this.#search.state),
      detail: cloneState(this.#detail.state),
      historyEntries: this.#history.length,
      ...this.#counters,
    };
    const fingerprint = hashFingerprint(stableSerialize({
      ...base,
      historyFingerprint: historyFingerprint(this.#history),
    }));
    return Object.freeze({ ...base, fingerprint });
  }

  audit(): GeneralSearchLifecycleAuditReportV11 {
    return auditGeneralSearchLifecycleV11({
      policy: this.#policy,
      snapshot: this.snapshot(),
      history: this.history(),
    });
  }

  executeSearch(
    queryInput: unknown,
    options: GeneralSearchExecutionOptionsV11 = {},
  ): Promise<GeneralSearchExecutionEnvelopeV11> {
    this.#ensureActive();
    const admission = admitGeneralSearchQueryV11(queryInput, this.#policy);
    if (!admission.accepted || !admission.query || admission.fieldCount === 0) {
      this.#counters.rejected += 1;
      return Promise.reject(new GeneralSearchAdmissionErrorV11(
        admission.code ?? 'QUERY_REQUIRED',
        'Arama sorgusu geçerli alan içermiyor.',
      ));
    }
    return this.#begin(
      this.#search,
      admission.query,
      admission.fingerprint,
      false,
      this.#normalizeExecution('search', options),
    );
  }

  scheduleSearch(
    queryInput: unknown,
    options: GeneralSearchScheduleOptionsV11 = {},
  ): Promise<GeneralSearchExecutionEnvelopeV11> {
    this.#ensureActive();
    if (options.bypassDebounce) return this.executeSearch(queryInput, options);
    const admission = admitGeneralSearchQueryV11(queryInput, this.#policy);
    if (!admission.accepted || !admission.query || admission.fieldCount === 0) {
      this.#counters.rejected += 1;
      return Promise.reject(new GeneralSearchAdmissionErrorV11(
        admission.code ?? 'QUERY_REQUIRED',
        'Arama sorgusu geçerli alan içermiyor.',
      ));
    }

    this.#cancelScheduled(this.#search, 'Search request superseded before execution.');
    this.#abortActive(this.#search);
    const requestId = this.#nextRequestId(this.#search);
    const debounceMs = normalizeInteger(options.debounceMs, {
      min: 0,
      max: this.#policy.maxDebounceMs,
      fallback: this.#policy.searchDebounceMs,
    });
    const scheduledAt = safeNow(this.#clock);
    this.#search.state = Object.freeze({
      lane: 'search',
      status: 'scheduled',
      requestId,
      requestKey: this.#requestKey('search', admission.fingerprint),
      fingerprint: admission.fingerprint,
      scheduledAt,
      startedAt: null,
      completedAt: null,
      attemptCount: 0,
      resultCount: 0,
      errorName: null,
      errorCode: null,
    });
    this.#counters.scheduled += 1;

    return new Promise<GeneralSearchExecutionEnvelopeV11>((resolve, reject) => {
      this.#search.scheduledRequestId = requestId;
      this.#search.scheduledReject = reject;
      this.#search.scheduledTimer = this.#clock.setTimeout(() => {
        if (
          this.#disposed
          || this.#search.scheduledRequestId !== requestId
          || this.#search.sequence !== requestId
        ) {
          reject(new BusinessAbortError('Search schedule became stale.'));
          return;
        }
        this.#search.scheduledTimer = null;
        this.#search.scheduledReject = null;
        this.#search.scheduledRequestId = null;
        void this.#execute({
          lane: 'search',
          query: admission.query as Readonly<Record<string, unknown>>,
          fingerprint: admission.fingerprint,
          returnGeometry: false,
          options: this.#normalizeExecution('search', options),
          requestId,
        }).then(resolve, reject);
      }, debounceMs);
    });
  }

  executeDetail(
    objectIdInput: unknown,
    options: GeneralSearchExecutionOptionsV11 = {},
  ): Promise<GeneralSearchExecutionEnvelopeV11> {
    this.#ensureActive();
    const objectId = boundedId(objectIdInput);
    if (objectId === null) {
      this.#counters.rejected += 1;
      return Promise.reject(new GeneralSearchAdmissionErrorV11(
        'DETAIL_ID_REQUIRED',
        'Arama sonucu ayrıntısı için geçerli kayıt kimliği gerekli.',
      ));
    }
    const query: GeneralSearchDetailRequestV11 = Object.freeze({ ObjectId: objectId });
    const admission = admitGeneralSearchQueryV11(query, this.#policy);
    if (!admission.accepted || !admission.query) {
      this.#counters.rejected += 1;
      return Promise.reject(new GeneralSearchAdmissionErrorV11(
        admission.code ?? 'DETAIL_ID_REQUIRED',
        'Arama sonucu ayrıntı sorgusu kabul edilmedi.',
      ));
    }
    return this.#begin(
      this.#detail,
      admission.query,
      admission.fingerprint,
      true,
      this.#normalizeExecution('detail', options),
    );
  }

  cancelSearch(reason = 'Search request cancelled.'): void {
    this.#cancelLane(this.#search, reason);
  }

  cancelDetail(reason = 'Detail request cancelled.'): void {
    this.#cancelLane(this.#detail, reason);
  }

  cancelAll(reason = 'General search lifecycle cancelled.'): void {
    this.#cancelLane(this.#search, reason);
    this.#cancelLane(this.#detail, reason);
  }

  reset(): void {
    this.#ensureActive();
    this.cancelAll('General search lifecycle reset.');
    this.#search.state = initialLaneState('search');
    this.#detail.state = initialLaneState('detail');
  }

  dispose(): void {
    if (this.#disposed) return;
    this.cancelAll('General search lifecycle disposed.');
    this.#disposed = true;
    this.#search.state = Object.freeze({
      ...this.#search.state,
      status: 'disposed',
    });
    this.#detail.state = Object.freeze({
      ...this.#detail.state,
      status: 'disposed',
    });
  }

  #lane(lane: GeneralSearchLaneV11): LaneRuntimeV11 {
    return lane === 'search' ? this.#search : this.#detail;
  }

  #ensureActive(): void {
    if (this.#disposed) {
      throw new GeneralSearchAdmissionErrorV11(
        'RUNTIME_DISPOSED',
        'Genel arama yaşam döngüsü kapatıldı.',
      );
    }
  }

  #nextRequestId(lane: LaneRuntimeV11): number {
    lane.sequence += 1;
    return lane.sequence;
  }

  #requestKey(lane: GeneralSearchLaneV11, fingerprint: string): string {
    return `general-search-v11:${lane}:${fingerprint}`;
  }

  #normalizeExecution(
    lane: GeneralSearchLaneV11,
    options: GeneralSearchExecutionOptionsV11,
  ): NormalizedExecutionV11 {
    const timeoutDefault = lane === 'search'
      ? this.#policy.searchTimeoutMs
      : this.#policy.detailTimeoutMs;
    const cacheTtlDefault = lane === 'search'
      ? this.#policy.searchCacheTtlMs
      : this.#policy.detailCacheTtlMs;
    const cacheDefault = lane === 'search'
      ? this.#policy.cacheSearch
      : this.#policy.cacheDetail;
    const dedupeDefault = lane === 'search'
      ? this.#policy.deduplicateSearch
      : this.#policy.deduplicateDetail;

    return Object.freeze({
      signal: options.signal ?? null,
      timeoutMs: normalizeInteger(options.timeoutMs, {
        min: 250,
        max: this.#policy.maxTimeoutMs,
        fallback: timeoutDefault,
      }),
      cacheTtlMs: normalizeInteger(options.cacheTtlMs, {
        min: 0,
        max: this.#policy.maxCacheTtlMs,
        fallback: cacheTtlDefault,
      }),
      cacheEnabled: options.bypassCache ? false : cacheDefault,
      deduplicateEnabled: options.bypassDeduplication ? false : dedupeDefault,
      bypassRetry: options.bypassRetry === true,
      now: normalizedNowOverride(options.now),
    });
  }

  #begin(
    lane: LaneRuntimeV11,
    query: Readonly<Record<string, unknown>>,
    fingerprint: string,
    returnGeometry: boolean,
    options: NormalizedExecutionV11,
  ): Promise<GeneralSearchExecutionEnvelopeV11> {
    this.#cancelScheduled(lane, 'Request superseded before execution.');
    this.#abortActive(lane);
    const requestId = this.#nextRequestId(lane);
    return this.#execute({
      lane: lane.lane,
      query,
      fingerprint,
      returnGeometry,
      options,
      requestId,
    });
  }

  async #execute(input: ExecuteInputV11): Promise<GeneralSearchExecutionEnvelopeV11> {
    this.#ensureActive();
    const lane = this.#lane(input.lane);
    const requestKey = this.#requestKey(input.lane, input.fingerprint);
    const controller = new AbortController();
    const detachExternal = attachAbort(input.options.signal, controller);
    lane.activeController = controller;
    const startedAt = input.options.now ?? safeNow(this.#clock);
    lane.state = Object.freeze({
      lane: input.lane,
      status: 'running',
      requestId: input.requestId,
      requestKey,
      fingerprint: input.fingerprint,
      scheduledAt: lane.state.requestId === input.requestId
        ? lane.state.scheduledAt
        : null,
      startedAt,
      completedAt: null,
      attemptCount: 1,
      resultCount: 0,
      errorName: null,
      errorCode: null,
    });
    this.#counters.started += 1;

    let attempt = 0;
    try {
      while (true) {
        attempt += 1;
        if (controller.signal.aborted) throw new BusinessAbortError();
        lane.state = Object.freeze({
          ...lane.state,
          attemptCount: attempt,
        });

        try {
          const control: QueryExecutionControl = {
            signal: controller.signal,
            timeoutMs: input.options.timeoutMs,
            cacheTtlMs: input.options.cacheTtlMs,
            deduplicate: input.options.deduplicateEnabled,
            cache: input.options.cacheEnabled,
            requestKey,
          };
          const raw = await this.#transport.Query(
            input.query,
            input.returnGeometry,
            control,
          );
          if (controller.signal.aborted) throw new BusinessAbortError();

          const result = admitGeneralSearchServiceResultV11(
            raw,
            input.lane === 'search'
              ? this.#policy.maxSearchRecords
              : this.#policy.maxDetailRecords,
            this.#policy.maxMessageLength,
          );
          const completedAt = safeNow(this.#clock);
          const stale = this.#disposed
            || lane.sequence !== input.requestId
            || lane.activeController !== controller;

          if (result.truncated) this.#counters.truncatedResponses += 1;
          if (input.lane === 'search') this.#counters.admittedSearchRecords += result.outputCount;
          else this.#counters.admittedDetailRecords += result.outputCount;

          if (stale) {
            this.#counters.stale += 1;
            this.#recordHistory({
              lane: input.lane,
              requestId: input.requestId,
              requestKey,
              fingerprint: input.fingerprint,
              outcome: 'stale',
              startedAt,
              completedAt,
              elapsedMs: Math.max(0, completedAt - startedAt),
              attemptCount: attempt,
              resultCount: result.outputCount,
              stale: true,
              errorName: null,
              errorCode: null,
            });
          } else {
            this.#counters.succeeded += 1;
            lane.state = Object.freeze({
              ...lane.state,
              status: 'success',
              completedAt,
              attemptCount: attempt,
              resultCount: result.outputCount,
              errorName: null,
              errorCode: null,
            });
            this.#recordHistory({
              lane: input.lane,
              requestId: input.requestId,
              requestKey,
              fingerprint: input.fingerprint,
              outcome: 'success',
              startedAt,
              completedAt,
              elapsedMs: Math.max(0, completedAt - startedAt),
              attemptCount: attempt,
              resultCount: result.outputCount,
              stale: false,
              errorName: null,
              errorCode: null,
            });
          }

          return Object.freeze({
            version: GENERAL_SEARCH_LIFECYCLE_VERSION_V11,
            lane: input.lane,
            requestId: input.requestId,
            requestKey,
            fingerprint: input.fingerprint,
            query: input.query,
            returnGeometry: input.returnGeometry,
            result,
            startedAt,
            completedAt,
            elapsedMs: Math.max(0, completedAt - startedAt),
            attemptCount: attempt,
            stale,
            cacheEnabled: input.options.cacheEnabled,
            deduplicateEnabled: input.options.deduplicateEnabled,
          });
        } catch (error) {
          if (controller.signal.aborted || isAbortError(error)) throw error;
          const decision = retryDecisionForGeneralSearchV11(
            error,
            attempt,
            input.fingerprint,
            this.#policy,
            input.options.bypassRetry,
          );
          if (!decision.retry) throw error;
          this.#counters.retries += 1;
          await delay(this.#clock, decision.delayMs, controller.signal);
        }
      }
    } catch (error) {
      const completedAt = safeNow(this.#clock);
      const stale = this.#disposed
        || lane.sequence !== input.requestId
        || lane.activeController !== controller;
      const normalized = normalizeGeneralSearchErrorV11(error);
      const aborted = controller.signal.aborted || isAbortError(error);
      const outcome = aborted
        ? 'cancelled'
        : stale
          ? 'stale'
          : 'failure';

      if (aborted) this.#counters.cancelled += 1;
      else if (stale) this.#counters.stale += 1;
      else this.#counters.failed += 1;

      if (!stale) {
        lane.state = Object.freeze({
          ...lane.state,
          status: aborted ? 'cancelled' : 'failure',
          completedAt,
          attemptCount: attempt,
          resultCount: 0,
          errorName: normalized.name,
          errorCode: normalized.code,
        });
      }

      this.#recordHistory({
        lane: input.lane,
        requestId: input.requestId,
        requestKey,
        fingerprint: input.fingerprint,
        outcome,
        startedAt,
        completedAt,
        elapsedMs: Math.max(0, completedAt - startedAt),
        attemptCount: attempt,
        resultCount: 0,
        stale,
        errorName: normalized.name,
        errorCode: normalized.code,
      });

      const failure: GeneralSearchFailureEnvelopeV11 = Object.freeze({
        version: GENERAL_SEARCH_LIFECYCLE_VERSION_V11,
        lane: input.lane,
        requestId: input.requestId,
        requestKey,
        fingerprint: input.fingerprint,
        startedAt,
        completedAt,
        elapsedMs: Math.max(0, completedAt - startedAt),
        attemptCount: attempt,
        stale,
        errorName: normalized.name,
        errorCode: normalized.code,
        retryable: normalized.retryable,
      });
      if (error && typeof error === 'object') {
        try {
          Object.defineProperty(error, 'generalSearchFailure', {
            value: failure,
            enumerable: false,
            configurable: true,
          });
        } catch {
          // Error metadata is diagnostic-only; never mask the original failure.
        }
      }
      throw error;
    } finally {
      detachExternal();
      if (lane.activeController === controller) lane.activeController = null;
    }
  }

  #recordHistory(entry: GeneralSearchHistoryEntryV11): void {
    this.#history.push(Object.freeze(entry));
    while (this.#history.length > this.#policy.maxHistory) this.#history.shift();
  }

  #cancelScheduled(lane: LaneRuntimeV11, reason: string): void {
    if (lane.scheduledTimer !== null) {
      this.#clock.clearTimeout(lane.scheduledTimer);
      lane.scheduledTimer = null;
    }
    if (lane.scheduledReject) {
      const reject = lane.scheduledReject;
      lane.scheduledReject = null;
      lane.scheduledRequestId = null;
      this.#counters.cancelled += 1;
      reject(new BusinessAbortError(reason));
    }
  }

  #abortActive(lane: LaneRuntimeV11): void {
    if (lane.activeController && !lane.activeController.signal.aborted) {
      lane.activeController.abort();
    }
  }

  #cancelLane(lane: LaneRuntimeV11, reason: string): void {
    this.#cancelScheduled(lane, reason);
    this.#abortActive(lane);
    lane.sequence += 1;
    const completedAt = safeNow(this.#clock);
    if (lane.state.status === 'scheduled' || lane.state.status === 'running') {
      lane.state = Object.freeze({
        ...lane.state,
        status: 'cancelled',
        completedAt,
        errorName: 'AbortError',
        errorCode: 'ABORTED',
      });
    }
  }
}

export const createGeneralSearchLifecycleRuntimeV11 = (
  dependencies: GeneralSearchLifecycleDependenciesV11,
  policy: GeneralSearchLifecyclePolicyV11 = {},
): GeneralSearchLifecycleRuntimeV11 => new GeneralSearchLifecycleRuntimeV11(
  dependencies,
  policy,
);
