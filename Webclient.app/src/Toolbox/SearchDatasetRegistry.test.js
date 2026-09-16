import {
    DEFAULT_DATASET_TTL_MS,
    createDatasetFingerprint,
    createSearchAbortError,
    createSearchDatasetRegistry,
    hashSearchDataset,
    normalizeDatasetName,
    normalizeDatasetOptions,
    stableSerializeForFingerprint,
    throwIfDatasetAborted
} from "./SearchDatasetRegistry";

const records = (...ids) => ids.map(id => ({
    id,
    title: `Kayıt ${id}`,
    category: id % 2 ? "Parklar" : "Kütüphaneler"
}));

describe("SearchDatasetRegistry", () => {
    describe("normalization and fingerprinting", () => {
        test("normalizes dataset names deterministically", () => {
            expect(normalizeDatasetName("  Genel Arama / Ankara  ")).toBe("genel-arama-ankara");
            expect(normalizeDatasetName("ADRES_2026")).toBe("adres_2026");
            expect(normalizeDatasetName(null)).toBe("");
        });

        test("normalizes unsafe options to bounded defaults", () => {
            expect(normalizeDatasetOptions({ ttlMs: -1, maxDatasets: 0, maxRecords: 0 })).toEqual(expect.objectContaining({
                ttlMs: DEFAULT_DATASET_TTL_MS,
                maxDatasets: 12,
                maxRecords: 100000
            }));
        });

        test("stable serialization does not depend on object key order", () => {
            const left = stableSerializeForFingerprint({ b: 2, a: 1, nested: { z: 3, y: 2 } });
            const right = stableSerializeForFingerprint({ nested: { y: 2, z: 3 }, a: 1, b: 2 });
            expect(left).toBe(right);
        });

        test("stable serialization tolerates circular values", () => {
            const source = { id: 1 };
            source.self = source;
            expect(stableSerializeForFingerprint(source)).toContain("[Circular]");
        });

        test("fingerprints are deterministic and data-sensitive", () => {
            const first = createDatasetFingerprint(records(1, 2), { source: "a" });
            const second = createDatasetFingerprint(records(1, 2), { source: "a" });
            const changed = createDatasetFingerprint(records(1, 3), { source: "a" });
            expect(first).toBe(second);
            expect(changed).not.toBe(first);
            expect(first).toMatch(/^fnv1a-[0-9a-f]{8}$/);
        });

        test("generic hashing is deterministic for Turkish text", () => {
            expect(hashSearchDataset("Çankaya Şehit Cengiz Karaca")).toBe(hashSearchDataset("Çankaya Şehit Cengiz Karaca"));
        });
    });

    describe("abort contract", () => {
        test("creates standard AbortError instances", () => {
            const error = createSearchAbortError("cancelled");
            expect(error).toBeInstanceOf(Error);
            expect(error.name).toBe("AbortError");
            expect(error.message).toBe("cancelled");
        });

        test("throws only for aborted signals", () => {
            expect(() => throwIfDatasetAborted({ aborted: false })).not.toThrow();
            expect(() => throwIfDatasetAborted({ aborted: true })).toThrow("Search dataset operation aborted");
        });
    });

    describe("dataset lifecycle", () => {
        test("registers and reads immutable snapshots", () => {
            const registry = createSearchDatasetRegistry();
            const snapshot = registry.register("places", records(1, 2), { service: "places" }, { now: 100 });
            expect(snapshot.name).toBe("places");
            expect(snapshot.recordCount).toBe(2);
            expect(snapshot.revision).toBe(1);
            expect(snapshot.createdAt).toBe(100);
            expect(Object.isFrozen(snapshot)).toBe(true);
            expect(Object.isFrozen(snapshot.records)).toBe(true);
            expect(registry.get("places", { now: 101 }).records).toHaveLength(2);
        });

        test("preserves numeric zero identifiers in records", () => {
            const registry = createSearchDatasetRegistry();
            registry.register("zero", [{ id: 0, title: "Merkez" }]);
            expect(registry.get("zero").records[0].id).toBe(0);
        });

        test("replace increments revision and changes fingerprint", () => {
            const registry = createSearchDatasetRegistry();
            const first = registry.register("places", records(1), {}, { now: 1 });
            const second = registry.replace("places", records(1, 2), {}, { now: 2 });
            expect(second.revision).toBe(2);
            expect(second.fingerprint).not.toBe(first.fingerprint);
            expect(second.createdAt).toBe(1);
            expect(second.updatedAt).toBe(2);
        });

        test("append retains previous records and merges metadata", () => {
            const registry = createSearchDatasetRegistry();
            registry.register("places", records(1), { source: "gis", version: 1 });
            const appended = registry.append("places", records(2, 3), { version: 2 });
            expect(appended.records.map(item => item.id)).toEqual([1, 2, 3]);
            expect(appended.metadata).toEqual({ source: "gis", version: 2 });
            expect(appended.revision).toBe(2);
        });

        test("rejects empty dataset names", () => {
            const registry = createSearchDatasetRegistry();
            expect(() => registry.register("", [])).toThrow("Dataset name is required");
        });

        test("removes datasets and registered loaders", async () => {
            const registry = createSearchDatasetRegistry();
            registry.register("places", records(1));
            registry.registerLoader("places", () => records(2));
            expect(registry.remove("places")).toBe(true);
            expect(registry.has("places", { allowStale: true })).toBe(false);
            await expect(registry.load("places")).rejects.toMatchObject({ code: "DATASET_LOADER_MISSING" });
        });

        test("clear reports removed dataset count", () => {
            const registry = createSearchDatasetRegistry();
            registry.register("one", records(1));
            registry.register("two", records(2));
            expect(registry.clear()).toBe(2);
            expect(registry.list()).toEqual([]);
        });
    });

    describe("ttl and stale behavior", () => {
        test("marks expired snapshots as stale", () => {
            const registry = createSearchDatasetRegistry({ ttlMs: 100 });
            registry.register("places", records(1), {}, { now: 1000 });
            expect(registry.get("places", { now: 1050 }).stale).toBe(false);
            expect(registry.get("places", { now: 1100 }).stale).toBe(true);
        });

        test("can reject stale reads", () => {
            const registry = createSearchDatasetRegistry({ ttlMs: 10 });
            registry.register("places", records(1), {}, { now: 0 });
            expect(registry.get("places", { now: 20, allowStale: false })).toBeNull();
            expect(registry.peek("places", { now: 20 }).stale).toBe(true);
        });

        test("explicit markStale invalidates freshness", () => {
            const registry = createSearchDatasetRegistry({ ttlMs: 1000 });
            registry.register("places", records(1), {}, { now: 0 });
            expect(registry.markStale("places")).toBe(true);
            expect(registry.has("places", { now: 1 })).toBe(false);
            expect(registry.has("places", { now: 1, allowStale: true })).toBe(true);
        });

        test("refreshExpiry makes a stale dataset fresh without changing revision", () => {
            const registry = createSearchDatasetRegistry({ ttlMs: 10 });
            const original = registry.register("places", records(1), {}, { now: 0 });
            registry.markStale("places");
            const refreshed = registry.refreshExpiry("places", 500, 100);
            expect(refreshed.stale).toBe(false);
            expect(refreshed.expiresAt).toBe(600);
            expect(refreshed.revision).toBe(original.revision);
        });
    });

    describe("bounded memory", () => {
        test("rejects oversized datasets by default", () => {
            const registry = createSearchDatasetRegistry({ maxRecords: 2 });
            expect(() => registry.register("too-big", records(1, 2, 3))).toThrow(RangeError);
            try {
                registry.register("too-big", records(1, 2, 3));
            } catch (error) {
                expect(error.code).toBe("DATASET_RECORD_LIMIT");
            }
        });

        test("can intentionally truncate when rejectOversized is disabled", () => {
            const registry = createSearchDatasetRegistry({ maxRecords: 2, rejectOversized: false });
            expect(registry.register("bounded", records(1, 2, 3)).records.map(item => item.id)).toEqual([1, 2]);
        });

        test("evicts least recently used datasets when capacity is exceeded", () => {
            const registry = createSearchDatasetRegistry({ maxDatasets: 2 });
            registry.register("one", records(1), {}, { now: 1 });
            registry.register("two", records(2), {}, { now: 2 });
            registry.get("one", { now: 3 });
            registry.register("three", records(3), {}, { now: 4 });
            expect(registry.peek("one")).not.toBeNull();
            expect(registry.peek("two")).toBeNull();
            expect(registry.peek("three")).not.toBeNull();
            expect(registry.diagnostics().evictions).toBe(1);
        });
    });

    describe("loader and in-flight deduplication", () => {
        test("loads a missing dataset using a registered loader", async () => {
            const registry = createSearchDatasetRegistry();
            registry.registerLoader("places", () => ({
                records: records(1, 2),
                metadata: { source: "loader" }
            }));
            const result = await registry.load("places", { completedAt: 100 });
            expect(result.recordCount).toBe(2);
            expect(result.metadata.source).toBe("loader");
            expect(registry.diagnostics()).toEqual(expect.objectContaining({
                loadsStarted: 1,
                loadsSucceeded: 1,
                loadsFailed: 0
            }));
        });

        test("deduplicates concurrent loads for the same dataset", async () => {
            const registry = createSearchDatasetRegistry();
            let resolveLoader;
            let calls = 0;
            registry.registerLoader("places", () => {
                calls += 1;
                return new Promise(resolve => {
                    resolveLoader = resolve;
                });
            });
            const first = registry.load("places");
            const second = registry.load("places");
            await Promise.resolve();
            expect(calls).toBe(1);
            resolveLoader(records(1, 2));
            const [left, right] = await Promise.all([first, second]);
            expect(left.fingerprint).toBe(right.fingerprint);
            expect(registry.diagnostics().loadsDeduped).toBe(1);
        });

        test("does not call loaders when a fresh dataset is cached", async () => {
            const registry = createSearchDatasetRegistry({ ttlMs: 1000 });
            registry.register("places", records(1), {}, { now: 0 });
            const loader = jest.fn(() => records(2));
            registry.registerLoader("places", loader);
            const result = await registry.load("places", { now: 10 });
            expect(result.records[0].id).toBe(1);
            expect(loader).not.toHaveBeenCalled();
        });

        test("reloads stale datasets when stale reads are not requested", async () => {
            const registry = createSearchDatasetRegistry({ ttlMs: 10 });
            registry.register("places", records(1), {}, { now: 0 });
            registry.registerLoader("places", () => records(2));
            const result = await registry.load("places", { now: 20, completedAt: 20 });
            expect(result.records[0].id).toBe(2);
            expect(result.revision).toBe(2);
        });

        test("can intentionally return stale local data without loading", async () => {
            const registry = createSearchDatasetRegistry({ ttlMs: 10 });
            registry.register("places", records(1), {}, { now: 0 });
            const loader = jest.fn(() => records(2));
            registry.registerLoader("places", loader);
            const result = await registry.load("places", { now: 20, allowStale: true });
            expect(result.stale).toBe(true);
            expect(result.records[0].id).toBe(1);
            expect(loader).not.toHaveBeenCalled();
        });

        test("surfaces loader failures and clears in-flight state", async () => {
            const registry = createSearchDatasetRegistry();
            registry.registerLoader("places", () => Promise.reject(new Error("service failed")));
            await expect(registry.load("places")).rejects.toThrow("service failed");
            expect(registry.diagnostics()).toEqual(expect.objectContaining({
                loadsFailed: 1,
                inFlightCount: 0
            }));
        });

        test("rejects pre-aborted loads without calling loader", async () => {
            const registry = createSearchDatasetRegistry();
            const loader = jest.fn(() => records(1));
            registry.registerLoader("places", loader);
            await expect(registry.load("places", { signal: { aborted: true } })).rejects.toMatchObject({ name: "AbortError" });
            expect(loader).not.toHaveBeenCalled();
        });

        test("ensure returns fresh cache before loader", async () => {
            const registry = createSearchDatasetRegistry({ ttlMs: 1000 });
            registry.register("places", records(1), {}, { now: 0 });
            const loader = jest.fn(() => records(2));
            registry.registerLoader("places", loader);
            const result = await registry.ensure("places", { now: 50 });
            expect(result.records[0].id).toBe(1);
            expect(loader).not.toHaveBeenCalled();
        });
    });

    describe("derived artifacts", () => {
        test("caches a derived index by dataset revision", () => {
            const registry = createSearchDatasetRegistry();
            registry.register("places", records(1));
            const builder = jest.fn(snapshot => ({ count: snapshot.recordCount }));
            const first = registry.getOrBuildDerived("places", "index", builder);
            const second = registry.getOrBuildDerived("places", "index", builder);
            expect(first).toEqual({ count: 1 });
            expect(second).toBe(first);
            expect(builder).toHaveBeenCalledTimes(1);
        });

        test("replacement invalidates derived artifacts", () => {
            const registry = createSearchDatasetRegistry();
            registry.register("places", records(1));
            registry.setDerived("places", "index", { revision: 1 });
            registry.replace("places", records(1, 2));
            expect(registry.getDerived("places", "index")).toBeUndefined();
        });

        test("markStale clears derived artifacts", () => {
            const registry = createSearchDatasetRegistry();
            registry.register("places", records(1));
            registry.setDerived("places", "index", { ok: true });
            registry.markStale("places");
            expect(registry.getDerived("places", "index")).toBeUndefined();
        });

        test("supports targeted and full derived invalidation", () => {
            const registry = createSearchDatasetRegistry();
            registry.register("places", records(1));
            registry.setDerived("places", "a", 1);
            registry.setDerived("places", "b", 2);
            expect(registry.invalidateDerived("places", "a")).toBe(true);
            expect(registry.getDerived("places", "a")).toBeUndefined();
            expect(registry.getDerived("places", "b")).toBe(2);
            expect(registry.invalidateDerived("places")).toBe(true);
            expect(registry.getDerived("places", "b")).toBeUndefined();
        });
    });

    describe("diagnostics", () => {
        test("reports aggregate dataset and record counts", () => {
            const registry = createSearchDatasetRegistry({ ttlMs: 100 });
            registry.register("one", records(1, 2), {}, { now: 0 });
            registry.register("two", records(3), {}, { now: 0 });
            expect(registry.diagnostics({ now: 50 })).toEqual(expect.objectContaining({
                datasetCount: 2,
                totalRecords: 3,
                staleDatasetCount: 0,
                names: ["one", "two"]
            }));
            expect(registry.diagnostics({ now: 101 }).staleDatasetCount).toBe(2);
        });

        test("tracks cache reads and can reset statistics", () => {
            const registry = createSearchDatasetRegistry();
            registry.register("one", records(1));
            registry.get("one");
            registry.get("missing");
            expect(registry.diagnostics()).toEqual(expect.objectContaining({
                cacheHits: 1,
                cacheMisses: 1
            }));
            registry.resetStatistics();
            expect(registry.diagnostics()).toEqual(expect.objectContaining({
                cacheHits: 0,
                cacheMisses: 0,
                registrations: 0
            }));
        });
    });
});