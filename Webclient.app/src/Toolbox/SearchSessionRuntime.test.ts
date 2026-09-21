import {
    createManualSearchScheduler,
    createSearchSession,
    createSessionRequestKey,
    createSessionState,
    normalizeSearchDebounceMs
} from "./SearchSessionRuntime";

const createCoordinatorStub = () => ({
    search: vi.fn(async (dataset, request) => ({
        dataset,
        request,
        records: [{ id: request.query || "all" }],
        page: {
            offset: request.offset || 0,
            limit: request.limit || 50,
            count: 1,
            total: 1,
            hasMore: false,
            nextOffset: null
        }
    }))
});

const createDeferredCoordinator = () => {
    const pending = [];
    return {
        pending,
        search: vi.fn((dataset, request, options) => new Promise((resolve, reject) => {
            pending.push({ dataset, request, options, resolve, reject });
        }))
    };
};

describe("SearchSessionRuntime", () => {
    describe("normalization", () => {
        test("normalizes debounce bounds", () => {
            expect(normalizeSearchDebounceMs(undefined)).toBe(180);
            expect(normalizeSearchDebounceMs(-1)).toBe(180);
            expect(normalizeSearchDebounceMs(0)).toBe(0);
            expect(normalizeSearchDebounceMs(99999)).toBe(2000);
        });

        test("creates stable keys for normalized queries", () => {
            const left = createSessionRequestKey("places", { query: " KUĞULU   PARK ", mode: "text" });
            const right = createSessionRequestKey("places", { query: "kuğulu park", mode: "text" });
            expect(left).toBe(right);
        });

        test("request keys distinguish pagination", () => {
            const left = createSessionRequestKey("places", { query: "park", offset: 0 });
            const right = createSessionRequestKey("places", { query: "park", offset: 50 });
            expect(left).not.toBe(right);
        });

        test("initial state is deterministic", () => {
            expect(createSessionState()).toEqual(expect.objectContaining({
                status: "idle",
                requestId: 0,
                committedRequestId: 0,
                staleResponseCount: 0,
                cancellationCount: 0,
                result: null,
                error: null
            }));
        });
    });

    describe("manual scheduler", () => {
        test("stores and runs scheduled callbacks", () => {
            const scheduler = createManualSearchScheduler();
            const callback = vi.fn();
            const id = scheduler.set(callback, 180);
            expect(scheduler.size()).toBe(1);
            expect(scheduler.entries()).toEqual([{ id, delay: 180 }]);
            expect(scheduler.run(id)).toBe(true);
            expect(callback).toHaveBeenCalledTimes(1);
            expect(scheduler.size()).toBe(0);
        });

        test("clears scheduled callbacks", () => {
            const scheduler = createManualSearchScheduler();
            const callback = vi.fn();
            const id = scheduler.set(callback, 180);
            scheduler.clear(id);
            expect(scheduler.run(id)).toBe(false);
            expect(callback).not.toHaveBeenCalled();
        });

        test("runs all queued callbacks", () => {
            const scheduler = createManualSearchScheduler();
            const one = vi.fn();
            const two = vi.fn();
            scheduler.set(one, 1);
            scheduler.set(two, 2);
            expect(scheduler.runAll()).toBe(2);
            expect(one).toHaveBeenCalledTimes(1);
            expect(two).toHaveBeenCalledTimes(1);
        });
    });

    describe("basic execution", () => {
        test("requires a coordinator", () => {
            expect(() => createSearchSession(null)).toThrow("Search session requires a coordinator");
        });

        test("executes immediate searches", async () => {
            const coordinator = createCoordinatorStub();
            const session = createSearchSession(coordinator, { now: () => 100 });
            const response = await session.searchNow("places", { query: "park", mode: "text" });
            expect(response.stale).toBe(false);
            expect(response.result.dataset).toBe("places");
            expect(coordinator.search).toHaveBeenCalledTimes(1);
            expect(session.getState()).toEqual(expect.objectContaining({
                status: "success",
                committedRequestId: 1,
                dataset: "places",
                normalizedQuery: "park"
            }));
        });

        test("tracks deterministic durations with injected clock", async () => {
            const times = [100, 145];
            const coordinator = createCoordinatorStub();
            const session = createSearchSession(coordinator, { now: () => times.shift() });
            await session.search("places", { query: "park" });
            expect(session.getState().durationMs).toBe(45);
        });

        test("records successful history", async () => {
            const coordinator = createCoordinatorStub();
            const session = createSearchSession(coordinator);
            await session.search("places", { query: "park" });
            expect(session.getHistory()).toHaveLength(1);
            expect(session.getHistory()[0]).toEqual(expect.objectContaining({
                dataset: "places",
                query: "park",
                status: "success"
            }));
        });
    });

    describe("debounce", () => {
        test("schedules search without calling coordinator immediately", async () => {
            const scheduler = createManualSearchScheduler();
            const coordinator = createCoordinatorStub();
            const session = createSearchSession(coordinator, { scheduler, debounceMs: 250 });
            const promise = session.schedule("places", { query: "park" });
            expect(coordinator.search).not.toHaveBeenCalled();
            expect(scheduler.entries()[0].delay).toBe(250);
            scheduler.runAll();
            await promise;
            expect(coordinator.search).toHaveBeenCalledTimes(1);
        });

        test("supersedes older scheduled search", async () => {
            const scheduler = createManualSearchScheduler();
            const coordinator = createCoordinatorStub();
            const session = createSearchSession(coordinator, { scheduler });
            const first = session.schedule("places", { query: "p" });
            const second = session.schedule("places", { query: "park" });
            await expect(first).rejects.toMatchObject({ name: "AbortError" });
            expect(scheduler.size()).toBe(1);
            scheduler.runAll();
            await second;
            expect(coordinator.search).toHaveBeenCalledTimes(1);
            expect(coordinator.search.mock.calls[0][1].query).toBe("park");
        });

        test("searchNow cancels a scheduled search", async () => {
            const scheduler = createManualSearchScheduler();
            const coordinator = createCoordinatorStub();
            const session = createSearchSession(coordinator, { scheduler });
            const scheduled = session.schedule("places", { query: "old" });
            const immediate = session.searchNow("places", { query: "new" });
            await expect(scheduled).rejects.toMatchObject({ name: "AbortError" });
            await immediate;
            expect(scheduler.size()).toBe(0);
            expect(coordinator.search).toHaveBeenCalledTimes(1);
        });
    });

    describe("in-flight dedupe", () => {
        test("deduplicates identical concurrent requests", async () => {
            const coordinator = createDeferredCoordinator();
            const session = createSearchSession(coordinator);
            const first = session.search("places", { query: "park" });
            const second = session.search("places", { query: "park" });
            await Promise.resolve();
            expect(coordinator.search).toHaveBeenCalledTimes(1);
            coordinator.pending[0].resolve({ records: [], page: { hasMore: false, nextOffset: null } });
            const [left, right] = await Promise.all([first, second]);
            expect(left).toBe(right);
            expect(session.getInFlightCount()).toBe(0);
        });

        test("can disable in-flight dedupe", async () => {
            const coordinator = createDeferredCoordinator();
            const session = createSearchSession(coordinator, { dedupeInFlight: false, cancelPrevious: false });
            const first = session.search("places", { query: "park" });
            const second = session.search("places", { query: "park" });
            await Promise.resolve();
            expect(coordinator.search).toHaveBeenCalledTimes(2);
            coordinator.pending.forEach(item => item.resolve({ records: [], page: { hasMore: false, nextOffset: null } }));
            await Promise.all([first, second]);
        });
    });

    describe("cancellation and stale response safety", () => {
        test("cancels previous request when a new different request starts", async () => {
            const coordinator = createDeferredCoordinator();
            const session = createSearchSession(coordinator);
            const first = session.search("places", { query: "old" });
            await Promise.resolve();
            const firstSignal = coordinator.pending[0].options.signal;
            const second = session.search("places", { query: "new" });
            await Promise.resolve();
            expect(firstSignal.aborted).toBe(true);
            coordinator.pending[0].resolve({ records: [{ id: "old" }], page: { hasMore: false } });
            coordinator.pending[1].resolve({ records: [{ id: "new" }], page: { hasMore: false } });
            await expect(first).rejects.toMatchObject({ name: "AbortError" });
            const latest = await second;
            expect(latest.result.records[0].id).toBe("new");
            expect(session.getState().result.records[0].id).toBe("new");
        });

        test("marks older completion stale when cancellation is disabled", async () => {
            const coordinator = createDeferredCoordinator();
            const session = createSearchSession(coordinator, { cancelPrevious: false });
            const first = session.search("places", { query: "old" });
            const second = session.search("places", { query: "new" });
            await Promise.resolve();
            coordinator.pending[1].resolve({ records: [{ id: "new" }], page: { hasMore: false } });
            const latest = await second;
            coordinator.pending[0].resolve({ records: [{ id: "old" }], page: { hasMore: false } });
            const stale = await first;
            expect(latest.stale).toBe(false);
            expect(stale.stale).toBe(true);
            expect(session.getState().result.records[0].id).toBe("new");
            expect(session.getState().staleResponseCount).toBe(1);
        });

        test("explicit cancel aborts active request", async () => {
            const coordinator = createDeferredCoordinator();
            const session = createSearchSession(coordinator);
            const promise = session.search("places", { query: "park" });
            await Promise.resolve();
            const signal = coordinator.pending[0].options.signal;
            expect(session.cancel()).toBe(true);
            expect(signal.aborted).toBe(true);
            coordinator.pending[0].resolve({ records: [], page: { hasMore: false } });
            await expect(promise).rejects.toMatchObject({ name: "AbortError" });
            expect(session.getState().status).toBe("cancelled");
        });

        test("does nothing when nothing is active", () => {
            const session = createSearchSession(createCoordinatorStub());
            expect(session.cancel()).toBe(false);
        });

        test("rejects externally pre-aborted searches", async () => {
            const session = createSearchSession(createCoordinatorStub());
            await expect(session.search("places", { query: "park" }, {
                signal: { aborted: true }
            })).rejects.toMatchObject({ name: "AbortError" });
        });
    });

    describe("errors", () => {
        test("stores non-abort errors", async () => {
            const coordinator = {
                search: vi.fn(() => Promise.reject(new Error("backend failed")))
            };
            const session = createSearchSession(coordinator);
            await expect(session.search("places", { query: "park" })).rejects.toThrow("backend failed");
            expect(session.getState()).toEqual(expect.objectContaining({
                status: "error",
                error: expect.objectContaining({ message: "backend failed" })
            }));
            expect(session.getHistory()[0].status).toBe("error");
        });
    });

    describe("pagination", () => {
        test("loadMore is terminal without a next page", async () => {
            const coordinator = createCoordinatorStub();
            const session = createSearchSession(coordinator);
            await session.search("places", { query: "park" });
            const next = await session.loadMore();
            expect(next.terminal).toBe(true);
            expect(coordinator.search).toHaveBeenCalledTimes(1);
        });

        test("loadMore executes the next offset", async () => {
            const coordinator = {
                search: vi.fn(async (_dataset, request) => ({
                    request,
                    records: [{ id: request.offset || 0 }],
                    page: request.offset
                        ? { offset: 2, count: 1, total: 3, hasMore: false, nextOffset: null }
                        : { offset: 0, count: 2, total: 3, hasMore: true, nextOffset: 2 }
                }))
            };
            const session = createSearchSession(coordinator);
            await session.search("places", { query: "park", offset: 0, limit: 2 });
            const next = await session.loadMore();
            expect(next.result.request.offset).toBe(2);
            expect(coordinator.search).toHaveBeenCalledTimes(2);
        });
    });

    describe("subscriptions", () => {
        test("notifies listeners on state changes", async () => {
            const coordinator = createCoordinatorStub();
            const session = createSearchSession(coordinator);
            const listener = vi.fn();
            const unsubscribe = session.subscribe(listener);
            await session.search("places", { query: "park" });
            expect(listener).toHaveBeenCalled();
            const calls = listener.mock.calls.length;
            unsubscribe();
            await session.search("places", { query: "müze" });
            expect(listener).toHaveBeenCalledTimes(calls);
        });

        test("ignores listener failures", async () => {
            const session = createSearchSession(createCoordinatorStub());
            session.subscribe(() => {
                throw new Error("listener broke");
            });
            await expect(session.search("places", { query: "park" })).resolves.toBeDefined();
        });
    });

    describe("history and lifecycle", () => {
        test("bounds history size", async () => {
            const session = createSearchSession(createCoordinatorStub(), { historySize: 2 });
            await session.search("places", { query: "one" });
            await session.search("places", { query: "two" });
            await session.search("places", { query: "three" });
            expect(session.getHistory()).toHaveLength(2);
            expect(session.getHistory().map(item => item.query)).toEqual(["two", "three"]);
        });

        test("clears history", async () => {
            const session = createSearchSession(createCoordinatorStub());
            await session.search("places", { query: "one" });
            expect(session.clearHistory()).toBe(1);
            expect(session.getHistory()).toEqual([]);
        });

        test("reset returns state to idle", async () => {
            const session = createSearchSession(createCoordinatorStub());
            await session.search("places", { query: "one" });
            session.reset();
            expect(session.getState()).toEqual(createSessionState());
            expect(session.getHistory()).toEqual([]);
        });

        test("dispose is idempotent and prevents new searches", async () => {
            const session = createSearchSession(createCoordinatorStub());
            expect(session.dispose()).toBe(true);
            expect(session.dispose()).toBe(false);
            expect(session.isDisposed()).toBe(true);
            await expect(session.search("places", { query: "park" })).rejects.toThrow("disposed");
        });

        test("diagnostics expose runtime state without raw results", async () => {
            const session = createSearchSession(createCoordinatorStub(), { debounceMs: 120 });
            await session.search("places", { query: "park" });
            expect(session.diagnostics()).toEqual(expect.objectContaining({
                status: "success",
                committedRequestId: 1,
                inFlightCount: 0,
                historyCount: 1,
                debounceMs: 120,
                disposed: false
            }));
        });
    });
});