import { describe, expect, it } from "vitest";
import {
  DEFAULT_SPATIAL_LOD_POLICY,
  decideSpatialLod,
  lodClusterTarget,
  lodRequestBudget,
  type LodPressure,
  type SpatialLodDecision,
  type SpatialLodPolicy,
} from "./spatialLodBudget";

const pressureRank: Record<LodPressure, number> = {
  normal: 0,
  warm: 1,
  hot: 2,
  critical: 3,
};

const policy: SpatialLodPolicy = {
  ...DEFAULT_SPATIAL_LOD_POLICY,
  minLevel: 2,
  maxLevel: 18,
  maxVisibleFeatures: 1_000,
  maxEstimatedVertices: 10_000,
  warmFeatureRatio: 0.5,
  hotFeatureRatio: 0.75,
  criticalFeatureRatio: 1,
};

const decide = (
  visibleFeatures: number,
  estimatedVertices: number,
  framePressure: LodPressure = "normal",
  requestedLevel = 12,
): SpatialLodDecision => {
  const decision = decideSpatialLod({
    requestedLevel,
    visibleFeatures,
    estimatedVertices,
    framePressure,
  }, policy);
  expect(decision).not.toBeNull();
  return decision!;
};

describe("spatial LOD release invariants", () => {
  it("keeps pressure monotonic as feature load increases", () => {
    let previous = -1;
    for (let features = 0; features <= 1_500; features += 25) {
      const current = pressureRank[decide(features, 0).pressure];
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
  });

  it("keeps pressure monotonic as vertex load increases", () => {
    let previous = -1;
    for (let vertices = 0; vertices <= 15_000; vertices += 250) {
      const current = pressureRank[decide(0, vertices).pressure];
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
  });

  it("never increases effective detail when feature pressure rises", () => {
    let previous = Number.POSITIVE_INFINITY;
    for (let features = 0; features <= 1_500; features += 25) {
      const current = decide(features, 0).effectiveLevel;
      expect(current).toBeLessThanOrEqual(previous);
      previous = current;
    }
  });

  it("never increases effective detail when vertex pressure rises", () => {
    let previous = Number.POSITIVE_INFINITY;
    for (let vertices = 0; vertices <= 15_000; vertices += 250) {
      const current = decide(0, vertices).effectiveLevel;
      expect(current).toBeLessThanOrEqual(previous);
      previous = current;
    }
  });

  it("preserves exact pressure thresholds for feature load", () => {
    expect(decide(499, 0)).toMatchObject({ pressure: "normal", reason: "none" });
    expect(decide(500, 0)).toMatchObject({ pressure: "warm", reason: "feature-budget" });
    expect(decide(749, 0)).toMatchObject({ pressure: "warm", reason: "feature-budget" });
    expect(decide(750, 0)).toMatchObject({ pressure: "hot", reason: "feature-budget" });
    expect(decide(999, 0)).toMatchObject({ pressure: "hot", reason: "feature-budget" });
    expect(decide(1_000, 0)).toMatchObject({ pressure: "critical", reason: "feature-budget" });
  });

  it("preserves exact pressure thresholds for vertex load", () => {
    expect(decide(0, 4_999)).toMatchObject({ pressure: "normal", reason: "none" });
    expect(decide(0, 5_000)).toMatchObject({ pressure: "warm", reason: "vertex-budget" });
    expect(decide(0, 7_499)).toMatchObject({ pressure: "warm", reason: "vertex-budget" });
    expect(decide(0, 7_500)).toMatchObject({ pressure: "hot", reason: "vertex-budget" });
    expect(decide(0, 9_999)).toMatchObject({ pressure: "hot", reason: "vertex-budget" });
    expect(decide(0, 10_000)).toMatchObject({ pressure: "critical", reason: "vertex-budget" });
  });

  it("reports combined provenance whenever frame and data pressure coexist", () => {
    for (const framePressure of ["warm", "hot", "critical"] as const) {
      for (const [features, vertices] of [[500, 0], [0, 5_000], [750, 7_500]] as const) {
        expect(decide(features, vertices, framePressure).reason).toBe("combined");
      }
    }
  });

  it("reports frame provenance only when data pressure is normal", () => {
    for (const framePressure of ["warm", "hot", "critical"] as const) {
      expect(decide(100, 1_000, framePressure)).toMatchObject({
        pressure: framePressure,
        reason: "frame-pressure",
      });
    }
  });

  it("uses the strongest source without losing combined provenance", () => {
    expect(decide(500, 0, "critical")).toMatchObject({ pressure: "critical", reason: "combined" });
    expect(decide(1_000, 0, "warm")).toMatchObject({ pressure: "critical", reason: "combined" });
    expect(decide(0, 7_500, "warm")).toMatchObject({ pressure: "hot", reason: "combined" });
  });

  it("uses deterministic feature provenance when data pressures tie", () => {
    expect(decide(500, 5_000)).toMatchObject({ pressure: "warm", reason: "feature-budget" });
    expect(decide(750, 7_500)).toMatchObject({ pressure: "hot", reason: "feature-budget" });
    expect(decide(1_000, 10_000)).toMatchObject({ pressure: "critical", reason: "feature-budget" });
  });

  it("keeps ratio diagnostics proportional beyond capacity", () => {
    const decision = decide(2_500, 25_000);
    expect(decision.featureRatio).toBe(2.5);
    expect(decision.vertexRatio).toBe(2.5);
    expect(decision.pressure).toBe("critical");
  });

  it("clamps requested detail before applying degradation", () => {
    expect(decide(0, 0, "normal", -100)).toMatchObject({ requestedLevel: 2, effectiveLevel: 2, degraded: false });
    expect(decide(0, 0, "normal", 100)).toMatchObject({ requestedLevel: 18, effectiveLevel: 18, degraded: false });
    expect(decide(1_000, 0, "normal", 100)).toMatchObject({ requestedLevel: 18, effectiveLevel: 15, degraded: true });
  });

  it("never degrades below the configured minimum", () => {
    for (const requestedLevel of [2, 3, 4, 5]) {
      expect(decide(10_000, 100_000, "critical", requestedLevel).effectiveLevel).toBeGreaterThanOrEqual(2);
    }
  });

  it("keeps degraded consistent with the effective level", () => {
    for (const framePressure of ["normal", "warm", "hot", "critical"] as const) {
      for (const requestedLevel of [2, 3, 8, 18]) {
        const decision = decide(800, 8_000, framePressure, requestedLevel);
        expect(decision.degraded).toBe(decision.effectiveLevel < decision.requestedLevel);
      }
    }
  });

  it("scales cluster targets monotonically with pressure", () => {
    const targets = (["normal", "warm", "hot", "critical"] as const).map((framePressure) =>
      lodClusterTarget(decide(0, 0, framePressure), 100),
    );
    expect(targets).toEqual([100, 200, 300, 400]);
  });

  it("scales request concurrency monotonically with pressure", () => {
    const budgets = (["normal", "warm", "hot", "critical"] as const).map((framePressure) =>
      lodRequestBudget(decide(0, 0, framePressure), 12),
    );
    expect(budgets).toEqual([12, 6, 4, 3]);
  });

  it("keeps request concurrency at least one under critical pressure", () => {
    for (const base of [1, 2, 3, 4]) {
      expect(lodRequestBudget(decide(0, 0, "critical"), base)).toBe(1);
    }
  });

  it("rejects invalid downstream budget inputs", () => {
    const decision = decide(0, 0);
    for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(lodClusterTarget(decision, invalid)).toBeNull();
      expect(lodRequestBudget(decision, invalid)).toBeNull();
    }
  });

  it("rejects malformed spatial observations without manufacturing pressure", () => {
    expect(decideSpatialLod({ requestedLevel: 1.5, visibleFeatures: 0, estimatedVertices: 0 }, policy)).toBeNull();
    expect(decideSpatialLod({ requestedLevel: 3, visibleFeatures: -1, estimatedVertices: 0 }, policy)).toBeNull();
    expect(decideSpatialLod({ requestedLevel: 3, visibleFeatures: 0.5, estimatedVertices: 0 }, policy)).toBeNull();
    expect(decideSpatialLod({ requestedLevel: 3, visibleFeatures: 0, estimatedVertices: -1 }, policy)).toBeNull();
    expect(decideSpatialLod({ requestedLevel: 3, visibleFeatures: 0, estimatedVertices: 0.5 }, policy)).toBeNull();
  });

  it("fails closed for invalid policy ordering", () => {
    expect(() => decideSpatialLod({ requestedLevel: 4, visibleFeatures: 0, estimatedVertices: 0 }, {
      warmFeatureRatio: 0.9,
      hotFeatureRatio: 0.8,
    })).toThrow(/hotFeatureRatio/);
    expect(() => decideSpatialLod({ requestedLevel: 4, visibleFeatures: 0, estimatedVertices: 0 }, {
      hotFeatureRatio: 0.95,
      criticalFeatureRatio: 0.9,
    })).toThrow(/criticalFeatureRatio/);
  });

  it("fails closed for invalid capacity policy", () => {
    expect(() => decideSpatialLod({ requestedLevel: 4, visibleFeatures: 0, estimatedVertices: 0 }, { maxVisibleFeatures: 0 })).toThrow(/maxVisibleFeatures/);
    expect(() => decideSpatialLod({ requestedLevel: 4, visibleFeatures: 0, estimatedVertices: 0 }, { maxEstimatedVertices: 0 })).toThrow(/maxEstimatedVertices/);
  });
});
