import type { GisPerformanceBudget, GisPerformanceProfile } from './adaptivePerformanceRuntime';
import {
  decideSpatialLod,
  lodClusterTarget,
  lodRequestBudget,
  type LodPressure,
  type SpatialLodDecision,
  type SpatialLodPolicy,
} from './spatialLodBudget';

export interface SpatialPressureObservation {
  requestedLevel: number;
  visibleFeatures: number;
  estimatedVertices: number;
  framePressure?: LodPressure;
}

export interface SpatialPressureCoordinatorPolicy {
  minLevel: number;
  maxLevel: number;
  maxEstimatedVertices: number;
  warmFeatureRatio: number;
  hotFeatureRatio: number;
  criticalFeatureRatio: number;
  baseConcurrentRequests: number;
  minConcurrentRequests: number;
  maxConcurrentRequests: number;
  minClusterTarget: number;
  maxClusterTarget: number;
  hysteresisSamples: number;
}

export interface SpatialPressurePlan {
  sequence: number;
  profile: GisPerformanceProfile;
  lod: SpatialLodDecision;
  observedPressure: LodPressure;
  clusterTarget: number;
  concurrentRequests: number;
  visibleFeatureBudget: number;
  queryCacheBytes: number;
  residentLayerBudget: number;
  prefetch: boolean;
  pressureChanged: boolean;
  transitionSuppressed: boolean;
}

export interface SpatialPressureCoordinatorMetrics {
  observations: number;
  rejectedObservations: number;
  pressureTransitions: number;
  suppressedTransitions: number;
  profileChanges: number;
}

export interface SpatialPressureCoordinatorSnapshot {
  sequence: number;
  profile: GisPerformanceProfile;
  pressure: LodPressure;
  pendingPressure: LodPressure | null;
  pendingSamples: number;
  metrics: SpatialPressureCoordinatorMetrics;
  lastPlan: SpatialPressurePlan | null;
}

export interface SpatialPressureCoordinator {
  observe: (observation: SpatialPressureObservation) => SpatialPressurePlan | null;
  updatePerformance: (profile: GisPerformanceProfile, budget: GisPerformanceBudget) => SpatialPressureCoordinatorSnapshot;
  getSnapshot: () => SpatialPressureCoordinatorSnapshot;
  reset: () => SpatialPressureCoordinatorSnapshot;
}

const DEFAULT_POLICY: SpatialPressureCoordinatorPolicy = Object.freeze({
  minLevel: 0,
  maxLevel: 24,
  maxEstimatedVertices: 2_000_000,
  warmFeatureRatio: 0.7,
  hotFeatureRatio: 0.85,
  criticalFeatureRatio: 1,
  baseConcurrentRequests: 8,
  minConcurrentRequests: 1,
  maxConcurrentRequests: 12,
  minClusterTarget: 100,
  maxClusterTarget: 50_000,
  hysteresisSamples: 2,
});

const PRESSURES: readonly LodPressure[] = ['normal', 'warm', 'hot', 'critical'];
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const isPositiveInteger = (value: unknown): value is number => Number.isInteger(value) && Number(value) > 0;

function validateBudget(budget: GisPerformanceBudget): void {
  if (!isPositiveInteger(budget.maxConcurrentLayers)) throw new TypeError('maxConcurrentLayers must be a positive integer');
  if (!isPositiveInteger(budget.maxResidentLayers)) throw new TypeError('maxResidentLayers must be a positive integer');
  if (!isPositiveInteger(budget.maxQueryCacheBytes)) throw new TypeError('maxQueryCacheBytes must be a positive integer');
  if (!isPositiveInteger(budget.clusterThreshold)) throw new TypeError('clusterThreshold must be a positive integer');
  if (!isPositiveInteger(budget.maxVisibleFeatures)) throw new TypeError('maxVisibleFeatures must be a positive integer');
  if (!Number.isFinite(budget.sceneQuality) || budget.sceneQuality <= 0 || budget.sceneQuality > 1) {
    throw new TypeError('sceneQuality must be in (0, 1]');
  }
}

function validatePolicy(policy: SpatialPressureCoordinatorPolicy): void {
  if (!Number.isInteger(policy.minLevel) || policy.minLevel < 0) throw new TypeError('minLevel must be a non-negative integer');
  if (!Number.isInteger(policy.maxLevel) || policy.maxLevel < policy.minLevel) throw new TypeError('maxLevel must be >= minLevel');
  if (!isPositiveInteger(policy.maxEstimatedVertices)) throw new TypeError('maxEstimatedVertices must be a positive integer');
  if (!Number.isFinite(policy.warmFeatureRatio) || policy.warmFeatureRatio <= 0 || policy.warmFeatureRatio > 1) throw new TypeError('warmFeatureRatio out of range');
  if (!Number.isFinite(policy.hotFeatureRatio) || policy.hotFeatureRatio < policy.warmFeatureRatio || policy.hotFeatureRatio > 1) throw new TypeError('hotFeatureRatio out of range');
  if (!Number.isFinite(policy.criticalFeatureRatio) || policy.criticalFeatureRatio < policy.hotFeatureRatio || policy.criticalFeatureRatio > 1) throw new TypeError('criticalFeatureRatio out of range');
  if (!isPositiveInteger(policy.baseConcurrentRequests)) throw new TypeError('baseConcurrentRequests must be a positive integer');
  if (!isPositiveInteger(policy.minConcurrentRequests)) throw new TypeError('minConcurrentRequests must be a positive integer');
  if (!isPositiveInteger(policy.maxConcurrentRequests) || policy.maxConcurrentRequests < policy.minConcurrentRequests) throw new TypeError('maxConcurrentRequests must be >= minConcurrentRequests');
  if (!isPositiveInteger(policy.minClusterTarget)) throw new TypeError('minClusterTarget must be a positive integer');
  if (!isPositiveInteger(policy.maxClusterTarget) || policy.maxClusterTarget < policy.minClusterTarget) throw new TypeError('maxClusterTarget must be >= minClusterTarget');
  if (!isPositiveInteger(policy.hysteresisSamples)) throw new TypeError('hysteresisSamples must be a positive integer');
}

const copyMetrics = (metrics: SpatialPressureCoordinatorMetrics): SpatialPressureCoordinatorMetrics => Object.freeze({ ...metrics });

export function createSpatialPressureCoordinator(
  initialProfile: GisPerformanceProfile,
  initialBudget: GisPerformanceBudget,
  policyInput: Partial<SpatialPressureCoordinatorPolicy> = {},
): SpatialPressureCoordinator {
  const policy: SpatialPressureCoordinatorPolicy = { ...DEFAULT_POLICY, ...policyInput };
  validatePolicy(policy);
  validateBudget(initialBudget);

  let profile = initialProfile;
  let budget = initialBudget;
  let sequence = 0;
  let stablePressure: LodPressure = 'normal';
  let pendingPressure: LodPressure | null = null;
  let pendingSamples = 0;
  let lastPlan: SpatialPressurePlan | null = null;
  const metrics: SpatialPressureCoordinatorMetrics = {
    observations: 0,
    rejectedObservations: 0,
    pressureTransitions: 0,
    suppressedTransitions: 0,
    profileChanges: 0,
  };

  const snapshot = (): SpatialPressureCoordinatorSnapshot => Object.freeze({
    sequence,
    profile,
    pressure: stablePressure,
    pendingPressure,
    pendingSamples,
    metrics: copyMetrics(metrics),
    lastPlan,
  });

  const resetPending = (): void => {
    pendingPressure = null;
    pendingSamples = 0;
  };

  const stabilizePressure = (candidate: LodPressure): { pressure: LodPressure; changed: boolean; suppressed: boolean } => {
    if (candidate === stablePressure) {
      resetPending();
      return { pressure: stablePressure, changed: false, suppressed: false };
    }
    if (candidate !== pendingPressure) {
      pendingPressure = candidate;
      pendingSamples = 1;
    } else {
      pendingSamples += 1;
    }
    if (pendingSamples < policy.hysteresisSamples) {
      metrics.suppressedTransitions += 1;
      return { pressure: stablePressure, changed: false, suppressed: true };
    }
    stablePressure = candidate;
    metrics.pressureTransitions += 1;
    resetPending();
    return { pressure: stablePressure, changed: true, suppressed: false };
  };

  const decide = (observation: SpatialPressureObservation): SpatialLodDecision | null => {
    const lodPolicy: Partial<SpatialLodPolicy> = {
      minLevel: policy.minLevel,
      maxLevel: policy.maxLevel,
      maxVisibleFeatures: budget.maxVisibleFeatures,
      maxEstimatedVertices: policy.maxEstimatedVertices,
      warmFeatureRatio: policy.warmFeatureRatio,
      hotFeatureRatio: policy.hotFeatureRatio,
      criticalFeatureRatio: policy.criticalFeatureRatio,
    };
    return decideSpatialLod(observation, lodPolicy);
  };

  const observe = (observation: SpatialPressureObservation): SpatialPressurePlan | null => {
    metrics.observations += 1;
    const candidate = decide(observation);
    if (!candidate) {
      metrics.rejectedObservations += 1;
      return null;
    }
    const observedPressure = candidate.pressure;
    const stabilized = stabilizePressure(observedPressure);
    const stabilizedDecision: SpatialLodDecision = stabilized.pressure === observedPressure
      ? candidate
      : {
          ...candidate,
          pressure: stabilized.pressure,
          effectiveLevel: clamp(candidate.requestedLevel - PRESSURES.indexOf(stabilized.pressure), policy.minLevel, policy.maxLevel),
          degraded: stabilized.pressure !== 'normal',
        };
    const clusterTarget = lodClusterTarget(stabilizedDecision, budget.clusterThreshold) ?? budget.clusterThreshold;
    const requestBase = Math.min(policy.baseConcurrentRequests, Math.max(1, budget.maxConcurrentLayers * 2));
    const requestBudget = lodRequestBudget(stabilizedDecision, requestBase) ?? requestBase;
    sequence += 1;
    lastPlan = Object.freeze({
      sequence,
      profile,
      lod: Object.freeze(stabilizedDecision),
      observedPressure,
      clusterTarget: clamp(clusterTarget, policy.minClusterTarget, policy.maxClusterTarget),
      concurrentRequests: clamp(requestBudget, policy.minConcurrentRequests, policy.maxConcurrentRequests),
      visibleFeatureBudget: budget.maxVisibleFeatures,
      queryCacheBytes: budget.maxQueryCacheBytes,
      residentLayerBudget: budget.maxResidentLayers,
      prefetch: budget.prefetch && stabilized.pressure === 'normal',
      pressureChanged: stabilized.changed,
      transitionSuppressed: stabilized.suppressed,
    });
    return lastPlan;
  };

  const updatePerformance = (
    nextProfile: GisPerformanceProfile,
    nextBudget: GisPerformanceBudget,
  ): SpatialPressureCoordinatorSnapshot => {
    validateBudget(nextBudget);
    if (nextProfile !== profile) metrics.profileChanges += 1;
    profile = nextProfile;
    budget = nextBudget;
    resetPending();
    return snapshot();
  };

  const reset = (): SpatialPressureCoordinatorSnapshot => {
    sequence = 0;
    stablePressure = 'normal';
    resetPending();
    lastPlan = null;
    metrics.observations = 0;
    metrics.rejectedObservations = 0;
    metrics.pressureTransitions = 0;
    metrics.suppressedTransitions = 0;
    metrics.profileChanges = 0;
    return snapshot();
  };

  return Object.freeze({ observe, updatePerformance, getSnapshot: snapshot, reset });
}
