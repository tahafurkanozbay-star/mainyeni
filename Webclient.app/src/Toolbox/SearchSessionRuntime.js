import {
    normalizeInteger,
    normalizeSearchText,
    normalizeText
} from "./DataIntegrityHelper";
import {
    normalizeCoordinatorRequest
} from "./SearchCoordinatorRuntime";
import {
    createSearchAbortError
} from "./SearchDatasetRegistry";

export const DEFAULT_SEARCH_DEBOUNCE_MS = 180;
export const MAX_SEARCH_DEBOUNCE_MS = 2000;
export const DEFAULT_SESSION_HISTORY_SIZE = 20;
export const MAX_SESSION_HISTORY_SIZE = 200;

const noop = () => {};
const asArray = value => Array.isArray(value) ? value : [];
const hasAbortController = () => typeof AbortController !== "undefined";

export const normalizeSearchDebounceMs = value => {
    if (value === 0 || value === "0") return 0;
    if (value === undefined || value === null || value === "") return DEFAULT_SEARCH_DEBOUNCE_MS;
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || !Number.isInteger(numeric) || numeric < 0) return DEFAULT_SEARCH_DEBOUNCE_MS;
    return Math.min(MAX_SEARCH_DEBOUNCE_MS, numeric);
};

export const createSessionRequestKey = (datasetName, request = {}) => {
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

export const createSessionState = () => ({
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

export const createManualSearchScheduler = () => {
    let sequence = 0;
    const tasks = new Map();
    return {
        set(callback, delay) {
            const id = ++sequence;
            tasks.set(id, { callback, delay });
            return id;
        },
        clear(id) {
            tasks.delete(id);
        },
        run(id) {
            const task = tasks.get(id);
            if (!task) return false;
            tasks.delete(id);
            task.callback();
            return true;
        },
        runAll() {
            const ids = Array.from(tasks.keys());
            ids.forEach(id => this.run(id));
            return ids.length;
        },
        size() {
            return tasks.size;
        },
        entries() {
            return Array.from(tasks.entries()).map(([id, task]) => ({ id, delay: task.delay }));
        }
    };
};

const createDefaultScheduler = () => ({
    set: (callback, delay) => setTimeout(callback, delay),
    clear: id => clearTimeout(id)
});

const createController = () => hasAbortController()
    ? new AbortController()
    : {
        signal: { aborted: false },
        abort() {
            this.signal.aborted = true;
        }
    };

const cloneState = state => ({ ...state });

export const createSearchSession = (coordinator, options = {}) => {
    if (!coordinator || typeof coordinator.search !== "function") {
        throw new TypeError("Search session requires a coordinator with a search function");
    }

    const scheduler = options.scheduler || createDefaultScheduler();
    const now = typeof options.now === "function" ? options.now : () => Date.now();
    const debounceMs = normalizeSearchDebounceMs(options.debounceMs);
    const historySize = normalizeInteger(options.historySize, {
        min: 1,
        max: MAX_SESSION_HISTORY_SIZE,
        fallback: DEFAULT_SESSION_HISTORY_SIZE
    });
    const cancelPrevious = options.cancelPrevious !== false;
    const dedupeInFlight = options.dedupeInFlight !== false;
    const listeners = new Set();
    const inFlight = new Map();
    const history = [];
    let state = createSessionState();
    let sequence = 0;
    let activeController = null;
    let activeKey = null;
    let scheduled = null;
    let disposed = false;

    const emit = () => {
        const snapshot = cloneState(state);
        listeners.forEach(listener => {
            try {
                listener(snapshot);
            } catch (_error) {
                // Consumer listeners are observational and cannot break search execution.
            }
        });
    };

    const transition = patch => {
        state = { ...state, ...patch };
        emit();
        return cloneState(state);
    };

    const remember = entry => {
        history.push(entry);
        while (history.length > historySize) history.shift();
    };

    const cancelScheduled = reason => {
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

    const abortActive = reason => {
        if (!activeController) return false;
        activeController.abort(reason);
        activeController = null;
        activeKey = null;
        transition({ cancellationCount: state.cancellationCount + 1 });
        return true;
    };

    const execute = async (datasetName, request = {}, searchOptions = {}) => {
        if (disposed) throw new Error("Search session is disposed");
        const normalized = normalizeCoordinatorRequest(request);
        const requestKey = createSessionRequestKey(datasetName, normalized);
        if (searchOptions.signal?.aborted) throw createSearchAbortError();
        if (dedupeInFlight && inFlight.has(requestKey)) return inFlight.get(requestKey);

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
            const result = await coordinator.search(datasetName, normalized, {
                ...searchOptions,
                signal: controller.signal
            });
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
        }).catch(error => {
            const completedAt = now();
            const aborted = error?.name === "AbortError" || controller.signal.aborted;
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

    const schedule = (datasetName, request = {}, searchOptions = {}) => {
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
        return new Promise((resolve, reject) => {
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

        searchNow(datasetName, request = {}, searchOptions = {}) {
            cancelScheduled("Immediate search requested");
            return execute(datasetName, request, searchOptions);
        },

        async loadMore(searchOptions = {}) {
            const current = state.result;
            const nextOffset = current?.page?.nextOffset;
            if (!current || current?.page?.hasMore !== true || nextOffset === null || nextOffset === undefined) {
                return { result: current, stale: false, requestId: state.committedRequestId, terminal: true };
            }
            return execute(state.dataset, {
                ...(current.request || {}),
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

        subscribe(listener) {
            if (typeof listener !== "function") return noop;
            listeners.add(listener);
            return () => listeners.delete(listener);
        },

        getState() {
            return cloneState(state);
        },

        getHistory() {
            return history.slice();
        },

        getInFlightCount() {
            return inFlight.size;
        },

        clearHistory() {
            const count = history.length;
            history.length = 0;
            return count;
        },

        reset() {
            api.cancel("Search session reset");
            history.length = 0;
            sequence = 0;
            state = createSessionState();
            emit();
        },

        dispose() {
            if (disposed) return false;
            api.cancel("Search session disposed");
            disposed = true;
            listeners.clear();
            history.length = 0;
            inFlight.clear();
            return true;
        },

        isDisposed() {
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