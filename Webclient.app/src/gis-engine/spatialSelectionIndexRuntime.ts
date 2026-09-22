export type SelectionPriority = 'background' | 'normal' | 'high' | 'critical';

export interface SelectionBounds { readonly xmin: number; readonly ymin: number; readonly xmax: number; readonly ymax: number }
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
  readonly maxQueryResults?: number;
  readonly maxHistory?: number;
}
export interface SpatialSelectionQuery {
  readonly bounds: SelectionBounds;
  readonly layerIds?: ReadonlySet<string>;
  readonly minimumPriority?: SelectionPriority;
  readonly limit?: number;
}
export interface SpatialSelectionSnapshot {
  readonly entries: number;
  readonly estimatedBytes: number;
  readonly layers: number;
  readonly revision: number;
  readonly evictions: number;
  readonly rejected: number;
}
export interface SpatialSelectionMutation {
  readonly kind: 'upsert' | 'remove' | 'evict' | 'clear';
  readonly id: string | null;
  readonly layerId: string | null;
  readonly revision: number;
}

const PRIORITY: Readonly<Record<SelectionPriority, number>> = Object.freeze({ background: 0, normal: 1, high: 2, critical: 3 });
const DEFAULTS = Object.freeze({ maxEntries: 5_000, maxBytes: 32 * 1024 * 1024, maxEntriesPerLayer: 2_000, maxQueryResults: 500, maxHistory: 256 });

function positive(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) throw new RangeError(`${name} must be a positive safe integer`);
  return result;
}
function finite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
  return Object.is(value, -0) ? 0 : value;
}
function normalizeBounds(bounds: SelectionBounds): SelectionBounds {
  const xmin = finite(bounds.xmin, 'xmin'); const ymin = finite(bounds.ymin, 'ymin'); const xmax = finite(bounds.xmax, 'xmax'); const ymax = finite(bounds.ymax, 'ymax');
  if (xmin > xmax || ymin > ymax) throw new RangeError('selection bounds minimum must not exceed maximum');
  return Object.freeze({ xmin, ymin, xmax, ymax });
}
function normalizeId(value: string, name: string): string {
  const result = value.trim();
  if (!result) throw new TypeError(`${name} must not be empty`);
  if (result.length > 512) throw new RangeError(`${name} exceeds 512 characters`);
  return result;
}
function intersects(left: SelectionBounds, right: SelectionBounds): boolean {
  return left.xmax >= right.xmin && left.xmin <= right.xmax && left.ymax >= right.ymin && left.ymin <= right.ymax;
}
function compareRecords<T>(left: InternalRecord<T>, right: InternalRecord<T>): number {
  const priority = PRIORITY[right.record.priority] - PRIORITY[left.record.priority];
  if (priority !== 0) return priority;
  if (left.touchedAt !== right.touchedAt) return right.touchedAt - left.touchedAt;
  return left.record.id.localeCompare(right.record.id);
}
interface InternalRecord<T> { record: SpatialSelectionRecord<T>; touchedAt: number }

export class SpatialSelectionIndexRuntime<T> {
  readonly #maxEntries: number;
  readonly #maxBytes: number;
  readonly #maxEntriesPerLayer: number;
  readonly #maxQueryResults: number;
  readonly #maxHistory: number;
  readonly #records = new Map<string, InternalRecord<T>>();
  readonly #layers = new Map<string, Set<string>>();
  readonly #history: SpatialSelectionMutation[] = [];
  #bytes = 0;
  #clock = 0;
  #revision = 0;
  #evictions = 0;
  #rejected = 0;
  #disposed = false;

  constructor(options: SpatialSelectionIndexOptions = {}) {
    this.#maxEntries = positive(options.maxEntries, DEFAULTS.maxEntries, 'maxEntries');
    this.#maxBytes = positive(options.maxBytes, DEFAULTS.maxBytes, 'maxBytes');
    this.#maxEntriesPerLayer = positive(options.maxEntriesPerLayer, DEFAULTS.maxEntriesPerLayer, 'maxEntriesPerLayer');
    this.#maxQueryResults = positive(options.maxQueryResults, DEFAULTS.maxQueryResults, 'maxQueryResults');
    this.#maxHistory = positive(options.maxHistory, DEFAULTS.maxHistory, 'maxHistory');
  }

  get disposed(): boolean { return this.#disposed; }

  snapshot(): SpatialSelectionSnapshot {
    return Object.freeze({ entries: this.#records.size, estimatedBytes: this.#bytes, layers: this.#layers.size, revision: this.#revision, evictions: this.#evictions, rejected: this.#rejected });
  }

  history(): readonly SpatialSelectionMutation[] { return Object.freeze(this.#history.slice()); }

  has(id: string): boolean { this.#assertActive(); return this.#records.has(id.trim()); }

  get(id: string): SpatialSelectionRecord<T> | null {
    this.#assertActive();
    const entry = this.#records.get(id.trim());
    if (!entry) return null;
    entry.touchedAt = ++this.#clock;
    return entry.record;
  }

  upsert(input: Omit<SpatialSelectionRecord<T>, 'revision'>): SpatialSelectionRecord<T> | null {
    this.#assertActive();
    const id = normalizeId(input.id, 'id');
    const layerId = normalizeId(input.layerId, 'layerId');
    const estimatedBytes = positive(input.estimatedBytes, 0, 'estimatedBytes');
    if (estimatedBytes > this.#maxBytes) { this.#rejected += 1; return null; }
    const previous = this.#records.get(id);
    const nextRevision = this.#revision + 1;
    const record: SpatialSelectionRecord<T> = Object.freeze({ id, layerId, bounds: normalizeBounds(input.bounds), priority: input.priority, payload: input.payload, estimatedBytes, revision: nextRevision });
    if (previous) this.#detach(previous.record);
    this.#records.set(id, { record, touchedAt: ++this.#clock });
    this.#attach(record);
    this.#revision = nextRevision;
    this.#pushHistory('upsert', record);
    this.#enforceLayerBudget(layerId, id);
    this.#enforceGlobalBudget(id);
    return this.#records.get(id)?.record ?? null;
  }

  remove(id: string): boolean {
    this.#assertActive();
    const key = id.trim();
    const entry = this.#records.get(key);
    if (!entry) return false;
    this.#records.delete(key); this.#detach(entry.record); this.#revision += 1; this.#pushHistory('remove', entry.record); return true;
  }

  removeLayer(layerId: string): number {
    this.#assertActive();
    const key = layerId.trim();
    const ids = this.#layers.get(key);
    if (!ids) return 0;
    let removed = 0;
    for (const id of [...ids]) if (this.remove(id)) removed += 1;
    return removed;
  }

  query(input: SpatialSelectionQuery): readonly SpatialSelectionRecord<T>[] {
    this.#assertActive();
    const bounds = normalizeBounds(input.bounds);
    const requestedLimit = input.limit === undefined ? this.#maxQueryResults : positive(input.limit, this.#maxQueryResults, 'limit');
    const limit = Math.min(requestedLimit, this.#maxQueryResults);
    const minimum = input.minimumPriority === undefined ? 0 : PRIORITY[input.minimumPriority];
    const matches: InternalRecord<T>[] = [];
    for (const entry of this.#records.values()) {
      if (PRIORITY[entry.record.priority] < minimum) continue;
      if (input.layerIds && !input.layerIds.has(entry.record.layerId)) continue;
      if (!intersects(entry.record.bounds, bounds)) continue;
      matches.push(entry);
    }
    matches.sort(compareRecords);
    const selected = matches.slice(0, limit);
    for (const entry of selected) entry.touchedAt = ++this.#clock;
    return Object.freeze(selected.map((entry) => entry.record));
  }

  nearest(point: Readonly<{ x: number; y: number }>, limit = 1, layerIds?: ReadonlySet<string>): readonly SpatialSelectionRecord<T>[] {
    this.#assertActive();
    const x = finite(point.x, 'point.x'); const y = finite(point.y, 'point.y');
    const boundedLimit = Math.min(positive(limit, 1, 'limit'), this.#maxQueryResults);
    const candidates: Array<{ entry: InternalRecord<T>; distance: number }> = [];
    for (const entry of this.#records.values()) {
      if (layerIds && !layerIds.has(entry.record.layerId)) continue;
      const bounds = entry.record.bounds;
      const dx = x < bounds.xmin ? bounds.xmin - x : x > bounds.xmax ? x - bounds.xmax : 0;
      const dy = y < bounds.ymin ? bounds.ymin - y : y > bounds.ymax ? y - bounds.ymax : 0;
      candidates.push({ entry, distance: Math.hypot(dx, dy) });
    }
    candidates.sort((left, right) => left.distance - right.distance || compareRecords(left.entry, right.entry));
    const selected = candidates.slice(0, boundedLimit).map((item) => item.entry);
    for (const entry of selected) entry.touchedAt = ++this.#clock;
    return Object.freeze(selected.map((entry) => entry.record));
  }

  clear(): void {
    this.#assertActive();
    if (this.#records.size === 0) return;
    this.#records.clear(); this.#layers.clear(); this.#bytes = 0; this.#revision += 1; this.#pushHistory('clear', null);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#records.clear(); this.#layers.clear(); this.#history.length = 0; this.#bytes = 0; this.#disposed = true;
  }

  #attach(record: SpatialSelectionRecord<T>): void {
    this.#bytes += record.estimatedBytes;
    let layer = this.#layers.get(record.layerId);
    if (!layer) { layer = new Set(); this.#layers.set(record.layerId, layer); }
    layer.add(record.id);
  }

  #detach(record: SpatialSelectionRecord<T>): void {
    this.#bytes -= record.estimatedBytes;
    const layer = this.#layers.get(record.layerId);
    layer?.delete(record.id);
    if (layer?.size === 0) this.#layers.delete(record.layerId);
  }

  #evictionCandidate(layerId?: string, protectedId?: string): InternalRecord<T> | null {
    let candidate: InternalRecord<T> | null = null;
    for (const entry of this.#records.values()) {
      if (entry.record.id === protectedId || (layerId !== undefined && entry.record.layerId !== layerId)) continue;
      if (!candidate) { candidate = entry; continue; }
      const priority = PRIORITY[entry.record.priority] - PRIORITY[candidate.record.priority];
      if (priority < 0 || (priority === 0 && (entry.touchedAt < candidate.touchedAt || (entry.touchedAt === candidate.touchedAt && entry.record.id < candidate.record.id)))) candidate = entry;
    }
    return candidate;
  }

  #evict(entry: InternalRecord<T>): void {
    this.#records.delete(entry.record.id); this.#detach(entry.record); this.#evictions += 1; this.#revision += 1; this.#pushHistory('evict', entry.record);
  }

  #enforceLayerBudget(layerId: string, protectedId: string): void {
    while ((this.#layers.get(layerId)?.size ?? 0) > this.#maxEntriesPerLayer) {
      const candidate = this.#evictionCandidate(layerId, protectedId) ?? this.#evictionCandidate(layerId);
      if (!candidate) break;
      this.#evict(candidate);
    }
  }

  #enforceGlobalBudget(protectedId: string): void {
    while (this.#records.size > this.#maxEntries || this.#bytes > this.#maxBytes) {
      const candidate = this.#evictionCandidate(undefined, protectedId) ?? this.#evictionCandidate();
      if (!candidate) break;
      this.#evict(candidate);
    }
    if (this.#records.size > this.#maxEntries || this.#bytes > this.#maxBytes) {
      const protectedEntry = this.#records.get(protectedId);
      if (protectedEntry) { this.#records.delete(protectedId); this.#detach(protectedEntry.record); this.#rejected += 1; }
    }
  }

  #pushHistory(kind: SpatialSelectionMutation['kind'], record: SpatialSelectionRecord<T> | null): void {
    this.#history.push(Object.freeze({ kind, id: record?.id ?? null, layerId: record?.layerId ?? null, revision: this.#revision }));
    while (this.#history.length > this.#maxHistory) this.#history.shift();
  }

  #assertActive(): void { if (this.#disposed) throw new Error('Spatial selection index is disposed'); }
}
