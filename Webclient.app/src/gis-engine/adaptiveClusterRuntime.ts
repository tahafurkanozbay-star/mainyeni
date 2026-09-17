import {
  clusterPointsIntoGrid,
  createClusterLodDecision,
  type ClusterBucket,
  type ClusterBucketPoint,
  type ClusterLodDecision,
  type ClusterMode,
} from './clusterLodPolicy';

export type ClusterRuntimePressure = 'normal' | 'elevated' | 'critical';
export type ClusterRuntimeTransitionReason =
  | 'initial'
  | 'viewport'
  | 'feature-count'
  | 'frame-pressure'
  | 'memory-pressure'
  | 'reduced-motion'
  | 'selection'
  | 'stable';

export interface AdaptiveClusterFeature extends ClusterBucketPoint {
  label?: string;
  selected?: boolean;
  importance?: number;
}

export interface AdaptiveClusterViewport {
  width: number;
  height: number;
  zoom: number;
  pixelRatio?: number;
}

export interface AdaptiveClusterPerformanceSample {
  frameMs?: number;
  deviceMemoryGb?: number;
  heapPressure?: number;
  reducedMotion?: boolean;
}

export interface AdaptiveClusterConfiguration {
  maxInputFeatures?: number;
  maxClusters?: number;
  maxIdsPerCluster?: number;
  maxSelectedFeatures?: number;
  hysteresisFrames?: number;
  criticalFrameMs?: number;
  elevatedFrameMs?: number;
}

export interface AdaptiveClusterInput {
  features: readonly AdaptiveClusterFeature[];
  viewport: AdaptiveClusterViewport;
  performance?: AdaptiveClusterPerformanceSample;
  selectedIds?: readonly (string | number)[];
}

export interface AdaptiveClusterRenderItem {
  key: string;
  kind: 'feature' | 'cluster';
  x: number;
  y: number;
  count: number;
  totalWeight: number;
  ids: readonly (string | number)[];
  selected: boolean;
  label: string | null;
}

export interface AdaptiveClusterResult {
  revision: number;
  decision: ClusterLodDecision;
  pressure: ClusterRuntimePressure;
  transitionReason: ClusterRuntimeTransitionReason;
  inputCount: number;
  acceptedCount: number;
  droppedCount: number;
  clusterCount: number;
  featureCount: number;
  labelCount: number;
  items: readonly AdaptiveClusterRenderItem[];
  selectedIds: readonly (string | number)[];
  fingerprint: string;
}

export interface AdaptiveClusterSnapshot {
  revision: number;
  disposed: boolean;
  lastMode: ClusterMode | null;
  stableFrames: number;
  pressure: ClusterRuntimePressure;
  lastInputCount: number;
  lastOutputCount: number;
  transitions: number;
  droppedFeatures: number;
}

interface NormalizedConfiguration {
  maxInputFeatures: number;
  maxClusters: number;
  maxIdsPerCluster: number;
  maxSelectedFeatures: number;
  hysteresisFrames: number;
  criticalFrameMs: number;
  elevatedFrameMs: number;
}

const DEFAULTS: NormalizedConfiguration = Object.freeze({
  maxInputFeatures: 100_000,
  maxClusters: 12_000,
  maxIdsPerCluster: 64,
  maxSelectedFeatures: 256,
  hysteresisFrames: 3,
  criticalFrameMs: 42,
  elevatedFrameMs: 25,
});

const finite = (value: unknown, fallback = 0): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const integer = (value: unknown, fallback: number, min: number, max: number): number => {
  const numeric = finite(value, fallback);
  return Math.min(max, Math.max(min, Math.floor(numeric)));
};

const normalizeConfiguration = (input: AdaptiveClusterConfiguration = {}): NormalizedConfiguration => Object.freeze({
  maxInputFeatures: integer(input.maxInputFeatures, DEFAULTS.maxInputFeatures, 1_000, 500_000),
  maxClusters: integer(input.maxClusters, DEFAULTS.maxClusters, 100, 100_000),
  maxIdsPerCluster: integer(input.maxIdsPerCluster, DEFAULTS.maxIdsPerCluster, 1, 1_000),
  maxSelectedFeatures: integer(input.maxSelectedFeatures, DEFAULTS.maxSelectedFeatures, 1, 10_000),
  hysteresisFrames: integer(input.hysteresisFrames, DEFAULTS.hysteresisFrames, 1, 30),
  criticalFrameMs: Math.max(20, finite(input.criticalFrameMs, DEFAULTS.criticalFrameMs)),
  elevatedFrameMs: Math.max(16, finite(input.elevatedFrameMs, DEFAULTS.elevatedFrameMs)),
});

const normalizeViewport = (viewport: AdaptiveClusterViewport): AdaptiveClusterViewport => Object.freeze({
  width: Math.max(1, finite(viewport.width, 1)),
  height: Math.max(1, finite(viewport.height, 1)),
  zoom: Math.min(24, Math.max(0, finite(viewport.zoom, 0))),
  pixelRatio: Math.min(4, Math.max(0.5, finite(viewport.pixelRatio, 1))),
});

const normalizeFeature = (feature: AdaptiveClusterFeature): AdaptiveClusterFeature | null => {
  const x = finite(feature.x, Number.NaN);
  const y = finite(feature.y, Number.NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return Object.freeze({
    id: feature.id,
    x,
    y,
    weight: Math.max(0, finite(feature.weight, 1)),
    label: typeof feature.label === 'string' && feature.label.trim() ? feature.label.trim() : undefined,
    selected: feature.selected === true,
    importance: Math.max(0, finite(feature.importance, 0)),
  });
};

const pressureRank = (pressure: ClusterRuntimePressure): number => (
  pressure === 'critical' ? 2 : pressure === 'elevated' ? 1 : 0
);

export const deriveClusterRuntimePressure = (
  sample: AdaptiveClusterPerformanceSample = {},
  configuration: AdaptiveClusterConfiguration = {},
): ClusterRuntimePressure => {
  const config = normalizeConfiguration(configuration);
  const frameMs = Math.max(0, finite(sample.frameMs, 16.67));
  const memoryGb = Math.max(0.25, finite(sample.deviceMemoryGb, 4));
  const heapPressure = Math.min(1, Math.max(0, finite(sample.heapPressure, 0)));

  if (frameMs >= config.criticalFrameMs || memoryGb < 1.5 || heapPressure >= 0.9) return 'critical';
  if (frameMs >= config.elevatedFrameMs || memoryGb < 3 || heapPressure >= 0.7) return 'elevated';
  return 'normal';
};

const selectionSet = (
  features: readonly AdaptiveClusterFeature[],
  selectedIds: readonly (string | number)[] | undefined,
  limit: number,
): Set<string | number> => {
  const selected = new Set<string | number>();
  for (const id of selectedIds ?? []) {
    if (selected.size >= limit) break;
    selected.add(id);
  }
  for (const feature of features) {
    if (selected.size >= limit) break;
    if (feature.selected) selected.add(feature.id);
  }
  return selected;
};

const featureScore = (feature: AdaptiveClusterFeature, selected: Set<string | number>): number => {
  if (selected.has(feature.id)) return 1_000_000_000;
  return Math.max(0, finite(feature.importance, 0)) * 10_000 + Math.max(0, finite(feature.weight, 1));
};

const deterministicSample = (
  features: readonly AdaptiveClusterFeature[],
  limit: number,
  selected: Set<string | number>,
): readonly AdaptiveClusterFeature[] => {
  if (features.length <= limit) return features;
  const mustKeep = features.filter((feature) => selected.has(feature.id));
  const remainingLimit = Math.max(0, limit - mustKeep.length);
  const candidates = features
    .filter((feature) => !selected.has(feature.id))
    .map((feature, index) => ({ feature, index, score: featureScore(feature, selected) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, remainingLimit)
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.feature);
  return Object.freeze([...mustKeep, ...candidates]);
};

const bucketSelected = (bucket: ClusterBucket, selected: Set<string | number>): boolean => (
  bucket.ids.some((id) => selected.has(id))
);

const stableItemFingerprint = (items: readonly AdaptiveClusterRenderItem[]): string => {
  let hash = 2_166_136_261;
  const feed = (value: string): void => {
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16_777_619) >>> 0;
    }
  };
  for (const item of items) {
    feed(item.key);
    feed(String(item.count));
    feed(item.selected ? '1' : '0');
  }
  return hash.toString(16).padStart(8, '0');
};

const featureToItem = (
  feature: AdaptiveClusterFeature,
  selected: Set<string | number>,
  allowLabel: boolean,
): AdaptiveClusterRenderItem => Object.freeze({
  key: `feature:${typeof feature.id}:${String(feature.id)}`,
  kind: 'feature',
  x: feature.x,
  y: feature.y,
  count: 1,
  totalWeight: Math.max(0, finite(feature.weight, 1)),
  ids: Object.freeze([feature.id]),
  selected: selected.has(feature.id),
  label: allowLabel ? feature.label ?? null : null,
});

const bucketToItem = (
  bucket: ClusterBucket,
  selected: Set<string | number>,
): AdaptiveClusterRenderItem => Object.freeze({
  key: `cluster:${bucket.key}`,
  kind: 'cluster',
  x: bucket.x,
  y: bucket.y,
  count: bucket.count,
  totalWeight: bucket.totalWeight,
  ids: bucket.ids,
  selected: bucketSelected(bucket, selected),
  label: String(bucket.count),
});

const applyItemBudget = (
  items: readonly AdaptiveClusterRenderItem[],
  limit: number,
): readonly AdaptiveClusterRenderItem[] => {
  if (items.length <= limit) return Object.freeze([...items]);
  const selected = items.filter((item) => item.selected);
  const rest = items.filter((item) => !item.selected);
  const selectedBudget = selected.slice(0, limit);
  const remaining = Math.max(0, limit - selectedBudget.length);
  return Object.freeze([...selectedBudget, ...rest.slice(0, remaining)]);
};

const createItems = (
  features: readonly AdaptiveClusterFeature[],
  decision: ClusterLodDecision,
  selected: Set<string | number>,
  configuration: NormalizedConfiguration,
): readonly AdaptiveClusterRenderItem[] => {
  if (decision.mode === 'off' || decision.clusterRadiusPx <= 0) {
    const labelBudget = decision.labelBudget;
    let labelsUsed = 0;
    const items = features.map((feature) => {
      const selectedFeature = selected.has(feature.id);
      const allowLabel = selectedFeature || (feature.label != null && labelsUsed < labelBudget);
      if (allowLabel && !selectedFeature) labelsUsed += 1;
      return featureToItem(feature, selected, allowLabel);
    });
    return applyItemBudget(items, Math.min(decision.maxVisibleFeatures, configuration.maxClusters));
  }

  const buckets = clusterPointsIntoGrid(features, decision.clusterRadiusPx, configuration.maxIdsPerCluster);
  const items = buckets.map((bucket) => bucketToItem(bucket, selected));
  return applyItemBudget(items, configuration.maxClusters);
};

const transitionReason = (
  previousMode: ClusterMode | null,
  nextMode: ClusterMode,
  previousPressure: ClusterRuntimePressure,
  nextPressure: ClusterRuntimePressure,
  previousInputCount: number,
  nextInputCount: number,
  previousZoom: number | null,
  nextZoom: number,
  reducedMotionChanged: boolean,
  selectionChanged: boolean,
): ClusterRuntimeTransitionReason => {
  if (previousMode === null) return 'initial';
  if (previousPressure !== nextPressure) {
    return pressureRank(nextPressure) > pressureRank(previousPressure) ? 'frame-pressure' : 'memory-pressure';
  }
  if (Math.abs((previousZoom ?? nextZoom) - nextZoom) >= 0.5) return 'viewport';
  if (Math.abs(previousInputCount - nextInputCount) >= Math.max(100, previousInputCount * 0.1)) return 'feature-count';
  if (reducedMotionChanged) return 'reduced-motion';
  if (selectionChanged) return 'selection';
  if (previousMode !== nextMode) return 'frame-pressure';
  return 'stable';
};

export class AdaptiveClusterRuntime {
  #configuration: NormalizedConfiguration;
  #revision = 0;
  #disposed = false;
  #lastMode: ClusterMode | null = null;
  #candidateMode: ClusterMode | null = null;
  #candidateFrames = 0;
  #stableFrames = 0;
  #pressure: ClusterRuntimePressure = 'normal';
  #lastInputCount = 0;
  #lastOutputCount = 0;
  #lastZoom: number | null = null;
  #lastReducedMotion = false;
  #lastSelectionFingerprint = '';
  #transitions = 0;
  #droppedFeatures = 0;

  constructor(configuration: AdaptiveClusterConfiguration = {}) {
    this.#configuration = normalizeConfiguration(configuration);
  }

  configure(configuration: AdaptiveClusterConfiguration): AdaptiveClusterSnapshot {
    this.#assertActive();
    this.#configuration = normalizeConfiguration({ ...this.#configuration, ...configuration });
    return this.snapshot();
  }

  evaluate(input: AdaptiveClusterInput): AdaptiveClusterResult {
    this.#assertActive();
    const viewport = normalizeViewport(input.viewport);
    const normalized = input.features
      .map(normalizeFeature)
      .filter((feature): feature is AdaptiveClusterFeature => feature !== null);
    const selected = selectionSet(normalized, input.selectedIds, this.#configuration.maxSelectedFeatures);
    const sampled = deterministicSample(normalized, this.#configuration.maxInputFeatures, selected);
    const pressure = deriveClusterRuntimePressure(input.performance, this.#configuration);
    const reducedMotion = input.performance?.reducedMotion === true;
    const selectionFingerprint = [...selected].map(String).sort().join('|');

    const rawDecision = createClusterLodDecision({
      featureCount: sampled.length,
      viewportWidth: viewport.width * (viewport.pixelRatio ?? 1),
      viewportHeight: viewport.height * (viewport.pixelRatio ?? 1),
      zoom: viewport.zoom,
      averageFrameMs: input.performance?.frameMs,
      deviceMemoryGb: input.performance?.deviceMemoryGb,
      reducedMotion,
    });
    const mode = this.#resolveMode(rawDecision.mode, pressure);
    const decision = Object.freeze({ ...rawDecision, mode });
    const items = createItems(sampled, decision, selected, this.#configuration);
    const labels = items.reduce((count, item) => count + (item.label == null ? 0 : 1), 0);
    const reason = transitionReason(
      this.#lastMode,
      mode,
      this.#pressure,
      pressure,
      this.#lastInputCount,
      normalized.length,
      this.#lastZoom,
      viewport.zoom,
      this.#lastReducedMotion !== reducedMotion,
      this.#lastSelectionFingerprint !== selectionFingerprint,
    );

    this.#revision += 1;
    if (this.#lastMode !== null && this.#lastMode !== mode) this.#transitions += 1;
    this.#lastMode = mode;
    this.#pressure = pressure;
    this.#lastInputCount = normalized.length;
    this.#lastOutputCount = items.length;
    this.#lastZoom = viewport.zoom;
    this.#lastReducedMotion = reducedMotion;
    this.#lastSelectionFingerprint = selectionFingerprint;
    this.#droppedFeatures += Math.max(0, normalized.length - sampled.length);

    return Object.freeze({
      revision: this.#revision,
      decision,
      pressure,
      transitionReason: reason,
      inputCount: input.features.length,
      acceptedCount: sampled.length,
      droppedCount: Math.max(0, input.features.length - sampled.length),
      clusterCount: items.filter((item) => item.kind === 'cluster').length,
      featureCount: items.filter((item) => item.kind === 'feature').length,
      labelCount: labels,
      items,
      selectedIds: Object.freeze([...selected]),
      fingerprint: stableItemFingerprint(items),
    });
  }

  snapshot(): AdaptiveClusterSnapshot {
    return Object.freeze({
      revision: this.#revision,
      disposed: this.#disposed,
      lastMode: this.#lastMode,
      stableFrames: this.#stableFrames,
      pressure: this.#pressure,
      lastInputCount: this.#lastInputCount,
      lastOutputCount: this.#lastOutputCount,
      transitions: this.#transitions,
      droppedFeatures: this.#droppedFeatures,
    });
  }

  reset(): void {
    this.#assertActive();
    this.#revision = 0;
    this.#lastMode = null;
    this.#candidateMode = null;
    this.#candidateFrames = 0;
    this.#stableFrames = 0;
    this.#pressure = 'normal';
    this.#lastInputCount = 0;
    this.#lastOutputCount = 0;
    this.#lastZoom = null;
    this.#lastReducedMotion = false;
    this.#lastSelectionFingerprint = '';
    this.#transitions = 0;
    this.#droppedFeatures = 0;
  }

  dispose(): void {
    this.#disposed = true;
  }

  #resolveMode(requested: ClusterMode, pressure: ClusterRuntimePressure): ClusterMode {
    const pressureFloor: ClusterMode = pressure === 'critical'
      ? 'aggressive'
      : pressure === 'elevated'
        ? 'soft'
        : 'off';
    const rank: Record<ClusterMode, number> = { off: 0, soft: 1, aggressive: 2 };
    const target = rank[requested] >= rank[pressureFloor] ? requested : pressureFloor;

    if (this.#lastMode === null || target === this.#lastMode) {
      this.#candidateMode = null;
      this.#candidateFrames = 0;
      this.#stableFrames += 1;
      return target;
    }

    if (rank[target] > rank[this.#lastMode]) {
      this.#candidateMode = null;
      this.#candidateFrames = 0;
      this.#stableFrames = 0;
      return target;
    }

    if (this.#candidateMode !== target) {
      this.#candidateMode = target;
      this.#candidateFrames = 1;
      return this.#lastMode;
    }

    this.#candidateFrames += 1;
    if (this.#candidateFrames >= this.#configuration.hysteresisFrames) {
      this.#candidateMode = null;
      this.#candidateFrames = 0;
      this.#stableFrames = 0;
      return target;
    }
    return this.#lastMode;
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw Object.assign(new Error('Adaptive cluster runtime has been disposed.'), {
        code: 'CLUSTER_RUNTIME_DISPOSED',
      });
    }
  }
}

export const createAdaptiveClusterRuntime = (
  configuration: AdaptiveClusterConfiguration = {},
): AdaptiveClusterRuntime => new AdaptiveClusterRuntime(configuration);
