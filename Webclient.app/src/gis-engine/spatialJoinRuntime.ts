export type SpatialJoinId = string | number;

export interface SpatialJoinPoint {
  readonly x: number;
  readonly y: number;
}

export interface SpatialJoinFeature<TId extends SpatialJoinId = SpatialJoinId> {
  readonly id: TId;
  readonly point: SpatialJoinPoint;
}

export interface SpatialJoinPolygon<TId extends SpatialJoinId = SpatialJoinId> {
  readonly id: TId;
  readonly rings: readonly (readonly SpatialJoinPoint[])[];
}

export interface SpatialJoinBudgets {
  readonly maxFeatures: number;
  readonly maxPolygons: number;
  readonly maxRingVertices: number;
  readonly maxCandidatePairs: number;
  readonly maxMatches: number;
}

export interface SpatialJoinOptions {
  readonly budgets: SpatialJoinBudgets;
  readonly signal?: AbortSignal;
}

export interface SpatialJoinMatch<TFeatureId extends SpatialJoinId = SpatialJoinId, TPolygonId extends SpatialJoinId = SpatialJoinId> {
  readonly featureId: TFeatureId;
  readonly polygonId: TPolygonId;
}

export interface SpatialJoinDiagnostics {
  readonly featuresVisited: number;
  readonly polygonsVisited: number;
  readonly candidatePairsVisited: number;
  readonly matchesProduced: number;
  readonly truncated: boolean;
  readonly reason: 'complete' | 'feature-budget' | 'polygon-budget' | 'vertex-budget' | 'candidate-budget' | 'match-budget';
}

export interface SpatialJoinResult<TFeatureId extends SpatialJoinId = SpatialJoinId, TPolygonId extends SpatialJoinId = SpatialJoinId> {
  readonly matches: readonly SpatialJoinMatch<TFeatureId, TPolygonId>[];
  readonly diagnostics: SpatialJoinDiagnostics;
}

type RingContainment = 'outside' | 'inside' | 'boundary';

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function assertPoint(point: SpatialJoinPoint, name: string): void {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new TypeError(`${name} must contain finite coordinates`);
  }
}

function assertId(id: SpatialJoinId, name: string): void {
  if (typeof id === 'number' && !Number.isFinite(id)) {
    throw new TypeError(`${name} must be a finite number or string`);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('Spatial join aborted', 'AbortError');
  }
}

function pointOnSegment(point: SpatialJoinPoint, a: SpatialJoinPoint, b: SpatialJoinPoint): boolean {
  const cross = (point.y - a.y) * (b.x - a.x) - (point.x - a.x) * (b.y - a.y);
  if (Math.abs(cross) > Number.EPSILON * 32) return false;
  const dot = (point.x - a.x) * (b.x - a.x) + (point.y - a.y) * (b.y - a.y);
  if (dot < 0) return false;
  const lengthSquared = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
  return dot <= lengthSquared;
}

function classifyPointInRing(point: SpatialJoinPoint, ring: readonly SpatialJoinPoint[]): RingContainment {
  if (ring.length === 0) return 'outside';
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j]!;
    const b = ring[i]!;
    if (pointOnSegment(point, a, b)) return 'boundary';
    const intersects = (a.y > point.y) !== (b.y > point.y)
      && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
    if (intersects) inside = !inside;
  }
  return inside ? 'inside' : 'outside';
}

function pointInPolygon(point: SpatialJoinPoint, rings: readonly (readonly SpatialJoinPoint[])[]): boolean {
  let inside = false;
  for (const ring of rings) {
    const containment = classifyPointInRing(point, ring);
    // Polygon boundaries are inclusive. Keep this state distinct from an interior
    // crossing so a closed ring or a hole cannot toggle a boundary point away.
    if (containment === 'boundary') return true;
    if (containment === 'inside') inside = !inside;
  }
  return inside;
}

function validateBudgets(budgets: SpatialJoinBudgets): void {
  assertPositiveInteger(budgets.maxFeatures, 'maxFeatures');
  assertPositiveInteger(budgets.maxPolygons, 'maxPolygons');
  assertPositiveInteger(budgets.maxRingVertices, 'maxRingVertices');
  assertPositiveInteger(budgets.maxCandidatePairs, 'maxCandidatePairs');
  assertPositiveInteger(budgets.maxMatches, 'maxMatches');
}

/**
 * Deterministic, allocation-bounded point-in-polygon join for client-side GIS analysis.
 * Numeric and string identities remain distinct and input order defines stable match order.
 */
export function joinPointsToPolygons<TFeatureId extends SpatialJoinId, TPolygonId extends SpatialJoinId>(
  features: readonly SpatialJoinFeature<TFeatureId>[],
  polygons: readonly SpatialJoinPolygon<TPolygonId>[],
  options: SpatialJoinOptions,
): SpatialJoinResult<TFeatureId, TPolygonId> {
  validateBudgets(options.budgets);
  throwIfAborted(options.signal);

  const { maxFeatures, maxPolygons, maxRingVertices, maxCandidatePairs, maxMatches } = options.budgets;
  const matches: SpatialJoinMatch<TFeatureId, TPolygonId>[] = [];
  let featuresVisited = 0;
  let polygonsVisited = 0;
  let candidatePairsVisited = 0;
  let reason: SpatialJoinDiagnostics['reason'] = 'complete';

  const polygonLimit = Math.min(polygons.length, maxPolygons);
  if (polygons.length > maxPolygons) reason = 'polygon-budget';

  for (let featureIndex = 0; featureIndex < features.length; featureIndex += 1) {
    if (featuresVisited >= maxFeatures) {
      reason = 'feature-budget';
      break;
    }
    throwIfAborted(options.signal);
    const feature = features[featureIndex]!;
    assertId(feature.id, 'feature.id');
    assertPoint(feature.point, 'feature.point');
    featuresVisited += 1;

    for (let polygonIndex = 0; polygonIndex < polygonLimit; polygonIndex += 1) {
      if (candidatePairsVisited >= maxCandidatePairs) {
        reason = 'candidate-budget';
        break;
      }
      throwIfAborted(options.signal);
      const polygon = polygons[polygonIndex]!;
      assertId(polygon.id, 'polygon.id');
      polygonsVisited += 1;
      candidatePairsVisited += 1;

      let vertexCount = 0;
      for (const ring of polygon.rings) {
        vertexCount += ring.length;
        if (vertexCount > maxRingVertices) {
          reason = 'vertex-budget';
          break;
        }
        for (const point of ring) assertPoint(point, 'polygon vertex');
      }
      if (reason === 'vertex-budget') break;

      if (pointInPolygon(feature.point, polygon.rings)) {
        if (matches.length >= maxMatches) {
          reason = 'match-budget';
          break;
        }
        matches.push({ featureId: feature.id, polygonId: polygon.id });
      }
    }
    if (reason === 'candidate-budget' || reason === 'match-budget' || reason === 'vertex-budget') break;
  }

  return {
    matches,
    diagnostics: {
      featuresVisited,
      polygonsVisited,
      candidatePairsVisited,
      matchesProduced: matches.length,
      truncated: reason !== 'complete',
      reason,
    },
  };
}
