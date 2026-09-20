import type {
  JsonObject,
  JsonValue,
  SketchGeometrySnapshot,
  SketchGeometryType,
  SketchGraphicSnapshot,
} from './sketchContracts';

export interface SketchGeometryBudget {
  readonly maxCoordinates?: number;
  readonly maxRings?: number;
  readonly maxPaths?: number;
  readonly maxAbsoluteCoordinate?: number;
}

export interface SketchGeometryAnalysis {
  readonly type: SketchGeometryType;
  readonly coordinateCount: number;
  readonly finiteCoordinateCount: number;
  readonly invalidCoordinateCount: number;
  readonly bounds: readonly [number, number, number, number] | null;
  readonly estimatedBytes: number;
}

const DEFAULT_BUDGET: Required<SketchGeometryBudget> = Object.freeze({
  maxCoordinates: 100_000,
  maxRings: 2_000,
  maxPaths: 2_000,
  maxAbsoluteCoordinate: 1_000_000_000,
});
const EMPTY_RECORD: Readonly<Record<string, unknown>> = Object.freeze({});
const BLOCKED_JSON_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const mergeBudget = (budget: SketchGeometryBudget = {}): Required<SketchGeometryBudget> => Object.freeze({
  maxCoordinates: Math.min(1_000_000, Math.max(1, Math.floor(budget.maxCoordinates ?? DEFAULT_BUDGET.maxCoordinates))),
  maxRings: Math.min(20_000, Math.max(1, Math.floor(budget.maxRings ?? DEFAULT_BUDGET.maxRings))),
  maxPaths: Math.min(20_000, Math.max(1, Math.floor(budget.maxPaths ?? DEFAULT_BUDGET.maxPaths))),
  maxAbsoluteCoordinate: Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, Number(budget.maxAbsoluteCoordinate ?? DEFAULT_BUDGET.maxAbsoluteCoordinate))),
});

const geometryType = (value: unknown): SketchGeometryType => {
  if (value === 'point' || value === 'multipoint' || value === 'polyline' || value === 'polygon' || value === 'extent') return value;
  return 'unknown';
};

const finiteCoordinate = (value: unknown, maximum: number): number | null => {
  if (typeof value !== 'number') return null;
  return Number.isFinite(value) && Math.abs(value) <= maximum ? value : null;
};

interface CoordinateAccumulator { count: number; finite: number; invalid: number; minX: number; minY: number; maxX: number; maxY: number }
const emptyAccumulator = (): CoordinateAccumulator => ({ count: 0, finite: 0, invalid: 0, minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
const addPair = (a: CoordinateAccumulator, x: unknown, y: unknown, maximum: number): void => {
  a.count += 1;
  const nx = finiteCoordinate(x, maximum); const ny = finiteCoordinate(y, maximum);
  if (nx === null || ny === null) { a.invalid += 1; return; }
  a.finite += 1; a.minX = Math.min(a.minX, nx); a.minY = Math.min(a.minY, ny); a.maxX = Math.max(a.maxX, nx); a.maxY = Math.max(a.maxY, ny);
};
const isCoordinatePair = (value: readonly unknown[]): boolean =>
  value.length >= 2 && !Array.isArray(value[0]) && !Array.isArray(value[1]);
const walkCoordinatePairs = (value: unknown, a: CoordinateAccumulator, budget: Required<SketchGeometryBudget>): void => {
  if (a.count >= budget.maxCoordinates || !Array.isArray(value)) return;
  if (isCoordinatePair(value)) { addPair(a, value[0], value[1], budget.maxAbsoluteCoordinate); return; }
  for (const child of value) { if (a.count >= budget.maxCoordinates) break; walkCoordinatePairs(child, a, budget); }
};
const readCoordinatePayload = (type: SketchGeometryType, record: Readonly<Record<string, unknown>>): unknown => {
  if (type === 'point') return [record.x, record.y];
  if (type === 'multipoint') return record.points;
  if (type === 'polyline') return record.paths;
  if (type === 'polygon') return record.rings;
  if (type === 'extent') return [[record.xmin, record.ymin], [record.xmax, record.ymax]];
  return record.coordinates;
};
const countCollections = (value: unknown): number => Array.isArray(value) ? value.length : 0;
const assertCollectionBudget = (type: SketchGeometryType, record: Readonly<Record<string, unknown>>, budget: Required<SketchGeometryBudget>): void => {
  if (type === 'polygon' && countCollections(record.rings) > budget.maxRings) throw new RangeError(`Polygon exceeds ${budget.maxRings} ring budget.`);
  if (type === 'polyline' && countCollections(record.paths) > budget.maxPaths) throw new RangeError(`Polyline exceeds ${budget.maxPaths} path budget.`);
};

export const analyzeGeometry = (geometry: SketchGeometrySnapshot | unknown, budgetInput: SketchGeometryBudget = {}): SketchGeometryAnalysis => {
  const budget = mergeBudget(budgetInput);
  const geometryRecord = isRecord(geometry) ? geometry : EMPTY_RECORD;
  const type = geometryType(geometryRecord.type);
  const payload = isRecord(geometryRecord.payload) ? geometryRecord.payload : geometryRecord;
  assertCollectionBudget(type, payload, budget);
  const a = emptyAccumulator(); walkCoordinatePairs(readCoordinatePayload(type, payload), a, budget);
  const bounds = a.finite > 0 ? Object.freeze([a.minX, a.minY, a.maxX, a.maxY]) as readonly [number, number, number, number] : null;
  return Object.freeze({ type, coordinateCount: a.count, finiteCoordinateCount: a.finite, invalidCoordinateCount: a.invalid, bounds, estimatedBytes: new TextEncoder().encode(JSON.stringify(payload)).byteLength });
};

const sanitizeJson = (value: unknown, depth = 0): JsonValue => {
  if (depth > 12) return null;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map((entry) => sanitizeJson(entry, depth + 1));
  if (!isRecord(value)) return null;
  const output = Object.create(null) as Record<string, JsonValue>;
  for (const [key, nested] of Object.entries(value)) {
    if (BLOCKED_JSON_KEYS.has(key)) continue;
    output[key.slice(0, 256)] = sanitizeJson(nested, depth + 1);
  }
  return Object.freeze(output);
};
const sanitizeObject = (value: unknown): JsonObject => { const json = sanitizeJson(value); return isRecord(json) ? json as JsonObject : Object.freeze(Object.create(null) as Record<string, JsonValue>); };
const readWkid = (geometry: Readonly<Record<string, unknown>>): number | null => {
  const direct = Number(geometry.spatialReferenceWkid); if (Number.isInteger(direct) && direct > 0) return direct;
  const sr = isRecord(geometry.spatialReference) ? geometry.spatialReference : null; const wkid = Number(sr?.wkid); return Number.isInteger(wkid) && wkid > 0 ? wkid : null;
};

export const snapshotGeometry = (geometry: unknown, budgetInput: SketchGeometryBudget = {}): SketchGeometrySnapshot => {
  if (!isRecord(geometry)) return Object.freeze({ type: 'unknown', spatialReferenceWkid: null, payload: Object.freeze({}) });
  const type = geometryType(geometry.type);
  const raw = typeof geometry.toJSON === 'function' ? geometry.toJSON.call(geometry) : geometry;
  const rawRecord = isRecord(raw) ? raw : EMPTY_RECORD;
  const analysis = analyzeGeometry({ type, payload: rawRecord }, budgetInput);
  if (analysis.coordinateCount >= mergeBudget(budgetInput).maxCoordinates) throw new RangeError('Geometry coordinate budget reached or exceeded.');
  if (analysis.invalidCoordinateCount > 0) throw new TypeError('Geometry contains invalid or non-finite coordinates.');
  return Object.freeze({ type, spatialReferenceWkid: readWkid(geometry), payload: sanitizeObject(rawRecord) });
};

export const createGraphicSnapshot = (input: { readonly id: string; readonly geometry: unknown; readonly attributes?: Readonly<Record<string, unknown>>; readonly symbol?: unknown; readonly createdAt?: number; readonly updatedAt?: number }, budgetInput: SketchGeometryBudget = {}): SketchGraphicSnapshot => {
  const id = String(input.id ?? '').trim(); if (!id) throw new TypeError('Sketch graphic id is required.');
  const now = Date.now();
  return Object.freeze({ id: id.slice(0, 200), geometry: snapshotGeometry(input.geometry, budgetInput), attributes: sanitizeObject(input.attributes ?? {}), symbol: input.symbol == null ? null : sanitizeObject(input.symbol), createdAt: Number.isFinite(input.createdAt) ? Number(input.createdAt) : now, updatedAt: Number.isFinite(input.updatedAt) ? Number(input.updatedAt) : now });
};
export const estimateGraphicBytes = (graphic: SketchGraphicSnapshot): number => new TextEncoder().encode(JSON.stringify(graphic)).byteLength;
export const totalGraphicBytes = (graphics: readonly SketchGraphicSnapshot[]): number => graphics.reduce((total, graphic) => total + estimateGraphicBytes(graphic), 0);
