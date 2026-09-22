import { describe, expect, it } from "vitest";
import { decideSpatialLod, lodClusterTarget, lodRequestBudget } from "./spatialLodBudget";

describe("spatial LOD budget", () => {
  it("keeps requested LOD under normal load", () => {
    expect(decideSpatialLod({ requestedLevel: 12, visibleFeatures: 10_000, estimatedVertices: 100_000 })).toMatchObject({ effectiveLevel: 12, pressure: "normal", degraded: false, reason: "none" });
  });

  it("degrades one level under warm feature pressure and preserves provenance", () => {
    expect(decideSpatialLod({ requestedLevel: 12, visibleFeatures: 70_000, estimatedVertices: 100_000 })).toMatchObject({ effectiveLevel: 11, pressure: "warm", reason: "feature-budget" });
  });

  it("degrades two levels under hot feature pressure and preserves provenance", () => {
    expect(decideSpatialLod({ requestedLevel: 12, visibleFeatures: 85_000, estimatedVertices: 100_000 })).toMatchObject({ effectiveLevel: 10, pressure: "hot", reason: "feature-budget" });
  });

  it("degrades three levels at feature capacity", () => {
    expect(decideSpatialLod({ requestedLevel: 12, visibleFeatures: 100_000, estimatedVertices: 100_000 })).toMatchObject({ effectiveLevel: 9, pressure: "critical", reason: "feature-budget" });
  });

  it("uses warm vertex pressure independently", () => {
    expect(decideSpatialLod({ requestedLevel: 8, visibleFeatures: 1, estimatedVertices: 1_400_000 })).toMatchObject({ effectiveLevel: 7, pressure: "warm", reason: "vertex-budget" });
  });

  it("uses vertex pressure independently at capacity", () => {
    expect(decideSpatialLod({ requestedLevel: 8, visibleFeatures: 1, estimatedVertices: 2_000_000 })).toMatchObject({ effectiveLevel: 5, pressure: "critical", reason: "vertex-budget" });
  });

  it("uses the stronger data source as the reason", () => {
    expect(decideSpatialLod({ requestedLevel: 10, visibleFeatures: 70_000, estimatedVertices: 1_700_000 })).toMatchObject({ effectiveLevel: 8, pressure: "hot", reason: "vertex-budget" });
    expect(decideSpatialLod({ requestedLevel: 10, visibleFeatures: 85_000, estimatedVertices: 1_400_000 })).toMatchObject({ effectiveLevel: 8, pressure: "hot", reason: "feature-budget" });
  });

  it("uses feature provenance as deterministic tie breaker", () => {
    expect(decideSpatialLod({ requestedLevel: 10, visibleFeatures: 70_000, estimatedVertices: 1_400_000 })).toMatchObject({ pressure: "warm", reason: "feature-budget" });
  });

  it("honors stronger frame pressure", () => {
    expect(decideSpatialLod({ requestedLevel: 8, visibleFeatures: 1, estimatedVertices: 1, framePressure: "hot" })).toMatchObject({ effectiveLevel: 6, pressure: "hot", reason: "frame-pressure" });
  });

  it("reports combined pressure when both data and frame contribute below capacity", () => {
    expect(decideSpatialLod({ requestedLevel: 8, visibleFeatures: 70_000, estimatedVertices: 1, framePressure: "warm" })).toMatchObject({ effectiveLevel: 7, pressure: "warm", reason: "combined" });
  });

  it("reports combined data and frame pressure at capacity", () => {
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
