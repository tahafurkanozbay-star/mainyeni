import { describe, expect, it } from "vitest";
import { createSpatialFeatureSnapshotStore } from "./spatialFeatureSnapshotRuntime";
import type { SpatialFeature } from "./spatialReferenceFeatureRuntime";
import { normalizeSpatialReference } from "./spatialReferenceRuntime";

const sr = normalizeSpatialReference({ wkid: 4326 });

function point(
  id: string | number,
  x: number,
  y: number,
  name = String(id),
): SpatialFeature {
  return {
    id,
    geometry: {
      type: "point",
      x,
      y,
      spatialReference: sr,
    },
    attributes: {
      name,
    },
  };
}

describe("spatialFeatureSnapshotRuntime", () => {
  it("creates immutable deterministic snapshots", () => {
    const store = createSpatialFeatureSnapshotStore({
      now: () => 100,
    });
    const change = store.replace([
      point("b", 2, 2),
      point(0, 0, 0),
      point("a", 1, 1),
    ]);

    expect(change.inserted).toBe(3);
    expect(change.snapshot.ids).toEqual([0, "a", "b"]);
    expect(change.snapshot.extent).toEqual({
      xmin: 0,
      ymin: 0,
      xmax: 2,
      ymax: 2,
    });
    expect(change.snapshot.spatialReference?.key).toBe("wkid:4326");
  });

  it("keeps numeric and string identities distinct", () => {
    const store = createSpatialFeatureSnapshotStore();
    store.replace([
      point(0, 0, 0),
      point("0", 1, 1),
    ]);

    expect(store.get(0)?.geometry.type).toBe("point");
    expect(store.get("0")?.geometry.type).toBe("point");
    expect(store.snapshot().size).toBe(2);
  });

  it("applies bounded upsert/delete deltas atomically", () => {
    const store = createSpatialFeatureSnapshotStore();
    store.replace([
      point(1, 0, 0, "old"),
      point(2, 1, 1),
    ]);

    const change = store.applyDelta({
      deleteIds: [2],
      upsert: [
        point(1, 0, 0, "new"),
        point(3, 2, 2),
      ],
    });

    expect(change.updated).toBe(1);
    expect(change.inserted).toBe(1);
    expect(change.deleted).toBe(1);
    expect(change.snapshot.ids).toEqual([1, 3]);
    expect(store.get(1)?.attributes.name).toBe("new");
  });

  it("does not advance when a delta would exceed the feature budget", () => {
    const store = createSpatialFeatureSnapshotStore({
      maxSnapshotFeatures: 2,
      maxDeltaFeatures: 2,
    });
    store.replace([point(1, 0, 0), point(2, 1, 1)]);
    const before = store.snapshot();

    expect(() =>
      store.applyDelta({
        upsert: [point(3, 2, 2)],
      }),
    ).toThrow(/feature budget/);
    expect(store.snapshot()).toBe(before);
  });

  it("rejects mixed spatial references without mutating the committed snapshot or index", () => {
    const webMercator = normalizeSpatialReference({ wkid: 3857 });
    const store = createSpatialFeatureSnapshotStore();
    store.replace([point(9, 9, 9)]);
    const before = store.snapshot();

    expect(() =>
      store.replace([
        point(1, 0, 0),
        {
          id: 2,
          geometry: {
            type: "point",
            x: 0,
            y: 0,
            spatialReference: webMercator,
          },
          attributes: {},
        },
      ]),
    ).toThrow(/mixed spatial references/);

    expect(store.snapshot()).toBe(before);
    expect(store.has(9)).toBe(true);
    expect(store.has(1)).toBe(false);
    expect(store.has(2)).toBe(false);
  });

  it("keeps delta commits atomic when the estimated-byte budget is exceeded", () => {
    const store = createSpatialFeatureSnapshotStore({
      maxSnapshotFeatures: 3,
      maxDeltaFeatures: 2,
      maxEstimatedBytes: 100,
    });
    store.replace([point(1, 0, 0)]);
    const before = store.snapshot();

    expect(() =>
      store.applyDelta({
        upsert: [point(2, 1, 1)],
      }),
    ).toThrow(/estimated-byte budget/);

    expect(store.snapshot()).toBe(before);
    expect(store.has(1)).toBe(true);
    expect(store.has(2)).toBe(false);
  });

  it("supports projection-on-ingest when explicitly configured", () => {
    const webMercator = normalizeSpatialReference({ wkid: 3857 });
    const store = createSpatialFeatureSnapshotStore({
      targetSpatialReference: webMercator,
      projectToTarget: true,
    });

    store.replace([point(1, 29, 41)]);
    expect(store.snapshot().spatialReference?.key).toBe("wkid:3857");
    const feature = store.get(1);
    expect(feature?.geometry.spatialReference.key).toBe("wkid:3857");
  });

  it("honors cancellation before mutating state", () => {
    const store = createSpatialFeatureSnapshotStore();
    store.replace([point(1, 0, 0)]);
    const before = store.snapshot();
    const controller = new AbortController();
    controller.abort(new Error("cancel"));

    expect(() =>
      store.applyDelta(
        {
          upsert: [point(2, 1, 1)],
        },
        controller.signal,
      ),
    ).toThrow("cancel");
    expect(store.snapshot()).toBe(before);
  });

  it("clears with an explicit revision change", () => {
    const store = createSpatialFeatureSnapshotStore();
    store.replace([point(1, 0, 0)]);
    const change = store.clear();

    expect(change.deleted).toBe(1);
    expect(change.snapshot.size).toBe(0);
    expect(change.snapshot.extent).toBeNull();
  });
});
