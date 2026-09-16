import { canonicalSpatialReference, type SpatialReferenceLike } from './spatialExtent';

export type Coordinate = readonly [number, number];
export type CoordinateZ = readonly [number, number, number];
export type NormalizedPoint = Readonly<{ type: 'point'; coordinate: Coordinate; z?: number; spatialReference?: SpatialReferenceLike }>;
export type NormalizedMultipoint = Readonly<{ type: 'multipoint'; points: readonly Coordinate[]; spatialReference?: SpatialReferenceLike }>;
export type NormalizedPolyline = Readonly<{ type: 'polyline'; paths: readonly (readonly Coordinate[])[]; spatialReference?: SpatialReferenceLike }>;
export type NormalizedPolygon = Readonly<{ type: 'polygon'; rings: readonly (readonly Coordinate[])[]; spatialReference?: SpatialReferenceLike }>;
export type NormalizedGeometry = NormalizedPoint | NormalizedMultipoint | NormalizedPolyline | NormalizedPolygon;
export type GeometryNormalizationLimits = Readonly<{ maxParts: number; maxVertices: number; maxVerticesPerPart: number }>;
export type GeometryNormalizationResult = Readonly<{ geometry: NormalizedGeometry | null; vertexCount: number; droppedParts: number; repairedRings: number; reason?: string }>;

const DEFAULT_LIMITS: GeometryNormalizationLimits = Object.freeze({ maxParts: 2048, maxVertices: 100_000, maxVerticesPerPart: 50_000 });
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const coordinate = (value: unknown): Coordinate | null => Array.isArray(value) && value.length >= 2 && finite(value[0]) && finite(value[1]) ? Object.freeze([value[0], value[1]]) : null;
const same = (a: Coordinate, b: Coordinate): boolean => a[0] === b[0] && a[1] === b[1];
const validLimits = (input?: Partial<GeometryNormalizationLimits>): GeometryNormalizationLimits => {
  const merged = { ...DEFAULT_LIMITS, ...input };
  for (const [name, value] of Object.entries(merged)) if (!Number.isInteger(value) || value <= 0) throw new Error(`Invalid geometry normalization limit ${name}`);
  return Object.freeze(merged);
};

const spatialReference = (raw: unknown): SpatialReferenceLike | undefined => {
  if (!raw || typeof raw !== 'object') return undefined;
  const candidate = raw as SpatialReferenceLike;
  const canonical = canonicalSpatialReference(candidate);
  return canonical ?? undefined;
};

const normalizeParts = (raw: unknown, limits: GeometryNormalizationLimits, closeRings: boolean): Readonly<{ parts: readonly (readonly Coordinate[])[]; vertices: number; dropped: number; repaired: number }> => {
  if (!Array.isArray(raw)) return Object.freeze({ parts: Object.freeze([]), vertices: 0, dropped: 0, repaired: 0 });
  if (raw.length > limits.maxParts) throw new Error('Geometry part budget exceeded');
  const parts: (readonly Coordinate[])[] = [];
  let vertices = 0;
  let dropped = 0;
  let repaired = 0;
  for (const candidate of raw) {
    if (!Array.isArray(candidate)) { dropped += 1; continue; }
    if (candidate.length > limits.maxVerticesPerPart) throw new Error('Geometry per-part vertex budget exceeded');
    const part: Coordinate[] = [];
    for (const rawCoordinate of candidate) {
      const next = coordinate(rawCoordinate);
      if (!next) continue;
      const previous = part[part.length - 1];
      if (previous && same(previous, next)) continue;
      part.push(next);
      vertices += 1;
      if (vertices > limits.maxVertices) throw new Error('Geometry vertex budget exceeded');
    }
    if (closeRings && part.length >= 3 && !same(part[0], part[part.length - 1])) {
      if (vertices + 1 > limits.maxVertices || part.length + 1 > limits.maxVerticesPerPart) throw new Error('Geometry ring closure exceeds vertex budget');
      part.push(part[0]); vertices += 1; repaired += 1;
    }
    const minimum = closeRings ? 4 : 2;
    if (part.length < minimum) { vertices -= part.length; dropped += 1; continue; }
    parts.push(Object.freeze(part));
  }
  return Object.freeze({ parts: Object.freeze(parts), vertices, dropped, repaired });
};

/**
 * Normalizes ArcGIS JSON geometry without projection guesses or topology invention.
 * Invalid vertices are discarded, consecutive duplicates are collapsed, polygon rings
 * are closed only when enough valid vertices remain, and hard budgets cap CPU/memory.
 */
export const normalizeArcgisGeometry = (raw: unknown, inputLimits?: Partial<GeometryNormalizationLimits>): GeometryNormalizationResult => {
  const limits = validLimits(inputLimits);
  if (!raw || typeof raw !== 'object') return Object.freeze({ geometry: null, vertexCount: 0, droppedParts: 0, repairedRings: 0, reason: 'geometry-not-object' });
  const value = raw as Record<string, unknown>;
  const sr = spatialReference(value.spatialReference);
  if ('x' in value || 'y' in value) {
    if (!finite(value.x) || !finite(value.y)) return Object.freeze({ geometry: null, vertexCount: 0, droppedParts: 0, repairedRings: 0, reason: 'invalid-point' });
    const z = finite(value.z) ? value.z : undefined;
    return Object.freeze({ geometry: Object.freeze({ type: 'point', coordinate: Object.freeze([value.x, value.y]), ...(z === undefined ? {} : { z }), ...(sr ? { spatialReference: sr } : {}) }), vertexCount: 1, droppedParts: 0, repairedRings: 0 });
  }
  if ('points' in value) {
    if (!Array.isArray(value.points)) return Object.freeze({ geometry: null, vertexCount: 0, droppedParts: 0, repairedRings: 0, reason: 'invalid-multipoint' });
    if (value.points.length > limits.maxVertices) throw new Error('Geometry vertex budget exceeded');
    const points: Coordinate[] = [];
    for (const rawPoint of value.points) { const next = coordinate(rawPoint); if (!next) continue; const previous = points[points.length - 1]; if (!previous || !same(previous, next)) points.push(next); }
    if (points.length === 0) return Object.freeze({ geometry: null, vertexCount: 0, droppedParts: 0, repairedRings: 0, reason: 'empty-multipoint' });
    return Object.freeze({ geometry: Object.freeze({ type: 'multipoint', points: Object.freeze(points), ...(sr ? { spatialReference: sr } : {}) }), vertexCount: points.length, droppedParts: 0, repairedRings: 0 });
  }
  if ('paths' in value) {
    const result = normalizeParts(value.paths, limits, false);
    if (result.parts.length === 0) return Object.freeze({ geometry: null, vertexCount: 0, droppedParts: result.dropped, repairedRings: 0, reason: 'empty-polyline' });
    return Object.freeze({ geometry: Object.freeze({ type: 'polyline', paths: result.parts, ...(sr ? { spatialReference: sr } : {}) }), vertexCount: result.vertices, droppedParts: result.dropped, repairedRings: 0 });
  }
  if ('rings' in value) {
    const result = normalizeParts(value.rings, limits, true);
    if (result.parts.length === 0) return Object.freeze({ geometry: null, vertexCount: 0, droppedParts: result.dropped, repairedRings: result.repaired, reason: 'empty-polygon' });
    return Object.freeze({ geometry: Object.freeze({ type: 'polygon', rings: result.parts, ...(sr ? { spatialReference: sr } : {}) }), vertexCount: result.vertices, droppedParts: result.dropped, repairedRings: result.repaired });
  }
  return Object.freeze({ geometry: null, vertexCount: 0, droppedParts: 0, repairedRings: 0, reason: 'unsupported-geometry-shape' });
};

export const geometryVertexCount = (geometry: NormalizedGeometry): number => {
  if (geometry.type === 'point') return 1;
  if (geometry.type === 'multipoint') return geometry.points.length;
  const parts = geometry.type === 'polyline' ? geometry.paths : geometry.rings;
  let count = 0; for (const part of parts) count += part.length; return count;
};
