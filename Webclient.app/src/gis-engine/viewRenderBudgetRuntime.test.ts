import { describe, expect, it, vi } from "vitest";
import {
  createRenderBudgetRuntime,
  DEFAULT_RENDER_BUDGET_POLICY,
  type RenderBudgetPolicy,
  type RenderResourceRequest,
} from "./viewRenderBudgetRuntime";

const policy = (overrides: Partial<RenderBudgetPolicy> = {}): RenderBudgetPolicy => ({
  ...DEFAULT_RENDER_BUDGET_POLICY,
  maxResources: 3,
  maxCpuBytes: 100,
  maxGpuBytes: 100,
  maxDrawCalls2d: 10,
  maxDrawCalls3d: 10,
  maxVisibleFeatures2d: 100,
  maxVisibleFeatures3d: 100,
  maxPendingAdmissions: 4,
  maxObservers: 2,
  maxEvents: 5,
  pressureWindow: 3,
  recoverySamples: 2,
  idleTtlMs: 100,
  ...overrides,
});

const resource = (id: string, overrides: Partial<RenderResourceRequest> = {}): RenderResourceRequest => ({
  id,
  kind: "feature",
  mode: "2d",
  cpuBytes: 10,
  gpuBytes: 10,
  drawCalls: 1,
  visibleFeatures: 10,
  ...overrides,
});

describe("viewRenderBudgetRuntime", () => {
  it("admits resources and accounts 2d usage", () => {
    const runtime = createRenderBudgetRuntime(policy());
    const result = runtime.admit(resource("roads"), 10);
    expect(result.admitted).toBe(true);
    expect(result.evicted).toEqual([]);
    expect(runtime.snapshot().usage).toEqual({
      resources: 1,
      cpuBytes: 10,
      gpuBytes: 10,
      drawCalls2d: 1,
      drawCalls3d: 0,
      visibleFeatures2d: 10,
      visibleFeatures3d: 0,
    });
    expect(runtime.metrics().admissions).toBe(1);
  });

  it("accounts shared resources against both rendering modes", () => {
    const runtime = createRenderBudgetRuntime(policy());
    runtime.admit(resource("shared", { mode: "shared", drawCalls: 3, visibleFeatures: 12 }), 1);
    expect(runtime.snapshot().usage.drawCalls2d).toBe(3);
    expect(runtime.snapshot().usage.drawCalls3d).toBe(3);
    expect(runtime.snapshot().usage.visibleFeatures2d).toBe(12);
    expect(runtime.snapshot().usage.visibleFeatures3d).toBe(12);
  });

  it("rejects malformed and duplicate requests fail closed", () => {
    const runtime = createRenderBudgetRuntime(policy());
    expect(runtime.admit(resource(""), 1)).toMatchObject({ admitted: false, reason: "invalid" });
    expect(runtime.admit(resource("x", { cpuBytes: -1 }), 1)).toMatchObject({ admitted: false, reason: "invalid" });
    expect(runtime.admit(resource("x", { gpuBytes: Number.NaN }), 1)).toMatchObject({ admitted: false, reason: "invalid" });
    expect(runtime.admit(resource("x", { drawCalls: 1.5 }), 1)).toMatchObject({ admitted: false, reason: "invalid" });
    expect(runtime.admit(resource("x"), 1).admitted).toBe(true);
    expect(runtime.admit(resource("x"), 2)).toMatchObject({ admitted: false, reason: "duplicate" });
    expect(runtime.metrics().rejections).toBe(5);
  });

  it("rejects a single resource that cannot fit any budget", () => {
    const runtime = createRenderBudgetRuntime(policy());
    const result = runtime.admit(resource("huge", { cpuBytes: 101 }), 1);
    expect(result).toMatchObject({ admitted: false, reason: "budget", evicted: [] });
    expect(runtime.snapshot().usage.resources).toBe(0);
    expect(runtime.events().at(-1)).toMatchObject({ type: "rejected", resourceId: "huge", detail: "budget" });
  });

  it("evicts lower priority resources to admit higher priority work", () => {
    const runtime = createRenderBudgetRuntime(policy({ maxResources: 2 }));
    runtime.admit(resource("background", { priority: "background" }), 1);
    runtime.admit(resource("normal", { priority: "normal" }), 2);
    const result = runtime.admit(resource("critical", { priority: "critical" }), 3);
    expect(result.admitted).toBe(true);
    expect(result.evicted).toEqual(["background"]);
    expect(runtime.snapshot().resources.map((item) => item.id)).toEqual(["normal", "critical"]);
    expect(runtime.metrics().evictions).toBe(1);
  });

  it("does not evict higher priority work for lower priority admission", () => {
    const runtime = createRenderBudgetRuntime(policy({ maxResources: 1 }));
    runtime.admit(resource("critical", { priority: "critical" }), 1);
    const result = runtime.admit(resource("background", { priority: "background" }), 2);
    expect(result).toMatchObject({ admitted: false, reason: "budget" });
    expect(runtime.snapshot().resources.map((item) => item.id)).toEqual(["critical"]);
  });

  it("never evicts pinned resources", () => {
    const runtime = createRenderBudgetRuntime(policy({ maxResources: 1 }));
    runtime.admit(resource("base", { priority: "background", pinned: true }), 1);
    const result = runtime.admit(resource("critical", { priority: "critical" }), 2);
    expect(result).toMatchObject({ admitted: false, reason: "budget" });
    expect(runtime.snapshot().resources[0]?.id).toBe("base");
  });

  it("prefers inactive-mode resources when priorities are equal", () => {
    const runtime = createRenderBudgetRuntime(policy({ maxResources: 2 }), "2d");
    runtime.admit(resource("scene", { mode: "3d" }), 1);
    runtime.admit(resource("map", { mode: "2d" }), 2);
    const result = runtime.admit(resource("next", { mode: "2d" }), 3);
    expect(result.evicted).toEqual(["scene"]);
  });

  it("uses least recently touched resource as deterministic eviction tie-breaker", () => {
    const runtime = createRenderBudgetRuntime(policy({ maxResources: 2 }));
    runtime.admit(resource("old"), 1);
    runtime.admit(resource("new"), 2);
    runtime.touch("old", 5);
    const result = runtime.admit(resource("incoming"), 6);
    expect(result.evicted).toEqual(["new"]);
  });

  it("release returns capacity and is idempotent for unknown ids", () => {
    const runtime = createRenderBudgetRuntime(policy({ maxResources: 1 }));
    runtime.admit(resource("a"), 1);
    expect(runtime.release("a", 2)).toBe(true);
    expect(runtime.release("a", 3)).toBe(false);
    expect(runtime.snapshot().usage.resources).toBe(0);
    expect(runtime.metrics().releases).toBe(1);
    expect(runtime.admit(resource("b"), 4).admitted).toBe(true);
  });

  it("touch never moves last-used time backwards", () => {
    const runtime = createRenderBudgetRuntime(policy());
    runtime.admit(resource("a"), 10);
    expect(runtime.touch("a", 5)).toBe(true);
    expect(runtime.snapshot().resources[0]?.lastUsedAt).toBe(10);
    expect(runtime.touch("missing", 12)).toBe(false);
  });

  it("sweeps idle resources but preserves pinned resources", () => {
    const runtime = createRenderBudgetRuntime(policy({ idleTtlMs: 100 }));
    runtime.admit(resource("idle"), 1);
    runtime.admit(resource("pinned", { pinned: true }), 1);
    runtime.admit(resource("recent"), 150);
    expect(runtime.sweepIdle(200)).toEqual(["idle"]);
    expect(runtime.snapshot().resources.map((item) => item.id)).toEqual(["pinned", "recent"]);
  });

  it("tracks mode transitions without duplicating no-op events", () => {
    const runtime = createRenderBudgetRuntime(policy(), "2d");
    runtime.setMode("2d", 1);
    runtime.setMode("3d", 2);
    runtime.setMode("3d", 3);
    expect(runtime.snapshot().mode).toBe("3d");
    expect(runtime.metrics().modeTransitions).toBe(1);
    expect(runtime.events().filter((event) => event.type === "mode")).toHaveLength(1);
  });

  it("escalates pressure immediately from p95 frame pacing", () => {
    const runtime = createRenderBudgetRuntime(policy());
    expect(runtime.sampleFrame(10, 1)).toBe("normal");
    expect(runtime.sampleFrame(24, 2)).toBe("warm");
    expect(runtime.sampleFrame(40, 3)).toBe("hot");
    expect(runtime.snapshot().qualityScale).toBe(0.65);
    expect(runtime.metrics().frameSamples).toBe(3);
  });

  it("requires sustained recovery before reducing pressure", () => {
    const runtime = createRenderBudgetRuntime(policy({ pressureWindow: 1, recoverySamples: 2 }));
    expect(runtime.sampleFrame(55, 1)).toBe("critical");
    expect(runtime.sampleFrame(10, 2)).toBe("critical");
    expect(runtime.sampleFrame(10, 3)).toBe("normal");
    expect(runtime.metrics().pressureTransitions).toBe(2);
  });

  it("maps pressure levels to deterministic quality scales", () => {
    const runtime = createRenderBudgetRuntime(policy({ pressureWindow: 1, recoverySamples: 1 }));
    runtime.sampleFrame(23, 1);
    expect(runtime.snapshot().qualityScale).toBe(0.82);
    runtime.sampleFrame(34, 2);
    expect(runtime.snapshot().qualityScale).toBe(0.65);
    runtime.sampleFrame(51, 3);
    expect(runtime.snapshot().qualityScale).toBe(0.5);
    runtime.sampleFrame(10, 4);
    expect(runtime.snapshot().qualityScale).toBe(1);
  });

  it("bounds event history", () => {
    const runtime = createRenderBudgetRuntime(policy({ maxEvents: 3, maxResources: 10 }));
    runtime.admit(resource("a"), 1);
    runtime.admit(resource("b"), 2);
    runtime.release("a", 3);
    runtime.release("b", 4);
    expect(runtime.events()).toHaveLength(3);
    expect(runtime.events().map((event) => event.at)).toEqual([2, 3, 4]);
  });

  it("notifies observers with immutable snapshots and supports unsubscribe", () => {
    const runtime = createRenderBudgetRuntime(policy());
    const observer = vi.fn();
    const unsubscribe = runtime.subscribe(observer);
    runtime.admit(resource("a"), 1);
    expect(observer).toHaveBeenCalledTimes(1);
    const snapshot = observer.mock.calls[0]?.[0];
    expect(snapshot.resources.map((item: { id: string }) => item.id)).toEqual(["a"]);
    unsubscribe();
    unsubscribe();
    runtime.release("a", 2);
    expect(observer).toHaveBeenCalledTimes(1);
  });

  it("isolates observer failures from resource lifecycle", () => {
    const runtime = createRenderBudgetRuntime(policy());
    runtime.subscribe(() => { throw new Error("observer failed"); });
    const healthy = vi.fn();
    runtime.subscribe(healthy);
    expect(runtime.admit(resource("a"), 1).admitted).toBe(true);
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(runtime.metrics().observerErrors).toBe(1);
  });

  it("enforces observer budget", () => {
    const runtime = createRenderBudgetRuntime(policy({ maxObservers: 1 }));
    const first = vi.fn();
    const second = vi.fn();
    runtime.subscribe(first);
    runtime.subscribe(second);
    runtime.admit(resource("a"), 1);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it("disposes resources and prevents subsequent mutation", () => {
    const runtime = createRenderBudgetRuntime(policy());
    const observer = vi.fn();
    runtime.subscribe(observer);
    runtime.admit(resource("a"), 1);
    runtime.dispose(2);
    runtime.dispose(3);
    expect(runtime.snapshot()).toMatchObject({ disposed: true, pendingAdmissions: 0 });
    expect(runtime.snapshot().resources).toEqual([]);
    expect(runtime.snapshot().usage.resources).toBe(0);
    expect(runtime.admit(resource("b"), 4)).toMatchObject({ admitted: false, reason: "disposed" });
    expect(runtime.release("a", 4)).toBe(false);
    expect(runtime.touch("a", 4)).toBe(false);
    expect(runtime.sweepIdle(4)).toEqual([]);
    expect(observer.mock.calls.at(-1)?.[1]).toMatchObject({ type: "disposed", at: 2 });
  });

  it("rejects invalid policy contracts", () => {
    expect(() => createRenderBudgetRuntime(policy({ maxResources: 0 }))).toThrow("Invalid GIS render-budget policy");
    expect(() => createRenderBudgetRuntime(policy({ maxCpuBytes: -1 }))).toThrow("Invalid GIS render-budget policy");
    expect(() => createRenderBudgetRuntime(policy({ warmFrameMs: 10 }))).toThrow("Invalid GIS render-budget policy");
    expect(() => createRenderBudgetRuntime(policy({ hotFrameMs: 20, warmFrameMs: 22 }))).toThrow("Invalid GIS render-budget policy");
    expect(() => createRenderBudgetRuntime(policy({ criticalFrameMs: 20, hotFrameMs: 33 }))).toThrow("Invalid GIS render-budget policy");
    expect(() => createRenderBudgetRuntime(policy({ idleTtlMs: -1 }))).toThrow("Invalid GIS render-budget policy");
  });

  it("keeps gpu, draw-call and feature budgets independent", () => {
    const gpu = createRenderBudgetRuntime(policy({ maxGpuBytes: 5 }));
    expect(gpu.admit(resource("gpu", { gpuBytes: 6 }))).toMatchObject({ admitted: false, reason: "budget" });
    const draw = createRenderBudgetRuntime(policy({ maxDrawCalls3d: 1 }));
    expect(draw.admit(resource("draw", { mode: "3d", drawCalls: 2 }))).toMatchObject({ admitted: false, reason: "budget" });
    const features = createRenderBudgetRuntime(policy({ maxVisibleFeatures2d: 5 }));
    expect(features.admit(resource("features", { visibleFeatures: 6 }))).toMatchObject({ admitted: false, reason: "budget" });
  });

  it("does not count 3d-only work against 2d draw and feature budgets", () => {
    const runtime = createRenderBudgetRuntime(policy({ maxDrawCalls2d: 1, maxVisibleFeatures2d: 1 }));
    expect(runtime.admit(resource("scene", { mode: "3d", drawCalls: 8, visibleFeatures: 90 })).admitted).toBe(true);
    expect(runtime.snapshot().usage.drawCalls2d).toBe(0);
    expect(runtime.snapshot().usage.visibleFeatures2d).toBe(0);
  });

  it("returns defensive event and metric snapshots", () => {
    const runtime = createRenderBudgetRuntime(policy());
    runtime.admit(resource("a"), 1);
    const events = runtime.events() as Array<{ type: string }>;
    events[0]!.type = "corrupted";
    expect(runtime.events()[0]?.type).toBe("admitted");
    const metrics = runtime.metrics() as { admissions: number };
    metrics.admissions = 99;
    expect(runtime.metrics().admissions).toBe(1);
  });
});
