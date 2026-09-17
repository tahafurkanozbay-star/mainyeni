import {
  createClusterLodDecision,
  type ClusterLodDecision,
} from './clusterLodPolicy';

export type ClusterSpatialReference = Readonly<{ wkid?: number; wkt?: string }>;

export type AdaptiveClusterFeature = Readonly<{
  id: string | number;
  x: number;
  y: number;
  weight?: number;
  selected?: boolean;
  spatialReference?: ClusterSpatialReference | null;
}>;

export type AdaptiveClusterView = Readonly<{
  width: number;
  height: number;
  zoom: number;
  scale?: number;
  averageFrameMs?: number;
  deviceMemoryGb?: number;
  reducedMotion?: boolean;
  spatialReference?: ClusterSpatialReference | null;
}>;

export type AdaptiveClusterOptions = Readonly<{
  maxInputFeatures?: number;
  maxClusters?: number;
  maxMembersPerCluster?: number;
  preserveSelectedFeatures?: boolean;
  rejectSpatialReferenceMismatch?: boolean;
  namespace?: string;
}>;

export type AdaptiveClusterNode = Readonly<{
  id: string;
  cellKey: string;
  x: number;
  y: number;
  count: number;
  totalWeight: number;
  memberIds: readonly string[];
  selectedMemberIds: readonly string[];
  truncatedMembers: boolean;
  spatialReference: ClusterSpatialReference | null;
}>;

export type AdaptiveClusterDiff = Readonly<{
  added: readonly AdaptiveClusterNode[];
  updated: readonly AdaptiveClusterNode[];
  removed: readonly string[];
  unchanged: readonly string[];
}>;

export type AdaptiveClusterMetrics = Readonly<{
  inputFeatures: number;
  acceptedFeatures: number;
  rejectedFeatures: number;
  rejectedSpatialReference: number;
  invalidCoordinates: number;
  truncatedInput: number;
  emittedClusters: number;
  truncatedClusters: number;
  selectedFeatures: number;
}>;

export type AdaptiveClusterSnapshot = Readonly<{
  generation: number;
  namespace: string;
  decision: ClusterLodDecision;
  clusters: readonly AdaptiveClusterNode[];
  diff: AdaptiveClusterDiff;
  metrics: AdaptiveClusterMetrics;
  spatialReference: ClusterSpatialReference | null;
}>;

export class AdaptiveClusterRuntimeError extends Error {
  readonly code: string;
  readonly featureId: string | null;

  constructor(message: string, code = 'ADAPTIVE_CLUSTER_RUNTIME_ERROR', featureId: string | null = null) {
    super(message);
    this.name = 'AdaptiveClusterRuntimeError';
    this.code = code;
    this.featureId = featureId;
  }
}

const finite = (value: unknown, fallback = 0): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const positiveInteger = (value: unknown, fallback: number, max: number): number => {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric <= 0) return fallback;
  return Math.min(max, numeric);
};

const normalizeId = (value: string | number): string => String(value).trim();

const normalizeSpatialReference = (value: ClusterSpatialReference | null | undefined): ClusterSpatialReference | null => {
  if (!value) return null;
  const wkid = Number(value.wkid);
  if (Number.isSafeInteger(wkid) && wkid > 0) return Object.freeze({ wkid });
  if (typeof value.wkt === 'string' && value.wkt.trim()) return Object.freeze({ wkt: value.wkt.trim() });
  return null;
};

const spatialReferenceKey = (value: ClusterSpatialReference | null): string => {
  if (!value) return 'unknown';
  if (value.wkid !== undefined) return `wkid:${value.wkid}`;
  return `wkt:${value.wkt ?? ''}`;
};

const sameSpatialReference = (left: ClusterSpatialReference | null, right: ClusterSpatialReference | null): boolean => {
  if (!left || !right) return left === right;
  return spatialReferenceKey(left) === spatialReferenceKey(right);
};

const hashString = (value: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

const throwIfAborted = (signal?: AbortSignal): void => {
  if (!signal?.aborted) return;
  const reason = signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? 'Cluster operation aborted');
  throw new AdaptiveClusterRuntimeError(reason, 'ABORTED');
};

const nodeSignature = (node: AdaptiveClusterNode): string => [
  node.cellKey,
  node.x.toFixed(5),
  node.y.toFixed(5),
  node.count,
  node.totalWeight.toFixed(5),
  node.memberIds.join(','),
  node.selectedMemberIds.join(','),
  node.truncatedMembers ? '1' : '0',
  spatialReferenceKey(node.spatialReference),
].join('|');

const diffClusters = (
  previous: ReadonlyMap<string, AdaptiveClusterNode>,
  next: ReadonlyMap<string, AdaptiveClusterNode>,
): AdaptiveClusterDiff => {
  const added: AdaptiveClusterNode[] = [];
  const updated: AdaptiveClusterNode[] = [];
  const removed: string[] = [];
  const unchanged: string[] = [];

  for (const [id, node] of next) {
    const before = previous.get(id);
    if (!before) {
      added.push(node);
    } else if (nodeSignature(before) !== nodeSignature(node)) {
      updated.push(node);
    } else {
      unchanged.push(id);
    }
  }
  for (const id of previous.keys()) {
    if (!next.has(id)) removed.push(id);
  }

  return Object.freeze({
    added: Object.freeze(added),
    updated: Object.freeze(updated),
    removed: Object.freeze(removed),
    unchanged: Object.freeze(unchanged),
  });
};

type MutableBucket = {
  cellKey: string;
  weightedX: number;
  weightedY: number;
  totalWeight: number;
  count: number;
  memberIds: string[];
  selectedMemberIds: string[];
  truncatedMembers: boolean;
};

const createCellKey = (x: number, y: number, cellSize: number): string => (
  `${Math.floor(x / cellSize)}:${Math.floor(y / cellSize)}`
);

const createClusterId = (
  namespace: string,
  cellKey: string,
  spatialReference: ClusterSpatialReference | null,
  members: readonly string[],
): string => {
  const identity = `${namespace}|${spatialReferenceKey(spatialReference)}|${cellKey}|${[...members].sort().join(',')}`;
  return `cluster:${hashString(identity)}`;
};

const standaloneNode = (
  namespace: string,
  feature: AdaptiveClusterFeature,
  spatialReference: ClusterSpatialReference | null,
): AdaptiveClusterNode => {
  const id = normalizeId(feature.id);
  return Object.freeze({
    id: `feature:${namespace}:${hashString(id)}`,
    cellKey: `selected:${id}`,
    x: feature.x,
    y: feature.y,
    count: 1,
    totalWeight: Math.max(0, finite(feature.weight, 1)),
    memberIds: Object.freeze([id]),
    selectedMemberIds: Object.freeze(feature.selected ? [id] : []),
    truncatedMembers: false,
    spatialReference,
  });
};

export const createAdaptiveClusterRuntime = (options: AdaptiveClusterOptions = {}) => {
  const maxInputFeatures = positiveInteger(options.maxInputFeatures, 100_000, 1_000_000);
  const maxClusters = positiveInteger(options.maxClusters, 20_000, 100_000);
  const maxMembersPerCluster = positiveInteger(options.maxMembersPerCluster, 128, 10_000);
  const preserveSelectedFeatures = options.preserveSelectedFeatures !== false;
  const rejectSpatialReferenceMismatch = options.rejectSpatialReferenceMismatch !== false;
  const namespace = String(options.namespace ?? 'gis').trim() || 'gis';

  let generation = 0;
  let previous = new Map<string, AdaptiveClusterNode>();
  let destroyed = false;

  const assertActive = (): void => {
    if (destroyed) {
      throw new AdaptiveClusterRuntimeError('Adaptive cluster runtime has been destroyed.', 'RUNTIME_DESTROYED');
    }
  };

  const cluster = (
    features: readonly AdaptiveClusterFeature[],
    view: AdaptiveClusterView,
    signal?: AbortSignal,
  ): AdaptiveClusterSnapshot => {
    assertActive();
    throwIfAborted(signal);

    const viewSpatialReference = normalizeSpatialReference(view.spatialReference);
    const decision = createClusterLodDecision({
      featureCount: features.length,
      viewportWidth: Math.max(1, finite(view.width, 1)),
      viewportHeight: Math.max(1, finite(view.height, 1)),
      zoom: finite(view.zoom),
      ...(view.averageFrameMs !== undefined ? { averageFrameMs: view.averageFrameMs } : {}),
      ...(view.deviceMemoryGb !== undefined ? { deviceMemoryGb: view.deviceMemoryGb } : {}),
      ...(view.reducedMotion !== undefined ? { reducedMotion: view.reducedMotion } : {}),
    });

    const input = features.slice(0, maxInputFeatures);
    const cellSize = Math.max(1, decision.clusterRadiusPx || 1);
    const buckets = new Map<string, MutableBucket>();
    const standalone: AdaptiveClusterNode[] = [];
    let rejectedFeatures = 0;
    let rejectedSpatialReference = 0;
    let invalidCoordinates = 0;
    let selectedFeatures = 0;

    for (let index = 0; index < input.length; index += 1) {
      if ((index & 511) === 0) throwIfAborted(signal);
      const feature = input[index];
      if (!feature) continue;
      const id = normalizeId(feature.id);
      if (!id || !Number.isFinite(feature.x) || !Number.isFinite(feature.y)) {
        rejectedFeatures += 1;
        invalidCoordinates += 1;
        continue;
      }

      const featureSpatialReference = normalizeSpatialReference(feature.spatialReference) ?? viewSpatialReference;
      if (
        rejectSpatialReferenceMismatch
        && viewSpatialReference
        && featureSpatialReference
        && !sameSpatialReference(featureSpatialReference, viewSpatialReference)
      ) {
        rejectedFeatures += 1;
        rejectedSpatialReference += 1;
        continue;
      }

      if (feature.selected) selectedFeatures += 1;
      if (decision.mode === 'off' || (preserveSelectedFeatures && feature.selected)) {
        standalone.push(standaloneNode(namespace, feature, featureSpatialReference));
        continue;
      }

      const cellKey = createCellKey(feature.x, feature.y, cellSize);
      const bucketKey = `${spatialReferenceKey(featureSpatialReference)}|${cellKey}`;
      const weight = Math.max(0.0001, finite(feature.weight, 1));
      const bucket = buckets.get(bucketKey) ?? {
        cellKey,
        weightedX: 0,
        weightedY: 0,
        totalWeight: 0,
        count: 0,
        memberIds: [],
        selectedMemberIds: [],
        truncatedMembers: false,
      };
      bucket.weightedX += feature.x * weight;
      bucket.weightedY += feature.y * weight;
      bucket.totalWeight += weight;
      bucket.count += 1;
      if (bucket.memberIds.length < maxMembersPerCluster) bucket.memberIds.push(id);
      else bucket.truncatedMembers = true;
      if (feature.selected && bucket.selectedMemberIds.length < maxMembersPerCluster) bucket.selectedMemberIds.push(id);
      buckets.set(bucketKey, bucket);
    }

    const clustered: AdaptiveClusterNode[] = [];
    for (const [bucketKey, bucket] of buckets) {
      const separator = bucketKey.indexOf('|');
      const srKey = separator >= 0 ? bucketKey.slice(0, separator) : 'unknown';
      const sr = srKey.startsWith('wkid:')
        ? Object.freeze({ wkid: Number(srKey.slice(5)) })
        : viewSpatialReference;
      const members = [...bucket.memberIds].sort();
      const divisor = Math.max(0.0001, bucket.totalWeight);
      clustered.push(Object.freeze({
        id: createClusterId(namespace, bucket.cellKey, sr, members),
        cellKey: bucket.cellKey,
        x: bucket.weightedX / divisor,
        y: bucket.weightedY / divisor,
        count: bucket.count,
        totalWeight: bucket.totalWeight,
        memberIds: Object.freeze(members),
        selectedMemberIds: Object.freeze([...bucket.selectedMemberIds].sort()),
        truncatedMembers: bucket.truncatedMembers,
        spatialReference: sr,
      }));
    }

    const ordered = [...standalone, ...clustered].sort((left, right) => left.id.localeCompare(right.id));
    const limited = ordered.slice(0, maxClusters);
    const next = new Map(limited.map((node) => [node.id, node]));
    const diff = diffClusters(previous, next);
    previous = next;
    generation += 1;

    return Object.freeze({
      generation,
      namespace,
      decision,
      clusters: Object.freeze(limited),
      diff,
      metrics: Object.freeze({
        inputFeatures: features.length,
        acceptedFeatures: input.length - rejectedFeatures,
        rejectedFeatures,
        rejectedSpatialReference,
        invalidCoordinates,
        truncatedInput: Math.max(0, features.length - input.length),
        emittedClusters: limited.length,
        truncatedClusters: Math.max(0, ordered.length - limited.length),
        selectedFeatures,
      }),
      spatialReference: viewSpatialReference,
    });
  };

  const reset = (): void => {
    assertActive();
    previous.clear();
    previous = new Map<string, AdaptiveClusterNode>();
    generation = 0;
  };

  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    previous.clear();
  };

  const snapshot = () => Object.freeze({
    generation,
    clusterCount: previous.size,
    namespace,
    destroyed,
    limits: Object.freeze({ maxInputFeatures, maxClusters, maxMembersPerCluster }),
  });

  return Object.freeze({ cluster, reset, destroy, snapshot });
};
