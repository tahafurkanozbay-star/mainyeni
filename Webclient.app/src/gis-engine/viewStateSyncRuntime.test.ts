import { describe, expect, it, vi } from "vitest";
import { createViewStateSyncRuntime } from "./viewStateSyncRuntime";
import type { ViewState } from "./viewStateContract";

const state2d = (x = 10, rotation = 20): ViewState => ({
  mode: "2d",
  center: { x, y: 30, spatialReference: { wkid: 3857 } },
  scale: 5_000,
  rotation,
});
const state3d = (x = 10, heading = 20, tilt = 35): ViewState => ({
  mode: "3d",
  center: { x, y: 30, z: 50, spatialReference: { wkid: 3857 } },
  scale: 5_000,
  heading,
  tilt,
});

describe("viewStateSyncRuntime", () => {
  it("converts a 2d navigation update into a bounded 3d target", () => {
    const runtime = createViewStateSyncRuntime();
    const update = runtime.publish("2d", state2d());
    expect(update?.target).toBe("3d");
    expect(update?.state.mode).toBe("3d");
    expect(update?.state.mode === "3d" ? update.state.heading : -1).toBe(20);
    expect(runtime.snapshot().pending).toHaveLength(1);
  });

  it("converts 3d heading back to 2d rotation", () => {
    const runtime = createViewStateSyncRuntime();
    const update = runtime.publish("3d", state3d());
    expect(update?.target).toBe("2d");
    expect(update?.state.mode).toBe("2d");
    expect(update?.state.mode === "2d" ? update.state.rotation : -1).toBe(20);
  });

  it("rejects invalid non-finite view states", () => {
    const runtime = createViewStateSyncRuntime();
    const update = runtime.publish("2d", state2d(Number.NaN));
    expect(update).toBeNull();
    expect(runtime.metrics().rejected).toBe(1);
  });

  it("normalizes Web Mercator aliases through the shared state contract", () => {
    const runtime = createViewStateSyncRuntime();
    const update = runtime.publish("2d", {
      mode: "2d",
      center: { x: 1, y: 2, spatialReference: { wkid: 102100 } },
      scale: 1000,
      rotation: 0,
    });
    expect(update?.state.center.spatialReference?.wkid).toBe(3857);
  });

  it("deduplicates a target that is already equivalent", () => {
    const runtime = createViewStateSyncRuntime({ initialState: state3d(10, 20, 0) });
    const update = runtime.publish("2d", state2d(10, 20));
    expect(update).toBeNull();
    expect(runtime.metrics().deduplicated).toBe(1);
  });

  it("keeps only a bounded number of pending updates", () => {
    let clock = 0;
    const runtime = createViewStateSyncRuntime({
      syncPolicy: { equivalenceTolerance: 0, maxPendingUpdates: 2, maxObservers: 4, maxRecentTransactions: 4, transactionTtlMs: 1000 },
      now: () => ++clock,
    });
    runtime.publish("2d", state2d(1));
    runtime.publish("2d", state2d(2));
    runtime.publish("2d", state2d(3));
    expect(runtime.snapshot().pending.map((item) => item.state.center.x)).toEqual([2, 3]);
    expect(runtime.metrics().evicted).toBe(1);
  });

  it("marks acknowledgements for evicted transactions as stale", () => {
    let clock = 10;
    const runtime = createViewStateSyncRuntime({
      syncPolicy: { equivalenceTolerance: 0, maxPendingUpdates: 1, maxObservers: 4, maxRecentTransactions: 4, transactionTtlMs: 1000 },
      now: () => clock,
    });
    const first = runtime.publish("2d", state2d(1));
    runtime.publish("2d", state2d(2));
    expect(runtime.acknowledge(first!.transactionId)).toBe(false);
    expect(runtime.metrics().staleAcks).toBe(1);
  });

  it("expires stale transaction evidence", () => {
    let clock = 10;
    const runtime = createViewStateSyncRuntime({
      syncPolicy: { equivalenceTolerance: 0, maxPendingUpdates: 1, maxObservers: 4, maxRecentTransactions: 4, transactionTtlMs: 100 },
      now: () => clock,
    });
    const first = runtime.publish("2d", state2d(1));
    runtime.publish("2d", state2d(2));
    clock = 1000;
    expect(runtime.acknowledge(first!.transactionId)).toBe(false);
    expect(runtime.metrics().staleAcks).toBe(0);
    expect(runtime.metrics().rejected).toBe(1);
  });

  it("applies an acknowledgement and removes it from the pending queue", () => {
    const runtime = createViewStateSyncRuntime();
    const update = runtime.publish("2d", state2d());
    expect(runtime.acknowledge(update!.transactionId)).toBe(true);
    expect(runtime.snapshot().pending).toHaveLength(0);
    expect(runtime.snapshot().state3d?.mode).toBe("3d");
    expect(runtime.metrics().applied).toBe(1);
  });

  it("accepts a canonical target state supplied by the view acknowledgement", () => {
    const runtime = createViewStateSyncRuntime();
    const update = runtime.publish("2d", state2d());
    expect(runtime.acknowledge(update!.transactionId, state3d(11, 21, 40))).toBe(true);
    expect(runtime.snapshot().state3d?.center.x).toBe(11);
  });

  it("rejects acknowledgement state with the wrong target mode without consuming the transaction", () => {
    const runtime = createViewStateSyncRuntime();
    const update = runtime.publish("2d", state2d());
    expect(runtime.acknowledge(update!.transactionId, state2d())).toBe(false);
    expect(runtime.snapshot().pending).toHaveLength(1);
  });

  it("rejects malformed transaction identifiers", () => {
    const runtime = createViewStateSyncRuntime();
    expect(runtime.acknowledge(0)).toBe(false);
    expect(runtime.acknowledge(Number.NaN)).toBe(false);
    expect(runtime.metrics().rejected).toBe(2);
  });

  it("transitions from active 2d state to 3d while preserving camera intent", () => {
    const runtime = createViewStateSyncRuntime({ initialState: state2d(5, 45) });
    const update = runtime.transition("3d");
    expect(update?.reason).toBe("mode-transition");
    expect(update?.target).toBe("3d");
    expect(runtime.snapshot().activeMode).toBe("3d");
    expect(runtime.metrics().modeTransitions).toBe(1);
  });

  it("does not create duplicate transitions to the active mode", () => {
    const runtime = createViewStateSyncRuntime({ initialState: state2d() });
    expect(runtime.transition("2d")).toBeNull();
    expect(runtime.metrics().deduplicated).toBe(1);
  });

  it("rejects a mode transition when there is no source state", () => {
    const runtime = createViewStateSyncRuntime();
    expect(runtime.transition("3d")).toBeNull();
    expect(runtime.metrics().rejected).toBe(1);
  });

  it("isolates observer failures from synchronization outcomes", () => {
    const runtime = createViewStateSyncRuntime();
    const healthy = vi.fn();
    runtime.subscribe(() => { throw new Error("observer failure"); });
    runtime.subscribe(healthy);
    const update = runtime.publish("2d", state2d());
    expect(update).not.toBeNull();
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(runtime.metrics().observerErrors).toBe(1);
  });

  it("bounds observer subscriptions", () => {
    const runtime = createViewStateSyncRuntime({
      syncPolicy: { equivalenceTolerance: 0, maxPendingUpdates: 2, maxObservers: 1, maxRecentTransactions: 2, transactionTtlMs: 1000 },
    });
    const first = vi.fn();
    const second = vi.fn();
    runtime.subscribe(first);
    runtime.subscribe(second);
    runtime.publish("2d", state2d());
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    expect(runtime.metrics().rejected).toBe(1);
  });

  it("supports deterministic unsubscribe", () => {
    const runtime = createViewStateSyncRuntime();
    const observer = vi.fn();
    const unsubscribe = runtime.subscribe(observer);
    unsubscribe();
    unsubscribe();
    runtime.publish("2d", state2d());
    expect(observer).not.toHaveBeenCalled();
  });

  it("clears resources and rejects work after disposal", () => {
    const runtime = createViewStateSyncRuntime({ initialState: state2d() });
    runtime.publish("2d", state2d(11));
    runtime.dispose();
    expect(runtime.snapshot().disposed).toBe(true);
    expect(runtime.snapshot().pending).toHaveLength(0);
    expect(runtime.snapshot().state2d).toBeNull();
    expect(runtime.publish("2d", state2d())).toBeNull();
  });

  it("validates synchronization policy bounds", () => {
    expect(() => createViewStateSyncRuntime({
      syncPolicy: { equivalenceTolerance: 0, maxPendingUpdates: 0, maxObservers: 1, maxRecentTransactions: 1, transactionTtlMs: 100 },
    })).toThrow(/maxPendingUpdates/);
    expect(() => createViewStateSyncRuntime({
      syncPolicy: { equivalenceTolerance: 0, maxPendingUpdates: 1, maxObservers: 0, maxRecentTransactions: 1, transactionTtlMs: 100 },
    })).toThrow(/maxObservers/);
    expect(() => createViewStateSyncRuntime({
      syncPolicy: { equivalenceTolerance: -1, maxPendingUpdates: 1, maxObservers: 1, maxRecentTransactions: 1, transactionTtlMs: 100 },
    })).toThrow(/equivalenceTolerance/);
  });

  it("fails closed for an invalid initial state", () => {
    expect(() => createViewStateSyncRuntime({ initialState: state2d(Number.POSITIVE_INFINITY) })).toThrow(/initial view state/);
  });
});
