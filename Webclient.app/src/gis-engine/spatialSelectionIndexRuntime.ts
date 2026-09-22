import {
  createSpatialGridIndex,
  SpatialGridIndexError,
  type SpatialGridIndex,
  type SpatialIndexHit,
} from './spatialGridIndex';
import {
  SELECTION_PRIORITY_RANK,
  SpatialSelectionIndexError,
  normalizeSelectionBounds,
  normalizeSelectionEstimatedBytes,
  normalizeSelectionIdentifier,
  normalizeSelectionPoint,
  normalizeSelectionPriority,
  normalizeSpatialSelectionIndexPolicy,
  selectionBoundsDistanceSquared,
  selectionBudgetUtilization,
  selectionHealthForUtilization,
  throwIfSelectionAborted,
  type NormalizedSpatialSelectionIndexPolicy,
  type SelectionBounds,
  type SelectionPriority,
  type SpatialSelectionEvictionReason,
  type SpatialSelectionIndexHealth,
  type SpatialSelectionIndexOptions,
  type SpatialSelectionLayerSnapshot,
  type SpatialSelectionMutation,
  type SpatialSelectionMutationKind,
  type SpatialSelectionNearestQuery,
  type SpatialSelectionQuery,
  type SpatialSelectionQueryDiagnostics,
  type SpatialSelectionQueryResult,
  type SpatialSelectionRecord,
  type SpatialSelectionSnapshot,
} from './spatialSelectionIndexContracts';

export {
  SpatialSelectionIndexError,
  normalizeSpatialSelectionIndexPolicy,
} from './spatialSelectionIndexContracts';

export type {
  NormalizedSpatialSelectionIndexPolicy,
  SelectionBounds,
  SelectionPriority,
  SpatialSelectionEvictionReason,
  SpatialSelectionIndexHealth,
  SpatialSelectionIndexOptions,
  SpatialSelectionLayerSnapshot,
  SpatialSelectionMutation,
  SpatialSelectionMutationKind,
  SpatialSelectionNearestQuery,
  SpatialSelectionQuery,
  SpatialSelectionQueryDiagnostics,
  SpatialSelectionQueryResult,
  SpatialSelectionRecord,
  SpatialSelectionSnapshot,
} from './spatialSelectionIndexContracts';

type StoredSelectionRecord<T> = {
  readonly record: SpatialSelectionRecord<T>;
  readonly sequence: number;
  touchedAt: number;
};

type SelectionLayerState = {
  readonly layerId: string;
  readonly ids: Set<string>;
  estimatedBytes: number;
};

type QueryFilterState<T> = {
  readonly accepted: StoredSelectionRecord<T>[];
  filteredByLayer: number;
  filteredByPriority: number;
};

type NearestCandidate<T> = Readonly<{
  entry: StoredSelectionRecord<T>;
  distanceSquared: number;
}>;

const boundedPositiveInteger = (
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number => {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return Math.min(resolved, maximum);
};

const boundedPositiveFinite = (
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number => {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new RangeError(`${name} must be finite and positive`);
  }
  return Math.min(resolved, maximum);
};

const compareEviction = <T>(
  left: StoredSelectionRecord<T>,
  right: StoredSelectionRecord<T>,
): number => (
  SELECTION_PRIORITY_RANK[left.record.priority] - SELECTION_PRIORITY_RANK[right.record.priority]
  || left.touchedAt - right.touchedAt
  || left.sequence - right.sequence
  || left.record.id.localeCompare(right.record.id)
);

const compareQuery = <T>(
  left: StoredSelectionRecord<T>,
  right: StoredSelectionRecord<T>,
): number => (
  SELECTION_PRIORITY_RANK[right.record.priority] - SELECTION_PRIORITY_RANK[left.record.priority]
  || right.touchedAt - left.touchedAt
  || right.sequence - left.sequence
  || left.record.id.localeCompare(right.record.id)
);

const compareNearest = <T>(
  left: NearestCandidate<T>,
  right: NearestCandidate<T>,
): number => (
  left.distanceSquared - right.distanceSquared
  || compareQuery(left.entry, right.entry)
);

const gridError = (error: unknown): SpatialSelectionIndexError => {
  if (error instanceof SpatialSelectionIndexError) return error;
  if (error instanceof SpatialGridIndexError) {
    return new SpatialSelectionIndexError(
      'GRID_BUDGET_EXCEEDED',
      `spatial selection grid rejected the operation (${error.code})`,
      error,
    );
  }
  return new SpatialSelectionIndexError(
    'GRID_BUDGET_EXCEEDED',
    'spatial selection grid rejected the operation',
    error,
  );
};

const extentForRadius = (
  point: Readonly<{ x: number; y: number }>,
  radius: number,
): SelectionBounds => Object.freeze({
  xmin: point.x - radius,
  ymin: point.y - radius,
  xmax: point.x + radius,
  ymax: point.y + radius,
});

const normalizedLayerFilter = (
  input: ReadonlySet<string> | undefined,
  maximumLength: number,
): ReadonlySet<string> | undefined => (
  input === undefined
    ? undefined
    : new Set(
      Array.from(input)
        .map((layerId) => normalizeSelectionIdentifier(layerId, 'layerId', maximumLength)),
    )
);

const queryDiagnostics = (
  kind: SpatialSelectionQueryDiagnostics['kind'],
  candidates: number,
  matched: number,
  returned: number,
  truncated: boolean,
  gridQueries: number,
  filteredByLayer: number,
  filteredByPriority: number,
): SpatialSelectionQueryDiagnostics => Object.freeze({
  kind,
  candidates,
  matched,
  returned,
  truncated,
  gridQueries,
  filteredByLayer,
  filteredByPriority,
});

export class SpatialSelectionIndexRuntime<T> {
  readonly #policy: NormalizedSpatialSelectionIndexPolicy;
  readonly #grid: SpatialGridIndex<string>;
  readonly #records = new Map<string, StoredSelectionRecord<T>>();
  readonly #layers = new Map<string, SelectionLayerState>();
  readonly #history: SpatialSelectionMutation[] = [];

  #estimatedBytes = 0;
  #clock = 0;
  #sequence = 0;
  #revision = 0;
  #evictions = 0;
  #rejected = 0;
  #mutations = 0;
  #queries = 0;
  #extentQueries = 0;
  #nearestQueries = 0;
  #cacheTouches = 0;
  #disposed = false;

  public constructor(options: SpatialSelectionIndexOptions = {}) {
    this.#policy = normalizeSpatialSelectionIndexPolicy(options);
    this.#grid = createSpatialGridIndex<string>({
      cellSize: this.#policy.gridCellSize,
      maximumFeatures: Math.min(this.#policy.maxEntries + 1, 1_000_000),
      maximumCells: this.#policy.maxGridCells,
      maximumReferences: this.#policy.maxGridReferences,
      maximumCellsPerFeature: this.#policy.maxCellsPerRecord,
      maximumBucketSize: this.#policy.maxGridBucketSize,
    });
  }

  public get disposed(): boolean {
    return this.#disposed;
  }

  public get policy(): NormalizedSpatialSelectionIndexPolicy {
    return this.#policy;
  }

  public get size(): number {
    return this.#records.size;
  }

  public has(idInput: string): boolean {
    this.#assertActive();
    const id = normalizeSelectionIdentifier(idInput, 'id', this.#policy.maxIdLength);
    return this.#records.has(id);
  }

  public get(idInput: string): SpatialSelectionRecord<T> | null {
    this.#assertActive();
    const id = normalizeSelectionIdentifier(idInput, 'id', this.#policy.maxIdLength);
    const entry = this.#records.get(id);
    if (!entry) return null;
    this.#touch(entry);
    return entry.record;
  }

  public upsert(
    input: Omit<SpatialSelectionRecord<T>, 'revision'>,
  ): SpatialSelectionRecord<T> | null {
    this.#assertActive();
    const id = normalizeSelectionIdentifier(input.id, 'id', this.#policy.maxIdLength);
    const layerId = normalizeSelectionIdentifier(
      input.layerId,
      'layerId',
      this.#policy.maxLayerIdLength,
    );
    const priority = normalizeSelectionPriority(input.priority);
    const bounds = normalizeSelectionBounds(input.bounds);
    const estimatedBytes = normalizeSelectionEstimatedBytes(input.estimatedBytes);

    if (
      estimatedBytes > this.#policy.maxBytes
      || estimatedBytes > this.#policy.maxBytesPerLayer
    ) {
      this.#rejected += 1;
      return null;
    }

    const nextRevision = this.#revision + 1;
    const record: SpatialSelectionRecord<T> = Object.freeze({
      id,
      layerId,
      bounds,
      priority,
      payload: input.payload,
      estimatedBytes,
      revision: nextRevision,
    });

    try {
      this.#grid.upsert({
        id,
        extent: bounds,
        value: id,
        owner: layerId,
      });
    } catch (error) {
      this.#rejected += 1;
      throw gridError(error);
    }

    const previous = this.#records.get(id);
    if (previous) this.#detachMetadata(previous.record);

    this.#revision = nextRevision;
    this.#sequence += 1;
    const stored: StoredSelectionRecord<T> = {
      record,
      sequence: this.#sequence,
      touchedAt: ++this.#clock,
    };
    this.#records.set(id, stored);
    this.#attachMetadata(record);
    this.#mutations += 1;
    this.#pushHistory('upsert', record, null);

    this.#enforceLayerCountBudget();
    this.#enforceLayerBudget(layerId);
    this.#enforceGlobalBudget();

    const retained = this.#records.get(id);
    if (!retained) {
      this.#rejected += 1;
      return null;
    }
    return retained.record;
  }

  public remove(idInput: string): boolean {
    this.#assertActive();
    const id = normalizeSelectionIdentifier(idInput, 'id', this.#policy.maxIdLength);
    const entry = this.#records.get(id);
    if (!entry) return false;
    this.#removeStored(entry, 'remove', 'explicit-remove');
    return true;
  }

  public removeLayer(layerIdInput: string): number {
    this.#assertActive();
    const layerId = normalizeSelectionIdentifier(
      layerIdInput,
      'layerId',
      this.#policy.maxLayerIdLength,
    );
    const layer = this.#layers.get(layerId);
    if (!layer) return 0;
    const entries = Array.from(layer.ids)
      .map((id) => this.#records.get(id))
      .filter((entry): entry is StoredSelectionRecord<T> => entry !== undefined);
    return entries.reduce((removed, entry) => {
      this.#removeStored(entry, 'remove-layer', 'layer-remove');
      return removed + 1;
    }, 0);
  }

  public recordsForLayer(
    layerIdInput: string,
    limitInput = this.#policy.maxQueryResults,
  ): readonly SpatialSelectionRecord<T>[] {
    this.#assertActive();
    const layerId = normalizeSelectionIdentifier(
      layerIdInput,
      'layerId',
      this.#policy.maxLayerIdLength,
    );
    const limit = boundedPositiveInteger(
      limitInput,
      this.#policy.maxQueryResults,
      this.#policy.maxQueryResults,
      'limit',
    );
    const layer = this.#layers.get(layerId);
    if (!layer) return Object.freeze([]);
    const records = Array.from(layer.ids)
      .map((id) => this.#records.get(id))
      .filter((entry): entry is StoredSelectionRecord<T> => entry !== undefined)
      .sort(compareQuery)
      .slice(0, limit);
    this.#touchMany(records);
    return Object.freeze(records.map((entry) => entry.record));
  }

  public query(input: SpatialSelectionQuery): SpatialSelectionQueryResult<T> {
    this.#assertActive();
    throwIfSelectionAborted(input.signal);
    const bounds = normalizeSelectionBounds(input.bounds);
    const layers = normalizedLayerFilter(input.layerIds, this.#policy.maxLayerIdLength);
    const minimum = input.minimumPriority === undefined
      ? null
      : normalizeSelectionPriority(input.minimumPriority);
    const minimumRank = minimum === null ? 0 : SELECTION_PRIORITY_RANK[minimum];
    const limit = boundedPositiveInteger(
      input.limit,
      this.#policy.maxQueryResults,
      this.#policy.maxQueryResults,
      'limit',
    );

    let hits: readonly SpatialIndexHit<string>[];
    try {
      hits = this.#grid.queryExtent(bounds, this.#policy.maxQueryCandidates);
    } catch (error) {
      throw gridError(error);
    }
    throwIfSelectionAborted(input.signal);

    const filtered = hits.reduce<QueryFilterState<T>>((state, hit) => {
      throwIfSelectionAborted(input.signal);
      const entry = this.#records.get(String(hit.id));
      if (!entry) return state;
      if (layers && !layers.has(entry.record.layerId)) {
        state.filteredByLayer += 1;
        return state;
      }
      if (SELECTION_PRIORITY_RANK[entry.record.priority] < minimumRank) {
        state.filteredByPriority += 1;
        return state;
      }
      state.accepted.push(entry);
      return state;
    }, {
      accepted: [],
      filteredByLayer: 0,
      filteredByPriority: 0,
    });

    const sorted = filtered.accepted.sort(compareQuery);
    const selected = sorted.slice(0, limit);
    this.#touchMany(selected);
    this.#queries += 1;
    this.#extentQueries += 1;
    const truncated = hits.length >= this.#policy.maxQueryCandidates
      || sorted.length > selected.length;

    return Object.freeze({
      records: Object.freeze(selected.map((entry) => entry.record)),
      diagnostics: queryDiagnostics(
        'extent',
        hits.length,
        sorted.length,
        selected.length,
        truncated,
        1,
        filtered.filteredByLayer,
        filtered.filteredByPriority,
      ),
    });
  }

  public nearest(
    input: SpatialSelectionNearestQuery,
  ): SpatialSelectionQueryResult<T> {
    this.#assertActive();
    throwIfSelectionAborted(input.signal);
    const point = normalizeSelectionPoint(input.point);
    const layers = normalizedLayerFilter(input.layerIds, this.#policy.maxLayerIdLength);
    const minimum = input.minimumPriority === undefined
      ? null
      : normalizeSelectionPriority(input.minimumPriority);
    const minimumRank = minimum === null ? 0 : SELECTION_PRIORITY_RANK[minimum];
    const limit = boundedPositiveInteger(
      input.limit,
      1,
      this.#policy.maxQueryResults,
      'limit',
    );
    const initialRadius = boundedPositiveFinite(
      input.initialRadius,
      this.#policy.nearestInitialRadius,
      this.#policy.nearestMaxRadius,
      'initialRadius',
    );
    const maxRadius = boundedPositiveFinite(
      input.maxRadius,
      this.#policy.nearestMaxRadius,
      this.#policy.nearestMaxRadius,
      'maxRadius',
    );
    if (initialRadius > maxRadius) {
      throw new RangeError('initialRadius cannot exceed maxRadius');
    }
    const steps = boundedPositiveInteger(
      input.expansionSteps,
      this.#policy.nearestExpansionSteps,
      this.#policy.nearestExpansionSteps,
      'expansionSteps',
    );
    const linearCellSpan = Math.max(
      1,
      Math.floor(Math.sqrt(this.#policy.maxCellsPerRecord)),
    );
    const gridSafeRadius = Math.max(
      this.#policy.gridCellSize / 2,
      ((linearCellSpan - 1) * this.#policy.gridCellSize) / 2,
    );
    const effectiveMaxRadius = Math.min(maxRadius, gridSafeRadius);
    const effectiveInitialRadius = Math.min(initialRadius, effectiveMaxRadius);
    const growth = steps <= 1 || effectiveInitialRadius === effectiveMaxRadius
      ? 1
      : Math.pow(effectiveMaxRadius / effectiveInitialRadius, 1 / (steps - 1));
    const radii = Array.from({ length: steps }, (_, index) => (
      index === steps - 1
        ? effectiveMaxRadius
        : Math.min(
          effectiveMaxRadius,
          effectiveInitialRadius * Math.pow(growth, index),
        )
    ));

    const candidateIds = new Set<string>();
    const eligibleCandidateCount = (): number => Array.from(candidateIds).reduce(
      (count, id) => {
        const entry = this.#records.get(id);
        if (!entry) return count;
        if (layers && !layers.has(entry.record.layerId)) return count;
        if (SELECTION_PRIORITY_RANK[entry.record.priority] < minimumRank) return count;
        return count + 1;
      },
      0,
    );
    let gridQueries = 0;
    radii.some((radius) => {
      throwIfSelectionAborted(input.signal);
      gridQueries += 1;
      let hits: readonly SpatialIndexHit<string>[];
      try {
        hits = this.#grid.queryExtent(
          extentForRadius(point, radius),
          this.#policy.maxQueryCandidates,
        );
      } catch (error) {
        throw gridError(error);
      }
      hits.reduce((set, hit) => {
        set.add(String(hit.id));
        return set;
      }, candidateIds);
      return (
        candidateIds.size >= this.#policy.maxQueryCandidates
        || eligibleCandidateCount() >= limit
      );
    });
    throwIfSelectionAborted(input.signal);

    const filtered = Array.from(candidateIds).reduce<QueryFilterState<T>>((state, id) => {
      const entry = this.#records.get(id);
      if (!entry) return state;
      if (layers && !layers.has(entry.record.layerId)) {
        state.filteredByLayer += 1;
        return state;
      }
      if (SELECTION_PRIORITY_RANK[entry.record.priority] < minimumRank) {
        state.filteredByPriority += 1;
        return state;
      }
      state.accepted.push(entry);
      return state;
    }, {
      accepted: [],
      filteredByLayer: 0,
      filteredByPriority: 0,
    });

    const ranked = filtered.accepted
      .map((entry): NearestCandidate<T> => Object.freeze({
        entry,
        distanceSquared: selectionBoundsDistanceSquared(entry.record.bounds, point),
      }))
      .sort(compareNearest);
    const selected = ranked.slice(0, limit).map((candidate) => candidate.entry);
    this.#touchMany(selected);
    this.#queries += 1;
    this.#nearestQueries += 1;
    const truncated = candidateIds.size >= this.#policy.maxQueryCandidates
      || effectiveMaxRadius < maxRadius
      || ranked.length > selected.length;

    return Object.freeze({
      records: Object.freeze(selected.map((entry) => entry.record)),
      diagnostics: queryDiagnostics(
        'nearest',
        candidateIds.size,
        ranked.length,
        selected.length,
        truncated,
        gridQueries,
        filtered.filteredByLayer,
        filtered.filteredByPriority,
      ),
    });
  }

  public layerSnapshots(): readonly SpatialSelectionLayerSnapshot[] {
    const snapshots = Array.from(this.#layers.values())
      .map((layer): SpatialSelectionLayerSnapshot => Object.freeze({
        layerId: layer.layerId,
        entries: layer.ids.size,
        estimatedBytes: layer.estimatedBytes,
        maxEntries: this.#policy.maxEntriesPerLayer,
        maxBytes: this.#policy.maxBytesPerLayer,
        utilization: selectionBudgetUtilization(
          layer.ids.size,
          this.#policy.maxEntriesPerLayer,
          layer.estimatedBytes,
          this.#policy.maxBytesPerLayer,
        ),
      }))
      .sort((left, right) => (
        right.utilization - left.utilization
        || left.layerId.localeCompare(right.layerId)
      ));
    return Object.freeze(snapshots);
  }

  public history(limitInput = this.#policy.maxHistory): readonly SpatialSelectionMutation[] {
    const limit = boundedPositiveInteger(
      limitInput,
      this.#policy.maxHistory,
      this.#policy.maxHistory,
      'limit',
    );
    return Object.freeze(this.#history.slice(Math.max(0, this.#history.length - limit)));
  }

  public snapshot(): SpatialSelectionSnapshot {
    const grid = this.#grid.snapshot();
    const globalUtilization = selectionBudgetUtilization(
      this.#records.size,
      this.#policy.maxEntries,
      this.#estimatedBytes,
      this.#policy.maxBytes,
    );
    const layerUtilization = Array.from(this.#layers.values()).reduce(
      (maximum, layer) => Math.max(
        maximum,
        selectionBudgetUtilization(
          layer.ids.size,
          this.#policy.maxEntriesPerLayer,
          layer.estimatedBytes,
          this.#policy.maxBytesPerLayer,
        ),
      ),
      0,
    );
    const utilization = Math.max(
      globalUtilization,
      layerUtilization,
      this.#layers.size / Math.max(1, this.#policy.maxLayers),
    );
    const health = this.#disposed
      ? 'blocked'
      : selectionHealthForUtilization(utilization, this.#policy);

    return Object.freeze({
      disposed: this.#disposed,
      health,
      entries: this.#records.size,
      estimatedBytes: this.#estimatedBytes,
      layers: this.#layers.size,
      revision: this.#revision,
      evictions: this.#evictions,
      rejected: this.#rejected,
      mutations: this.#mutations,
      queries: this.#queries,
      extentQueries: this.#extentQueries,
      nearestQueries: this.#nearestQueries,
      cacheTouches: this.#cacheTouches,
      maxEntries: this.#policy.maxEntries,
      maxBytes: this.#policy.maxBytes,
      maxLayers: this.#policy.maxLayers,
      utilization,
      grid: Object.freeze({
        featureCount: grid.featureCount,
        cellCount: grid.cellCount,
        referenceCount: grid.referenceCount,
        ownerCount: grid.ownerCount,
        cellSize: grid.cellSize,
        maximumFeatures: grid.maximumFeatures,
        maximumCells: grid.maximumCells,
        maximumReferences: grid.maximumReferences,
        maximumCellsPerFeature: grid.maximumCellsPerFeature,
        maximumBucketSize: grid.maximumBucketSize,
      }),
    });
  }

  public clear(): void {
    this.#assertActive();
    if (this.#records.size === 0) return;
    const removedBytes = this.#estimatedBytes;
    this.#grid.clear();
    this.#records.clear();
    this.#layers.clear();
    this.#estimatedBytes = 0;
    this.#revision += 1;
    this.#mutations += 1;
    this.#pushHistoryRaw('clear', null, null, 'clear', removedBytes);
  }

  public dispose(): void {
    if (this.#disposed) return;
    const removedBytes = this.#estimatedBytes;
    this.#records.clear();
    this.#layers.clear();
    this.#history.length = 0;
    this.#estimatedBytes = 0;
    this.#grid.dispose();
    this.#revision += 1;
    this.#mutations += 1;
    this.#disposed = true;
    this.#pushHistoryRaw('dispose', null, null, 'dispose', removedBytes);
  }

  #assertActive(): void {
    if (!this.#disposed) return;
    throw new SpatialSelectionIndexError(
      'DISPOSED',
      'spatial selection index is disposed',
    );
  }

  #attachMetadata(record: SpatialSelectionRecord<T>): void {
    this.#estimatedBytes += record.estimatedBytes;
    const layer = this.#layers.get(record.layerId) ?? {
      layerId: record.layerId,
      ids: new Set<string>(),
      estimatedBytes: 0,
    };
    layer.ids.add(record.id);
    layer.estimatedBytes += record.estimatedBytes;
    this.#layers.set(record.layerId, layer);
  }

  #detachMetadata(record: SpatialSelectionRecord<T>): void {
    this.#estimatedBytes = Math.max(0, this.#estimatedBytes - record.estimatedBytes);
    const layer = this.#layers.get(record.layerId);
    if (!layer) return;
    layer.ids.delete(record.id);
    layer.estimatedBytes = Math.max(0, layer.estimatedBytes - record.estimatedBytes);
    if (layer.ids.size === 0) this.#layers.delete(record.layerId);
  }

  #touch(entry: StoredSelectionRecord<T>): void {
    entry.touchedAt = ++this.#clock;
    this.#cacheTouches += 1;
  }

  #touchMany(entries: readonly StoredSelectionRecord<T>[]): void {
    entries.map((entry) => {
      this.#touch(entry);
      return entry;
    });
  }

  #pushHistory(
    kind: SpatialSelectionMutationKind,
    record: SpatialSelectionRecord<T>,
    reason: SpatialSelectionEvictionReason | null,
  ): void {
    this.#pushHistoryRaw(
      kind,
      record.id,
      record.layerId,
      reason,
      record.estimatedBytes,
    );
  }

  #pushHistoryRaw(
    kind: SpatialSelectionMutationKind,
    id: string | null,
    layerId: string | null,
    reason: SpatialSelectionEvictionReason | null,
    estimatedBytes: number,
  ): void {
    this.#history.push(Object.freeze({
      kind,
      id,
      layerId,
      revision: this.#revision,
      reason,
      estimatedBytes,
    }));
    if (this.#history.length > this.#policy.maxHistory) {
      this.#history.splice(0, this.#history.length - this.#policy.maxHistory);
    }
  }

  #removeStored(
    entry: StoredSelectionRecord<T>,
    kind: SpatialSelectionMutationKind,
    reason: SpatialSelectionEvictionReason,
  ): void {
    this.#grid.remove(entry.record.id);
    this.#records.delete(entry.record.id);
    this.#detachMetadata(entry.record);
    this.#revision += 1;
    this.#mutations += 1;
    if (kind === 'evict') this.#evictions += 1;
    this.#pushHistory(kind, entry.record, reason);
  }

  #evictionCandidates(layerId?: string): StoredSelectionRecord<T>[] {
    const source = layerId === undefined
      ? Array.from(this.#records.values())
      : Array.from(this.#layers.get(layerId)?.ids ?? [])
        .map((id) => this.#records.get(id))
        .filter((entry): entry is StoredSelectionRecord<T> => entry !== undefined);
    return source.sort(compareEviction);
  }

  #layerBudgetExceeded(layerId: string): boolean {
    const layer = this.#layers.get(layerId);
    return Boolean(
      layer
      && (
        layer.ids.size > this.#policy.maxEntriesPerLayer
        || layer.estimatedBytes > this.#policy.maxBytesPerLayer
      )
    );
  }

  #enforceLayerBudget(layerId: string): void {
    const candidates = this.#evictionCandidates(layerId);
    candidates.some((entry) => {
      if (!this.#layerBudgetExceeded(layerId)) return true;
      const layer = this.#layers.get(layerId);
      const reason: SpatialSelectionEvictionReason = (
        (layer?.ids.size ?? 0) > this.#policy.maxEntriesPerLayer
          ? 'layer-entry-budget'
          : 'layer-byte-budget'
      );
      this.#removeStored(entry, 'evict', reason);
      return false;
    });
  }

  #globalBudgetExceeded(): boolean {
    return (
      this.#records.size > this.#policy.maxEntries
      || this.#estimatedBytes > this.#policy.maxBytes
    );
  }

  #enforceGlobalBudget(): void {
    const candidates = this.#evictionCandidates();
    candidates.some((entry) => {
      if (!this.#globalBudgetExceeded()) return true;
      const reason: SpatialSelectionEvictionReason = (
        this.#records.size > this.#policy.maxEntries
          ? 'global-entry-budget'
          : 'global-byte-budget'
      );
      this.#removeStored(entry, 'evict', reason);
      return false;
    });
  }

  #enforceLayerCountBudget(): void {
    if (this.#layers.size <= this.#policy.maxLayers) return;
    const rankedLayers = Array.from(this.#layers.values())
      .map((layer) => {
        const members = Array.from(layer.ids)
          .map((id) => this.#records.get(id))
          .filter((entry): entry is StoredSelectionRecord<T> => entry !== undefined)
          .sort(compareEviction);
        const weakest = members[0];
        return Object.freeze({
          layerId: layer.layerId,
          weakestPriority: weakest
            ? SELECTION_PRIORITY_RANK[weakest.record.priority]
            : -1,
          weakestTouchedAt: weakest?.touchedAt ?? 0,
          members,
        });
      })
      .sort((left, right) => (
        left.weakestPriority - right.weakestPriority
        || left.weakestTouchedAt - right.weakestTouchedAt
        || left.layerId.localeCompare(right.layerId)
      ));

    rankedLayers.some((layer) => {
      if (this.#layers.size <= this.#policy.maxLayers) return true;
      layer.members.map((entry) => {
        if (this.#records.has(entry.record.id)) {
          this.#removeStored(entry, 'evict', 'layer-count-budget');
        }
        return entry;
      });
      return false;
    });
  }
}

export const createSpatialSelectionIndexRuntime = <T>(
  options: SpatialSelectionIndexOptions = {},
): SpatialSelectionIndexRuntime<T> => new SpatialSelectionIndexRuntime<T>(options);
