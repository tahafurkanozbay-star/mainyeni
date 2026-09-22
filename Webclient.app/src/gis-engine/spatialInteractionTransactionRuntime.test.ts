import { describe, expect, it, vi } from "vitest";
import {
  createSpatialInteractionTransactionRuntime,
  DEFAULT_INTERACTION_POLICY,
  type InteractionRequest,
} from "./spatialInteractionTransactionRuntime";

const request = (id: string, overrides: Partial<InteractionRequest> = {}): InteractionRequest => ({
  id,
  mode: "identify",
  view: "2d",
  point: { x: 32.8, y: 39.9, wkid: 4326 },
  layerIds: ["parcels"],
  createdAt: 100,
  ...overrides,
});

describe("spatial interaction transaction runtime", () => {
  it("accepts a bounded request and exposes immutable canonical state", () => {
    const runtime = createSpatialInteractionTransactionRuntime();
    expect(runtime.enqueue(request("a"), 100)).toBe(true);
    const item = runtime.get("a");
    expect(item).toMatchObject({ id: "a", state: "queued", priority: "normal", tolerancePx: 8 });
    expect(item?.point).toEqual({ x: 32.8, y: 39.9, wkid: 4326 });
    expect(runtime.metrics().accepted).toBe(1);
  });

  it("normalizes legacy Web Mercator aliases", () => {
    const runtime = createSpatialInteractionTransactionRuntime();
    runtime.enqueue(request("wm", { point: { x: 1, y: 2, wkid: 102100 } }), 100);
    expect(runtime.get("wm")?.point.wkid).toBe(3857);
  });

  it("rejects non-finite coordinates", () => {
    const runtime = createSpatialInteractionTransactionRuntime();
    expect(runtime.enqueue(request("bad", { point: { x: Number.NaN, y: 2, wkid: 4326 } }), 100)).toBe(false);
    expect(runtime.metrics().rejected).toBe(1);
  });

  it("rejects non-finite elevation", () => {
    const runtime = createSpatialInteractionTransactionRuntime();
    expect(runtime.enqueue(request("bad-z", { point: { x: 1, y: 2, z: Infinity, wkid: 4326 } }), 100)).toBe(false);
  });

  it("rejects invalid spatial references", () => {
    const runtime = createSpatialInteractionTransactionRuntime();
    expect(runtime.enqueue(request("bad-wkid", { point: { x: 1, y: 2, wkid: 0 } }), 100)).toBe(false);
  });

  it("deduplicates layer ids without changing first-seen order", () => {
    const runtime = createSpatialInteractionTransactionRuntime();
    runtime.enqueue(request("layers", { layerIds: ["a", "b", "a", "c", "b"] }), 100);
    expect(runtime.get("layers")?.layerIds).toEqual(["a", "b", "c"]);
  });

  it("rejects empty layer sets", () => {
    const runtime = createSpatialInteractionTransactionRuntime();
    expect(runtime.enqueue(request("empty", { layerIds: [] }), 100)).toBe(false);
  });

  it("rejects requests over the layer fanout budget", () => {
    const runtime = createSpatialInteractionTransactionRuntime({ maxLayersPerRequest: 2 });
    expect(runtime.enqueue(request("fanout", { layerIds: ["a", "b", "c"] }), 100)).toBe(false);
  });

  it("rejects stale requests", () => {
    const runtime = createSpatialInteractionTransactionRuntime({ staleRequestMs: 50 });
    expect(runtime.enqueue(request("stale", { createdAt: 10 }), 100)).toBe(false);
  });

  it("rejects future-dated requests", () => {
    const runtime = createSpatialInteractionTransactionRuntime();
    expect(runtime.enqueue(request("future", { createdAt: 101 }), 100)).toBe(false);
  });

  it("rejects duplicate transaction ids", () => {
    const runtime = createSpatialInteractionTransactionRuntime();
    expect(runtime.enqueue(request("same"), 100)).toBe(true);
    expect(runtime.enqueue(request("same"), 100)).toBe(false);
    expect(runtime.metrics().deduplicated).toBe(1);
  });

  it("enforces minimum hit tolerance", () => {
    const runtime = createSpatialInteractionTransactionRuntime({ minTolerancePx: 2 });
    expect(runtime.enqueue(request("small", { tolerancePx: 1 }), 100)).toBe(false);
  });

  it("enforces maximum hit tolerance", () => {
    const runtime = createSpatialInteractionTransactionRuntime({ maxTolerancePx: 12 });
    expect(runtime.enqueue(request("large", { tolerancePx: 13 }), 100)).toBe(false);
  });

  it("starts highest priority request first", () => {
    const runtime = createSpatialInteractionTransactionRuntime();
    runtime.enqueue(request("normal", { priority: "normal" }), 100);
    runtime.enqueue(request("critical", { priority: "critical" }), 100);
    runtime.enqueue(request("important", { priority: "important" }), 100);
    expect(runtime.startNext(101)?.id).toBe("critical");
    expect(runtime.startNext(101)?.id).toBe("important");
    expect(runtime.startNext(101)?.id).toBe("normal");
  });

  it("uses creation order for equal-priority scheduling", () => {
    const runtime = createSpatialInteractionTransactionRuntime();
    runtime.enqueue(request("later", { createdAt: 100 }), 100);
    runtime.enqueue(request("earlier", { createdAt: 90 }), 100);
    expect(runtime.startNext(101)?.id).toBe("earlier");
  });

  it("uses insertion order as final scheduling tie breaker", () => {
    const runtime = createSpatialInteractionTransactionRuntime();
    runtime.enqueue(request("first"), 100);
    runtime.enqueue(request("second"), 100);
    expect(runtime.startNext(101)?.id).toBe("first");
  });

  it("bounds running concurrency", () => {
    const runtime = createSpatialInteractionTransactionRuntime({ maxRunning: 1 });
    runtime.enqueue(request("one"), 100);
    runtime.enqueue(request("two"), 100);
    expect(runtime.startNext(101)?.id).toBe("one");
    expect(runtime.startNext(101)).toBeNull();
  });

  it("allows another transaction after completion releases a running slot", () => {
    const runtime = createSpatialInteractionTransactionRuntime({ maxRunning: 1 });
    runtime.enqueue(request("one"), 100);
    runtime.enqueue(request("two"), 100);
    runtime.startNext(101);
    runtime.complete("one", [], 102);
    expect(runtime.startNext(103)?.id).toBe("two");
  });

  it("evicts lower priority queued work when queue is full", () => {
    const runtime = createSpatialInteractionTransactionRuntime({ maxQueued: 2 });
    runtime.enqueue(request("background", { priority: "background" }), 100);
    runtime.enqueue(request("normal", { priority: "normal" }), 100);
    expect(runtime.enqueue(request("critical", { priority: "critical" }), 100)).toBe(true);
    expect(runtime.get("background")).toBeNull();
    expect(runtime.metrics().evicted).toBe(1);
  });

  it("does not evict equal priority queued work", () => {
    const runtime = createSpatialInteractionTransactionRuntime({ maxQueued: 1 });
    runtime.enqueue(request("first", { priority: "normal" }), 100);
    expect(runtime.enqueue(request("second", { priority: "normal" }), 100)).toBe(false);
    expect(runtime.get("first")).not.toBeNull();
  });

  it("does not let background work evict important work", () => {
    const runtime = createSpatialInteractionTransactionRuntime({ maxQueued: 1 });
    runtime.enqueue(request("important", { priority: "important" }), 100);
    expect(runtime.enqueue(request("background", { priority: "background" }), 100)).toBe(false);
  });

  it("completes running work with bounded results", () => {
    const runtime = createSpatialInteractionTransactionRuntime({ maxResultsPerRequest: 2 });
    runtime.enqueue(request("a"), 100);
    runtime.startNext(101);
    expect(runtime.complete("a", [
      { layerId: "parcels", objectId: 1, distance: 0 },
      { layerId: "roads", objectId: "r-1", distance: 4.5 },
    ], 102)).toBe(true);
    expect(runtime.get("a")).toMatchObject({ state: "completed", resultCount: 2, completedAt: 102 });
  });

  it("rejects result sets above the budget without completing work", () => {
    const runtime = createSpatialInteractionTransactionRuntime({ maxResultsPerRequest: 1 });
    runtime.enqueue(request("a"), 100);
    runtime.startNext(101);
    expect(runtime.complete("a", [{ layerId: "a", objectId: 1 }, { layerId: "a", objectId: 2 }], 102)).toBe(false);
    expect(runtime.get("a")?.state).toBe("running");
  });

  it("deduplicates repeated result identities", () => {
    const runtime = createSpatialInteractionTransactionRuntime();
    runtime.enqueue(request("a"), 100);
    runtime.startNext(101);
    runtime.complete("a", [{ layerId: "a", objectId: 1 }, { layerId: "a", objectId: 1 }], 102);
    expect(runtime.get("a")?.resultCount).toBe(1);
  });

  it("keeps numeric and string object ids distinct", () => {
    const runtime = createSpatialInteractionTransactionRuntime();
    runtime.enqueue(request("a"), 100);
    runtime.startNext(101);
    runtime.complete("a", [{ layerId: "a", objectId: 1 }, { layerId: "a", objectId: "1" }], 102);
    expect(runtime.get("a")?.resultCount).toBe(2);
  });

  it("rejects negative result distances", () => {
    const runtime = createSpatialInteractionTransactionRuntime();
    runtime.enqueue(request("a"), 100);
    runtime.startNext(101);
    expect(runtime.complete("a", [{ layerId: "a", objectId: 1, distance: -1 }], 102)).toBe(false);
  });

  it("rejects unsafe numeric object ids", () => {
    const runtime = createSpatialInteractionTransactionRuntime();
    runtime.enqueue(request("a"), 100);
    runtime.startNext(101);
    expect(runtime.complete("a", [{ layerId: "a", objectId: Number.MAX_VALUE }], 102)).toBe(false);
  });

  it("fails running work with a bounded reason", () => {
    const runtime = createSpatialInteractionTransactionRuntime();
    runtime.enqueue(request("a"), 100);
    runtime.startNext(101);
    expect(runtime.fail("a", "service unavailable", 102)).toBe(true);
    expect(runtime.get("a")).toMatchObject({ state: "failed", failure: "service unavailable" });
  });

  it("does not fail queued work", () => {
    const runtime = createSpatialInteractionTransactionRuntime();
    runtime.enqueue(request("a"), 100);
    expect(runtime.fail("a", "bad", 101)).toBe(false);
  });

  it("cancels queued work", () => {
    const runtime = createSpatialInteractionTransactionRuntime();
    runtime.enqueue(request("a"), 100);
    expect(runtime.cancel("a", "superseded", 101)).toBe(true);
    expect(runtime.get("a")).toMatchObject({ state: "cancelled", failure: "superseded" });
  });

  it("cancels running work", () => {
    const runtime = createSpatialInteractionTransactionRuntime();
    runtime.enqueue(request("a"), 100);
    runtime.startNext(101);
    expect(runtime.cancel("a", "view changed", 102)).toBe(true);
  });

  it("does not cancel terminal work twice", () => {
    const runtime = createSpatialInteractionTransactionRuntime();
    runtime.enqueue(request("a"), 100);
    runtime.cancel("a", "done", 101);
    expect(runtime.cancel("a", "again", 102)).toBe(false);
  });

  it("times out running interactions deterministically", () => {
    const runtime = createSpatialInteractionTransactionRuntime({ timeoutMs: 10 });
    runtime.enqueue(request("a"), 100);
    runtime.startNext(101);
    expect(runtime.sweep(110)).toEqual([]);
    expect(runtime.sweep(111)).toEqual(["a"]);
    expect(runtime.get("a")).toMatchObject({ state: "failed", failure: "timeout" });
    expect(runtime.metrics().timedOut).toBe(1);
  });

  it("never times out queued interactions as running work", () => {
    const runtime = createSpatialInteractionTransactionRuntime({ timeoutMs: 1 });
    runtime.enqueue(request("a"), 100);
    expect(runtime.sweep(1000)).toEqual([]);
    expect(runtime.get("a")?.state).toBe("queued");
  });

  it("skips stale queued work when scheduling", () => {
    const runtime = createSpatialInteractionTransactionRuntime({ staleRequestMs: 10 });
    runtime.enqueue(request("old", { createdAt: 100 }), 100);
    runtime.enqueue(request("fresh", { createdAt: 105 }), 105);
    expect(runtime.startNext(111)?.id).toBe("fresh");
    expect(runtime.get("old")?.state).toBe("cancelled");
  });

  it("emits lifecycle events in order", () => {
    const runtime = createSpatialInteractionTransactionRuntime();
    runtime.enqueue(request("a"), 100);
    runtime.startNext(101);
    runtime.complete("a", [], 102);
    expect(runtime.events().map((event) => event.type)).toEqual(["queued", "started", "completed"]);
  });

  it("bounds retained event history", () => {
    const runtime = createSpatialInteractionTransactionRuntime({ maxEvents: 2 });
    runtime.enqueue(request("a"), 100);
    runtime.startNext(101);
    runtime.complete("a", [], 102);
    expect(runtime.events()).toHaveLength(2);
    expect(runtime.events().map((event) => event.type)).toEqual(["started", "completed"]);
  });

  it("notifies subscribers with request snapshots", () => {
    const runtime = createSpatialInteractionTransactionRuntime();
    const listener = vi.fn();
    runtime.subscribe(listener);
    runtime.enqueue(request("a"), 100);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[1]).toMatchObject({ id: "a", state: "queued" });
  });

  it("isolates listener failures", () => {
    const runtime = createSpatialInteractionTransactionRuntime();
    runtime.subscribe(() => { throw new Error("listener failure"); });
    expect(runtime.enqueue(request("a"), 100)).toBe(true);
    expect(runtime.metrics().listenerErrors).toBe(1);
  });

  it("supports deterministic unsubscribe", () => {
    const runtime = createSpatialInteractionTransactionRuntime();
    const listener = vi.fn();
    const unsubscribe = runtime.subscribe(listener);
    unsubscribe();
    unsubscribe();
    runtime.enqueue(request("a"), 100);
    expect(listener).not.toHaveBeenCalled();
  });

  it("bounds subscriber count", () => {
    const runtime = createSpatialInteractionTransactionRuntime({ maxListeners: 1 });
    const first = vi.fn();
    const second = vi.fn();
    runtime.subscribe(first);
    runtime.subscribe(second);
    runtime.enqueue(request("a"), 100);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it("returns defensive snapshots", () => {
    const runtime = createSpatialInteractionTransactionRuntime();
    runtime.enqueue(request("a"), 100);
    const snapshot = runtime.snapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]).not.toBe(runtime.get("a"));
  });

  it("keeps completed work in deterministic sequence order", () => {
    const runtime = createSpatialInteractionTransactionRuntime({ maxRunning: 2 });
    runtime.enqueue(request("a"), 100);
    runtime.enqueue(request("b"), 100);
    runtime.startNext(101);
    runtime.startNext(101);
    runtime.complete("b", [], 102);
    runtime.complete("a", [], 103);
    expect(runtime.snapshot().map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("disposes active work and rejects new work", () => {
    const runtime = createSpatialInteractionTransactionRuntime();
    runtime.enqueue(request("queued"), 100);
    runtime.enqueue(request("running"), 100);
    runtime.startNext(101);
    runtime.dispose(102);
    expect(runtime.get("queued")?.state).toBe("cancelled");
    expect(runtime.get("running")?.state).toBe("cancelled");
    expect(runtime.enqueue(request("new"), 103)).toBe(false);
  });

  it("disposal is idempotent", () => {
    const runtime = createSpatialInteractionTransactionRuntime();
    runtime.dispose(100);
    runtime.dispose(101);
    expect(runtime.events().filter((event) => event.type === "disposed")).toHaveLength(1);
  });

  it("rejects malformed policies", () => {
    expect(() => createSpatialInteractionTransactionRuntime({ maxQueued: 0 })).toThrow();
    expect(() => createSpatialInteractionTransactionRuntime({ maxRunning: 0 })).toThrow();
    expect(() => createSpatialInteractionTransactionRuntime({ timeoutMs: 0 })).toThrow();
    expect(() => createSpatialInteractionTransactionRuntime({ minTolerancePx: 10, maxTolerancePx: 5 })).toThrow();
  });

  it("uses conservative production defaults", () => {
    expect(DEFAULT_INTERACTION_POLICY.maxQueued).toBeLessThanOrEqual(64);
    expect(DEFAULT_INTERACTION_POLICY.maxRunning).toBeLessThanOrEqual(8);
    expect(DEFAULT_INTERACTION_POLICY.maxResultsPerRequest).toBeLessThanOrEqual(1000);
    expect(DEFAULT_INTERACTION_POLICY.timeoutMs).toBeLessThanOrEqual(30_000);
  });
});
