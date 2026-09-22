import { describe, expect, it } from "vitest";
import { createSpatialSnapshotRuntime, type SpatialSnapshotInput } from "./spatialSnapshotRuntime";

const base = (id: string): SpatialSnapshotInput => ({
    id,
    mode: "2d",
    extent: { xmin: 0, ymin: 0, xmax: 100, ymax: 100, wkid: 3857 },
    scale: 10_000,
});

describe("spatialSnapshotRuntime", () => {
    it("stores and retrieves a normalized immutable snapshot", () => {
        let time = 100;
        const runtime = createSpatialSnapshotRuntime({}, () => time);
        const snapshot = runtime.put({
            ...base("  home  "),
            rotation: 12,
            layers: [{ layerId: " roads ", visible: true, opacity: 0.5, minScale: 0, maxScale: 25_000, revision: " r1 " }],
            selections: [{ layerId: " roads ", objectIds: [1, 1, " A ", "A"] }],
        });
        expect(snapshot.id).toBe("home");
        expect(snapshot.createdAt).toBe(100);
        expect(snapshot.layers[0]?.layerId).toBe("roads");
        expect(snapshot.selections[0]?.objectIds).toEqual([1, "A"]);
        expect(Object.isFrozen(snapshot)).toBe(true);
        time = 120;
        expect(runtime.get("home")).toBe(snapshot);
        expect(runtime.stats().count).toBe(1);
    });

    it("keeps numeric and string object identities distinct", () => {
        const runtime = createSpatialSnapshotRuntime();
        const snapshot = runtime.put({ ...base("ids"), selections: [{ layerId: "poi", objectIds: [1, "1", 1, "1"] }] });
        expect(snapshot.selections[0]?.objectIds).toEqual([1, "1"]);
    });

    it("rejects inverted extents", () => {
        const runtime = createSpatialSnapshotRuntime();
        expect(() => runtime.put({ ...base("bad"), extent: { xmin: 5, ymin: 0, xmax: 1, ymax: 10, wkid: 4326 } })).toThrow(/inverted/);
    });

    it("rejects invalid wkids", () => {
        const runtime = createSpatialSnapshotRuntime();
        expect(() => runtime.put({ ...base("bad"), extent: { xmin: 0, ymin: 0, xmax: 1, ymax: 1, wkid: 0 } })).toThrow(/wkid/);
    });

    it("rejects non-finite navigation state", () => {
        const runtime = createSpatialSnapshotRuntime();
        expect(() => runtime.put({ ...base("bad"), scale: Number.NaN })).toThrow(/scale/);
        expect(() => runtime.put({ ...base("bad2"), rotation: Number.POSITIVE_INFINITY })).toThrow(/rotation/);
    });

    it("rejects invalid opacity", () => {
        const runtime = createSpatialSnapshotRuntime();
        expect(() => runtime.put({
            ...base("bad"),
            layers: [{ layerId: "a", visible: true, opacity: 2, minScale: 0, maxScale: 0, revision: "1" }],
        })).toThrow(/opacity/);
    });

    it("rejects duplicate layer states", () => {
        const runtime = createSpatialSnapshotRuntime();
        const layer = { layerId: "a", visible: true, opacity: 1, minScale: 0, maxScale: 0, revision: "1" } as const;
        expect(() => runtime.put({ ...base("bad"), layers: [layer, layer] })).toThrow(/Duplicate layer/);
    });

    it("rejects duplicate selection states", () => {
        const runtime = createSpatialSnapshotRuntime();
        expect(() => runtime.put({
            ...base("bad"),
            selections: [{ layerId: "a", objectIds: [1] }, { layerId: "a", objectIds: [2] }],
        })).toThrow(/Duplicate selection/);
    });

    it("enforces layer cardinality", () => {
        const runtime = createSpatialSnapshotRuntime({ maxLayersPerSnapshot: 1 });
        expect(() => runtime.put({
            ...base("bad"),
            layers: [
                { layerId: "a", visible: true, opacity: 1, minScale: 0, maxScale: 0, revision: "1" },
                { layerId: "b", visible: true, opacity: 1, minScale: 0, maxScale: 0, revision: "1" },
            ],
        })).toThrow(/layer budget/);
    });

    it("enforces selection cardinality", () => {
        const runtime = createSpatialSnapshotRuntime({ maxSelectionsPerSnapshot: 1 });
        expect(() => runtime.put({
            ...base("bad"),
            selections: [{ layerId: "a", objectIds: [] }, { layerId: "b", objectIds: [] }],
        })).toThrow(/selection budget/);
    });

    it("enforces object-id cardinality", () => {
        const runtime = createSpatialSnapshotRuntime({ maxObjectIdsPerSelection: 2 });
        expect(() => runtime.put({ ...base("bad"), selections: [{ layerId: "a", objectIds: [1, 2, 3] }] })).toThrow(/object-id budget/);
    });

    it("replaces an existing id without growing count", () => {
        let time = 1;
        const runtime = createSpatialSnapshotRuntime({}, () => time);
        runtime.put(base("a"));
        time = 2;
        const second = runtime.put({ ...base("a"), mode: "3d" });
        expect(runtime.stats()).toMatchObject({ count: 1, inserted: 1, replaced: 1 });
        expect(runtime.get("a")?.mode).toBe("3d");
        expect(second.createdAt).toBe(2);
    });

    it("evicts least recently used snapshots deterministically", () => {
        let time = 1;
        const runtime = createSpatialSnapshotRuntime({ maxSnapshots: 2 }, () => time);
        runtime.put(base("a"));
        time = 2;
        runtime.put(base("b"));
        time = 3;
        expect(runtime.get("a")?.id).toBe("a");
        time = 4;
        runtime.put(base("c"));
        expect(runtime.get("a")?.id).toBe("a");
        expect(runtime.get("b")).toBeNull();
        expect(runtime.get("c")?.id).toBe("c");
        expect(runtime.stats().evicted).toBe(1);
    });

    it("expires stale snapshots on read", () => {
        let time = 0;
        const runtime = createSpatialSnapshotRuntime({ maxAgeMs: 10 }, () => time);
        runtime.put(base("a"));
        time = 10;
        expect(runtime.get("a")).toBeNull();
        expect(runtime.stats()).toMatchObject({ count: 0, expired: 1 });
    });

    it("prunes all expired snapshots", () => {
        let time = 0;
        const runtime = createSpatialSnapshotRuntime({ maxAgeMs: 10 }, () => time);
        runtime.put(base("a"));
        time = 5;
        runtime.put(base("b"));
        time = 11;
        expect(runtime.pruneExpired()).toBe(1);
        expect(runtime.list().map((snapshot) => snapshot.id)).toEqual(["b"]);
    });

    it("removes snapshots and accounts bytes", () => {
        const runtime = createSpatialSnapshotRuntime();
        runtime.put(base("a"));
        expect(runtime.stats().estimatedBytes).toBeGreaterThan(0);
        expect(runtime.remove("a")).toBe(true);
        expect(runtime.remove("a")).toBe(false);
        expect(runtime.stats().estimatedBytes).toBe(0);
    });

    it("clears all retained state", () => {
        const runtime = createSpatialSnapshotRuntime();
        runtime.put(base("a"));
        runtime.put(base("b"));
        runtime.clear();
        expect(runtime.list()).toEqual([]);
        expect(runtime.stats().estimatedBytes).toBe(0);
    });

    it("rejects a single snapshot larger than byte budget", () => {
        const runtime = createSpatialSnapshotRuntime({ maxEstimatedBytes: 200 });
        expect(() => runtime.put({
            ...base("large"),
            selections: [{ layerId: "poi", objectIds: ["x".repeat(100)] }],
        })).toThrow(/byte budget/);
    });

    it("evicts older snapshots to honor aggregate byte budget", () => {
        let time = 0;
        const runtime = createSpatialSnapshotRuntime({ maxEstimatedBytes: 500 }, () => time);
        runtime.put(base("a"));
        time = 1;
        runtime.put(base("b"));
        time = 2;
        runtime.put(base("c"));
        expect(runtime.stats().estimatedBytes).toBeLessThanOrEqual(500);
        expect(runtime.stats().evicted).toBeGreaterThanOrEqual(1);
    });

    it("validates configuration eagerly", () => {
        expect(() => createSpatialSnapshotRuntime({ maxSnapshots: 0 })).toThrow(/maxSnapshots/);
        expect(() => createSpatialSnapshotRuntime({ maxEstimatedBytes: Number.POSITIVE_INFINITY })).toThrow(/maxEstimatedBytes/);
    });

    it("rejects unsafe numeric object ids", () => {
        const runtime = createSpatialSnapshotRuntime();
        expect(() => runtime.put({ ...base("bad"), selections: [{ layerId: "a", objectIds: [Number.MAX_VALUE] }] })).toThrow(/safe integers/);
    });

    it("does not expose mutable list storage", () => {
        const runtime = createSpatialSnapshotRuntime();
        runtime.put(base("a"));
        const first = runtime.list();
        runtime.put(base("b"));
        expect(first.map((snapshot) => snapshot.id)).toEqual(["a"]);
        expect(runtime.list().map((snapshot) => snapshot.id)).toEqual(["a", "b"]);
    });
});
