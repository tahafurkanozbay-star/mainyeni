import { describe, expect, it } from "vitest";
import { decideSpatialLod } from "./spatialLodBudget";

describe("spatial LOD monotonicity contract", () => {
  it("never increases effective LOD as feature pressure rises", () => {
    const levels = [0, 25_000, 70_000, 85_000, 100_000, 150_000].map((visibleFeatures) =>
      decideSpatialLod({ requestedLevel: 16, visibleFeatures, estimatedVertices: 0 })?.effectiveLevel,
    );
    expect(levels).toEqual([16, 16, 15, 14, 13, 13]);
  });

  it("never increases effective LOD as vertex pressure rises", () => {
    const levels = [0, 500_000, 1_400_000, 1_700_000, 2_000_000].map((estimatedVertices) =>
      decideSpatialLod({ requestedLevel: 16, visibleFeatures: 0, estimatedVertices })?.effectiveLevel,
    );
    expect(levels).toEqual([16, 16, 15, 14, 13]);
  });

  it("uses the stronger of frame and data pressure", () => {
    const warmDataHotFrame = decideSpatialLod({ requestedLevel: 10, visibleFeatures: 70_000, estimatedVertices: 0, framePressure: "hot" });
    const criticalDataWarmFrame = decideSpatialLod({ requestedLevel: 10, visibleFeatures: 100_000, estimatedVertices: 0, framePressure: "warm" });
    expect(warmDataHotFrame).toMatchObject({ pressure: "hot", effectiveLevel: 8 });
    expect(criticalDataWarmFrame).toMatchObject({ pressure: "critical", effectiveLevel: 7 });
  });
});
