export type LodPressure = "normal" | "warm" | "hot" | "critical";

export interface SpatialLodPolicy {
  minLevel: number;
  maxLevel: number;
  maxVisibleFeatures: number;
  maxEstimatedVertices: number;
  warmFeatureRatio: number;
  hotFeatureRatio: number;
  criticalFeatureRatio: number;
}

export interface SpatialLodInput {
  requestedLevel: number;
  visibleFeatures: number;
  estimatedVertices: number;
  framePressure?: LodPressure;
}

export interface SpatialLodDecision {
  requestedLevel: number;
  effectiveLevel: number;
  pressure: LodPressure;
  featureRatio: number;
  vertexRatio: number;
  degraded: boolean;
  reason: "none" | "feature-budget" | "vertex-budget" | "frame-pressure" | "combined";
}

export const DEFAULT_SPATIAL_LOD_POLICY: SpatialLodPolicy = Object.freeze({
  minLevel: 0,
  maxLevel: 24,
  maxVisibleFeatures: 100_000,
  maxEstimatedVertices: 2_000_000,
  warmFeatureRatio: 0.7,
  hotFeatureRatio: 0.85,
  criticalFeatureRatio: 1,
});

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

function validatePolicy(policy: SpatialLodPolicy): void {
  if (!Number.isInteger(policy.minLevel) || policy.minLevel < 0) throw new Error("minLevel must be a non-negative integer");
  if (!Number.isInteger(policy.maxLevel) || policy.maxLevel < policy.minLevel) throw new Error("maxLevel must be >= minLevel");
  if (!Number.isInteger(policy.maxVisibleFeatures) || policy.maxVisibleFeatures <= 0) throw new Error("maxVisibleFeatures must be positive");
  if (!Number.isInteger(policy.maxEstimatedVertices) || policy.maxEstimatedVertices <= 0) throw new Error("maxEstimatedVertices must be positive");
  if (!finite(policy.warmFeatureRatio) || policy.warmFeatureRatio <= 0 || policy.warmFeatureRatio > 1) throw new Error("warmFeatureRatio out of range");
  if (!finite(policy.hotFeatureRatio) || policy.hotFeatureRatio < policy.warmFeatureRatio || policy.hotFeatureRatio > 1) throw new Error("hotFeatureRatio out of range");
  if (!finite(policy.criticalFeatureRatio) || policy.criticalFeatureRatio < policy.hotFeatureRatio || policy.criticalFeatureRatio > 1) throw new Error("criticalFeatureRatio out of range");
}

const pressureWeight = (pressure: LodPressure): number => {
  if (pressure === "critical") return 3;
  if (pressure === "hot") return 2;
  if (pressure === "warm") return 1;
  return 0;
};

const ratioPressure = (ratio: number, policy: SpatialLodPolicy): LodPressure => {
  if (ratio >= policy.criticalFeatureRatio) return "critical";
  if (ratio >= policy.hotFeatureRatio) return "hot";
  if (ratio >= policy.warmFeatureRatio) return "warm";
  return "normal";
};

const strongerPressure = (a: LodPressure, b: LodPressure): LodPressure => pressureWeight(a) >= pressureWeight(b) ? a : b;

function dataPressureReason(
  featurePressure: LodPressure,
  vertexPressure: LodPressure,
): SpatialLodDecision["reason"] {
  const featureWeight = pressureWeight(featurePressure);
  const vertexWeight = pressureWeight(vertexPressure);
  if (featureWeight === 0 && vertexWeight === 0) return "none";
  return featureWeight >= vertexWeight ? "feature-budget" : "vertex-budget";
}

export function decideSpatialLod(
  input: SpatialLodInput,
  policyInput: Partial<SpatialLodPolicy> = {},
): SpatialLodDecision | null {
  const policy: SpatialLodPolicy = { ...DEFAULT_SPATIAL_LOD_POLICY, ...policyInput };
  validatePolicy(policy);
  if (!Number.isInteger(input.requestedLevel)) return null;
  if (!Number.isInteger(input.visibleFeatures) || input.visibleFeatures < 0) return null;
  if (!Number.isInteger(input.estimatedVertices) || input.estimatedVertices < 0) return null;
  const requestedLevel = clamp(input.requestedLevel, policy.minLevel, policy.maxLevel);
  const featureRatio = input.visibleFeatures / policy.maxVisibleFeatures;
  const vertexRatio = input.estimatedVertices / policy.maxEstimatedVertices;
  const framePressure = input.framePressure ?? "normal";
  if (!(["normal", "warm", "hot", "critical"] as const).includes(framePressure)) return null;
  const featurePressure = ratioPressure(featureRatio, policy);
  const vertexPressure = ratioPressure(vertexRatio, policy);
  const dataPressure = strongerPressure(featurePressure, vertexPressure);
  const pressure = strongerPressure(dataPressure, framePressure);
  const reduction = pressureWeight(pressure);
  const effectiveLevel = clamp(requestedLevel - reduction, policy.minLevel, policy.maxLevel);
  const dataReason = dataPressureReason(featurePressure, vertexPressure);
  const hasDataPressure = dataReason !== "none";
  const hasFramePressure = pressureWeight(framePressure) > 0;
  const reason: SpatialLodDecision["reason"] = hasDataPressure && hasFramePressure
    ? "combined"
    : hasDataPressure
      ? dataReason
      : hasFramePressure
        ? "frame-pressure"
        : "none";
  return {
    requestedLevel,
    effectiveLevel,
    pressure,
    featureRatio,
    vertexRatio,
    degraded: effectiveLevel < requestedLevel,
    reason,
  };
}

export function lodClusterTarget(decision: SpatialLodDecision, baseTarget: number): number | null {
  if (!Number.isInteger(baseTarget) || baseTarget <= 0) return null;
  const multiplier = decision.pressure === "critical" ? 4 : decision.pressure === "hot" ? 3 : decision.pressure === "warm" ? 2 : 1;
  return Math.max(1, Math.floor(baseTarget * multiplier));
}

export function lodRequestBudget(decision: SpatialLodDecision, baseConcurrentRequests: number): number | null {
  if (!Number.isInteger(baseConcurrentRequests) || baseConcurrentRequests <= 0) return null;
  const divisor = decision.pressure === "critical" ? 4 : decision.pressure === "hot" ? 3 : decision.pressure === "warm" ? 2 : 1;
  return Math.max(1, Math.floor(baseConcurrentRequests / divisor));
}
