import { describe, expect, it } from "vitest";
import { normalizeSpatialReference } from "./spatialReferenceRuntime";
import { createSpatialViewQueryStateCoordinator } from "./spatialViewQueryStateRuntime";

const wgs84 = normalizeSpatialReference({ wkid: 4326 });
const webMercator = normalizeSpatialReference({ wkid: 3857 });

describe("spatialViewQueryStateRuntime", () => {
  it("gives 2d and 3d views the same query fingerprint when query state matches", () => {
    const coordinator = createSpatialViewQueryStateCoordinator();
    coordinator.upsert({
      viewId: "map",
      dimension: "2d",
      extent: { xmin: 28, ymin: 40, xmax: 30, ymax: 42 },
      spatialReference: wgs84,
      scale: 10000,
      visibleLayerIds: ["parks", "roads"],
    });
    coordinator.upsert({
      viewId: "scene",
      dimension: "3d",
      extent: { xmin: 28, ymin: 40, xmax: 30, ymax: 42 },
      spatialReference: wgs84,
      scale: 10000,
      visibleLayerIds: ["roads", "parks"],
      tilt: 65,
      rotation: 180,
    });

    expect(coordinator.queryEquivalent("map", "scene")).toBe(true);
  });

  it("invalidates only views that reference a changed layer", () => {
    const coordinator = createSpatialViewQueryStateCoordinator();
    coordinator.upsert({
      viewId: "map",
      dimension: "2d",
      extent: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 },
      spatialReference: wgs84,
      scale: 1000,
      visibleLayerIds: ["parks"],
    });
    coordinator.upsert({
      viewId: "other",
      dimension: "2d",
      extent: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 },
      spatialReference: wgs84,
      scale: 1000,
      visibleLayerIds: ["roads"],
    });
    const otherBefore = coordinator.querySignature("other");

    expect(coordinator.invalidateLayer("parks")).toBe(1);
    expect(coordinator.querySignature("other")).toBe(otherBefore);
  });

  it("projects view extents only when explicitly enabled", () => {
    const strict = createSpatialViewQueryStateCoordinator({
      targetSpatialReference: webMercator,
    });
    expect(() =>
      strict.upsert({
        viewId: "map",
        dimension: "2d",
        extent: { xmin: 29, ymin: 41, xmax: 30, ymax: 42 },
        spatialReference: wgs84,
        scale: 1000,
        visibleLayerIds: [],
      }),
    ).toThrow(/does not match/);

    const projecting = createSpatialViewQueryStateCoordinator({
      targetSpatialReference: webMercator,
      projectToTarget: true,
    });
    const state = projecting.upsert({
      viewId: "map",
      dimension: "2d",
      extent: { xmin: 29, ymin: 41, xmax: 30, ymax: 42 },
      spatialReference: wgs84,
      scale: 1000,
      visibleLayerIds: [],
    });
    expect(state.spatialReference.key).toBe("wkid:3857");
    expect(state.extent.xmin).toBeGreaterThan(3_000_000);
  });

  it("returns the same immutable state when only camera presentation changes", () => {
    const coordinator = createSpatialViewQueryStateCoordinator();
    const first = coordinator.upsert({
      viewId: "scene",
      dimension: "3d",
      extent: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 },
      spatialReference: wgs84,
      scale: 1000,
      visibleLayerIds: ["parks"],
      rotation: 0,
      tilt: 20,
    });
    const second = coordinator.upsert({
      viewId: "scene",
      dimension: "3d",
      extent: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 },
      spatialReference: wgs84,
      scale: 1000,
      visibleLayerIds: ["parks"],
      rotation: 90,
      tilt: 70,
    });

    expect(second).toBe(first);
  });

  it("bounds visible-layer cardinality", () => {
    const coordinator = createSpatialViewQueryStateCoordinator({
      maxVisibleLayers: 1,
    });
    expect(() =>
      coordinator.upsert({
        viewId: "map",
        dimension: "2d",
        extent: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 },
        spatialReference: wgs84,
        scale: 1000,
        visibleLayerIds: ["a", "b"],
      }),
    ).toThrow(/layer set/);
  });
});
