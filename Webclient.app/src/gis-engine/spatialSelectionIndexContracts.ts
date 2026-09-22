export type SelectionPriority = 'background' | 'normal' | 'high' | 'critical';

export type SpatialSelectionIndexHealth = 'healthy' | 'degraded' | 'blocked';

export type SpatialSelectionMutationKind =
  | 'upsert'
  | 'remove'
  | 'evict'
  | 'remove-layer'
  | 'clear'
  | 'dispose';

export type SpatialSelectionEvictionReason =
  | 'global-entry-budget'
  | 'global-byte-budget'
  | 'layer-entry-budget'
  | 'layer-byte-budget'
  | 'layer-count-budget'
  | 'explicit-remove'
  | 'layer-remove'
  | 'clear'
  | 'dispose';

export type SpatialSelectionQueryKind = 'extent' | 'nearest';

export interface SelectionBounds {
  readonly xmin: number;
  readonly ymin: number;
  readonly xmax: number;
  readonly ymax: number;
}

export interface SpatialSelectionRecord<T> {
  readonly id: string;
  readonly layerId: string;
  readonly bounds: SelectionBounds;
  readonly priority: SelectionPriority;
  readonly payload: T;
  readonly estimatedBytes: number;
  readonly revision: number;
}

export interface SpatialSelectionIndexOptions {
  readonly maxEntries?: number;
  readonly maxBytes?: number;
  readonly maxEntriesPerLayer?: number;
  readonly maxBytesPerLayer?: number;
  readonly maxLayers?: number;
  readonly maxQueryResults?: number;
  readonly maxQueryCandidates?: number;
  readonly maxHistory?: number;
  readonly maxIdLength?: number;
  readonly maxLayerIdLength?: number;
  readonly gridCellSize?: number;
  readonly maxGridCells?: number;
  readonly maxGridReferences?: number;
  readonly maxCellsPerRecord?: number;
  readonly maxGridBucketSize?: number;
  readonly nearestInitialRadius?: number;
  readonly nearestMaxRadius?: number;
  readonly nearestExpansionSteps?: number;
  readonly degradedBudgetRatio?: number;
  readonly blockedBudgetRatio?: number;
}

export interface NormalizedSpatialSelectionIndexPolicy {
  readonly maxEntries: number;
  readonly maxBytes: number;
  readonly maxEntriesPerLayer: number;
  readonly maxBytesPerLayer: number;
  readonly maxLayers: number;
  readonly maxQueryResults: number;
  readonly maxQueryCandidates: number;
  readonly maxHistory: number;
  readonly maxIdLength: number;
  readonly maxLayerIdLength: number;
  readonly gridCellSize: number;
  readonly maxGridCells: number;
  readonly maxGridReferences: number;
  readonly maxCellsPerRecord: number;
  readonly maxGridBucketSize: number;
  readonly nearestInitialRadius: number;
  readonly nearestMaxRadius: number;
  readonly nearestExpansionSteps: number;
  readonly degradedBudgetRatio: number;
  readonly blockedBudgetRatio: number;
}

export interface SpatialSelectionQuery {
  readonly bounds: SelectionBounds;
  readonly layerIds?: ReadonlySet<string>;
  readonly minimumPriority?: SelectionPriority;
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

export interface SpatialSelectionNearestQuery {
  readonly point: Readonly<{
    x: number;
    y: number;
  }>;
  readonly layerIds?: ReadonlySet<string>;
  readonly minimumPriority?: SelectionPriority;
  readonly limit?: number;
  readonly initialRadius?: number;
  readonly maxRadius?: number;
  readonly expansionSteps?: number;
  readonly signal?: AbortSignal;
}

export interface SpatialSelectionQueryDiagnostics {
  readonly kind: SpatialSelectionQueryKind;
  readonly candidates: number;
  readonly matched: number;
  readonly returned: number;
  readonly truncated: boolean;
  readonly gridQueries: number;
  readonly filteredByLayer: number;
  readonly filteredByPriority: number;
}

export interface SpatialSelectionQueryResult<T> {
  readonly records: readonly SpatialSelectionRecord<T>[];
  readonly diagnostics: SpatialSelectionQueryDiagnostics;
}

export interface SpatialSelectionLayerSnapshot {
  readonly layerId: string;
  readonly entries: number;
  readonly estimatedBytes: number;
  readonly maxEntries: number;
  readonly maxBytes: number;
  readonly utilization: number;
}

export interface SpatialSelectionSnapshot {
  readonly disposed: boolean;
  readonly health: SpatialSelectionIndexHealth;
  readonly entries: number;
  readonly estimatedBytes: number;
  readonly layers: number;
  readonly revision: number;
  readonly evictions: number;
  readonly rejected: number;
  readonly mutations: number;
  readonly queries: number;
  readonly extentQueries: number;
  readonly nearestQueries: number;
  readonly cacheTouches: number;
  readonly maxEntries: number;
  readonly maxBytes: number;
  readonly maxLayers: number;
  readonly utilization: number;
  readonly grid: Readonly<{
    featureCount: number;
    cellCount: number;
    referenceCount: number;
    ownerCount: number;
    cellSize: number;
    maximumFeatures: number;
    maximumCells: number;
    maximumReferences: number;
    maximumCellsPerFeature: number;
    maximumBucketSize: number;
  }>;
}

export interface SpatialSelectionMutation {
  readonly kind: SpatialSelectionMutationKind;
  readonly id: string | null;
  readonly layerId: string | null;
  readonly revision: number;
  readonly reason: SpatialSelectionEvictionReason | null;
  readonly estimatedBytes: number;
}

export type SpatialSelectionIndexErrorCode =
  | 'DISPOSED'
  | 'INVALID_ID'
  | 'INVALID_LAYER_ID'
  | 'INVALID_BOUNDS'
  | 'INVALID_PRIORITY'
  | 'INVALID_ESTIMATED_BYTES'
  | 'ENTRY_BYTE_BUDGET_EXCEEDED'
  | 'LAYER_BUDGET_EXCEEDED'
  | 'LAYER_COUNT_BUDGET_EXCEEDED'
  | 'GRID_BUDGET_EXCEEDED'
  | 'ABORTED';

export class SpatialSelectionIndexError extends Error {
  public constructor(
    public readonly code: SpatialSelectionIndexErrorCode,
    message: string,
    public readonly causeValue?: unknown,
  ) {
    super(message);
    this.name = 'SpatialSelectionIndexError';
  }
}

export const SELECTION_PRIORITY_RANK: Readonly<Record<SelectionPriority, number>> = Object.freeze({
  background: 0,
  normal: 1,
  high: 2,
  critical: 3,
});

export const DEFAULT_SPATIAL_SELECTION_INDEX_POLICY: NormalizedSpatialSelectionIndexPolicy = Object.freeze({
  maxEntries: 25_000,
  maxBytes: 64 * 1024 * 1024,
  maxEntriesPerLayer: 5_000,
  maxBytesPerLayer: 16 * 1024 * 1024,
  maxLayers: 256,
  maxQueryResults: 1_000,
  maxQueryCandidates: 10_000,
  maxHistory: 512,
  maxIdLength: 512,
  maxLayerIdLength: 256,
  gridCellSize: 1_000,
  maxGridCells: 100_000,
  maxGridReferences: 500_000,
  maxCellsPerRecord: 4_096,
  maxGridBucketSize: 10_000,
  nearestInitialRadius: 250,
  nearestMaxRadius: 100_000,
  nearestExpansionSteps: 10,
  degradedBudgetRatio: 0.72,
  blockedBudgetRatio: 0.92,
});

const positiveInteger = (
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number => {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > maximum) {
    throw new RangeError(`${name} must be a positive safe integer no greater than ${maximum}`);
  }
  return resolved;
};

const positiveFinite = (
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number => {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0 || resolved > maximum) {
    throw new RangeError(`${name} must be finite, positive, and no greater than ${maximum}`);
  }
  return resolved;
};

const ratio = (
  value: number | undefined,
  fallback: number,
  name: string,
): number => {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0 || resolved > 1) {
    throw new RangeError(`${name} must be greater than zero and no greater than one`);
  }
  return resolved;
};

export const normalizeSpatialSelectionIndexPolicy = (
  options: SpatialSelectionIndexOptions = {},
): NormalizedSpatialSelectionIndexPolicy => {
  const maxEntries = positiveInteger(
    options.maxEntries,
    DEFAULT_SPATIAL_SELECTION_INDEX_POLICY.maxEntries,
    1_000_000,
    'maxEntries',
  );
  const maxBytes = positiveInteger(
    options.maxBytes,
    DEFAULT_SPATIAL_SELECTION_INDEX_POLICY.maxBytes,
    4 * 1024 * 1024 * 1024,
    'maxBytes',
  );
  const maxEntriesPerLayer = positiveInteger(
    options.maxEntriesPerLayer,
    DEFAULT_SPATIAL_SELECTION_INDEX_POLICY.maxEntriesPerLayer,
    maxEntries,
    'maxEntriesPerLayer',
  );
  const maxBytesPerLayer = positiveInteger(
    options.maxBytesPerLayer,
    DEFAULT_SPATIAL_SELECTION_INDEX_POLICY.maxBytesPerLayer,
    maxBytes,
    'maxBytesPerLayer',
  );
  const maxLayers = positiveInteger(
    options.maxLayers,
    DEFAULT_SPATIAL_SELECTION_INDEX_POLICY.maxLayers,
    100_000,
    'maxLayers',
  );
  const maxQueryResults = positiveInteger(
    options.maxQueryResults,
    DEFAULT_SPATIAL_SELECTION_INDEX_POLICY.maxQueryResults,
    maxEntries,
    'maxQueryResults',
  );
  const maxQueryCandidates = positiveInteger(
    options.maxQueryCandidates,
    DEFAULT_SPATIAL_SELECTION_INDEX_POLICY.maxQueryCandidates,
    Math.min(maxEntries, 100_000),
    'maxQueryCandidates',
  );
  const maxHistory = positiveInteger(
    options.maxHistory,
    DEFAULT_SPATIAL_SELECTION_INDEX_POLICY.maxHistory,
    100_000,
    'maxHistory',
  );
  const maxIdLength = positiveInteger(
    options.maxIdLength,
    DEFAULT_SPATIAL_SELECTION_INDEX_POLICY.maxIdLength,
    16_384,
    'maxIdLength',
  );
  const maxLayerIdLength = positiveInteger(
    options.maxLayerIdLength,
    DEFAULT_SPATIAL_SELECTION_INDEX_POLICY.maxLayerIdLength,
    4_096,
    'maxLayerIdLength',
  );
  const gridCellSize = positiveFinite(
    options.gridCellSize,
    DEFAULT_SPATIAL_SELECTION_INDEX_POLICY.gridCellSize,
    1_000_000_000,
    'gridCellSize',
  );
  const maxGridCells = positiveInteger(
    options.maxGridCells,
    DEFAULT_SPATIAL_SELECTION_INDEX_POLICY.maxGridCells,
    4_000_000,
    'maxGridCells',
  );
  const maxGridReferences = positiveInteger(
    options.maxGridReferences,
    DEFAULT_SPATIAL_SELECTION_INDEX_POLICY.maxGridReferences,
    8_000_000,
    'maxGridReferences',
  );
  const maxCellsPerRecord = positiveInteger(
    options.maxCellsPerRecord,
    DEFAULT_SPATIAL_SELECTION_INDEX_POLICY.maxCellsPerRecord,
    65_536,
    'maxCellsPerRecord',
  );
  const maxGridBucketSize = positiveInteger(
    options.maxGridBucketSize,
    DEFAULT_SPATIAL_SELECTION_INDEX_POLICY.maxGridBucketSize,
    250_000,
    'maxGridBucketSize',
  );
  const nearestInitialRadius = positiveFinite(
    options.nearestInitialRadius,
    DEFAULT_SPATIAL_SELECTION_INDEX_POLICY.nearestInitialRadius,
    1_000_000_000,
    'nearestInitialRadius',
  );
  const nearestMaxRadius = positiveFinite(
    options.nearestMaxRadius,
    DEFAULT_SPATIAL_SELECTION_INDEX_POLICY.nearestMaxRadius,
    1_000_000_000,
    'nearestMaxRadius',
  );
  const nearestExpansionSteps = positiveInteger(
    options.nearestExpansionSteps,
    DEFAULT_SPATIAL_SELECTION_INDEX_POLICY.nearestExpansionSteps,
    64,
    'nearestExpansionSteps',
  );
  const degradedBudgetRatio = ratio(
    options.degradedBudgetRatio,
    DEFAULT_SPATIAL_SELECTION_INDEX_POLICY.degradedBudgetRatio,
    'degradedBudgetRatio',
  );
  const blockedBudgetRatio = ratio(
    options.blockedBudgetRatio,
    DEFAULT_SPATIAL_SELECTION_INDEX_POLICY.blockedBudgetRatio,
    'blockedBudgetRatio',
  );

  if (maxEntriesPerLayer > maxEntries) {
    throw new RangeError('maxEntriesPerLayer cannot exceed maxEntries');
  }
  if (maxBytesPerLayer > maxBytes) {
    throw new RangeError('maxBytesPerLayer cannot exceed maxBytes');
  }
  if (nearestInitialRadius > nearestMaxRadius) {
    throw new RangeError('nearestInitialRadius cannot exceed nearestMaxRadius');
  }
  if (degradedBudgetRatio >= blockedBudgetRatio) {
    throw new RangeError('degradedBudgetRatio must be lower than blockedBudgetRatio');
  }

  return Object.freeze({
    maxEntries,
    maxBytes,
    maxEntriesPerLayer,
    maxBytesPerLayer,
    maxLayers,
    maxQueryResults,
    maxQueryCandidates,
    maxHistory,
    maxIdLength,
    maxLayerIdLength,
    gridCellSize,
    maxGridCells,
    maxGridReferences,
    maxCellsPerRecord,
    maxGridBucketSize,
    nearestInitialRadius,
    nearestMaxRadius,
    nearestExpansionSteps,
    degradedBudgetRatio,
    blockedBudgetRatio,
  });
};

export const normalizeSelectionIdentifier = (
  value: string,
  name: 'id' | 'layerId',
  maximumLength: number,
): string => {
  if (typeof value !== 'string') {
    throw new SpatialSelectionIndexError(
      name === 'id' ? 'INVALID_ID' : 'INVALID_LAYER_ID',
      `${name} must be a string`,
    );
  }
  const normalized = value.trim().replace(/\s+/gu, ' ');
  if (!normalized || normalized.length > maximumLength) {
    throw new SpatialSelectionIndexError(
      name === 'id' ? 'INVALID_ID' : 'INVALID_LAYER_ID',
      `${name} must contain between 1 and ${maximumLength} characters`,
    );
  }
  return normalized;
};

export const normalizeSelectionPriority = (
  value: SelectionPriority,
): SelectionPriority => {
  if (
    value !== 'background'
    && value !== 'normal'
    && value !== 'high'
    && value !== 'critical'
  ) {
    throw new SpatialSelectionIndexError('INVALID_PRIORITY', 'selection priority is invalid');
  }
  return value;
};

export const normalizeSelectionEstimatedBytes = (
  value: number,
): number => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new SpatialSelectionIndexError(
      'INVALID_ESTIMATED_BYTES',
      'estimatedBytes must be a positive safe integer',
    );
  }
  return value;
};

const finiteCoordinate = (
  value: number,
  name: string,
): number => {
  if (!Number.isFinite(value)) {
    throw new SpatialSelectionIndexError('INVALID_BOUNDS', `${name} must be finite`);
  }
  return Object.is(value, -0) ? 0 : value;
};

export const normalizeSelectionBounds = (
  bounds: SelectionBounds,
): SelectionBounds => {
  const xmin = finiteCoordinate(bounds.xmin, 'bounds.xmin');
  const ymin = finiteCoordinate(bounds.ymin, 'bounds.ymin');
  const xmax = finiteCoordinate(bounds.xmax, 'bounds.xmax');
  const ymax = finiteCoordinate(bounds.ymax, 'bounds.ymax');
  if (xmin > xmax || ymin > ymax) {
    throw new SpatialSelectionIndexError(
      'INVALID_BOUNDS',
      'selection bounds minimum must not exceed maximum',
    );
  }
  return Object.freeze({ xmin, ymin, xmax, ymax });
};

export const normalizeSelectionPoint = (
  point: Readonly<{ x: number; y: number }>,
): Readonly<{ x: number; y: number }> => Object.freeze({
  x: finiteCoordinate(point.x, 'point.x'),
  y: finiteCoordinate(point.y, 'point.y'),
});

export const selectionBoundsIntersect = (
  left: SelectionBounds,
  right: SelectionBounds,
): boolean => (
  left.xmax >= right.xmin
  && left.xmin <= right.xmax
  && left.ymax >= right.ymin
  && left.ymin <= right.ymax
);

export const selectionBoundsDistanceSquared = (
  bounds: SelectionBounds,
  point: Readonly<{ x: number; y: number }>,
): number => {
  const dx = point.x < bounds.xmin
    ? bounds.xmin - point.x
    : point.x > bounds.xmax
      ? point.x - bounds.xmax
      : 0;
  const dy = point.y < bounds.ymin
    ? bounds.ymin - point.y
    : point.y > bounds.ymax
      ? point.y - bounds.ymax
      : 0;
  const distanceSquared = dx * dx + dy * dy;
  return Number.isFinite(distanceSquared) ? distanceSquared : Number.MAX_VALUE;
};

export const selectionBudgetUtilization = (
  usedEntries: number,
  maximumEntries: number,
  usedBytes: number,
  maximumBytes: number,
): number => Math.max(
  usedEntries / Math.max(1, maximumEntries),
  usedBytes / Math.max(1, maximumBytes),
);

export const selectionHealthForUtilization = (
  utilization: number,
  policy: Pick<
    NormalizedSpatialSelectionIndexPolicy,
    'degradedBudgetRatio' | 'blockedBudgetRatio'
  >,
): SpatialSelectionIndexHealth => (
  utilization >= policy.blockedBudgetRatio
    ? 'blocked'
    : utilization >= policy.degradedBudgetRatio
      ? 'degraded'
      : 'healthy'
);

export const throwIfSelectionAborted = (
  signal?: AbortSignal,
): void => {
  if (!signal?.aborted) return;
  throw new SpatialSelectionIndexError(
    'ABORTED',
    'spatial selection operation aborted',
    signal.reason,
  );
};
