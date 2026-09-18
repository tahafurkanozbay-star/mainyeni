import { describe, expect, it } from "vitest";
import type { SpatialQuerySession, SpatialQuerySessionResult } from "./spatialQuerySessionRuntime";
import { createSpatialQueryParityRuntime } from "./spatialQueryParityRuntime";
import { normalizeSpatialReference } from "./spatialReferenceRuntime";
import { createSpatialViewQueryStateCoordinator } from "./spatialViewQueryStateRuntime";

const sr = normalizeSpatialReference({ wkid: 4326 });

function result(key: string): SpatialQuerySessionResult {
  return {
    contract: { fingerprint: key } as SpatialQuerySessionResult["contract"],
    plan: {} as SpatialQuerySessionResult["plan"],
    execution: {
      features: [],
      pagesRead: 0,
      estimatedBytes: 0,
      completed: true,
      stoppedBy: "service-complete",
    },
    integrity: {
      features: [],
      issues: [],
      acceptedCount: 0,
      rejectedCount: 0,
      duplicateCount: 0,
      projectedCount: 0,
    },
    cacheKey: key,
    generation: 0,
  };
}

function session(calls: string[], key: string): SpatialQuerySession {
  let generation = 0;
  return {
    capability: {} as SpatialQuerySession["capability"],
    query: async () => {
      calls.push(key);
      return result(key);
    },
    invalidate: () => {
      generation += 1;
      return generation;
    },
    stats: () => ({
      requests: 0,
      successes: 0,
      failures: 0,
      cancellations: 0,
      invalidations: generation,
      generation,
      admittedFeatures: 0,
      returnedFeatures: 0,
      pagesRead: 0,
    }),
    dispose: () => undefined,
  };
}

function registerView(
  coordinator: ReturnType<typeof createSpatialViewQueryStateCoordinator>,
  viewId: string,
  dimension: "2d" | "3d",
): void {
  coordinator.upsert({
    viewId,
    dimension,
    extent: { xmin: 28, ymin: 40, xmax: 30, ymax: 42 },
    spatialReference: sr,
    scale: 5000,
    visibleLayerIds: ["parks"],
    ...(dimension === "3d" ? { tilt: 60 } : {}),
  });
}

describe("spatialQueryParityRuntime", () => {
  it("produces equivalent 2d/3d query plans for equivalent view state", () => {
    const coordinator = createSpatialViewQueryStateCoordinator();
    registerView(coordinator, "map", "2d");
    registerView(coordinator, "scene", "3d");
    const runtime = createSpatialQueryParityRuntime({ coordinator });
    runtime.register({
      layerId: "parks",
      session: session([], "parks"),
      budget: { mode: "viewport", requestedFeatures: 100 },
    });

    const mapPlan = runtime.plan("map");
    const scenePlan = runtime.plan("scene");
    expect(runtime.equivalentViews("map", "scene")).toBe(true);
    expect(mapPlan.taskCount).toBe(1);
    expect(scenePlan.taskCount).toBe(1);
    expect(mapPlan.viewFingerprint).toBe(scenePlan.viewFingerprint);
  });

  it("executes only visible registered layer bindings", async () => {
    const calls: string[] = [];
    const coordinator = createSpatialViewQueryStateCoordinator();
    registerView(coordinator, "map", "2d");
    const runtime = createSpatialQueryParityRuntime({ coordinator });
    runtime.register({
      layerId: "parks",
      session: session(calls, "parks"),
      budget: { mode: "viewport" },
      estimatedBytes: 1024,
    });

    const response = await runtime.execute("map");
    expect(calls).toEqual(["parks"]);
    expect(response.fulfilled).toBe(1);
    expect(runtime.stats().fulfilledTasks).toBe(1);
  });

  it("invalidates both view fingerprint and session generation", () => {
    const calls: string[] = [];
    const coordinator = createSpatialViewQueryStateCoordinator();
    registerView(coordinator, "map", "2d");
    const querySession = session(calls, "parks");
    const runtime = createSpatialQueryParityRuntime({ coordinator });
    runtime.register({
      layerId: "parks",
      session: querySession,
      budget: { mode: "viewport" },
    });
    const before = coordinator.querySignature("map");

    expect(runtime.invalidateLayer("parks")).toBe(1);
    expect(coordinator.querySignature("map")).not.toBe(before);
    expect(querySession.stats().generation).toBeGreaterThan(0);
  });

  it("can fail closed for visible layers without verified bindings", () => {
    const coordinator = createSpatialViewQueryStateCoordinator();
    registerView(coordinator, "map", "2d");
    const runtime = createSpatialQueryParityRuntime({
      coordinator,
      unknownVisibleLayer: "error",
    });

    expect(() => runtime.plan("map")).toThrow(/no query binding/);
  });
});
