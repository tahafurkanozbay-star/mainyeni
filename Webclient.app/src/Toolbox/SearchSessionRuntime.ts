import {
    normalizeInteger,
    normalizeSearchText,
    normalizeText
} from "./DataIntegrityHelper";
import {
    normalizeCoordinatorRequest,
    type CoordinatorRequestInput,
    type CoordinatorResponse,
    type CoordinatorSearchOptions,
    type NormalizedCoordinatorRequest
} from "./SearchCoordinatorRuntime";
import {
    createSearchAbortError
} from "./SearchDatasetRegistry";


type UnknownRecord = Record<string, unknown>;

export type SearchSessionStatus = "idle" | "scheduled" | "loading" | "success" | "cancelled" | "error";

export interface SearchAbortSignalLike {
    aborted: boolean;
}

interface SearchAbortControllerLike {
    signal: SearchAbortSignalLike;
    abort(reason?: unknown): void;
}

export interface SearchSessionState {
    status: SearchSessionStatus;
    requestId: number;
    committedRequestId: number;
    pendingRequestId: number | null;
    dataset: string;
    query: string;
    normalizedQuery: string;
    result: SessionSearchResult | null;
    error: unknown;
    startedAt: number | null;
    completedAt: number | null;
    durationMs: number | null;
    staleResponseCount: number;
    cancellationCount: number;
}

export interface SessionSearchResult extends UnknownRecord {
    records?: unknown[];
    request?: UnknownRecord | null;
    page?: {
        hasMore?: boolean;
        nextOffset?: number | null;
        [key: string]: unknown;
    } | null;
}

export interface SessionExecutionResult {
    result: SessionSearchResult | null;
    stale: boolean;
    requestId: number;
    terminal?: boolean;
}

export interface SearchSessionHistoryEntry {
    requestId: number;
    dataset: unknown;
    query: string;
    status: "success" | "stale" | "cancelled" | "error";
    startedAt: number;
    completedAt: number;
    error?: unknown;
}

export interface SearchScheduler<TId = unknown> {
    set(callback: () => void, delay: number): TId;
    clear(id: TId): void;
}

export interface ManualSearchScheduler extends SearchScheduler<number> {
    run(id: number): boolean;
    runAll(): number;
    size(): number;
    entries(): Array<{ id: number; delay: number }>;
}

export interface SearchCoordinatorLike {
    search(
        datasetName: unknown,
        request?: CoordinatorRequestInput | NormalizedCoordinatorRequest,
        options?: CoordinatorSearchOptions | UnknownRecord
    ): Promise<CoordinatorResponse | SessionSearchResult>;
}

export interface SearchSessionOptions {
    scheduler?: SearchScheduler;
    now?: () => number;
    debounceMs?: unknown;
    historySize?: unknown;
    cancelPrevious?: boolean;
    dedupeInFlight?: boolean;
}

export interface SessionSearchOptions extends UnknownRecord {
    signal?: SearchAbortSignalLike | null;
    debounceMs?: unknown;
}

interface ScheduledSearch {
    timerId: unknown;
    resolve: (value: SessionExecutionResult | PromiseLike<SessionExecutionResult>) => void;
    reject: (reason?: unknown) => void;
    datasetName: unknown;
    request: CoordinatorRequestInput;
}

export interface SearchSessionApi {
    search(datasetName: unknown, request?: CoordinatorRequestInput, searchOptions?: SessionSearchOptions): Promise<SessionExecutionResult>;
    schedule(datasetName: unknown, request?: CoordinatorRequestInput, searchOptions?: SessionSearchOptions): Promise<SessionExecutionResult>;
    searchNow(datasetName: unknown, request?: CoordinatorRequestInput, searchOptions?: SessionSearchOptions): Promise<SessionExecutionResult>;
    loadMore(searchOptions?: SessionSearchOptions): Promise<SessionExecutionResult>;
    cancel(reason?: string): boolean;
    subscribe(listener: (state: SearchSessionState) => void): () => boolean | void;
    getState(): SearchSessionState;
    getHistory(): SearchSessionHistoryEntry[];
    getInFlightCount(): number;
    clearHistory(): number;
    reset(): void;
    dispose(): boolean;
    isDisposed(): boolean;
    diagnostics(): {
        status: SearchSessionStatus;
        requestId: number;
        committedRequestId: number;
        staleResponseCount: number;
        cancellationCount: number;
        inFlightCount: number;
        scheduled: boolean;
        historyCount: number;
        listenerCount: number;
        debounceMs: number;
        disposed: boolean;
    };
}

const normalizeIntegerValue = (
    value: unknown,
    options: Readonly<{ min?: number; max?: number; fallback: number }>
): number => normalizeInteger(value as never, options as never) as number;

const isRecord = (value: unknown): value is UnknownRecord =>
    value !== null && typeof value === "object" && !Array.isArray(value);

export const DEFAULT_SEARCH_DEBOUNCE_MS = 180;
export const MAX_SEARCH_DEBOUNCE_MS = 2000;
export const DEFAULT_SESSION_HISTORY_SIZE = 20;
export const MAX_SESSION_HISTORY_SIZE = 200;

const noop = (): void => {};
const asArray = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const hasAbortController = (): boolean => typeof AbortController !== "undefined";

export const normalizeSearchDebounceMs = (value: unknown): number => {
    if (value === 0 || value === "0") return 0;
    if (value === undefined || value === null || value === "") return DEFAULT_SEARCH_DEBOUNCE_MS;
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || !Number.isInteger(numeric) || numeric < 0) return DEFAULT_SEARCH_DEBOUNCE_MS;
    return Math.min(MAX_SEARCH_DEBOUNCE_MS, numeric);
};

export const createSessionRequestKey = (
    datasetName: unknown,
    request: CoordinatorRequestInput = {}
): string => {
    const normalized = normalizeCoordinatorRequest(request);
    return JSON.stringify({
        dataset: normalizeText(datasetName),
        query: normalized.normalizedQuery,
        mode: normalized.mode,
        offset: normalized.offset,
        limit: normalized.limit,
        center: normalized.center,
        radiusMeters: normalized.radiusMeters,
        district: normalizeSearchText(normalized.district),
        neighborhood: normalizeSearchText(normalized.neighborhood),
        street: normalizeSearchText(normalized.street),
        level: normalizeSearchText(normalized.level),
        filters: asArray(normalized.filters),
        facetFields: asArray(normalized.facetFields),
        sort: normalized.sort || "",
        minScore: normalized.minScore ?? null
    });
};

export const createSessionState = (): SearchSessionState => ({
    status: "idle",
    requestId: 0,
    committedRequestId: 0,
    pendingRequestId: null,
    dataset: "",
    query: "",
    normalizedQuery: "",
    result: null,
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    staleResponseCount: 0,
    cancellationCount: 0
});

export const createManualSearchScheduler = (): ManualSearchScheduler => {
    let sequence = 0;
    const tasks = new Map<number, { callback: () => void; delay: number }>();
    return {
        set(callback: () => void, delay: number): number {
            const id = ++sequence;
            tasks.set(id, { callback, delay });
            return id;
        },
        clear(id: number): void {
            tasks.delete(id);
        },
        run(id: number): boolean {
            const task = tasks.get(id);
            if (!task) return false;
            tasks.delete(id);
            task.callback();
            return true;
        },
        runAll(): number {
            const ids = Array.from(tasks.keys());
            ids.forEach(id => this.run(id));
            return ids.length;
        },
        size(): number {
            return tasks.size;
        },
        entries(): Array<{ id: number; delay: number }> {
            return Array.from(tasks.entries()).map(([id, task]) => ({ id, delay: task.delay }));
        }
    };
};

const createDefaultScheduler = (): SearchScheduler<ReturnType<typeof setTimeout>> => ({
    set: (callback: () => void, delay: number) => setTimeout(callback, delay),
    clear: (id: ReturnType<typeof setTimeout>) => clearTimeout(id)
});

const createController = (): SearchAbortControllerLike => hasAbortController()
    ? new AbortController()
    : {
        signal: { aborted: false },
        abort() {
            this.signal.aborted = true;
        }
    };

const cloneState = (state: SearchSessionState): SearchSessionState => ({ ...state });

export const createSearchSession = (
    coordinator: SearchCoordinatorLike | null | undefined,
    options: SearchSessionOptions = {}
): SearchSessionApi => {
    if (!coordinator || typeof coordinator.search !== "function") {
        throw new TypeError("Search session requires a coordinator with a search function");
    }

    const scheduler: SearchScheduler = options.scheduler || createDefaultScheduler();
    const now = typeof options.now === "function" ? options.now : () => Date.now();
    const debounceMs = normalizeSearchDebounceMs(options.debounceMs);
    const historySize = normalizeIntegerValue(options.historySize, {
        min: 1,
        max: MAX_SESSION_HISTORY_SIZE,
        fallback: DEFAULT_SESSION_HISTORY_SIZE
    });
    const cancelPrevious = options.cancelPrevious !== false;
    const dedupeInFlight = options.dedupeInFlight !== false;
    const listeners = new Set<(state: SearchSessionState) => void>();
    const inFlight = new Map<string, Promise<SessionExecutionResult>>();
    const history: SearchSessionHistoryEntry[] = [];
    let state = createSessionState();
    let sequence = 0;
    let activeController: SearchAbortControllerLike | null = null;
    let activeKey: string | null = null;
    let scheduled: ScheduledSearch | null = null;
    let disposed = false;

    const emit = (): void => {
        const snapshot = cloneState(state);
        listeners.forEach(listener => {
            try {
                listener(snapshot);
            } catch {
                // Consumer listeners are observational and cannot break search execution.
            }
        });
    };

    const transition = (patch: Partial<SearchSessionState>): SearchSessionState => {
        state = { ...state, ...patch };
        emit();
        return cloneState(state);
    };

    const remember = (entry: SearchSessionHistoryEntry): void => {
        history.push(entry);
        while (history.length > historySize) history.shift();
    };

    const cancelScheduled = (reason?: string): boolean => {
        if (!scheduled) return false;
        scheduler.clear(scheduled.timerId);
        const pending = scheduled;
        scheduled = null;
        pending.reject(createSearchAbortError(reason || "Scheduled search superseded"));
        transition({
            pendingRequestId: null,
            cancellationCount: state.cancellationCount + 1
        });
        return true;
    };

    const abortActive = (reason?: string): boolean => {
        if (!activeController) return false;
        activeController.abort(reason);
        activeController = null;
        activeKey = null;
        transition({ cancellationCount: state.cancellationCount + 1 });
        return true;
    };

    const execute = async (
        datasetName: unknown,
        request: CoordinatorRequestInput = {},
        searchOptions: SessionSearchOptions = {}
    ): Promise<SessionExecutionResult> => {
        if (disposed) throw new Error("Search session is disposed");
        const normalized = normalizeCoordinatorRequest(request);
        const requestKey = createSessionRequestKey(datasetName, normalized);
        if (searchOptions.signal?.aborted) throw createSearchAbortError();
        if (dedupeInFlight && inFlight.has(requestKey)) return inFlight.get(requestKey)!;

        const requestId = ++sequence;
        if (cancelPrevious && activeKey && activeKey !== requestKey) abortActive("Search superseded");
        const controller = createController();
        activeController = controller;
        activeKey = requestKey;
        const startedAt = now();
        transition({
            status: "loading",
            requestId,
            pendingRequestId: null,
            dataset: normalizeText(datasetName),
            query: normalized.query,
            normalizedQuery: normalized.normalizedQuery,
            error: null,
            startedAt,
            completedAt: null,
            durationMs: null
        });

        const operation = Promise.resolve().then(async () => {
            if (searchOptions.signal?.aborted || controller.signal.aborted) throw createSearchAbortError();
            const coordinatorOptions: CoordinatorSearchOptions & UnknownRecord = {
                ...searchOptions,
                signal: controller.signal as AbortSignal
            };
            const result = await coordinator.search(datasetName, normalized, coordinatorOptions) as SessionSearchResult;
            if (searchOptions.signal?.aborted || controller.signal.aborted) throw createSearchAbortError();
            const completedAt = now();
            const stale = requestId < sequence;
            if (stale) {
                transition({ staleResponseCount: state.staleResponseCount + 1 });
                remember({ requestId, dataset: datasetName, query: normalized.query, status: "stale", startedAt, completedAt });
                return { result, stale: true, requestId };
            }
            transition({
                status: "success",
                committedRequestId: requestId,
                result,
                error: null,
                completedAt,
                durationMs: Math.max(0, completedAt - startedAt)
            });
            remember({ requestId, dataset: datasetName, query: normalized.query, status: "success", startedAt, completedAt });
            return { result, stale: false, requestId };
        }).catch((error: unknown) => {
            const completedAt = now();
            const aborted = (isRecord(error) && error.name === "AbortError") || controller.signal.aborted;
            if (requestId === sequence) {
                transition({
                    status: aborted ? "cancelled" : "error",
                    error: aborted ? null : error,
                    completedAt,
                    durationMs: Math.max(0, completedAt - startedAt)
                });
            }
            remember({
                requestId,
                dataset: datasetName,
                query: normalized.query,
                status: aborted ? "cancelled" : "error",
                startedAt,
                completedAt,
                error: aborted ? null : error
            });
            throw error;
        }).finally(() => {
            inFlight.delete(requestKey);
            if (activeController === controller) {
                activeController = null;
                activeKey = null;
            }
        });

        inFlight.set(requestKey, operation);
        return operation;
    };

    const schedule = (
        datasetName: unknown,
        request: CoordinatorRequestInput = {},
        searchOptions: SessionSearchOptions = {}
    ): Promise<SessionExecutionResult> => {
        if (disposed) return Promise.reject(new Error("Search session is disposed"));
        cancelScheduled("Scheduled search superseded");
        const requestId = sequence + 1;
        transition({
            status: "scheduled",
            pendingRequestId: requestId,
            dataset: normalizeText(datasetName),
            query: normalizeText(request?.query),
            normalizedQuery: normalizeSearchText(request?.query),
            error: null
        });
        return new Promise<SessionExecutionResult>((resolve, reject) => {
            const timerId = scheduler.set(() => {
                scheduled = null;
                execute(datasetName, request, searchOptions).then(resolve, reject);
            }, normalizeSearchDebounceMs(searchOptions.debounceMs ?? debounceMs));
            scheduled = { timerId, resolve, reject, datasetName, request };
        });
    };

    const api = {
        search: execute,
        schedule,

        searchNow(
            datasetName: unknown,
            request: CoordinatorRequestInput = {},
            searchOptions: SessionSearchOptions = {}
        ): Promise<SessionExecutionResult> {
            cancelScheduled("Immediate search requested");
            return execute(datasetName, request, searchOptions);
        },

        async loadMore(searchOptions: SessionSearchOptions = {}): Promise<SessionExecutionResult> {
            const current = state.result;
            const nextOffset = current?.page?.nextOffset;
            if (!current || current?.page?.hasMore !== true || nextOffset === null || nextOffset === undefined) {
                return { result: current, stale: false, requestId: state.committedRequestId, terminal: true };
            }
            const previousRequest = isRecord(current.request) ? current.request : {};
            return execute(state.dataset, {
                ...previousRequest,
                offset: nextOffset
            }, searchOptions);
        },

        cancel(reason = "Search cancelled") {
            const scheduledCancelled = cancelScheduled(reason);
            const activeCancelled = abortActive(reason);
            if (scheduledCancelled || activeCancelled) {
                transition({ status: "cancelled", pendingRequestId: null, error: null });
            }
            return scheduledCancelled || activeCancelled;
        },

        subscribe(listener: (state: SearchSessionState) => void): () => boolean | void {
            if (typeof listener !== "function") return noop;
            listeners.add(listener);
            return () => listeners.delete(listener);
        },

        getState(): SearchSessionState {
            return cloneState(state);
        },

        getHistory(): SearchSessionHistoryEntry[] {
            return history.slice();
        },

        getInFlightCount(): number {
            return inFlight.size;
        },

        clearHistory(): number {
            const count = history.length;
            history.length = 0;
            return count;
        },

        reset(): void {
            api.cancel("Search session reset");
            history.length = 0;
            sequence = 0;
            state = createSessionState();
            emit();
        },

        dispose(): boolean {
            if (disposed) return false;
            api.cancel("Search session disposed");
            disposed = true;
            listeners.clear();
            history.length = 0;
            inFlight.clear();
            return true;
        },

        isDisposed(): boolean {
            return disposed;
        },

        diagnostics() {
            return {
                status: state.status,
                requestId: state.requestId,
                committedRequestId: state.committedRequestId,
                staleResponseCount: state.staleResponseCount,
                cancellationCount: state.cancellationCount,
                inFlightCount: inFlight.size,
                scheduled: Boolean(scheduled),
                historyCount: history.length,
                listenerCount: listeners.size,
                debounceMs,
                disposed
            };
        }
    };

    return api;
};

export const SearchSessionRuntime = {
    DEFAULT_SEARCH_DEBOUNCE_MS,
    MAX_SEARCH_DEBOUNCE_MS,
    DEFAULT_SESSION_HISTORY_SIZE,
    MAX_SESSION_HISTORY_SIZE,
    normalizeSearchDebounceMs,
    createSessionRequestKey,
    createSessionState,
    createManualSearchScheduler,
    createSearchSession
};