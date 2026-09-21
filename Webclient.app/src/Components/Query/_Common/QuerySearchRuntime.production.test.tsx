import {
    createProductionSearchRuntime
} from "./QuerySearchRuntime";

const createHarness = () => {
    const coordinator = {
        ingest: vi.fn((_dataset, payload) => ({ name: "places", recordCount: payload.length })),
        register: vi.fn((_dataset, records) => ({ name: "places", recordCount: records.length })),
        registerLoader: vi.fn(() => vi.fn()),
        invalidate: vi.fn(() => true),
        diagnostics: vi.fn(() => ({ registry: { totalRecords: 2500 } }))
    };
    const session = {
        searchNow: vi.fn(async (dataset, request) => ({
            result: { dataset, mode: request.mode || "text", diagnostics: { candidateCount: 3, matchedCount: 1 } },
            stale: false,
            requestId: 1
        })),
        schedule: vi.fn(async (dataset, request) => ({
            result: { dataset, mode: request.mode || "text", diagnostics: { candidateCount: 2, matchedCount: 1 } },
            stale: false,
            requestId: 2
        })),
        loadMore: vi.fn(async () => ({
            result: { dataset: "places", mode: "text", diagnostics: { candidateCount: 1, matchedCount: 1 } },
            stale: false,
            requestId: 3
        })),
        getState: vi.fn(() => ({
            dataset: "places",
            result: { mode: "text" }
        })),
        diagnostics: vi.fn(() => ({ status: "success" })),
        dispose: vi.fn(() => true)
    };
    const observability = {
        recordDatasetSize: vi.fn(),
        recordSearch: vi.fn(),
        recordError: vi.fn(),
        recommendDebounce: vi.fn(() => 140),
        snapshot: vi.fn(() => ({ seriesCount: 1 })),
        evaluate: vi.fn(() => ({ withinBudget: true }))
    };
    const modules = [
        { createSearchCoordinator: vi.fn(() => coordinator) },
        { createSearchSession: vi.fn(() => session) },
        {
            createSearchObservability: vi.fn(() => observability),
            measureAsyncOperation: vi.fn(async operation => {
                try {
                    return { value: await operation(), durationMs: 25, error: null };
                } catch (error) {
                    return { value: undefined, durationMs: 25, error };
                }
            })
        }
    ];
    return { coordinator, session, observability, modules };
};

describe("QuerySearchRuntime production facade", () => {
    test("builds coordinator, session and observability from injected modules", async () => {
        const harness = createHarness();
        const runtime = await createProductionSearchRuntime({ modules: harness.modules });
        expect(runtime.coordinator).toBe(harness.coordinator);
        expect(runtime.session).toBe(harness.session);
        expect(runtime.observability).toBe(harness.observability);
        expect(harness.modules[0].createSearchCoordinator).toHaveBeenCalledTimes(1);
        expect(harness.modules[1].createSearchSession).toHaveBeenCalledTimes(1);
        expect(harness.modules[2].createSearchObservability).toHaveBeenCalledTimes(1);
    });

    test("rejects incomplete module sets", async () => {
        await expect(createProductionSearchRuntime({ modules: [{}, {}, {}] })).rejects.toThrow(
            "Production search runtime modules are incomplete"
        );
    });

    test("ingest records dataset size telemetry", async () => {
        const harness = createHarness();
        const runtime = await createProductionSearchRuntime({ modules: harness.modules });
        const snapshot = runtime.ingest("places", [{ id: 1 }, { id: 2 }]);
        expect(snapshot.recordCount).toBe(2);
        expect(harness.coordinator.ingest).toHaveBeenCalledWith("places", [{ id: 1 }, { id: 2 }], {});
        expect(harness.observability.recordDatasetSize).toHaveBeenCalledWith(2, { dataset: "places" });
    });

    test("register records dataset size telemetry", async () => {
        const harness = createHarness();
        const runtime = await createProductionSearchRuntime({ modules: harness.modules });
        runtime.register("places", [{ id: 1 }], { source: "test" });
        expect(harness.coordinator.register).toHaveBeenCalledWith("places", [{ id: 1 }], { source: "test" }, {});
        expect(harness.observability.recordDatasetSize).toHaveBeenCalledWith(1, { dataset: "places" });
    });

    test("delegates loader registration", async () => {
        const harness = createHarness();
        const runtime = await createProductionSearchRuntime({ modules: harness.modules });
        const loader = vi.fn();
        runtime.registerLoader("places", loader);
        expect(harness.coordinator.registerLoader).toHaveBeenCalledWith("places", loader);
    });

    test("measures and records immediate search", async () => {
        const harness = createHarness();
        const runtime = await createProductionSearchRuntime({ modules: harness.modules });
        const envelope = await runtime.search("places", { query: "park", mode: "text" });
        expect(envelope.result.dataset).toBe("places");
        expect(harness.session.searchNow).toHaveBeenCalled();
        expect(harness.observability.recordSearch).toHaveBeenCalledWith(
            envelope.result,
            25,
            { dataset: "places", mode: "text" }
        );
    });

    test("measures scheduled search", async () => {
        const harness = createHarness();
        const runtime = await createProductionSearchRuntime({ modules: harness.modules });
        const envelope = await runtime.schedule("places", { query: "park", mode: "text" });
        expect(envelope.requestId).toBe(2);
        expect(harness.session.schedule).toHaveBeenCalled();
        expect(harness.observability.recordSearch).toHaveBeenCalled();
    });

    test("measures loadMore using current session context", async () => {
        const harness = createHarness();
        const runtime = await createProductionSearchRuntime({ modules: harness.modules });
        const envelope = await runtime.loadMore();
        expect(envelope.requestId).toBe(3);
        expect(harness.observability.recordSearch).toHaveBeenCalledWith(
            envelope.result,
            25,
            { dataset: "places", mode: "text" }
        );
    });

    test("records search errors before rethrowing", async () => {
        const harness = createHarness();
        harness.session.searchNow.mockRejectedValueOnce(new Error("search failed"));
        const runtime = await createProductionSearchRuntime({ modules: harness.modules });
        await expect(runtime.search("places", { query: "park" })).rejects.toThrow("search failed");
        expect(harness.observability.recordError).toHaveBeenCalledWith({
            dataset: "places",
            mode: undefined
        });
    });

    test("exposes combined diagnostics", async () => {
        const harness = createHarness();
        const runtime = await createProductionSearchRuntime({ modules: harness.modules });
        expect(runtime.diagnostics()).toEqual({
            coordinator: { registry: { totalRecords: 2500 } },
            session: { status: "success" },
            observability: { seriesCount: 1 },
            performanceGate: { withinBudget: true }
        });
    });

    test("recommends debounce using current total record count and query length", async () => {
        const harness = createHarness();
        const runtime = await createProductionSearchRuntime({ modules: harness.modules });
        expect(runtime.recommendDebounce("park")).toBe(140);
        expect(harness.observability.recommendDebounce).toHaveBeenCalledWith({
            queryLength: 4,
            recordCount: 2500
        });
    });

    test("delegates invalidation and disposal", async () => {
        const harness = createHarness();
        const runtime = await createProductionSearchRuntime({ modules: harness.modules });
        expect(runtime.invalidate("places")).toBe(true);
        expect(runtime.dispose()).toBe(true);
        expect(harness.coordinator.invalidate).toHaveBeenCalledWith("places");
        expect(harness.session.dispose).toHaveBeenCalledTimes(1);
    });

    test("supports fully supplied runtime instances", async () => {
        const harness = createHarness();
        const runtime = await createProductionSearchRuntime({
            modules: harness.modules,
            coordinator: harness.coordinator,
            session: harness.session,
            observability: harness.observability
        });
        expect(runtime.coordinator).toBe(harness.coordinator);
        expect(runtime.session).toBe(harness.session);
        expect(runtime.observability).toBe(harness.observability);
    });
});