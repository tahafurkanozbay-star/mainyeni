import { describe, expect, it } from "vitest";
import { decideSpatialLod, lodClusterTarget, lodRequestBudget } from "./spatialLodBudget";

describe("spatial LOD budget", () => {
  it("keeps requested LOD under normal load", () => {
    expect(decideSpatialLod({ requestedLevel: 12, visibleFeatures: 10_000, estimatedVertices: 100_000 })).toMatchObject({ effectiveLevel: 12, pressure: "normal", degraded: false });
  });

  it("degrades one level under warm feature pressure", () => {
    expect(decideSpatialLod({ requestedLevel: 12, visibleFeatures: 70_000, estimatedVertices: 100_000 })).toMatchObject({ effectiveLevel: 11, pressure: "warm" });
  });

  it("degrades two levels under hot feature pressure", () => {
    expect(decideSpatialLod({ requestedLevel: 12, visibleFeatures: 85_000, estimatedVertices: 100_000 })).toMatchObject({ effectiveLevel: 10, pressure: "hot" });
  });

  it("degrades three levels at feature capacity", () => {
    expect(decideSpatialLod({ requestedLevel: 12, visibleFeatures: 100_000, estimatedVertices: 100_000 })).toMatchObject({ effectiveLevel: 9, pressure: "critical", reason: "feature-budget" });
  });

  it("uses vertex pressure independently", () => {
    expect(decideSpatialLod({ requestedLevel: 8, visibleFeatures: 1, estimatedVertices: 2_000_000 })).toMatchObject({ effectiveLevel: 5, pressure: "critical", reason: "vertex-budget" });
  });

  it("honors stronger frame pressure", () => {
    expect(decideSpatialLod({ requestedLevel: 8, visibleFeatures: 1, estimatedVertices: 1, framePressure: "hot" })).toMatchObject({ effectiveLevel: 6, pressure: "hot", reason: "frame-pressure" });
  });

  it("reports combined data and frame pressure", () => {
    expect(decideSpatialLod({ requestedLevel: 8, visibleFeatures: 100_000, estimatedVertices: 1, framePressure: "warm" })?.reason).toBe("combined");
  });

  it("never degrades below configured minimum", () => {
    expect(decideSpatialLod({ requestedLevel: 1, visibleFeatures: 100_000, estimatedVertices: 2_000_000 }, { minLevel: 1 })?.effectiveLevel).toBe(1);
  });

  it("clamps requested level to maximum", () => {
    expect(decideSpatialLod({ requestedLevel: 99, visibleFeatures: 0, estimatedVertices: 0 }, { maxLevel: 20 })?.requestedLevel).toBe(20);
  });

  it("rejects fractional requested levels", () => {
    expect(decideSpatialLod({ requestedLevel: 1.5, visibleFeatures: 0, estimatedVertices: 0 })).toBeNull();
  });

  it("rejects negative feature counts", () => {
    expect(decideSpatialLod({ requestedLevel: 1, visibleFeatures: -1, estimatedVertices: 0 })).toBeNull();
  });

  it("rejects negative vertex counts", () => {
    expect(decideSpatialLod({ requestedLevel: 1, visibleFeatures: 0, estimatedVertices: -1 })).toBeNull();
  });

  it("raises cluster target under pressure", () => {
    const decision = decideSpatialLod({ requestedLevel: 8, visibleFeatures: 100_000, estimatedVertices: 0 });
    expect(decision && lodClusterTarget(decision, 50)).toBe(200);
  });

  it("reduces concurrent request budget under pressure", () => {
    const decision = decideSpatialLod({ requestedLevel: 8, visibleFeatures: 85_000, estimatedVertices: 0 });
    expect(decision && lodRequestBudget(decision, 12)).toBe(4);
  });

  it("keeps at least one request slot", () => {
    const decision = decideSpatialLod({ requestedLevel: 8, visibleFeatures: 100_000, estimatedVertices: 0 });
    expect(decision && lodRequestBudget(decision, 1)).toBe(1);
  });

  it("rejects invalid cluster targets", () => {
    const decision = decideSpatialLod({ requestedLevel: 8, visibleFeatures: 0, estimatedVertices: 0 });
    expect(decision && lodClusterTarget(decision, 0)).toBeNull();
  });

  it("rejects invalid request budgets", () => {
    const decision = decideSpatialLod({ requestedLevel: 8, visibleFeatures: 0, estimatedVertices: 0 });
    expect(decision && lodRequestBudget(decision, 0)).toBeNull();
  });

  it("validates policy level ordering", () => {
    expect(() => decideSpatialLod({ requestedLevel: 1, visibleFeatures: 0, estimatedVertices: 0 }, { minLevel: 5, maxLevel: 4 })).toThrow();
  });

  it("validates monotonic pressure thresholds", () => {
    expect(() => decideSpatialLod({ requestedLevel: 1, visibleFeatures: 0, estimatedVertices: 0 }, { warmFeatureRatio: 0.9, hotFeatureRatio: 0.8 })).toThrow();
  });
});
