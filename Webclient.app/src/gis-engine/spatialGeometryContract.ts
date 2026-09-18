export type SpatialGeometryType = 'point' | 'multipoint' | 'polyline' | 'polygon' | 'extent';

export interface SpatialReferenceContract {
  readonly wkid?: number;
  readonly latestWkid?: number;
}

export interface PointContract {
  readonly type: 'point';
  readonly x: number;
  readonly y: number;
  readonly z?: number;
  readonly m?: number;
  readonly spatialReference?: SpatialReferenceContract;
}

export interface MultipointContract {
  readonly type: 'multipoint';
  readonly points: readonly (readonly number[])[];
  readonly spatialReference?: SpatialReferenceContract;
}

export interface PolylineContract {
  readonly type: 'polyline';
  readonly paths: readonly (readonly (readonly number[])[])[];
  readonly spatialReference?: SpatialReferenceContract;
}

export interface PolygonContract {
  readonly type: 'polygon';
  readonly rings: readonly (readonly (readonly number[])[])[];
  readonly spatialReference?: SpatialReferenceContract;
}

export interface ExtentContract {
  readonly type: 'extent';
  readonly xmin: number;
  readonly ymin: number;
  readonly xmax: number;
  readonly ymax: number;
  readonly zmin?: number;
  readonly zmax?: number;
  readonly spatialReference?: SpatialReferenceContract;
}

export type SpatialGeometryContract = PointContract | MultipointContract | PolylineContract | PolygonContract | ExtentContract;

export interface SpatialGeometryLimits {
  readonly maxParts: number;
  readonly maxVertices: number;
  readonly maxCoordinatesPerVertex: number;
  readonly maxAbsoluteCoordinate: number;
}

export interface SpatialGeometryInspection {
  readonly type: SpatialGeometryType;
  readonly partCount: number;
  readonly vertexCount: number;
  readonly coordinateCount: number;
  readonly hasZ: boolean;
  readonly hasM: boolean;
  readonly spatialReferenceWkid?: number;
  readonly bounds: Readonly<{ xmin: number; ymin: number; xmax: number; ymax: number }>;
}

const DEFAULT_LIMITS: SpatialGeometryLimits = Object.freeze({
  maxParts: 10_000,
  maxVertices: 250_000,
  maxCoordinatesPerVertex: 4,
  maxAbsoluteCoordinate: 1_000_000_000,
});

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
  return value;
}

function positiveFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be positive and finite`);
  return value;
}

export function normalizeSpatialGeometryLimits(input: Partial<SpatialGeometryLimits> = {}): SpatialGeometryLimits {
  const maxCoordinatesPerVertex = positiveInteger(input.maxCoordinatesPerVertex ?? DEFAULT_LIMITS.maxCoordinatesPerVertex, 'maxCoordinatesPerVertex');
  if (maxCoordinatesPerVertex < 2 || maxCoordinatesPerVertex > 4) throw new RangeError('maxCoordinatesPerVertex must be between 2 and 4');
  return Object.freeze({
    maxParts: positiveInteger(input.maxParts ?? DEFAULT_LIMITS.maxParts, 'maxParts'),
    maxVertices: positiveInteger(input.maxVertices ?? DEFAULT_LIMITS.maxVertices, 'maxVertices'),
    maxCoordinatesPerVertex,
    maxAbsoluteCoordinate: positiveFinite(input.maxAbsoluteCoordinate ?? DEFAULT_LIMITS.maxAbsoluteCoordinate, 'maxAbsoluteCoordinate'),
  });
}

function canonicalNumber(value: number, name: string, maxAbsolute: number): number {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
  if (Math.abs(value) > maxAbsolute) throw new RangeError(`${name} exceeds coordinate budget`);
  return Object.is(value, -0) ? 0 : value;
}

function normalizeWkid(reference: SpatialReferenceContract | undefined): number | undefined {
  const value = reference?.latestWkid ?? reference?.wkid;
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError('spatial reference WKID must be a positive safe integer');
  return value;
}

type NormalizedVertex = readonly [number, number, ...number[]];

function normalizeVertex(
  vertex: readonly number[],
  limits: SpatialGeometryLimits,
  name: string,
): NormalizedVertex {
  if (vertex.length < 2) throw new TypeError(`${name} requires at least x and y coordinates`);
  if (vertex.length > limits.maxCoordinatesPerVertex) throw new RangeError(`${name} exceeds coordinate dimension budget`);
  const coordinates = vertex.map((coordinate, index) => (
    canonicalNumber(coordinate, `${name}[${index}]`, limits.maxAbsoluteCoordinate)
  ));
  const x = coordinates[0];
  const y = coordinates[1];
  if (x === undefined || y === undefined) throw new TypeError(`${name} requires at least x and y coordinates`);
  return Object.freeze([x, y, ...coordinates.slice(2)]);
}

function coordinateAt(vertex: NormalizedVertex, index: number, name: string): number {
  const coordinate = vertex[index];
  if (coordinate === undefined) throw new TypeError(`${name} is missing from normalized vertex`);
  return coordinate;
}

class InspectionAccumulator {
  partCount = 0;
  vertexCount = 0;
  coordinateCount = 0;
  hasZ = false;
  hasM = false;
  xmin = Number.POSITIVE_INFINITY;
  ymin = Number.POSITIVE_INFINITY;
  xmax = Number.NEGATIVE_INFINITY;
  ymax = Number.NEGATIVE_INFINITY;

  constructor(readonly limits: SpatialGeometryLimits) {}

  addPart(): void {
    this.partCount += 1;
    if (this.partCount > this.limits.maxParts) throw new RangeError('geometry exceeds part budget');
  }

  addVertex(vertex: readonly number[], name: string): NormalizedVertex {
    this.vertexCount += 1;
    if (this.vertexCount > this.limits.maxVertices) throw new RangeError('geometry exceeds vertex budget');
    const normalized = normalizeVertex(vertex, this.limits, name);
    this.coordinateCount += normalized.length;
    this.hasZ ||= normalized.length >= 3;
    this.hasM ||= normalized.length >= 4;
    this.xmin = Math.min(this.xmin, normalized[0]);
    this.ymin = Math.min(this.ymin, normalized[1]);
    this.xmax = Math.max(this.xmax, normalized[0]);
    this.ymax = Math.max(this.ymax, normalized[1]);
    return normalized;
  }

  bounds(): Readonly<{ xmin: number; ymin: number; xmax: number; ymax: number }> {
    if (this.vertexCount === 0) throw new TypeError('geometry must contain at least one vertex');
    return Object.freeze({ xmin: this.xmin, ymin: this.ymin, xmax: this.xmax, ymax: this.ymax });
  }
}

function normalizeParts(
  parts: readonly (readonly (readonly number[])[])[],
  limits: SpatialGeometryLimits,
  accumulator: InspectionAccumulator,
  kind: 'path' | 'ring',
): readonly (readonly (readonly number[])[])[] {
  if (parts.length === 0) throw new TypeError(`${kind} geometry must contain at least one part`);
  return Object.freeze(parts.map((part, partIndex) => {
    accumulator.addPart();
    const minimum = kind === 'ring' ? 4 : 2;
    if (part.length < minimum) throw new TypeError(`${kind} ${partIndex} requires at least ${minimum} vertices`);
    const normalized = Object.freeze(part.map((vertex, vertexIndex) => accumulator.addVertex(vertex, `${kind}[${partIndex}][${vertexIndex}]`)));
    if (kind === 'ring') {
      const first = normalized[0];
      const last = normalized[normalized.length - 1];
      if (first === undefined || last === undefined) throw new TypeError(`ring ${partIndex} must contain vertices`);
      if (first[0] !== last[0] || first[1] !== last[1]) throw new TypeError(`ring ${partIndex} must be closed`);
    }
    return normalized;
  }));
}

export function normalizeSpatialGeometry(
  geometry: SpatialGeometryContract,
  limitInput: Partial<SpatialGeometryLimits> = {},
): Readonly<{ geometry: SpatialGeometryContract; inspection: SpatialGeometryInspection }> {
  const limits = normalizeSpatialGeometryLimits(limitInput);
  const accumulator = new InspectionAccumulator(limits);
  const wkid = normalizeWkid(geometry.spatialReference);
  let normalized: SpatialGeometryContract;

  if (geometry.type === 'point') {
    accumulator.addPart();
    const vertex = accumulator.addVertex([
      geometry.x,
      geometry.y,
      ...(geometry.z === undefined ? [] : [geometry.z]),
      ...(geometry.m === undefined ? [] : [geometry.m]),
    ], 'point');
    const z = geometry.z === undefined ? undefined : coordinateAt(vertex, 2, 'point.z');
    const m = geometry.m === undefined
      ? undefined
      : coordinateAt(vertex, geometry.z === undefined ? 2 : 3, 'point.m');
    normalized = Object.freeze({
      type: 'point',
      x: vertex[0],
      y: vertex[1],
      ...(z === undefined ? {} : { z }),
      ...(m === undefined ? {} : { m }),
      ...(wkid === undefined ? {} : { spatialReference: Object.freeze({ wkid }) }),
    });
  } else if (geometry.type === 'multipoint') {
    if (geometry.points.length === 0) throw new TypeError('multipoint must contain at least one point');
    accumulator.addPart();
    const points = Object.freeze(geometry.points.map((vertex, index) => accumulator.addVertex(vertex, `point[${index}]`)));
    normalized = Object.freeze({ type: 'multipoint', points, ...(wkid === undefined ? {} : { spatialReference: Object.freeze({ wkid }) }) });
  } else if (geometry.type === 'polyline') {
    const paths = normalizeParts(geometry.paths, limits, accumulator, 'path');
    normalized = Object.freeze({ type: 'polyline', paths, ...(wkid === undefined ? {} : { spatialReference: Object.freeze({ wkid }) }) });
  } else if (geometry.type === 'polygon') {
    const rings = normalizeParts(geometry.rings, limits, accumulator, 'ring');
    normalized = Object.freeze({ type: 'polygon', rings, ...(wkid === undefined ? {} : { spatialReference: Object.freeze({ wkid }) }) });
  } else {
    accumulator.addPart();
    const xmin = canonicalNumber(geometry.xmin, 'extent.xmin', limits.maxAbsoluteCoordinate);
    const ymin = canonicalNumber(geometry.ymin, 'extent.ymin', limits.maxAbsoluteCoordinate);
    const xmax = canonicalNumber(geometry.xmax, 'extent.xmax', limits.maxAbsoluteCoordinate);
    const ymax = canonicalNumber(geometry.ymax, 'extent.ymax', limits.maxAbsoluteCoordinate);
    if (xmin > xmax || ymin > ymax) throw new RangeError('extent minimum coordinates must not exceed maximum coordinates');
    accumulator.addVertex([xmin, ymin], 'extent.minimum');
    accumulator.addVertex([xmax, ymax], 'extent.maximum');
    const zmin = geometry.zmin === undefined ? undefined : canonicalNumber(geometry.zmin, 'extent.zmin', limits.maxAbsoluteCoordinate);
    const zmax = geometry.zmax === undefined ? undefined : canonicalNumber(geometry.zmax, 'extent.zmax', limits.maxAbsoluteCoordinate);
    if (zmin !== undefined && zmax !== undefined && zmin > zmax) throw new RangeError('extent zmin must not exceed zmax');
    normalized = Object.freeze({
      type: 'extent', xmin, ymin, xmax, ymax,
      ...(zmin === undefined ? {} : { zmin }),
      ...(zmax === undefined ? {} : { zmax }),
      ...(wkid === undefined ? {} : { spatialReference: Object.freeze({ wkid }) }),
    });
  }

  const inspection: SpatialGeometryInspection = Object.freeze({
    type: normalized.type,
    partCount: accumulator.partCount,
    vertexCount: accumulator.vertexCount,
    coordinateCount: accumulator.coordinateCount,
    hasZ: accumulator.hasZ || (normalized.type === 'extent' && (normalized.zmin !== undefined || normalized.zmax !== undefined)),
    hasM: accumulator.hasM,
    ...(wkid === undefined ? {} : { spatialReferenceWkid: wkid }),
    bounds: accumulator.bounds(),
  });
  return Object.freeze({ geometry: normalized, inspection });
}

export function estimateSpatialGeometryBytes(inspection: SpatialGeometryInspection): number {
  const coordinateBytes = inspection.coordinateCount * 8;
  const vertexOverhead = inspection.vertexCount * 8;
  const partOverhead = inspection.partCount * 16;
  const baseOverhead = 96;
  const total = coordinateBytes + vertexOverhead + partOverhead + baseOverhead;
  if (!Number.isSafeInteger(total)) throw new RangeError('geometry byte estimate exceeds safe integer range');
  return total;
}

export function geometryIntersectsBounds(
  inspection: SpatialGeometryInspection,
  bounds: Readonly<{ xmin: number; ymin: number; xmax: number; ymax: number }>,
): boolean {
  const xmin = canonicalNumber(bounds.xmin, 'bounds.xmin', Number.MAX_VALUE);
  const ymin = canonicalNumber(bounds.ymin, 'bounds.ymin', Number.MAX_VALUE);
  const xmax = canonicalNumber(bounds.xmax, 'bounds.xmax', Number.MAX_VALUE);
  const ymax = canonicalNumber(bounds.ymax, 'bounds.ymax', Number.MAX_VALUE);
  if (xmin > xmax || ymin > ymax) throw new RangeError('bounds minimum coordinates must not exceed maximum coordinates');
  const source = inspection.bounds;
  return source.xmax >= xmin && source.xmin <= xmax && source.ymax >= ymin && source.ymin <= ymax;
}
