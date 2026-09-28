export type ArcGisRestServiceKind = 'feature' | 'map' | 'scene' | 'image' | 'vector-tile';
export type ArcGisServiceQueryFormat = 'json' | 'geojson' | 'pbf';
export type ArcGisServiceCapability =
  | 'attachments'
  | 'create'
  | 'delete'
  | 'editing'
  | 'export-map'
  | 'extract'
  | 'order-by'
  | 'pagination'
  | 'query'
  | 'statistics'
  | 'sync'
  | 'tiles'
  | 'time'
  | 'update';

export type ArcGisServiceBreakingChange =
  | 'editing-disabled'
  | 'max-record-count-decreased'
  | 'order-by-disabled'
  | 'pagination-disabled'
  | 'service-kind-changed'
  | 'spatial-reference-changed'
  | 'statistics-disabled'
  | 'sync-disabled'
  | `capability-removed:${ArcGisServiceCapability}`
  | `layer-removed:${number}`
  | `query-format-removed:${ArcGisServiceQueryFormat}`
  | `table-removed:${number}`;

export interface ArcGisServiceCapabilityRegistryPolicy {
  readonly maxServices: number;
  readonly maxServiceKeyLength: number;
  readonly maxRevisionLength: number;
  readonly maxCapabilities: number;
  readonly maxQueryFormats: number;
  readonly maxLayerIds: number;
  readonly maxTableIds: number;
  readonly maxRecordCount: number;
  readonly retentionMs: number;
  readonly maxClockSkewMs: number;
}

export interface ArcGisServiceSpatialReferenceSnapshot {
  readonly wkid: number;
  readonly latestWkid: number | null;
}

export interface ArcGisServiceCapabilitySnapshot {
  readonly serviceKey: string;
  readonly serviceKind: ArcGisRestServiceKind;
  readonly revision: string;
  readonly observedAtMs: number;
  readonly currentVersion: number;
  readonly maxRecordCount: number;
  readonly spatialReference: ArcGisServiceSpatialReferenceSnapshot;
  readonly capabilities: readonly ArcGisServiceCapability[];
  readonly queryFormats: readonly ArcGisServiceQueryFormat[];
  readonly layerIds: readonly number[];
  readonly tableIds: readonly number[];
  readonly supportsPagination: boolean;
  readonly supportsOrderBy: boolean;
  readonly supportsStatistics: boolean;
  readonly supportsEditing: boolean;
  readonly supportsSync: boolean;
  readonly timeAware: boolean;
}

export interface ArcGisServiceCapabilityRegistryEntry {
  readonly sequence: number;
  readonly lastAccessedAtMs: number;
  readonly metadata: ArcGisServiceCapabilitySnapshot;
}

export interface ArcGisServiceCapabilityObservationResult {
  readonly status: 'inserted' | 'unchanged' | 'updated';
  readonly compatible: boolean;
  readonly breakingChanges: readonly ArcGisServiceBreakingChange[];
  readonly generation: number;
  readonly entry: ArcGisServiceCapabilityRegistryEntry;
}

export interface ArcGisServiceCapabilityRegistrySnapshot {
  readonly generation: number;
  readonly entries: readonly ArcGisServiceCapabilityRegistryEntry[];
}

const positiveInteger = (value: number, name: string, allowZero = false): number => {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) throw new Error(`${name} outside configured bounds`);
  return value;
};

const boundedText = (value: string, maxLength: number, name: string): string => {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || normalized.includes('\0')) throw new Error(`${name} outside configured bounds`);
  return normalized;
};

const finiteNumber = (value: number, name: string, minimum = 0): number => {
  if (!Number.isFinite(value) || value < minimum) throw new Error(`${name} outside configured bounds`);
  return value;
};

const freezeNumbers = (values: readonly number[]): readonly number[] => Object.freeze([...values]);
const freezeCapabilities = (values: readonly ArcGisServiceCapability[]): readonly ArcGisServiceCapability[] => Object.freeze([...values]);
const freezeFormats = (values: readonly ArcGisServiceQueryFormat[]): readonly ArcGisServiceQueryFormat[] => Object.freeze([...values]);

const freezeMetadata = (value: ArcGisServiceCapabilitySnapshot): ArcGisServiceCapabilitySnapshot => Object.freeze({
  serviceKey: value.serviceKey,
  serviceKind: value.serviceKind,
  revision: value.revision,
  observedAtMs: value.observedAtMs,
  currentVersion: value.currentVersion,
  maxRecordCount: value.maxRecordCount,
  spatialReference: Object.freeze({ wkid: value.spatialReference.wkid, latestWkid: value.spatialReference.latestWkid }),
  capabilities: freezeCapabilities(value.capabilities),
  queryFormats: freezeFormats(value.queryFormats),
  layerIds: freezeNumbers(value.layerIds),
  tableIds: freezeNumbers(value.tableIds),
  supportsPagination: value.supportsPagination,
  supportsOrderBy: value.supportsOrderBy,
  supportsStatistics: value.supportsStatistics,
  supportsEditing: value.supportsEditing,
  supportsSync: value.supportsSync,
  timeAware: value.timeAware,
});

const freezeEntry = (value: ArcGisServiceCapabilityRegistryEntry): ArcGisServiceCapabilityRegistryEntry => Object.freeze({
  sequence: value.sequence,
  lastAccessedAtMs: value.lastAccessedAtMs,
  metadata: freezeMetadata(value.metadata),
});

const compareText = (left: string, right: string): number => left.localeCompare(right);
const compareNumber = (left: number, right: number): number => left - right;

/**
 * Primitive-only registry for metadata already obtained from verified ArcGIS REST adapters.
 *
 * The registry deliberately owns no URL, credential, response body, request, timer, Promise,
 * AbortController, Layer, LayerView, Graphic, Geometry, MapView or SceneView instance. Its job is
 * to normalize the service contract that higher-level query/layer runtimes can safely consume,
 * detect capability shrink, and bound retained metadata under long-lived 2D/3D sessions.
 */
export class ArcGisServiceCapabilityRegistry {
  private readonly policy: Readonly<ArcGisServiceCapabilityRegistryPolicy>;
  private readonly entries = new Map<string, ArcGisServiceCapabilityRegistryEntry>();
  private generation = 0;
  private lastObservedAtMs = 0;
  private disposed = false;

  constructor(policy: ArcGisServiceCapabilityRegistryPolicy) {
    this.policy = Object.freeze({
      maxServices: positiveInteger(policy.maxServices, 'maxServices'),
      maxServiceKeyLength: positiveInteger(policy.maxServiceKeyLength, 'maxServiceKeyLength'),
      maxRevisionLength: positiveInteger(policy.maxRevisionLength, 'maxRevisionLength'),
      maxCapabilities: positiveInteger(policy.maxCapabilities, 'maxCapabilities'),
      maxQueryFormats: positiveInteger(policy.maxQueryFormats, 'maxQueryFormats'),
      maxLayerIds: positiveInteger(policy.maxLayerIds, 'maxLayerIds', true),
      maxTableIds: positiveInteger(policy.maxTableIds, 'maxTableIds', true),
      maxRecordCount: positiveInteger(policy.maxRecordCount, 'maxRecordCount'),
      retentionMs: positiveInteger(policy.retentionMs, 'retentionMs'),
      maxClockSkewMs: positiveInteger(policy.maxClockSkewMs, 'maxClockSkewMs', true),
    });
  }

  observe(
    input: ArcGisServiceCapabilitySnapshot,
    options: Readonly<{ allowIdentityRebind: boolean }> = Object.freeze({ allowIdentityRebind: false }),
  ): ArcGisServiceCapabilityObservationResult {
    this.assertUsable();
    const metadata = this.normalize(input);
    const now = this.time(metadata.observedAtMs);
    const previous = this.entries.get(metadata.serviceKey);

    if (previous && metadata.observedAtMs < previous.metadata.observedAtMs) throw new Error('stale service metadata observation');

    const breakingChanges = previous ? this.breakingChanges(previous.metadata, metadata) : Object.freeze([] as ArcGisServiceBreakingChange[]);
    if (!options.allowIdentityRebind && breakingChanges.some((change) => change === 'service-kind-changed' || change === 'spatial-reference-changed')) {
      throw new Error('service metadata identity rebind requires explicit approval');
    }

    if (previous && this.sameMetadata(previous.metadata, metadata)) {
      const touched = freezeEntry({ sequence: previous.sequence, lastAccessedAtMs: now, metadata });
      this.entries.set(metadata.serviceKey, touched);
      return Object.freeze({
        status: 'unchanged',
        compatible: true,
        breakingChanges: Object.freeze([]),
        generation: this.generation,
        entry: touched,
      });
    }

    if (!previous) this.ensureCapacity();
    const nextSequence = previous ? previous.sequence + 1 : 1;
    if (!Number.isSafeInteger(nextSequence)) throw new Error('service metadata sequence overflow');
    const entry = freezeEntry({ sequence: nextSequence, lastAccessedAtMs: now, metadata });
    this.entries.set(metadata.serviceKey, entry);
    this.generation += 1;

    return Object.freeze({
      status: previous ? 'updated' : 'inserted',
      compatible: breakingChanges.length === 0,
      breakingChanges,
      generation: this.generation,
      entry,
    });
  }

  get(serviceKeyValue: string, timestampMs: number): ArcGisServiceCapabilityRegistryEntry | null {
    this.assertUsable();
    const now = this.time(timestampMs);
    const serviceKey = boundedText(serviceKeyValue, this.policy.maxServiceKeyLength, 'service key');
    const current = this.entries.get(serviceKey);
    if (!current) return null;
    if (now - current.metadata.observedAtMs > this.policy.retentionMs) {
      this.entries.delete(serviceKey);
      this.generation += 1;
      return null;
    }
    if (current.lastAccessedAtMs === now) return current;
    const touched = freezeEntry({ sequence: current.sequence, lastAccessedAtMs: now, metadata: current.metadata });
    this.entries.set(serviceKey, touched);
    return touched;
  }

  invalidate(serviceKeyValue: string): boolean {
    this.assertUsable();
    const serviceKey = boundedText(serviceKeyValue, this.policy.maxServiceKeyLength, 'service key');
    const removed = this.entries.delete(serviceKey);
    if (removed) this.generation += 1;
    return removed;
  }

  prune(timestampMs: number): number {
    this.assertUsable();
    const now = this.time(timestampMs);
    let removed = 0;
    for (const [serviceKey, entry] of this.entries) {
      if (now - entry.metadata.observedAtMs > this.policy.retentionMs) {
        this.entries.delete(serviceKey);
        removed += 1;
      }
    }
    if (removed > 0) this.generation += 1;
    return removed;
  }

  snapshot(timestampMs: number): ArcGisServiceCapabilityRegistrySnapshot {
    this.assertUsable();
    this.time(timestampMs);
    const entries = [...this.entries.values()]
      .sort((left, right) => compareText(left.metadata.serviceKey, right.metadata.serviceKey))
      .map(freezeEntry);
    return Object.freeze({ generation: this.generation, entries: Object.freeze(entries) });
  }

  restore(snapshot: Pick<ArcGisServiceCapabilityRegistrySnapshot, 'entries'>, timestampMs: number): void {
    this.assertUsable();
    const now = this.time(timestampMs);
    if (!Array.isArray(snapshot.entries) || snapshot.entries.length > this.policy.maxServices) throw new Error('invalid service metadata capacity');

    const next = new Map<string, ArcGisServiceCapabilityRegistryEntry>();
    for (const rawEntry of snapshot.entries) {
      const sequence = positiveInteger(rawEntry.sequence, 'sequence');
      const lastAccessedAtMs = positiveInteger(rawEntry.lastAccessedAtMs, 'lastAccessedAtMs', true);
      const metadata = this.normalize(rawEntry.metadata);
      if (metadata.observedAtMs > now + this.policy.maxClockSkewMs || lastAccessedAtMs > now + this.policy.maxClockSkewMs) {
        throw new Error('future service metadata timestamp');
      }
      if (lastAccessedAtMs < metadata.observedAtMs) throw new Error('invalid service metadata chronology');
      if (next.has(metadata.serviceKey)) throw new Error('duplicate service metadata entry');
      next.set(metadata.serviceKey, freezeEntry({ sequence, lastAccessedAtMs, metadata }));
    }

    this.entries.clear();
    for (const [serviceKey, entry] of next) this.entries.set(serviceKey, entry);
    this.lastObservedAtMs = now;
    this.generation += 1;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.entries.clear();
    this.generation += 1;
  }

  private normalize(input: ArcGisServiceCapabilitySnapshot): ArcGisServiceCapabilitySnapshot {
    const serviceKey = boundedText(input.serviceKey, this.policy.maxServiceKeyLength, 'service key');
    const revision = boundedText(input.revision, this.policy.maxRevisionLength, 'revision');
    this.assertServiceKind(input.serviceKind);
    const observedAtMs = positiveInteger(input.observedAtMs, 'observedAtMs', true);
    const currentVersion = finiteNumber(input.currentVersion, 'currentVersion');
    if (currentVersion > 100) throw new Error('currentVersion outside configured bounds');
    const maxRecordCount = positiveInteger(input.maxRecordCount, 'maxRecordCount');
    if (maxRecordCount > this.policy.maxRecordCount) throw new Error('maxRecordCount exceeds registry policy');
    const spatialReference = this.normalizeSpatialReference(input.spatialReference);
    const capabilities = this.normalizeCapabilities(input.capabilities);
    const queryFormats = this.normalizeFormats(input.queryFormats);
    const layerIds = this.normalizeIds(input.layerIds, this.policy.maxLayerIds, 'layer IDs');
    const tableIds = this.normalizeIds(input.tableIds, this.policy.maxTableIds, 'table IDs');
    this.rejectCrossIdentity(layerIds, tableIds);
    this.assertBoolean(input.supportsPagination, 'supportsPagination');
    this.assertBoolean(input.supportsOrderBy, 'supportsOrderBy');
    this.assertBoolean(input.supportsStatistics, 'supportsStatistics');
    this.assertBoolean(input.supportsEditing, 'supportsEditing');
    this.assertBoolean(input.supportsSync, 'supportsSync');
    this.assertBoolean(input.timeAware, 'timeAware');

    if (input.supportsPagination && !capabilities.includes('query')) throw new Error('pagination requires query capability');
    if (input.supportsOrderBy && !capabilities.includes('query')) throw new Error('order-by requires query capability');
    if (input.supportsStatistics && !capabilities.includes('query')) throw new Error('statistics requires query capability');
    if (input.supportsEditing && !capabilities.includes('editing')) throw new Error('editing flag requires editing capability');
    if (input.supportsSync && !capabilities.includes('sync')) throw new Error('sync flag requires sync capability');
    if (input.timeAware && !capabilities.includes('time')) throw new Error('time-aware flag requires time capability');
    if (queryFormats.length > 0 && !capabilities.includes('query')) throw new Error('query formats require query capability');

    return freezeMetadata({
      serviceKey,
      serviceKind: input.serviceKind,
      revision,
      observedAtMs,
      currentVersion,
      maxRecordCount,
      spatialReference,
      capabilities,
      queryFormats,
      layerIds,
      tableIds,
      supportsPagination: input.supportsPagination,
      supportsOrderBy: input.supportsOrderBy,
      supportsStatistics: input.supportsStatistics,
      supportsEditing: input.supportsEditing,
      supportsSync: input.supportsSync,
      timeAware: input.timeAware,
    });
  }

  private normalizeSpatialReference(input: ArcGisServiceSpatialReferenceSnapshot): ArcGisServiceSpatialReferenceSnapshot {
    if (!input || typeof input !== 'object') throw new Error('spatial reference is required');
    const wkid = positiveInteger(input.wkid, 'wkid');
    const latestWkid = input.latestWkid === null ? null : positiveInteger(input.latestWkid, 'latestWkid');
    if (wkid > 1_000_000_000 || (latestWkid !== null && latestWkid > 1_000_000_000)) throw new Error('spatial reference outside configured bounds');
    return Object.freeze({ wkid, latestWkid });
  }

  private normalizeCapabilities(values: readonly ArcGisServiceCapability[]): readonly ArcGisServiceCapability[] {
    if (!Array.isArray(values) || values.length > this.policy.maxCapabilities) throw new Error('capability count exceeds registry policy');
    const normalized = new Set<ArcGisServiceCapability>();
    for (const value of values) {
      this.assertCapability(value);
      if (normalized.has(value)) throw new Error('duplicate service capability');
      normalized.add(value);
    }
    return freezeCapabilities([...normalized].sort(compareText));
  }

  private normalizeFormats(values: readonly ArcGisServiceQueryFormat[]): readonly ArcGisServiceQueryFormat[] {
    if (!Array.isArray(values) || values.length > this.policy.maxQueryFormats) throw new Error('query format count exceeds registry policy');
    const normalized = new Set<ArcGisServiceQueryFormat>();
    for (const value of values) {
      this.assertQueryFormat(value);
      if (normalized.has(value)) throw new Error('duplicate query format');
      normalized.add(value);
    }
    return freezeFormats([...normalized].sort(compareText));
  }

  private normalizeIds(values: readonly number[], maxEntries: number, name: string): readonly number[] {
    if (!Array.isArray(values) || values.length > maxEntries) throw new Error(`${name} exceed registry policy`);
    const unique = new Set<number>();
    for (const value of values) {
      const id = positiveInteger(value, name, true);
      if (unique.has(id)) throw new Error(`duplicate ${name}`);
      unique.add(id);
    }
    return freezeNumbers([...unique].sort(compareNumber));
  }

  private rejectCrossIdentity(layerIds: readonly number[], tableIds: readonly number[]): void {
    const layers = new Set(layerIds);
    for (const tableId of tableIds) if (layers.has(tableId)) throw new Error('layer and table IDs must be disjoint');
  }

  private breakingChanges(
    previous: ArcGisServiceCapabilitySnapshot,
    next: ArcGisServiceCapabilitySnapshot,
  ): readonly ArcGisServiceBreakingChange[] {
    const changes: ArcGisServiceBreakingChange[] = [];
    if (previous.serviceKind !== next.serviceKind) changes.push('service-kind-changed');
    if (!this.sameSpatialReference(previous.spatialReference, next.spatialReference)) changes.push('spatial-reference-changed');
    if (next.maxRecordCount < previous.maxRecordCount) changes.push('max-record-count-decreased');
    if (previous.supportsPagination && !next.supportsPagination) changes.push('pagination-disabled');
    if (previous.supportsOrderBy && !next.supportsOrderBy) changes.push('order-by-disabled');
    if (previous.supportsStatistics && !next.supportsStatistics) changes.push('statistics-disabled');
    if (previous.supportsEditing && !next.supportsEditing) changes.push('editing-disabled');
    if (previous.supportsSync && !next.supportsSync) changes.push('sync-disabled');
    for (const capability of previous.capabilities) if (!next.capabilities.includes(capability)) changes.push(`capability-removed:${capability}`);
    for (const format of previous.queryFormats) if (!next.queryFormats.includes(format)) changes.push(`query-format-removed:${format}`);
    for (const layerId of previous.layerIds) if (!next.layerIds.includes(layerId)) changes.push(`layer-removed:${layerId}`);
    for (const tableId of previous.tableIds) if (!next.tableIds.includes(tableId)) changes.push(`table-removed:${tableId}`);
    return Object.freeze(changes.sort(compareText));
  }

  private sameMetadata(left: ArcGisServiceCapabilitySnapshot, right: ArcGisServiceCapabilitySnapshot): boolean {
    return left.serviceKey === right.serviceKey
      && left.serviceKind === right.serviceKind
      && left.revision === right.revision
      && left.currentVersion === right.currentVersion
      && left.maxRecordCount === right.maxRecordCount
      && this.sameSpatialReference(left.spatialReference, right.spatialReference)
      && this.sameArray(left.capabilities, right.capabilities)
      && this.sameArray(left.queryFormats, right.queryFormats)
      && this.sameArray(left.layerIds, right.layerIds)
      && this.sameArray(left.tableIds, right.tableIds)
      && left.supportsPagination === right.supportsPagination
      && left.supportsOrderBy === right.supportsOrderBy
      && left.supportsStatistics === right.supportsStatistics
      && left.supportsEditing === right.supportsEditing
      && left.supportsSync === right.supportsSync
      && left.timeAware === right.timeAware;
  }

  private sameSpatialReference(left: ArcGisServiceSpatialReferenceSnapshot, right: ArcGisServiceSpatialReferenceSnapshot): boolean {
    return left.wkid === right.wkid && left.latestWkid === right.latestWkid;
  }

  private sameArray<T>(left: readonly T[], right: readonly T[]): boolean {
    if (left.length !== right.length) return false;
    return left.every((value, index) => value === right[index]);
  }

  private ensureCapacity(): void {
    while (this.entries.size >= this.policy.maxServices) {
      const candidate = [...this.entries.values()].sort((left, right) =>
        left.lastAccessedAtMs - right.lastAccessedAtMs
        || left.metadata.observedAtMs - right.metadata.observedAtMs
        || compareText(left.metadata.serviceKey, right.metadata.serviceKey),
      )[0];
      if (!candidate) throw new Error('service metadata capacity invariant failed');
      this.entries.delete(candidate.metadata.serviceKey);
      this.generation += 1;
    }
  }

  private assertServiceKind(value: string): asserts value is ArcGisRestServiceKind {
    if (value !== 'feature' && value !== 'map' && value !== 'scene' && value !== 'image' && value !== 'vector-tile') {
      throw new Error('unsupported ArcGIS REST service kind');
    }
  }

  private assertCapability(value: string): asserts value is ArcGisServiceCapability {
    if (value !== 'attachments'
      && value !== 'create'
      && value !== 'delete'
      && value !== 'editing'
      && value !== 'export-map'
      && value !== 'extract'
      && value !== 'order-by'
      && value !== 'pagination'
      && value !== 'query'
      && value !== 'statistics'
      && value !== 'sync'
      && value !== 'tiles'
      && value !== 'time'
      && value !== 'update') throw new Error('unsupported ArcGIS service capability');
  }

  private assertQueryFormat(value: string): asserts value is ArcGisServiceQueryFormat {
    if (value !== 'json' && value !== 'geojson' && value !== 'pbf') throw new Error('unsupported ArcGIS query format');
  }

  private assertBoolean(value: boolean, name: string): void {
    if (typeof value !== 'boolean') throw new Error(`${name} must be boolean`);
  }

  private time(value: number): number {
    const now = positiveInteger(value, 'timestampMs', true);
    if (now + this.policy.maxClockSkewMs < this.lastObservedAtMs) throw new Error('stale service metadata clock');
    this.lastObservedAtMs = Math.max(this.lastObservedAtMs, now);
    return now;
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('ArcGisServiceCapabilityRegistry is disposed');
  }
}
