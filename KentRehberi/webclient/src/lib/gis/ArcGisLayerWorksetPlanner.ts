export type ArcGisLayerWorksetViewMode = '2d' | '3d';
export type ArcGisLayerWorksetPriority = 'critical' | 'visible' | 'background';
export type ArcGisLayerWorksetHealth = 'available' | 'degraded' | 'unavailable';
export type ArcGisLayerWorksetRejectReason =
  | 'active-layer-budget'
  | 'cpu-budget'
  | 'draw-call-budget'
  | 'feature-budget'
  | 'gpu-budget'
  | 'hidden'
  | 'scale-range'
  | 'unavailable';

export interface ArcGisLayerWorksetCandidate {
  readonly layerKey: string;
  readonly priority: ArcGisLayerWorksetPriority;
  readonly health: ArcGisLayerWorksetHealth;
  readonly requestedVisible: boolean;
  readonly minScale: number;
  readonly maxScale: number;
  readonly featureCountEstimate: number;
  readonly cpuMsEstimate: number;
  readonly gpuBytesEstimate: number;
  readonly drawCallsEstimate: number;
}

export interface ArcGisLayerWorksetPolicy {
  readonly maxCandidates: number;
  readonly maxLayerKeyLength: number;
  readonly maxActiveLayers2d: number;
  readonly maxActiveLayers3d: number;
  readonly maxFeatures2d: number;
  readonly maxFeatures3d: number;
  readonly maxCpuMs2d: number;
  readonly maxCpuMs3d: number;
  readonly maxGpuBytes2d: number;
  readonly maxGpuBytes3d: number;
  readonly maxDrawCalls2d: number;
  readonly maxDrawCalls3d: number;
}

export interface ArcGisLayerWorksetRejection {
  readonly layerKey: string;
  readonly reason: ArcGisLayerWorksetRejectReason;
}

export interface ArcGisLayerWorksetPlan {
  readonly viewMode: ArcGisLayerWorksetViewMode;
  readonly viewScale: number;
  readonly admittedLayerKeys: readonly string[];
  readonly rejected: readonly ArcGisLayerWorksetRejection[];
  readonly activeLayerCount: number;
  readonly featureCountEstimate: number;
  readonly cpuMsEstimate: number;
  readonly gpuBytesEstimate: number;
  readonly drawCallsEstimate: number;
}

const integer = (value: number, name: string, allowZero = false): number => {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) throw new Error(`${name} outside configured bounds`);
  return value;
};

const finite = (value: number, name: string, minimum = 0): number => {
  if (!Number.isFinite(value) || value < minimum) throw new Error(`${name} outside configured bounds`);
  return value;
};

const boundedText = (value: string, maxLength: number, name: string): string => {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || normalized.includes('\0')) throw new Error(`${name} outside configured bounds`);
  return normalized;
};

const priorityRank: Readonly<Record<ArcGisLayerWorksetPriority, number>> = Object.freeze({ critical: 0, visible: 1, background: 2 });
const healthRank: Readonly<Record<ArcGisLayerWorksetHealth, number>> = Object.freeze({ available: 0, degraded: 1, unavailable: 2 });

/**
 * Deterministic layer admission planner that combines ArcGIS scale visibility with bounded
 * CPU/GPU/draw/feature budgets. It owns no Layer, LayerView, renderer, query or transport state.
 */
export class ArcGisLayerWorksetPlanner {
  private readonly policy: Readonly<ArcGisLayerWorksetPolicy>;

  constructor(policy: ArcGisLayerWorksetPolicy) {
    this.policy = Object.freeze({
      maxCandidates: integer(policy.maxCandidates, 'maxCandidates'),
      maxLayerKeyLength: integer(policy.maxLayerKeyLength, 'maxLayerKeyLength'),
      maxActiveLayers2d: integer(policy.maxActiveLayers2d, 'maxActiveLayers2d'),
      maxActiveLayers3d: integer(policy.maxActiveLayers3d, 'maxActiveLayers3d'),
      maxFeatures2d: integer(policy.maxFeatures2d, 'maxFeatures2d'),
      maxFeatures3d: integer(policy.maxFeatures3d, 'maxFeatures3d'),
      maxCpuMs2d: this.positiveFinite(policy.maxCpuMs2d, 'maxCpuMs2d'),
      maxCpuMs3d: this.positiveFinite(policy.maxCpuMs3d, 'maxCpuMs3d'),
      maxGpuBytes2d: integer(policy.maxGpuBytes2d, 'maxGpuBytes2d'),
      maxGpuBytes3d: integer(policy.maxGpuBytes3d, 'maxGpuBytes3d'),
      maxDrawCalls2d: integer(policy.maxDrawCalls2d, 'maxDrawCalls2d'),
      maxDrawCalls3d: integer(policy.maxDrawCalls3d, 'maxDrawCalls3d'),
    });
  }

  plan(viewModeValue: ArcGisLayerWorksetViewMode, viewScaleValue: number, candidatesValue: readonly ArcGisLayerWorksetCandidate[]): ArcGisLayerWorksetPlan {
    this.assertViewMode(viewModeValue);
    const viewScale = finite(viewScaleValue, 'viewScale');
    if (!Array.isArray(candidatesValue) || candidatesValue.length > this.policy.maxCandidates) throw new Error('candidate count outside configured bounds');
    const candidates = candidatesValue.map((candidate) => this.normalizeCandidate(candidate));
    const identities = new Set<string>();
    for (const candidate of candidates) {
      if (identities.has(candidate.layerKey)) throw new Error('duplicate layer workset candidate');
      identities.add(candidate.layerKey);
    }

    const rejected: ArcGisLayerWorksetRejection[] = [];
    const eligible: ArcGisLayerWorksetCandidate[] = [];
    for (const candidate of candidates) {
      if (!candidate.requestedVisible) {
        rejected.push(Object.freeze({ layerKey: candidate.layerKey, reason: 'hidden' }));
      } else if (candidate.health === 'unavailable') {
        rejected.push(Object.freeze({ layerKey: candidate.layerKey, reason: 'unavailable' }));
      } else if (!this.scaleVisible(candidate.minScale, candidate.maxScale, viewScale)) {
        rejected.push(Object.freeze({ layerKey: candidate.layerKey, reason: 'scale-range' }));
      } else {
        eligible.push(candidate);
      }
    }

    eligible.sort((left, right) =>
      priorityRank[left.priority] - priorityRank[right.priority]
      || healthRank[left.health] - healthRank[right.health]
      || left.cpuMsEstimate - right.cpuMsEstimate
      || left.gpuBytesEstimate - right.gpuBytesEstimate
      || left.layerKey.localeCompare(right.layerKey));

    const limits = this.limits(viewModeValue);
    const admittedLayerKeys: string[] = [];
    let featureCountEstimate = 0;
    let cpuMsEstimate = 0;
    let gpuBytesEstimate = 0;
    let drawCallsEstimate = 0;

    for (const candidate of eligible) {
      if (admittedLayerKeys.length >= limits.maxActiveLayers) {
        rejected.push(Object.freeze({ layerKey: candidate.layerKey, reason: 'active-layer-budget' }));
        continue;
      }
      if (featureCountEstimate + candidate.featureCountEstimate > limits.maxFeatures) {
        rejected.push(Object.freeze({ layerKey: candidate.layerKey, reason: 'feature-budget' }));
        continue;
      }
      if (cpuMsEstimate + candidate.cpuMsEstimate > limits.maxCpuMs) {
        rejected.push(Object.freeze({ layerKey: candidate.layerKey, reason: 'cpu-budget' }));
        continue;
      }
      if (gpuBytesEstimate + candidate.gpuBytesEstimate > limits.maxGpuBytes) {
        rejected.push(Object.freeze({ layerKey: candidate.layerKey, reason: 'gpu-budget' }));
        continue;
      }
      if (drawCallsEstimate + candidate.drawCallsEstimate > limits.maxDrawCalls) {
        rejected.push(Object.freeze({ layerKey: candidate.layerKey, reason: 'draw-call-budget' }));
        continue;
      }
      admittedLayerKeys.push(candidate.layerKey);
      featureCountEstimate += candidate.featureCountEstimate;
      cpuMsEstimate += candidate.cpuMsEstimate;
      gpuBytesEstimate += candidate.gpuBytesEstimate;
      drawCallsEstimate += candidate.drawCallsEstimate;
    }

    rejected.sort((left, right) => left.layerKey.localeCompare(right.layerKey) || left.reason.localeCompare(right.reason));
    return Object.freeze({
      viewMode: viewModeValue,
      viewScale,
      admittedLayerKeys: Object.freeze(admittedLayerKeys),
      rejected: Object.freeze(rejected),
      activeLayerCount: admittedLayerKeys.length,
      featureCountEstimate,
      cpuMsEstimate,
      gpuBytesEstimate,
      drawCallsEstimate,
    });
  }

  private normalizeCandidate(input: ArcGisLayerWorksetCandidate): ArcGisLayerWorksetCandidate {
    if (!input || typeof input !== 'object') throw new Error('layer workset candidate is required');
    const layerKey = boundedText(input.layerKey, this.policy.maxLayerKeyLength, 'layer key');
    this.assertPriority(input.priority);
    this.assertHealth(input.health);
    if (typeof input.requestedVisible !== 'boolean') throw new Error('requestedVisible must be boolean');
    const minScale = finite(input.minScale, 'minScale');
    const maxScale = finite(input.maxScale, 'maxScale');
    if (minScale !== 0 && maxScale !== 0 && minScale < maxScale) throw new Error('minScale must be zero or greater than or equal to maxScale');
    return Object.freeze({
      layerKey,
      priority: input.priority,
      health: input.health,
      requestedVisible: input.requestedVisible,
      minScale,
      maxScale,
      featureCountEstimate: integer(input.featureCountEstimate, 'featureCountEstimate', true),
      cpuMsEstimate: finite(input.cpuMsEstimate, 'cpuMsEstimate'),
      gpuBytesEstimate: integer(input.gpuBytesEstimate, 'gpuBytesEstimate', true),
      drawCallsEstimate: integer(input.drawCallsEstimate, 'drawCallsEstimate', true),
    });
  }

  private scaleVisible(minScale: number, maxScale: number, viewScale: number): boolean {
    const withinMinimum = minScale === 0 || viewScale <= minScale;
    const withinMaximum = maxScale === 0 || viewScale >= maxScale;
    return withinMinimum && withinMaximum;
  }

  private limits(viewMode: ArcGisLayerWorksetViewMode): Readonly<{
    maxActiveLayers: number;
    maxFeatures: number;
    maxCpuMs: number;
    maxGpuBytes: number;
    maxDrawCalls: number;
  }> {
    return viewMode === '2d'
      ? Object.freeze({ maxActiveLayers: this.policy.maxActiveLayers2d, maxFeatures: this.policy.maxFeatures2d, maxCpuMs: this.policy.maxCpuMs2d, maxGpuBytes: this.policy.maxGpuBytes2d, maxDrawCalls: this.policy.maxDrawCalls2d })
      : Object.freeze({ maxActiveLayers: this.policy.maxActiveLayers3d, maxFeatures: this.policy.maxFeatures3d, maxCpuMs: this.policy.maxCpuMs3d, maxGpuBytes: this.policy.maxGpuBytes3d, maxDrawCalls: this.policy.maxDrawCalls3d });
  }

  private positiveFinite(value: number, name: string): number {
    const normalized = finite(value, name);
    if (normalized <= 0) throw new Error(`${name} must be positive`);
    return normalized;
  }

  private assertViewMode(value: string): asserts value is ArcGisLayerWorksetViewMode {
    if (value !== '2d' && value !== '3d') throw new Error('invalid workset view mode');
  }

  private assertPriority(value: string): asserts value is ArcGisLayerWorksetPriority {
    if (value !== 'critical' && value !== 'visible' && value !== 'background') throw new Error('invalid layer workset priority');
  }

  private assertHealth(value: string): asserts value is ArcGisLayerWorksetHealth {
    if (value !== 'available' && value !== 'degraded' && value !== 'unavailable') throw new Error('invalid layer workset health');
  }
}
