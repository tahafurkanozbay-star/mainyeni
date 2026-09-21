import { describe, expect, it, vi } from "vitest";
import { createLayerRenderStateRuntime, DEFAULT_LAYER_RENDER_POLICY, type LayerRenderPolicy } from "./layerRenderStateRuntime";

const policy = (overrides: Partial<LayerRenderPolicy> = {}): LayerRenderPolicy => ({
  ...DEFAULT_LAYER_RENDER_POLICY,
  maxLayers: 4,
  maxVisible2d: 2,
  maxVisible3d: 1,
  maxLoading: 1,
  maxListeners: 2,
  maxEvents: 4,
  failureBackoffMs: 100,
  maxConsecutiveFailures: 3,
  ...overrides,
});

const layer = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  title: `Layer ${id}`,
  modes: ["2d", "3d"] as const,
  ...overrides,
});

describe("layerRenderStateRuntime", () => {
  it("registers normalized visible layers", () => {
    const runtime = createLayerRenderStateRuntime(policy(), "2d", 10_000);
    expect(runtime.register(layer("roads"), 1)).toBe(true);
    expect(runtime.snapshot().visibleIds).toEqual(["roads"]);
    expect(runtime.snapshot().layers[0]).toMatchObject({ id: "roads", priority: "normal", opacity: 1, health: "idle", revision: 1 });
  });

  it("rejects duplicate, malformed, and over-budget registrations", () => {
    const runtime = createLayerRenderStateRuntime(policy({ maxLayers: 1 }));
    expect(runtime.register(layer("a"), 1)).toBe(true);
    expect(runtime.register(layer("a"), 2)).toBe(false);
    expect(runtime.register(layer("b"), 2)).toBe(false);
    const malformed = createLayerRenderStateRuntime(policy());
    expect(malformed.register(layer("", {}), 1)).toBe(false);
    expect(malformed.register(layer("x", { modes: [] }), 1)).toBe(false);
    expect(malformed.register(layer("x", { opacity: 2 }), 1)).toBe(false);
    expect(malformed.register(layer("x", { minScale: 100, maxScale: 10 }), 1)).toBe(false);
  });

  it("enforces deterministic priority visibility budget", () => {
    const runtime = createLayerRenderStateRuntime(policy({ maxVisible2d: 2 }));
    runtime.register(layer("background", { priority: "background" }), 1);
    runtime.register(layer("normal", { priority: "normal" }), 2);
    runtime.register(layer("critical", { priority: "critical" }), 3);
    expect(runtime.snapshot().visibleIds).toEqual(["normal", "critical"]);
  });

  it("uses registration order as visibility tie breaker", () => {
    const runtime = createLayerRenderStateRuntime(policy({ maxVisible2d: 1 }));
    runtime.register(layer("first"), 1);
    runtime.register(layer("second"), 2);
    expect(runtime.snapshot().visibleIds).toEqual(["first"]);
  });

  it("applies mode compatibility and mode-specific budgets", () => {
    const runtime = createLayerRenderStateRuntime(policy({ maxVisible2d: 2, maxVisible3d: 1 }), "2d");
    runtime.register(layer("map", { modes: ["2d"] }), 1);
    runtime.register(layer("scene", { modes: ["3d"] }), 2);
    runtime.register(layer("shared"), 3);
    expect(runtime.snapshot().visibleIds).toEqual(["map", "shared"]);
    runtime.setMode("3d", 4);
    expect(runtime.snapshot().visibleIds).toEqual(["scene"]);
  });

  it("filters visibility by scale range", () => {
    const runtime = createLayerRenderStateRuntime(policy(), "2d", 1000);
    runtime.register(layer("local", { minScale: 100, maxScale: 2000 }), 1);
    runtime.register(layer("regional", { minScale: 5000, maxScale: 50_000 }), 1);
    expect(runtime.snapshot().visibleIds).toEqual(["local"]);
    runtime.setScale(10_000, 2);
    expect(runtime.snapshot().visibleIds).toEqual(["regional"]);
  });

  it("clamps scale to global policy bounds", () => {
    const runtime = createLayerRenderStateRuntime(policy({ minScale: 100, maxScale: 1000 }), "2d", 10);
    expect(runtime.snapshot().scale).toBe(100);
    expect(runtime.setScale(5000, 1)).toBe(true);
    expect(runtime.snapshot().scale).toBe(1000);
    expect(runtime.setScale(0, 2)).toBe(false);
  });

  it("tracks requested and effective visibility independently", () => {
    const runtime = createLayerRenderStateRuntime(policy());
    runtime.register(layer("a"), 1);
    expect(runtime.setRequestedVisible("a", false, 2)).toBe(true);
    expect(runtime.snapshot().layers[0]).toMatchObject({ requestedVisible: false, effectiveVisible: false });
    expect(runtime.setRequestedVisible("a", true, 3)).toBe(true);
    expect(runtime.snapshot().layers[0]).toMatchObject({ requestedVisible: true, effectiveVisible: true });
  });

  it("opacity zero suppresses rendering without losing requested visibility", () => {
    const runtime = createLayerRenderStateRuntime(policy());
    runtime.register(layer("a"), 1);
    expect(runtime.setOpacity("a", 0, 2)).toBe(true);
    expect(runtime.snapshot().layers[0]).toMatchObject({ requestedVisible: true, effectiveVisible: false, opacity: 0 });
    expect(runtime.setOpacity("a", 0.5, 3)).toBe(true);
    expect(runtime.snapshot().visibleIds).toEqual(["a"]);
  });

  it("rejects invalid opacity", () => {
    const runtime = createLayerRenderStateRuntime(policy());
    runtime.register(layer("a"), 1);
    expect(runtime.setOpacity("a", -0.1, 2)).toBe(false);
    expect(runtime.setOpacity("a", 1.1, 2)).toBe(false);
    expect(runtime.setOpacity("a", Number.NaN, 2)).toBe(false);
    expect(runtime.snapshot().layers[0]?.opacity).toBe(1);
  });

  it("caps concurrent loading transitions", () => {
    const runtime = createLayerRenderStateRuntime(policy({ maxLoading: 1 }));
    runtime.register(layer("a"), 1);
    runtime.register(layer("b"), 1);
    expect(runtime.setHealth("a", "loading", 2)).toBe(true);
    expect(runtime.setHealth("b", "loading", 2)).toBe(false);
    expect(runtime.snapshot().loadingCount).toBe(1);
    expect(runtime.setHealth("a", "ready", 3)).toBe(true);
    expect(runtime.setHealth("b", "loading", 4)).toBe(true);
  });

  it("failed layers become non-visible and use exponential retry backoff", () => {
    const runtime = createLayerRenderStateRuntime(policy({ failureBackoffMs: 100, maxConsecutiveFailures: 3 }));
    runtime.register(layer("a"), 1);
    runtime.setHealth("a", "failed", 10);
    expect(runtime.snapshot().visibleIds).toEqual([]);
    expect(runtime.canRetry("a", 109)).toBe(false);
    expect(runtime.canRetry("a", 110)).toBe(true);
    runtime.setHealth("a", "loading", 111);
    runtime.setHealth("a", "failed", 120);
    expect(runtime.snapshot().layers[0]?.retryAfter).toBe(320);
  });

  it("stops retries after configured consecutive failure ceiling", () => {
    const runtime = createLayerRenderStateRuntime(policy({ maxConsecutiveFailures: 2, failureBackoffMs: 1 }));
    runtime.register(layer("a"), 1);
    runtime.setHealth("a", "failed", 2);
    runtime.setHealth("a", "loading", 4);
    runtime.setHealth("a", "failed", 5);
    expect(runtime.snapshot().layers[0]?.consecutiveFailures).toBe(2);
    expect(runtime.canRetry("a", 100)).toBe(false);
  });

  it("ready health resets failure state", () => {
    const runtime = createLayerRenderStateRuntime(policy());
    runtime.register(layer("a"), 1);
    runtime.setHealth("a", "failed", 2);
    runtime.setHealth("a", "ready", 200);
    expect(runtime.snapshot().layers[0]).toMatchObject({ health: "ready", consecutiveFailures: 0, retryAfter: 0, effectiveVisible: true });
  });

  it("remove releases layer slots and recomputes visibility", () => {
    const runtime = createLayerRenderStateRuntime(policy({ maxVisible2d: 1 }));
    runtime.register(layer("a"), 1);
    runtime.register(layer("b"), 2);
    expect(runtime.snapshot().visibleIds).toEqual(["a"]);
    expect(runtime.remove("a", 3)).toBe(true);
    expect(runtime.snapshot().visibleIds).toEqual(["b"]);
    expect(runtime.remove("missing", 4)).toBe(false);
  });

  it("bounds event history", () => {
    const runtime = createLayerRenderStateRuntime(policy({ maxEvents: 2 }));
    runtime.register(layer("a"), 1);
    runtime.setOpacity("a", 0.5, 2);
    runtime.setRequestedVisible("a", false, 3);
    expect(runtime.events()).toHaveLength(2);
    expect(runtime.events().map((event) => event.at)).toEqual([2, 3]);
  });

  it("notifies listeners and supports deterministic unsubscribe", () => {
    const runtime = createLayerRenderStateRuntime(policy());
    const listener = vi.fn();
    const unsubscribe = runtime.subscribe(listener);
    runtime.register(layer("a"), 1);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    unsubscribe();
    runtime.setOpacity("a", 0.5, 2);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("isolates listener errors", () => {
    const runtime = createLayerRenderStateRuntime(policy());
    runtime.subscribe(() => { throw new Error("boom"); });
    const healthy = vi.fn();
    runtime.subscribe(healthy);
    expect(runtime.register(layer("a"), 1)).toBe(true);
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(runtime.metrics().listenerErrors).toBe(1);
  });

  it("enforces listener budget", () => {
    const runtime = createLayerRenderStateRuntime(policy({ maxListeners: 1 }));
    const a = vi.fn();
    const b = vi.fn();
    runtime.subscribe(a);
    runtime.subscribe(b);
    runtime.register(layer("x"), 1);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
  });

  it("increments revisions for real layer mutations", () => {
    const runtime = createLayerRenderStateRuntime(policy());
    runtime.register(layer("a"), 1);
    expect(runtime.snapshot().layers[0]?.revision).toBe(1);
    runtime.setOpacity("a", 0.5, 2);
    expect(runtime.snapshot().layers[0]?.revision).toBe(2);
    runtime.setHealth("a", "ready", 3);
    expect(runtime.snapshot().layers[0]?.revision).toBe(3);
  });

  it("returns defensive snapshots", () => {
    const runtime = createLayerRenderStateRuntime(policy());
    runtime.register(layer("a"), 1);
    const snapshot = runtime.snapshot();
    (snapshot.layers[0]!.modes as LayerViewMode[]).push("2d");
    expect(runtime.snapshot().layers[0]?.modes).toEqual(["2d", "3d"]);
    const events = runtime.events() as Array<{ type: string }>;
    events[0]!.type = "corrupt";
    expect(runtime.events()[0]?.type).toBe("registered");
  });

  it("disposes state and rejects later mutations", () => {
    const runtime = createLayerRenderStateRuntime(policy());
    const listener = vi.fn();
    runtime.subscribe(listener);
    runtime.register(layer("a"), 1);
    runtime.dispose(2);
    runtime.dispose(3);
    expect(runtime.snapshot()).toMatchObject({ disposed: true, layers: [], visibleIds: [], loadingCount: 0 });
    expect(runtime.register(layer("b"), 4)).toBe(false);
    expect(runtime.setOpacity("a", 0.5, 4)).toBe(false);
    expect(listener.mock.calls.at(-1)?.[1]).toMatchObject({ type: "disposed", at: 2 });
  });

  it("validates policy contracts", () => {
    expect(() => createLayerRenderStateRuntime(policy({ maxLayers: 0 }))).toThrow("Invalid GIS layer-render policy");
    expect(() => createLayerRenderStateRuntime(policy({ minScale: 100, maxScale: 10 }))).toThrow("Invalid GIS layer-render policy");
    expect(() => createLayerRenderStateRuntime(policy({ failureBackoffMs: -1 }))).toThrow("Invalid GIS layer-render policy");
    expect(() => createLayerRenderStateRuntime(policy(), "2d", 0)).toThrow("Invalid initial GIS scale");
  });

  it("tracks lifecycle metrics", () => {
    const runtime = createLayerRenderStateRuntime(policy());
    runtime.register(layer("a"), 1);
    runtime.setOpacity("a", 0.5, 2);
    runtime.setRequestedVisible("a", false, 3);
    runtime.setHealth("a", "ready", 4);
    runtime.setMode("3d", 5);
    runtime.setScale(20_000, 6);
    runtime.remove("a", 7);
    expect(runtime.metrics()).toMatchObject({ registrations: 1, removals: 1, visibilityChanges: 1, opacityChanges: 1, healthChanges: 1, modeChanges: 1, scaleChanges: 1 });
  });
});

type LayerViewMode = "2d" | "3d";
