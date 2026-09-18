import type { SearchRequest, SearchResponse } from './contracts';
import { createAbortError } from './contracts';
import { normalizeInteger, normalizeText } from './normalization';

export type SearchSessionStatus =
  | 'idle'
  | 'scheduled'
  | 'running'
  | 'success'
  | 'error'
  | 'cancelled'
  | 'disposed';

export interface SearchSessionEnvelope {
  readonly requestId: number;
  readonly datasetKey: string;
  readonly request: SearchRequest;
  readonly result: SearchResponse | null;
  readonly stale: boolean;
  readonly startedAt: number;
  readonly completedAt: number;
}

export interface SearchSessionState {
  readonly status: SearchSessionStatus;
  readonly requestId: number;
  readonly datasetKey: string | null;
  readonly request: SearchRequest | null;
  readonly result: SearchResponse | null;
  readonly error: Error | null;
  readonly staleResponses: number;
  readonly cancellations: number;
  readonly scheduledAt: number | null;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
}

export interface SearchSessionHistoryEntry {
  readonly requestId: number;
  readonly datasetKey: string;
  readonly status: 'success' | 'error' | 'cancelled' | 'stale';
  readonly durationMs: number;
  readonly resultCount: number;
  readonly query: string;
}

export interface SearchSessionOptions {
  readonly debounceMs?: number;
  readonly maxDebounceMs?: number;
  readonly maxHistory?: number;
  readonly clock?: () => number;
  readonly adaptiveDebounce?: (
    request: SearchRequest,
    context: Readonly<{ defaultDebounceMs: number; maxDebounceMs: number }>,
  ) => number;
}

export interface SearchSessionExecutionOptions {
  readonly signal?: AbortSignal | null;
  readonly bypassDebounce?: boolean;
}

export type SearchSessionExecutor = (
  datasetKey: string,
  request: SearchRequest,
) => SearchResponse | Promise<SearchResponse>;

interface PendingSchedule {
  readonly requestId: number;
  readonly datasetKey: string;
  readonly request: SearchRequest;
  readonly externalSignal: AbortSignal | null;
  readonly controller: AbortController;
  readonly resolve: (value: SearchSessionEnvelope) => void;
  readonly reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout> | null;
  settled: boolean;
  detachExternal: (() => void) | null;
}

const DEFAULT_DEBOUNCE_MS = 180;
const DEFAULT_MAX_DEBOUNCE_MS = 1_500;
const DEFAULT_MAX_HISTORY = 100;

const safeNow = (clock: () => number): number => {
  const value = Number(clock());
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : Date.now();
};

const normalizedDatasetKey = (value: unknown): string => normalizeText(value).trim();

const cloneRequest = (request: SearchRequest, signal: AbortSignal): SearchRequest => Object.freeze({
  ...request,
  signal,
});

const createInitialState = (): SearchSessionState => Object.freeze({
  status: 'idle',
  requestId: 0,
  datasetKey: null,
  request: null,
  result: null,
  error: null,
  staleResponses: 0,
  cancellations: 0,
  scheduledAt: null,
  startedAt: null,
  completedAt: null,
});

export class SearchSession {
  private readonly executor: SearchSessionExecutor;
  private readonly options: Readonly<{
    debounceMs: number;
    maxDebounceMs: number;
    maxHistory: number;
    clock: () => number;
    adaptiveDebounce: SearchSessionOptions['adaptiveDebounce'];
  }>;
  private state: SearchSessionState = createInitialState();
  private readonly history: SearchSessionHistoryEntry[] = [];
  private pending: PendingSchedule | null = null;
  private activeController: AbortController | null = null;
  private sequence = 0;
  private disposed = false;

  constructor(executor: SearchSessionExecutor, options: SearchSessionOptions = {}) {
    if (typeof executor !== 'function') throw new TypeError('Search session executor is required');
    const maxDebounceMs = normalizeInteger(options.maxDebounceMs, {
      min: 0,
      max: 10_000,
      fallback: DEFAULT_MAX_DEBOUNCE_MS,
    });
    this.executor = executor;
    this.options = Object.freeze({
      debounceMs: normalizeInteger(options.debounceMs, {
        min: 0,
        max: maxDebounceMs,
        fallback: DEFAULT_DEBOUNCE_MS,
      }),
      maxDebounceMs,
      maxHistory: normalizeInteger(options.maxHistory, {
        min: 1,
        max: 2_000,
        fallback: DEFAULT_MAX_HISTORY,
      }),
      clock: typeof options.clock === 'function' ? options.clock : () => Date.now(),
      adaptiveDebounce: options.adaptiveDebounce,
    });
  }

  private now(): number {
    return safeNow(this.options.clock);
  }

  private ensureActive(): void {
    if (this.disposed) throw new Error('Search session has been disposed');
  }

  private nextRequestId(): number {
    this.sequence += 1;
    return this.sequence;
  }

  private debounceFor(request: SearchRequest): number {
    if (!this.options.adaptiveDebounce) return this.options.debounceMs;
    const value = Number(this.options.adaptiveDebounce(request, {
      defaultDebounceMs: this.options.debounceMs,
      maxDebounceMs: this.options.maxDebounceMs,
    }));
    if (!Number.isFinite(value)) return this.options.debounceMs;
    return Math.min(this.options.maxDebounceMs, Math.max(0, Math.trunc(value)));
  }

  private recordHistory(entry: SearchSessionHistoryEntry): void {
    this.history.push(Object.freeze(entry));
    while (this.history.length > this.options.maxHistory) this.history.shift();
  }

  private detachPending(): void {
    const pending = this.pending;
    if (!pending) return;
    if (pending.timer !== null) clearTimeout(pending.timer);
    pending.timer = null;
    pending.detachExternal?.();
    pending.detachExternal = null;
    this.pending = null;
  }

  private settlePendingCancellation(reason = 'Search request superseded'): void {
    const pending = this.pending;
    if (!pending || pending.settled) return;
    pending.settled = true;
    if (!pending.controller.signal.aborted) pending.controller.abort();
    this.detachPending();
    const error = createAbortError(reason);
    pending.reject(error);
    const now = this.now();
    this.recordHistory({
      requestId: pending.requestId,
      datasetKey: pending.datasetKey,
      status: 'cancelled',
      durationMs: 0,
      resultCount: 0,
      query: normalizeText(pending.request.query),
    });
    this.state = Object.freeze({
      ...this.state,
      status: 'cancelled',
      cancellations: this.state.cancellations + 1,
      completedAt: now,
      error,
    });
  }

  private attachExternalAbort(
    signal: AbortSignal | null | undefined,
    controller: AbortController,
    onAbort?: () => void,
  ): () => void {
    if (!signal) return () => undefined;
    if (signal.aborted) {
      controller.abort();
      onAbort?.();
      return () => undefined;
    }
    const handler = (): void => {
      controller.abort();
      onAbort?.();
    };
    signal.addEventListener('abort', handler, { once: true });
    return () => signal.removeEventListener('abort', handler);
  }

  private async executeInternal(
    requestId: number,
    datasetKey: string,
    requestInput: SearchRequest,
    controller: AbortController,
    externalSignal: AbortSignal | null | undefined,
  ): Promise<SearchSessionEnvelope> {
    const startedAt = this.now();
    let detachExternal: () => void = () => undefined;
    detachExternal = this.attachExternalAbort(externalSignal, controller);
    if (controller.signal.aborted) {
      detachExternal();
      throw createAbortError();
    }
    this.activeController = controller;
    this.state = Object.freeze({
      ...this.state,
      status: 'running',
      requestId,
      datasetKey,
      request: Object.freeze({ ...requestInput, signal: null }),
      error: null,
      startedAt,
      completedAt: null,
      scheduledAt: this.state.requestId === requestId ? this.state.scheduledAt : null,
    });
    const request = cloneRequest(requestInput, controller.signal);
    try {
      const result = await Promise.resolve(this.executor(datasetKey, request));
      if (controller.signal.aborted) throw createAbortError();
      const completedAt = this.now();
      const stale = requestId !== this.sequence || this.disposed;
      if (stale) {
        this.recordHistory({
          requestId,
          datasetKey,
          status: 'stale',
          durationMs: Math.max(0, completedAt - startedAt),
          resultCount: result.results.length,
          query: normalizeText(requestInput.query),
        });
        this.state = Object.freeze({
          ...this.state,
          staleResponses: this.state.staleResponses + 1,
        });
      } else {
        this.recordHistory({
          requestId,
          datasetKey,
          status: 'success',
          durationMs: Math.max(0, completedAt - startedAt),
          resultCount: result.results.length,
          query: normalizeText(requestInput.query),
        });
        this.state = Object.freeze({
          ...this.state,
          status: 'success',
          requestId,
          datasetKey,
          request: Object.freeze({ ...requestInput, signal: null }),
          result,
          error: null,
          completedAt,
        });
      }
      return Object.freeze({
        requestId,
        datasetKey,
        request: Object.freeze({ ...requestInput, signal: null }),
        result,
        stale,
        startedAt,
        completedAt,
      });
    } catch (error) {
      const completedAt = this.now();
      const aborted = controller.signal.aborted || (error instanceof Error && error.name === 'AbortError');
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      this.recordHistory({
        requestId,
        datasetKey,
        status: aborted ? 'cancelled' : 'error',
        durationMs: Math.max(0, completedAt - startedAt),
        resultCount: 0,
        query: normalizeText(requestInput.query),
      });
      if (requestId === this.sequence && !this.disposed) {
        this.state = Object.freeze({
          ...this.state,
          status: aborted ? 'cancelled' : 'error',
          requestId,
          datasetKey,
          request: Object.freeze({ ...requestInput, signal: null }),
          error: normalizedError,
          cancellations: this.state.cancellations + (aborted ? 1 : 0),
          completedAt,
        });
      }
      throw normalizedError;
    } finally {
      detachExternal();
      if (this.activeController === controller) this.activeController = null;
    }
  }

  searchNow(
    datasetKeyInput: unknown,
    request: SearchRequest = {},
    options: SearchSessionExecutionOptions = {},
  ): Promise<SearchSessionEnvelope> {
    this.ensureActive();
    const datasetKey = normalizedDatasetKey(datasetKeyInput);
    if (!datasetKey) return Promise.reject(new TypeError('Search session dataset key is required'));
    this.settlePendingCancellation();
    if (this.activeController && !this.activeController.signal.aborted) this.activeController.abort();
    const requestId = this.nextRequestId();
    return this.executeInternal(requestId, datasetKey, request, new AbortController(), options.signal);
  }

  schedule(
    datasetKeyInput: unknown,
    request: SearchRequest = {},
    options: SearchSessionExecutionOptions = {},
  ): Promise<SearchSessionEnvelope> {
    this.ensureActive();
    if (options.bypassDebounce) return this.searchNow(datasetKeyInput, request, options);
    const datasetKey = normalizedDatasetKey(datasetKeyInput);
    if (!datasetKey) return Promise.reject(new TypeError('Search session dataset key is required'));
    this.settlePendingCancellation();
    if (this.activeController && !this.activeController.signal.aborted) this.activeController.abort();
    const requestId = this.nextRequestId();
    const controller = new AbortController();
    const scheduledAt = this.now();
    this.state = Object.freeze({
      ...this.state,
      status: 'scheduled',
      requestId,
      datasetKey,
      request: Object.freeze({ ...request, signal: null }),
      error: null,
      scheduledAt,
      startedAt: null,
      completedAt: null,
    });
    return new Promise<SearchSessionEnvelope>((resolve, reject) => {
      const pending: PendingSchedule = {
        requestId,
        datasetKey,
        request,
        externalSignal: options.signal ?? null,
        controller,
        resolve,
        reject,
        timer: null,
        settled: false,
        detachExternal: null,
      };
      const externalAbort = (): void => {
        if (pending.settled) return;
        pending.settled = true;
        if (pending.timer !== null) clearTimeout(pending.timer);
        pending.timer = null;
        if (this.pending === pending) this.pending = null;
        const error = createAbortError('Scheduled search aborted');
        reject(error);
        this.state = Object.freeze({
          ...this.state,
          status: 'cancelled',
          cancellations: this.state.cancellations + 1,
          completedAt: this.now(),
          error,
        });
      };
      pending.detachExternal = this.attachExternalAbort(options.signal, controller, externalAbort);
      if (controller.signal.aborted) {
        externalAbort();
        return;
      }
      const debounceMs = this.debounceFor(request);
      pending.timer = setTimeout(() => {
        pending.timer = null;
        pending.detachExternal?.();
        pending.detachExternal = null;
        if (pending.settled || controller.signal.aborted) return;
        pending.settled = true;
        if (this.pending === pending) this.pending = null;
        this.executeInternal(requestId, datasetKey, request, controller, options.signal).then(resolve, reject);
      }, debounceMs);
      this.pending = pending;
    });
  }

  loadMore(options: SearchSessionExecutionOptions = {}): Promise<SearchSessionEnvelope> {
    this.ensureActive();
    const result = this.state.result;
    const request = this.state.request;
    const datasetKey = this.state.datasetKey;
    if (!result || !request || !datasetKey || !result.page.hasMore || result.page.nextOffset === null) {
      return Promise.reject(new Error('No additional search page is available'));
    }
    return this.searchNow(datasetKey, {
      ...request,
      offset: result.page.nextOffset,
      limit: result.page.limit,
    }, options);
  }

  cancel(reason = 'Search cancelled'): boolean {
    let cancelled = false;
    if (this.pending) {
      this.settlePendingCancellation(reason);
      cancelled = true;
    }
    if (this.activeController && !this.activeController.signal.aborted) {
      this.activeController.abort();
      cancelled = true;
    }
    return cancelled;
  }

  getState(): SearchSessionState {
    return this.state;
  }

  getHistory(): readonly SearchSessionHistoryEntry[] {
    return Object.freeze([...this.history]);
  }

  diagnostics(): Readonly<Record<string, unknown>> {
    return Object.freeze({
      status: this.state.status,
      requestId: this.state.requestId,
      datasetKey: this.state.datasetKey,
      staleResponses: this.state.staleResponses,
      cancellations: this.state.cancellations,
      historySize: this.history.length,
      pending: Boolean(this.pending),
      running: Boolean(this.activeController),
      disposed: this.disposed,
      debounceMs: this.options.debounceMs,
      maxDebounceMs: this.options.maxDebounceMs,
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.cancel('Search session disposed');
    this.disposed = true;
    this.state = Object.freeze({
      ...this.state,
      status: 'disposed',
      completedAt: this.now(),
    });
  }
}

export const createSearchSession = (
  executor: SearchSessionExecutor,
  options: SearchSessionOptions = {},
): SearchSession => new SearchSession(executor, options);