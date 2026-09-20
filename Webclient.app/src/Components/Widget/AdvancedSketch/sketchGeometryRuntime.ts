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

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const mergeBudget = (budget: SketchGeometryBudget = {}): Required<SketchGeometryBudget> => Object.freeze({
  maxCoordinates: Math.min(1_000_000, Math.max(1, Math.floor(budget.maxCoordinates ?? DEFAULT_BUDGET.maxCoordinates))),
  maxRings: Math.min(20_000, Math.max(1, Math.floor(budget.maxRings ?? DEFAULT_BUDGET.maxRings))),
  maxPaths: Math.min(20_000, Math.max(1, Math.floor(budget.maxPaths ?? DEFAULT_BUDGET.maxPaths))),
  maxAbsoluteCoordinate: Math.min(
    Number.MAX_SAFE_INTEGER,
    Math.max(1, Number(budget.maxAbsoluteCoordinate ?? DEFAULT_BUDGET.maxAbsoluteCoordinate)),
  ),
});

const geometryType = (value: unknown): SketchGeometryType => {
  if (
    value === 'point'
    || value === 'multipoint'
    || value === 'polyline'
    || value === 'polygon'
    || value === 'extent'
  ) return value;
  return 'unknown';
};

const finiteCoordinate = (value: unknown, maximum: number): number | null => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && Math.abs(numeric) <= maximum ? numeric : null;
};

interface CoordinateAccumulator {
  count: number;
  finite: number;
  invalid: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const emptyAccumulator = (): CoordinateAccumulator => ({
  count: 0,
  finite: 0,
  invalid: 0,
  minX: Number.POSITIVE_INFINITY,
  minY: Number.POSITIVE_INFINITY,
  maxX: Number.NEGATIVE_INFINITY,
  maxY: Number.NEGATIVE_INFINITY,
});

const addPair = (
  accumulator: CoordinateAccumulator,
  x: unknown,
  y: unknown,
  maximum: number,
): void => {
  accumulator.count += 1;
  const normalizedX = finiteCoordinate(x, maximum);
  const normalizedY = finiteCoordinate(y, maximum);
  if (normalizedX === null || normalizedY === null) {
    accumulator.invalid += 1;
    return;
  }
  accumulator.finite += 1;
  accumulator.minX = Math.min(accumulator.minX, normalizedX);
  accumulator.minY = Math.min(accumulator.minY, normalizedY);
  accumulator.maxX = Math.max(accumulator.maxX, normalizedX);
  accumulator.maxY = Math.max(accumulator.maxY, normalizedY);
};

const walkCoordinatePairs = (
  value: unknown,
  accumulator: CoordinateAccumulator,
  budget: Required<SketchGeometryBudget>,
): void => {
  if (accumulator.count >= budget.maxCoordinates) return;
  if (!Array.isArray(value)) return;

  if (
    value.length >= 2
    && typeof value[0] !== 'object'
    && typeof value[1] !== 'object'
  ) {
    addPair(accumulator, value[0], value[1], budget.maxAbsoluteCoordinate);
    return;
  }

  for (const child of value) {
    if (accumulator.count >= budget.maxCoordinates) break;
    walkCoordinatePairs(child, accumulator, budget);
  }
};

const readCoordinatePayload = (
  type: SketchGeometryType,
  record: Readonly<Record<string, unknown>>,
): unknown => {
  if (type === 'point') return [record.x, record.y];
  if (type === 'multipoint') return record.points;
  if (type === 'polyline') return record.paths;
  if (type === 'polygon') return record.rings;
  if (type === 'extent') return [
    [record.xmin, record.ymin],
    [record.xmax, record.ymax],
  ];
  return record.coordinates;
};

const countCollections = (value: unknown): number =>
  Array.isArray(value) ? value.length : 0;

const assertCollectionBudget = (
  type: SketchGeometryType,
  record: Readonly<Record<string, unknown>>,
  budget: Required<SketchGeometryBudget>,
): void => {
  if (type === 'polygon' && countCollections(record.rings) > budget.maxRings) {
    throw new RangeError(`Polygon exceeds ${budget.maxRings} ring budget.`);
  }
  if (type === 'polyline' && countCollections(record.paths) > budget.maxPaths) {
    throw new RangeError(`Polyline exceeds ${budget.maxPaths} path budget.`);
  }
};

export const analyzeGeometry = (
  geometry: SketchGeometrySnapshot | unknown,
  budgetInput: SketchGeometryBudget = {},
): SketchGeometryAnalysis => {
  const budget = mergeBudget(budgetInput);
  const geometryRecord = isRecord(geometry) ? geometry : Object.freeze({});
  const type = geometryType(geometryRecord.type);
  const payload = isRecord(geometryRecord.payload)
    ? geometryRecord.payload
    : isRecord(geometry)
      ? geometry
      : Object.freeze({});
  assertCollectionBudget(type, payload, budget);

  const accumulator = emptyAccumulator();
  walkCoordinatePairs(readCoordinatePayload(type, payload), accumulator, budget);
  const bounds = accumulator.finite > 0
    ? Object.freeze([
      accumulator.minX,
      accumulator.minY,
      accumulator.maxX,
      accumulator.maxY,
    ]) as readonly [number, number, number, number]
    : null;
  const serialized = JSON.stringify(payload);

  return Object.freeze({
    type,
    coordinateCount: accumulator.count,
    finiteCoordinateCount: accumulator.finite,
    invalidCoordinateCount: accumulator.invalid,
    bounds,
    estimatedBytes: new TextEncoder().encode(serialized).byteLength,
  });
};

const sanitizeJson = (value: unknown, depth = 0): JsonValue => {
  if (depth > 12) return null;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map((entry) => sanitizeJson(entry, depth + 1));
  if (!isRecord(value)) return null;
  const output: Record<string, JsonValue> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') continue;
    output[key.slice(0, 256)] = sanitizeJson(nested, depth + 1);
  }
  return Object.freeze(output);
};

const sanitizeObject = (value: unknown): JsonObject => {
  const json = sanitizeJson(value);
  return isRecord(json) ? json as JsonObject : Object.freeze({});
};

const readWkid = (geometry: Readonly<Record<string, unknown>>): number | null => {
  const direct = Number(geometry.spatialReferenceWkid);
  if (Number.isInteger(direct) && direct > 0) return direct;
  const spatialReference = isRecord(geometry.spatialReference) ? geometry.spatialReference : null;
  const wkid = Number(spatialReference?.wkid);
  return Number.isInteger(wkid) && wkid > 0 ? wkid : null;
};

export const snapshotGeometry = (
  geometry: unknown,
  budgetInput: SketchGeometryBudget = {},
): SketchGeometrySnapshot => {
  if (!isRecord(geometry)) {
    return Object.freeze({
      type: 'unknown',
      spatialReferenceWkid: null,
      payload: Object.freeze({}),
    });
  }
  const type = geometryType(geometry.type);
  const toJson = geometry.toJSON;
  const payload = sanitizeObject(
    typeof toJson === 'function' ? toJson.call(geometry) : geometry,
  );
  const snapshot = Object.freeze({
    type,
    spatialReferenceWkid: readWkid(geometry),
    payload,
  });
  const analysis = analyzeGeometry(snapshot, budgetInput);
  if (analysis.coordinateCount >= mergeBudget(budgetInput).maxCoordinates) {
    throw new RangeError('Geometry coordinate budget reached or exceeded.');
  }
  if (analysis.invalidCoordinateCount > 0) {
    throw new TypeError('Geometry contains invalid or non-finite coordinates.');
  }
  return snapshot;
};

export const createGraphicSnapshot = (
  input: {
    readonly id: string;
    readonly geometry: unknown;
    readonly attributes?: Readonly<Record<string, unknown>>;
    readonly symbol?: unknown;
    readonly createdAt?: number;
    readonly updatedAt?: number;
  },
  budgetInput: SketchGeometryBudget = {},
): SketchGraphicSnapshot => {
  const id = String(input.id ?? '').trim();
  if (!id) throw new TypeError('Sketch graphic id is required.');
  const now = Date.now();
  const createdAt = Number.isFinite(input.createdAt) ? Number(input.createdAt) : now;
  const updatedAt = Number.isFinite(input.updatedAt) ? Number(input.updatedAt) : now;
  return Object.freeze({
    id: id.slice(0, 200),
    geometry: snapshotGeometry(input.geometry, budgetInput),
    attributes: sanitizeObject(input.attributes ?? {}),
    symbol: input.symbol === null || input.symbol === undefined ? null : sanitizeObject(input.symbol),
    createdAt,
    updatedAt,
  });
};

export const estimateGraphicBytes = (graphic: SketchGraphicSnapshot): number =>
  new TextEncoder().encode(JSON.stringify(graphic)).byteLength;

export const totalGraphicBytes = (graphics: readonly SketchGraphicSnapshot[]): number =>
  graphics.reduce((total, graphic) => total + estimateGraphicBytes(graphic), 0);
