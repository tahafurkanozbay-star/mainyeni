export type SpatialRelationship = 'intersects' | 'contains' | 'within' | 'touches' | 'crosses' | 'overlaps' | 'envelope-intersects';
export interface SpatialQueryKeyInput {
  readonly serviceId: string;
  readonly layerId: number;
  readonly where?: string;
  readonly objectIds?: readonly number[];
  readonly outFields?: readonly string[];
  readonly geometry?: Readonly<{ xmin?: number; ymin?: number; xmax?: number; ymax?: number; x?: number; y?: number; spatialReference?: Readonly<{ wkid?: number; latestWkid?: number }> }>;
  readonly spatialRelationship?: SpatialRelationship;
  readonly returnGeometry?: boolean;
  readonly outSpatialReference?: number;
  readonly resultOffset?: number;
  readonly resultRecordCount?: number;
  readonly orderByFields?: readonly string[];
  readonly groupByFieldsForStatistics?: readonly string[];
}
const MAX_TEXT = 4096;
const MAX_FIELDS = 256;
const MAX_IDS = 20_000;
function text(value: string | undefined, fallback = ''): string { const normalized = (value ?? fallback).trim().replace(/\s+/g, ' '); if (normalized.length > MAX_TEXT) throw new RangeError('query text exceeds key budget'); return normalized; }
function safeInteger(value: number, name: string, min = 0): number { if (!Number.isSafeInteger(value) || value < min) throw new RangeError(`${name} must be a safe integer >= ${min}`); return value; }
function finite(value: number | undefined, name: string): number | undefined { if (value === undefined) return undefined; if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`); return Object.is(value, -0) ? 0 : value; }
function uniqueSortedStrings(values: readonly string[] | undefined): readonly string[] { if (!values) return []; if (values.length > MAX_FIELDS) throw new RangeError('field list exceeds key budget'); return Object.freeze([...new Set(values.map((value) => text(value)).filter(Boolean))].sort()); }
function uniqueSortedIds(values: readonly number[] | undefined): readonly number[] { if (!values) return []; if (values.length > MAX_IDS) throw new RangeError('object id list exceeds key budget'); return Object.freeze([...new Set(values.map((value) => safeInteger(value, 'objectId')))].sort((a, b) => a - b)); }
function geometryKey(geometry: SpatialQueryKeyInput['geometry']): string { if (!geometry) return ''; const wkid = geometry.spatialReference?.latestWkid ?? geometry.spatialReference?.wkid; const parts = [finite(geometry.x, 'geometry.x'), finite(geometry.y, 'geometry.y'), finite(geometry.xmin, 'geometry.xmin'), finite(geometry.ymin, 'geometry.ymin'), finite(geometry.xmax, 'geometry.xmax'), finite(geometry.ymax, 'geometry.ymax')]; if (parts.every((value) => value === undefined)) throw new TypeError('geometry key requires point or extent coordinates'); return `${wkid === undefined ? '' : safeInteger(wkid, 'wkid', 1)}:${parts.map((value) => value ?? '').join(',')}`; }
function encode(values: readonly string[]): string { return values.map((value) => `${value.length}:${value}`).join('|'); }
export function createSpatialQueryKey(input: SpatialQueryKeyInput): string {
  const serviceId = text(input.serviceId); if (!serviceId) throw new TypeError('serviceId is required');
  const layerId = safeInteger(input.layerId, 'layerId');
  const outFields = uniqueSortedStrings(input.outFields);
  const objectIds = uniqueSortedIds(input.objectIds);
  const orderBy = uniqueSortedStrings(input.orderByFields);
  const groupBy = uniqueSortedStrings(input.groupByFieldsForStatistics);
  const offset = input.resultOffset === undefined ? 0 : safeInteger(input.resultOffset, 'resultOffset');
  const count = input.resultRecordCount === undefined ? 0 : safeInteger(input.resultRecordCount, 'resultRecordCount');
  const outSr = input.outSpatialReference === undefined ? 0 : safeInteger(input.outSpatialReference, 'outSpatialReference', 1);
  return encode([serviceId, String(layerId), text(input.where, '1=1'), objectIds.join(','), outFields.join(','), geometryKey(input.geometry), input.spatialRelationship ?? 'intersects', input.returnGeometry === false ? '0' : '1', String(outSr), String(offset), String(count), orderBy.join(','), groupBy.join(',')]);
}
export interface SpatialQueryKeyRegistryOptions { readonly maxEntries?: number; readonly ttlMs?: number; }
interface RegistryEntry { readonly key: string; lastUsedAt: number; hits: number; }
export class SpatialQueryKeyRegistry {
  readonly #maxEntries: number; readonly #ttlMs: number; readonly #entries = new Map<string, RegistryEntry>();
  constructor(options: SpatialQueryKeyRegistryOptions = {}) { this.#maxEntries = safeInteger(options.maxEntries ?? 1024, 'maxEntries', 1); this.#ttlMs = safeInteger(options.ttlMs ?? 120_000, 'ttlMs', 1); }
  touch(input: SpatialQueryKeyInput, now = Date.now()): Readonly<{ key: string; reused: boolean; hits: number }> { if (!Number.isFinite(now) || now < 0) throw new RangeError('now must be finite and non-negative'); this.prune(now); const key = createSpatialQueryKey(input); const existing = this.#entries.get(key); if (existing) { existing.lastUsedAt = now; existing.hits += 1; this.#entries.delete(key); this.#entries.set(key, existing); return Object.freeze({ key, reused: true, hits: existing.hits }); } while (this.#entries.size >= this.#maxEntries) { const oldest = this.#entries.keys().next().value as string | undefined; if (oldest === undefined) break; this.#entries.delete(oldest); } const entry = { key, lastUsedAt: now, hits: 1 }; this.#entries.set(key, entry); return Object.freeze({ key, reused: false, hits: 1 }); }
  prune(now = Date.now()): number { let removed = 0; for (const [key, entry] of this.#entries) if (now - entry.lastUsedAt >= this.#ttlMs) { this.#entries.delete(key); removed += 1; } return removed; }
  clear(): void { this.#entries.clear(); }
  get size(): number { return this.#entries.size; }
}
