import {
  type Coordinate2D,
  type Extent2D,
  type NormalizedSpatialReference,
  type SpatialReferenceRuntimeOptions,
  normalizeExtent,
  projectCoordinate,
  projectCoordinates,
  projectExtent,
  spatialReferencesEquivalent,
} from "./spatialReferenceRuntime";

export type PointGeometry2D = Readonly<{ type: "point"; x: number; y: number; spatialReference: NormalizedSpatialReference }>;
export type MultipointGeometry2D = Readonly<{ type: "multipoint"; points: readonly Coordinate2D[]; spatialReference: NormalizedSpatialReference }>;
export type PolylineGeometry2D = Readonly<{ type: "polyline"; paths: readonly (readonly Coordinate2D[])[]; spatialReference: NormalizedSpatialReference }>;
export type PolygonGeometry2D = Readonly<{ type: "polygon"; rings: readonly (readonly Coordinate2D[])[]; spatialReference: NormalizedSpatialReference }>;
export type ExtentGeometry2D = Readonly<{ type: "extent"; extent: Extent2D; spatialReference: NormalizedSpatialReference }>;
export type Geometry2D = PointGeometry2D | MultipointGeometry2D | PolylineGeometry2D | PolygonGeometry2D | ExtentGeometry2D;

export type GeometryProjectionOptions = SpatialReferenceRuntimeOptions & Readonly<{
  signal?: AbortSignal;
  maxParts?: number;
  maxVerticesPerPart?: number;
  closePolygonRings?: boolean;
}>;

const DEFAULT_MAX_PARTS = 10_000;
const DEFAULT_MAX_VERTICES_PER_PART = 100_000;

function positiveBudget(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new RangeError(`${label} must be a positive safe integer`);
  return resolved;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return value;
}

function coordinate(value: Coordinate2D, label: string): Coordinate2D {
  return Object.freeze([finite(value[0], `${label}.x`), finite(value[1], `${label}.y`)]);
}

function sameCoordinate(a: Coordinate2D, b: Coordinate2D): boolean {
  return Object.is(a[0], b[0]) && Object.is(a[1], b[1]);
}

function validatePart(
  part: readonly Coordinate2D[],
  partIndex: number,
  maxVerticesPerPart: number,
  signal?: AbortSignal,
): readonly Coordinate2D[] {
  if (part.length > maxVerticesPerPart) throw new RangeError(`geometry part ${partIndex} exceeds vertex budget`);
  const result: Coordinate2D[] = [];
  for (let index = 0; index < part.length; index += 1) {
    throwIfAborted(signal);
    result.push(coordinate(part[index]!, `part[${partIndex}][${index}]`));
  }
  return Object.freeze(result);
}

function validateParts(
  parts: readonly (readonly Coordinate2D[])[],
  options: GeometryProjectionOptions,
): readonly (readonly Coordinate2D[])[] {
  const maxParts = positiveBudget(options.maxParts, DEFAULT_MAX_PARTS, "maxParts");
  const maxVerticesPerPart = positiveBudget(options.maxVerticesPerPart, DEFAULT_MAX_VERTICES_PER_PART, "maxVerticesPerPart");
  if (parts.length > maxParts) throw new RangeError("geometry exceeds part budget");
  let totalVertices = 0;
  const maxCoordinates = positiveBudget(options.maxCoordinates, 100_000, "maxCoordinates");
  const result: (readonly Coordinate2D[])[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    throwIfAborted(options.signal);
    const normalized = validatePart(parts[index]!, index, maxVerticesPerPart, options.signal);
    totalVertices += normalized.length;
    if (totalVertices > maxCoordinates) throw new RangeError("geometry exceeds total coordinate budget");
    result.push(normalized);
  }
  return Object.freeze(result);
}

function closeRing(ring: readonly Coordinate2D[]): readonly Coordinate2D[] {
  if (ring.length === 0 || sameCoordinate(ring[0]!, ring[ring.length - 1]!)) return ring;
  return Object.freeze([...ring, ring[0]!]);
}

export function normalizeGeometry2D(geometry: Geometry2D, options: GeometryProjectionOptions = {}): Geometry2D {
  throwIfAborted(options.signal);
  switch (geometry.type) {
    case "point":
      return Object.freeze({ type: "point", x: finite(geometry.x, "point.x"), y: finite(geometry.y, "point.y"), spatialReference: geometry.spatialReference });
    case "extent":
      return Object.freeze({ type: "extent", extent: normalizeExtent(geometry.extent), spatialReference: geometry.spatialReference });
    case "multipoint": {
      const points = validatePart(geometry.points, 0, positiveBudget(options.maxCoordinates, 100_000, "maxCoordinates"), options.signal);
      return Object.freeze({ type: "multipoint", points, spatialReference: geometry.spatialReference });
    }
    case "polyline": {
      const paths = validateParts(geometry.paths, options);
      return Object.freeze({ type: "polyline", paths, spatialReference: geometry.spatialReference });
    }
    case "polygon": {
      const rings = validateParts(geometry.rings, options);
      const normalizedRings = options.closePolygonRings === false ? rings : Object.freeze(rings.map(closeRing));
      return Object.freeze({ type: "polygon", rings: normalizedRings, spatialReference: geometry.spatialReference });
    }
  }
}

function projectPart(
  part: readonly Coordinate2D[],
  source: NormalizedSpatialReference,
  target: NormalizedSpatialReference,
  options: GeometryProjectionOptions,
): readonly Coordinate2D[] {
  return projectCoordinates(part, source, target, { maxCoordinates: positiveBudget(options.maxVerticesPerPart, 100_000, "maxVerticesPerPart"), signal: options.signal });
}

export function projectGeometry2D(
  geometry: Geometry2D,
  target: NormalizedSpatialReference,
  options: GeometryProjectionOptions = {},
): Geometry2D {
  const normalized = normalizeGeometry2D(geometry, options);
  throwIfAborted(options.signal);
  if (spatialReferencesEquivalent(normalized.spatialReference, target)) {
    return Object.freeze({ ...normalized, spatialReference: target }) as Geometry2D;
  }
  switch (normalized.type) {
    case "point": {
      const [x, y] = projectCoordinate([normalized.x, normalized.y], normalized.spatialReference, target);
      return Object.freeze({ type: "point", x, y, spatialReference: target });
    }
    case "extent":
      return Object.freeze({ type: "extent", extent: projectExtent(normalized.extent, normalized.spatialReference, target), spatialReference: target });
    case "multipoint":
      return Object.freeze({ type: "multipoint", points: projectCoordinates(normalized.points, normalized.spatialReference, target, options), spatialReference: target });
    case "polyline": {
      const paths = normalized.paths.map((path) => projectPart(path, normalized.spatialReference, target, options));
      return Object.freeze({ type: "polyline", paths: Object.freeze(paths), spatialReference: target });
    }
    case "polygon": {
      const rings = normalized.rings.map((ring) => projectPart(ring, normalized.spatialReference, target, options));
      return Object.freeze({ type: "polygon", rings: Object.freeze(rings), spatialReference: target });
    }
  }
}

export function geometryExtent2D(geometry: Geometry2D, options: GeometryProjectionOptions = {}): Extent2D {
  const normalized = normalizeGeometry2D(geometry, options);
  if (normalized.type === "extent") return normalized.extent;
  if (normalized.type === "point") return Object.freeze({ xmin: normalized.x, ymin: normalized.y, xmax: normalized.x, ymax: normalized.y });
  const parts = normalized.type === "multipoint" ? [normalized.points] : normalized.type === "polyline" ? normalized.paths : normalized.rings;
  let xmin = Number.POSITIVE_INFINITY;
  let ymin = Number.POSITIVE_INFINITY;
  let xmax = Number.NEGATIVE_INFINITY;
  let ymax = Number.NEGATIVE_INFINITY;
  let count = 0;
  for (const part of parts) {
    for (const [x, y] of part) {
      throwIfAborted(options.signal);
      xmin = Math.min(xmin, x);
      ymin = Math.min(ymin, y);
      xmax = Math.max(xmax, x);
      ymax = Math.max(ymax, y);
      count += 1;
    }
  }
  if (count === 0) throw new RangeError("geometry has no coordinates");
  return Object.freeze({ xmin, ymin, xmax, ymax });
}

export function projectGeometryBatch(
  geometries: readonly Geometry2D[],
  target: NormalizedSpatialReference,
  options: GeometryProjectionOptions & Readonly<{ maxGeometries?: number }> = {},
): readonly Geometry2D[] {
  const maxGeometries = positiveBudget(options.maxGeometries, 10_000, "maxGeometries");
  if (geometries.length > maxGeometries) throw new RangeError("geometry batch exceeds configured budget");
  const result: Geometry2D[] = [];
  for (const geometry of geometries) {
    throwIfAborted(options.signal);
    result.push(projectGeometry2D(geometry, target, options));
  }
  return Object.freeze(result);
}
