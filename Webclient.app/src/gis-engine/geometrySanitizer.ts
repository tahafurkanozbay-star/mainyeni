import { closeLinearRing, dedupeAdjacentCoordinates, ensureRingOrientation, signedRingArea, type Coordinate } from "./coordinateNormalization";
import { normalizeSpatialReference, validateSpatialReference, type SpatialReferenceLike } from "./spatialReferencePolicy";

export type GeometryKind = "point" | "multipoint" | "polyline" | "polygon";
export interface PointGeometryLike { readonly x: number; readonly y: number; readonly z?: number; readonly spatialReference?: SpatialReferenceLike; }
export interface MultipointGeometryLike { readonly points: readonly Coordinate[]; readonly spatialReference?: SpatialReferenceLike; }
export interface PolylineGeometryLike { readonly paths: readonly (readonly Coordinate[])[]; readonly spatialReference?: SpatialReferenceLike; }
export interface PolygonGeometryLike { readonly rings: readonly (readonly Coordinate[])[]; readonly spatialReference?: SpatialReferenceLike; }
export type GeometryLike = PointGeometryLike | MultipointGeometryLike | PolylineGeometryLike | PolygonGeometryLike;

export interface GeometrySanitizerLimits {
  readonly maxParts: number;
  readonly maxVerticesPerPart: number;
  readonly maxTotalVertices: number;
  readonly coordinateTolerance: number;
  readonly minRingArea: number;
}

export interface GeometrySanitizerIssue { readonly code: string; readonly path: string; readonly severity: "warning" | "error"; }
export interface SanitizedGeometryResult<T> {
  readonly geometry: T | null;
  readonly issues: readonly GeometrySanitizerIssue[];
  readonly acceptedVertices: number;
  readonly droppedVertices: number;
  readonly truncated: boolean;
}

export const DEFAULT_GEOMETRY_SANITIZER_LIMITS: GeometrySanitizerLimits = Object.freeze({
  maxParts: 2_000,
  maxVerticesPerPart: 50_000,
  maxTotalVertices: 250_000,
  coordinateTolerance: 1e-8,
  minRingArea: 1e-12,
});

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const issue = (code: string, path: string, severity: "warning" | "error" = "warning"): GeometrySanitizerIssue => Object.freeze({ code, path, severity });

const normalizeLimits = (input?: Partial<GeometrySanitizerLimits>): GeometrySanitizerLimits => {
  const candidate = { ...DEFAULT_GEOMETRY_SANITIZER_LIMITS, ...input };
  const positiveInteger = (value: number, fallback: number) => Number.isSafeInteger(value) && value > 0 ? value : fallback;
  return Object.freeze({
    maxParts: positiveInteger(candidate.maxParts, DEFAULT_GEOMETRY_SANITIZER_LIMITS.maxParts),
    maxVerticesPerPart: positiveInteger(candidate.maxVerticesPerPart, DEFAULT_GEOMETRY_SANITIZER_LIMITS.maxVerticesPerPart),
    maxTotalVertices: positiveInteger(candidate.maxTotalVertices, DEFAULT_GEOMETRY_SANITIZER_LIMITS.maxTotalVertices),
    coordinateTolerance: finite(candidate.coordinateTolerance) && candidate.coordinateTolerance >= 0 ? candidate.coordinateTolerance : DEFAULT_GEOMETRY_SANITIZER_LIMITS.coordinateTolerance,
    minRingArea: finite(candidate.minRingArea) && candidate.minRingArea >= 0 ? candidate.minRingArea : DEFAULT_GEOMETRY_SANITIZER_LIMITS.minRingArea,
  });
};

const coordinateIsFinite = (coordinate: Coordinate): boolean => coordinate.length >= 2 && coordinate.length <= 3 && coordinate.every(finite);
const freezeCoordinate = (coordinate: Coordinate): Coordinate => Object.freeze([...coordinate]) as Coordinate;

const sanitizePart = (coordinates: readonly Coordinate[], path: string, limits: GeometrySanitizerLimits, budget: { remaining: number }, issues: GeometrySanitizerIssue[]): { coordinates: readonly Coordinate[]; dropped: number; truncated: boolean } => {
  const accepted: Coordinate[] = [];
  let dropped = 0;
  let truncated = false;
  const localLimit = Math.min(limits.maxVerticesPerPart, budget.remaining);
  for (let index = 0; index < coordinates.length; index += 1) {
    const coordinate = coordinates[index]!;
    if (!coordinateIsFinite(coordinate)) {
      dropped += 1;
      issues.push(issue("coordinate-non-finite", `${path}[${index}]`));
      continue;
    }
    if (accepted.length >= localLimit) {
      dropped += coordinates.length - index;
      truncated = true;
      issues.push(issue("vertex-budget-exceeded", path, "error"));
      break;
    }
    accepted.push(freezeCoordinate(coordinate));
  }
  const deduped = dedupeAdjacentCoordinates(accepted, limits.coordinateTolerance);
  dropped += accepted.length - deduped.length;
  if (accepted.length !== deduped.length) issues.push(issue("adjacent-duplicate-coordinate", path));
  budget.remaining -= deduped.length;
  return { coordinates: deduped, dropped, truncated };
};

const spatialReferenceIssues = (spatialReference: SpatialReferenceLike | undefined): readonly GeometrySanitizerIssue[] => validateSpatialReference(spatialReference).map((code) => issue(code, "spatialReference", "error"));

export const sanitizePointGeometry = (geometry: PointGeometryLike, inputLimits?: Partial<GeometrySanitizerLimits>): SanitizedGeometryResult<Readonly<PointGeometryLike>> => {
  void inputLimits;
  const issues = [...spatialReferenceIssues(geometry.spatialReference)];
  if (!finite(geometry.x) || !finite(geometry.y) || (geometry.z !== undefined && !finite(geometry.z))) {
    issues.push(issue("point-coordinate-non-finite", "point", "error"));
    return Object.freeze({ geometry: null, issues: Object.freeze(issues), acceptedVertices: 0, droppedVertices: 1, truncated: false });
  }
  const normalizedSpatialReference = normalizeSpatialReference(geometry.spatialReference);
  const sanitized = Object.freeze({ x: geometry.x, y: geometry.y, ...(geometry.z === undefined ? {} : { z: geometry.z }), spatialReference: normalizedSpatialReference });
  return Object.freeze({ geometry: sanitized, issues: Object.freeze(issues), acceptedVertices: 1, droppedVertices: 0, truncated: false });
};

export const sanitizeMultipointGeometry = (geometry: MultipointGeometryLike, inputLimits?: Partial<GeometrySanitizerLimits>): SanitizedGeometryResult<Readonly<MultipointGeometryLike>> => {
  const limits = normalizeLimits(inputLimits);
  const issues = [...spatialReferenceIssues(geometry.spatialReference)];
  const budget = { remaining: limits.maxTotalVertices };
  const part = sanitizePart(geometry.points, "points", limits, budget, issues);
  const sanitized = Object.freeze({ points: part.coordinates, spatialReference: normalizeSpatialReference(geometry.spatialReference) });
  return Object.freeze({ geometry: sanitized, issues: Object.freeze(issues), acceptedVertices: part.coordinates.length, droppedVertices: part.dropped, truncated: part.truncated });
};

export const sanitizePolylineGeometry = (geometry: PolylineGeometryLike, inputLimits?: Partial<GeometrySanitizerLimits>): SanitizedGeometryResult<Readonly<PolylineGeometryLike>> => {
  const limits = normalizeLimits(inputLimits);
  const issues = [...spatialReferenceIssues(geometry.spatialReference)];
  const budget = { remaining: limits.maxTotalVertices };
  const paths: (readonly Coordinate[])[] = [];
  let dropped = 0;
  let truncated = false;
  const partCount = Math.min(geometry.paths.length, limits.maxParts);
  if (geometry.paths.length > partCount) {
    truncated = true;
    issues.push(issue("part-budget-exceeded", "paths", "error"));
  }
  for (let index = 0; index < partCount && budget.remaining > 0; index += 1) {
    const result = sanitizePart(geometry.paths[index]!, `paths[${index}]`, limits, budget, issues);
    dropped += result.dropped;
    truncated ||= result.truncated;
    if (result.coordinates.length >= 2) paths.push(result.coordinates);
    else {
      dropped += result.coordinates.length;
      issues.push(issue("polyline-path-degenerate", `paths[${index}]`));
    }
  }
  const acceptedVertices = paths.reduce((sum, path) => sum + path.length, 0);
  return Object.freeze({ geometry: Object.freeze({ paths: Object.freeze(paths), spatialReference: normalizeSpatialReference(geometry.spatialReference) }), issues: Object.freeze(issues), acceptedVertices, droppedVertices: dropped, truncated });
};

export const sanitizePolygonGeometry = (geometry: PolygonGeometryLike, inputLimits?: Partial<GeometrySanitizerLimits>): SanitizedGeometryResult<Readonly<PolygonGeometryLike>> => {
  const limits = normalizeLimits(inputLimits);
  const issues = [...spatialReferenceIssues(geometry.spatialReference)];
  const budget = { remaining: limits.maxTotalVertices };
  const rings: (readonly Coordinate[])[] = [];
  let dropped = 0;
  let truncated = false;
  const partCount = Math.min(geometry.rings.length, limits.maxParts);
  if (geometry.rings.length > partCount) {
    truncated = true;
    issues.push(issue("part-budget-exceeded", "rings", "error"));
  }
  for (let index = 0; index < partCount && budget.remaining > 0; index += 1) {
    const result = sanitizePart(geometry.rings[index]!, `rings[${index}]`, limits, budget, issues);
    dropped += result.dropped;
    truncated ||= result.truncated;
    const closed = closeLinearRing(result.coordinates, limits.coordinateTolerance);
    if (closed.length < 4 || Math.abs(signedRingArea(closed)) < limits.minRingArea) {
      dropped += result.coordinates.length;
      issues.push(issue("polygon-ring-degenerate", `rings[${index}]`));
      continue;
    }
    const orientation = index === 0 ? "clockwise" : "counterclockwise";
    rings.push(ensureRingOrientation(closed, orientation));
  }
  const acceptedVertices = rings.reduce((sum, ring) => sum + ring.length, 0);
  return Object.freeze({ geometry: Object.freeze({ rings: Object.freeze(rings), spatialReference: normalizeSpatialReference(geometry.spatialReference) }), issues: Object.freeze(issues), acceptedVertices, droppedVertices: dropped, truncated });
};