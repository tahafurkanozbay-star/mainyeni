export type AnalysisPoint = Readonly<{ x: number; y: number; z?: number }>;
export type AnalysisExtent = Readonly<{ xmin: number; ymin: number; xmax: number; ymax: number }>;
export type AnalysisRing = readonly AnalysisPoint[];
export type AnalysisPolyline = readonly AnalysisPoint[];
export type AnalysisPolygon = readonly AnalysisRing[];

export type GeometryAnalysisBudget = Readonly<{
  maxVertices: number;
  maxSegments: number;
  maxRings: number;
}>;

export type GeometryAnalysisDiagnostics = Readonly<{
  verticesVisited: number;
  segmentsVisited: number;
  ringsVisited: number;
  truncated: boolean;
}>;

export type PolylineMeasurement = Readonly<{
  planarLength: number;
  elevationGain: number;
  elevationLoss: number;
  minimumZ?: number;
  maximumZ?: number;
  diagnostics: GeometryAnalysisDiagnostics;
}>;

export type PolygonMeasurement = Readonly<{
  signedArea: number;
  area: number;
  perimeter: number;
  centroid: AnalysisPoint | null;
  diagnostics: GeometryAnalysisDiagnostics;
}>;

export type SegmentProjection = Readonly<{
  point: AnalysisPoint;
  distance: number;
  segmentIndex: number;
  fraction: number;
}>;

export type PointInPolygonResult = Readonly<{
  inside: boolean;
  onBoundary: boolean;
  diagnostics: GeometryAnalysisDiagnostics;
}>;

const finite = (value: number, name: string): number => {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
  return value;
};

const positiveInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
  return value;
};

const abort = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
};

export const normalizeGeometryAnalysisBudget = (budget: GeometryAnalysisBudget): GeometryAnalysisBudget => ({
  maxVertices: positiveInteger(budget.maxVertices, 'maxVertices'),
  maxSegments: positiveInteger(budget.maxSegments, 'maxSegments'),
  maxRings: positiveInteger(budget.maxRings, 'maxRings'),
});

export const validateAnalysisPoint = (point: AnalysisPoint, name = 'point'): AnalysisPoint => {
  const x = finite(point.x, `${name}.x`);
  const y = finite(point.y, `${name}.y`);
  const z = point.z === undefined ? undefined : finite(point.z, `${name}.z`);
  return z === undefined ? { x, y } : { x, y, z };
};

export const normalizeExtent = (extent: AnalysisExtent): AnalysisExtent => {
  const xmin = finite(extent.xmin, 'extent.xmin');
  const ymin = finite(extent.ymin, 'extent.ymin');
  const xmax = finite(extent.xmax, 'extent.xmax');
  const ymax = finite(extent.ymax, 'extent.ymax');
  if (xmin > xmax || ymin > ymax) throw new RangeError('extent bounds are inverted');
  return { xmin, ymin, xmax, ymax };
};

export const extentFromPoints = (
  points: readonly AnalysisPoint[],
  maxVerticesInput: number,
  signal?: AbortSignal,
): AnalysisExtent | null => {
  const maxVertices = positiveInteger(maxVerticesInput, 'maxVertices');
  if (points.length === 0) return null;
  let xmin = Number.POSITIVE_INFINITY;
  let ymin = Number.POSITIVE_INFINITY;
  let xmax = Number.NEGATIVE_INFINITY;
  let ymax = Number.NEGATIVE_INFINITY;
  const count = Math.min(points.length, maxVertices);
  for (let index = 0; index < count; index += 1) {
    abort(signal);
    const point = validateAnalysisPoint(points[index]!, `points[${index}]`);
    xmin = Math.min(xmin, point.x);
    ymin = Math.min(ymin, point.y);
    xmax = Math.max(xmax, point.x);
    ymax = Math.max(ymax, point.y);
  }
  return { xmin, ymin, xmax, ymax };
};

export const extentsIntersect = (leftInput: AnalysisExtent, rightInput: AnalysisExtent): boolean => {
  const left = normalizeExtent(leftInput);
  const right = normalizeExtent(rightInput);
  return left.xmin <= right.xmax && left.xmax >= right.xmin && left.ymin <= right.ymax && left.ymax >= right.ymin;
};

export const intersectionExtent = (leftInput: AnalysisExtent, rightInput: AnalysisExtent): AnalysisExtent | null => {
  const left = normalizeExtent(leftInput);
  const right = normalizeExtent(rightInput);
  if (!extentsIntersect(left, right)) return null;
  return {
    xmin: Math.max(left.xmin, right.xmin),
    ymin: Math.max(left.ymin, right.ymin),
    xmax: Math.min(left.xmax, right.xmax),
    ymax: Math.min(left.ymax, right.ymax),
  };
};

export const expandExtent = (extentInput: AnalysisExtent, distanceInput: number): AnalysisExtent => {
  const extent = normalizeExtent(extentInput);
  const distance = finite(distanceInput, 'distance');
  if (distance < 0) throw new RangeError('distance must be non-negative');
  return {
    xmin: extent.xmin - distance,
    ymin: extent.ymin - distance,
    xmax: extent.xmax + distance,
    ymax: extent.ymax + distance,
  };
};

export const planarDistance = (leftInput: AnalysisPoint, rightInput: AnalysisPoint): number => {
  const left = validateAnalysisPoint(leftInput, 'left');
  const right = validateAnalysisPoint(rightInput, 'right');
  return Math.hypot(right.x - left.x, right.y - left.y);
};

export const distance3d = (leftInput: AnalysisPoint, rightInput: AnalysisPoint): number => {
  const left = validateAnalysisPoint(leftInput, 'left');
  const right = validateAnalysisPoint(rightInput, 'right');
  const dz = (right.z ?? 0) - (left.z ?? 0);
  return Math.hypot(right.x - left.x, right.y - left.y, dz);
};

const emptyDiagnostics = (): { verticesVisited: number; segmentsVisited: number; ringsVisited: number; truncated: boolean } => ({
  verticesVisited: 0,
  segmentsVisited: 0,
  ringsVisited: 0,
  truncated: false,
});

export const measurePolyline = (
  points: AnalysisPolyline,
  budgetInput: GeometryAnalysisBudget,
  signal?: AbortSignal,
): PolylineMeasurement => {
  const budget = normalizeGeometryAnalysisBudget(budgetInput);
  const diagnostics = emptyDiagnostics();
  let planarLength = 0;
  let elevationGain = 0;
  let elevationLoss = 0;
  let minimumZ: number | undefined;
  let maximumZ: number | undefined;
  let previous: AnalysisPoint | undefined;

  for (let index = 0; index < points.length; index += 1) {
    abort(signal);
    if (diagnostics.verticesVisited >= budget.maxVertices) {
      diagnostics.truncated = true;
      break;
    }
    const point = validateAnalysisPoint(points[index]!, `points[${index}]`);
    diagnostics.verticesVisited += 1;
    if (point.z !== undefined) {
      minimumZ = minimumZ === undefined ? point.z : Math.min(minimumZ, point.z);
      maximumZ = maximumZ === undefined ? point.z : Math.max(maximumZ, point.z);
    }
    if (previous) {
      if (diagnostics.segmentsVisited >= budget.maxSegments) {
        diagnostics.truncated = true;
        break;
      }
      planarLength += planarDistance(previous, point);
      if (previous.z !== undefined && point.z !== undefined) {
        const delta = point.z - previous.z;
        if (delta > 0) elevationGain += delta;
        else elevationLoss += -delta;
      }
      diagnostics.segmentsVisited += 1;
    }
    previous = point;
  }

  if (diagnostics.verticesVisited < points.length) diagnostics.truncated = true;
  return {
    planarLength,
    elevationGain,
    elevationLoss,
    ...(minimumZ === undefined ? {} : { minimumZ }),
    ...(maximumZ === undefined ? {} : { maximumZ }),
    diagnostics,
  };
};

const samePoint = (left: AnalysisPoint, right: AnalysisPoint): boolean => left.x === right.x && left.y === right.y;

const ringSegmentCount = (ring: AnalysisRing): number => {
  if (ring.length < 2) return 0;
  return samePoint(ring[0]!, ring[ring.length - 1]!) ? ring.length - 1 : ring.length;
};

const ringVertex = (ring: AnalysisRing, index: number): AnalysisPoint => ring[index % ring.length]!;

export const measurePolygon = (
  polygon: AnalysisPolygon,
  budgetInput: GeometryAnalysisBudget,
  signal?: AbortSignal,
): PolygonMeasurement => {
  const budget = normalizeGeometryAnalysisBudget(budgetInput);
  const diagnostics = emptyDiagnostics();
  let totalSignedArea = 0;
  let perimeter = 0;
  let centroidNumeratorX = 0;
  let centroidNumeratorY = 0;

  for (let ringIndex = 0; ringIndex < polygon.length; ringIndex += 1) {
    abort(signal);
    if (diagnostics.ringsVisited >= budget.maxRings) {
      diagnostics.truncated = true;
      break;
    }
    const ring = polygon[ringIndex]!;
    if (ring.length < 3) continue;
    diagnostics.ringsVisited += 1;
    const segmentCount = ringSegmentCount(ring);
    let ringCrossSum = 0;
    let ringCentroidX = 0;
    let ringCentroidY = 0;

    for (let index = 0; index < segmentCount; index += 1) {
      abort(signal);
      if (diagnostics.segmentsVisited >= budget.maxSegments || diagnostics.verticesVisited >= budget.maxVertices) {
        diagnostics.truncated = true;
        break;
      }
      const current = validateAnalysisPoint(ringVertex(ring, index), `polygon[${ringIndex}][${index}]`);
      const next = validateAnalysisPoint(ringVertex(ring, index + 1), `polygon[${ringIndex}][${index + 1}]`);
      const cross = current.x * next.y - next.x * current.y;
      ringCrossSum += cross;
      ringCentroidX += (current.x + next.x) * cross;
      ringCentroidY += (current.y + next.y) * cross;
      perimeter += planarDistance(current, next);
      diagnostics.verticesVisited += 1;
      diagnostics.segmentsVisited += 1;
    }
    const ringSignedArea = ringCrossSum / 2;
    totalSignedArea += ringSignedArea;
    centroidNumeratorX += ringCentroidX;
    centroidNumeratorY += ringCentroidY;
    if (diagnostics.truncated) break;
  }

  if (diagnostics.ringsVisited < polygon.filter((ring) => ring.length >= 3).length) diagnostics.truncated = true;
  const centroid = totalSignedArea === 0 || diagnostics.truncated
    ? null
    : { x: centroidNumeratorX / (6 * totalSignedArea), y: centroidNumeratorY / (6 * totalSignedArea) };
  return { signedArea: totalSignedArea, area: Math.abs(totalSignedArea), perimeter, centroid, diagnostics };
};

const pointOnSegment = (point: AnalysisPoint, start: AnalysisPoint, end: AnalysisPoint, epsilon: number): boolean => {
  const cross = (point.y - start.y) * (end.x - start.x) - (point.x - start.x) * (end.y - start.y);
  if (Math.abs(cross) > epsilon) return false;
  const dot = (point.x - start.x) * (end.x - start.x) + (point.y - start.y) * (end.y - start.y);
  if (dot < -epsilon) return false;
  const squaredLength = (end.x - start.x) ** 2 + (end.y - start.y) ** 2;
  return dot <= squaredLength + epsilon;
};

export const pointInPolygon = (
  pointInput: AnalysisPoint,
  polygon: AnalysisPolygon,
  budgetInput: GeometryAnalysisBudget,
  signal?: AbortSignal,
  epsilonInput = 1e-9,
): PointInPolygonResult => {
  const point = validateAnalysisPoint(pointInput);
  const budget = normalizeGeometryAnalysisBudget(budgetInput);
  const epsilon = finite(epsilonInput, 'epsilon');
  if (epsilon < 0) throw new RangeError('epsilon must be non-negative');
  const diagnostics = emptyDiagnostics();
  let inside = false;

  for (let ringIndex = 0; ringIndex < polygon.length; ringIndex += 1) {
    abort(signal);
    if (diagnostics.ringsVisited >= budget.maxRings) {
      diagnostics.truncated = true;
      break;
    }
    const ring = polygon[ringIndex]!;
    if (ring.length < 3) continue;
    diagnostics.ringsVisited += 1;
    let ringInside = false;
    const segmentCount = ringSegmentCount(ring);
    for (let index = 0; index < segmentCount; index += 1) {
      abort(signal);
      if (diagnostics.segmentsVisited >= budget.maxSegments || diagnostics.verticesVisited >= budget.maxVertices) {
        diagnostics.truncated = true;
        break;
      }
      const start = validateAnalysisPoint(ringVertex(ring, index));
      const end = validateAnalysisPoint(ringVertex(ring, index + 1));
      diagnostics.verticesVisited += 1;
      diagnostics.segmentsVisited += 1;
      if (pointOnSegment(point, start, end, epsilon)) return { inside: true, onBoundary: true, diagnostics };
      const intersects = (start.y > point.y) !== (end.y > point.y)
        && point.x < ((end.x - start.x) * (point.y - start.y)) / (end.y - start.y) + start.x;
      if (intersects) ringInside = !ringInside;
    }
    if (diagnostics.truncated) break;
    if (ringInside) inside = !inside;
  }
  return { inside: diagnostics.truncated ? false : inside, onBoundary: false, diagnostics };
};

export const projectPointToSegment = (
  pointInput: AnalysisPoint,
  startInput: AnalysisPoint,
  endInput: AnalysisPoint,
): Readonly<{ point: AnalysisPoint; distance: number; fraction: number }> => {
  const point = validateAnalysisPoint(pointInput, 'point');
  const start = validateAnalysisPoint(startInput, 'start');
  const end = validateAnalysisPoint(endInput, 'end');
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const denominator = dx * dx + dy * dy;
  const fraction = denominator === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / denominator));
  const projected: AnalysisPoint = { x: start.x + dx * fraction, y: start.y + dy * fraction };
  return { point: projected, distance: planarDistance(point, projected), fraction };
};

export const nearestPointOnPolyline = (
  point: AnalysisPoint,
  polyline: AnalysisPolyline,
  maxSegmentsInput: number,
  signal?: AbortSignal,
): SegmentProjection | null => {
  const maxSegments = positiveInteger(maxSegmentsInput, 'maxSegments');
  if (polyline.length < 2) return null;
  let best: SegmentProjection | null = null;
  const segmentCount = Math.min(polyline.length - 1, maxSegments);
  for (let index = 0; index < segmentCount; index += 1) {
    abort(signal);
    const projection = projectPointToSegment(point, polyline[index]!, polyline[index + 1]!);
    if (!best || projection.distance < best.distance) best = { ...projection, segmentIndex: index };
  }
  return best;
};

export const simplifyPolyline = (
  points: AnalysisPolyline,
  toleranceInput: number,
  maxVerticesInput: number,
  signal?: AbortSignal,
): AnalysisPolyline => {
  const tolerance = finite(toleranceInput, 'tolerance');
  if (tolerance < 0) throw new RangeError('tolerance must be non-negative');
  const maxVertices = positiveInteger(maxVerticesInput, 'maxVertices');
  if (points.length <= 2) return points.map((point, index) => validateAnalysisPoint(point, `points[${index}]`));
  const limit = Math.min(points.length, maxVertices);
  const retained: AnalysisPoint[] = [validateAnalysisPoint(points[0]!, 'points[0]')];
  let anchor = retained[0]!;
  for (let index = 1; index < limit - 1; index += 1) {
    abort(signal);
    const current = validateAnalysisPoint(points[index]!, `points[${index}]`);
    if (planarDistance(anchor, current) >= tolerance) {
      retained.push(current);
      anchor = current;
    }
  }
  const last = validateAnalysisPoint(points[limit - 1]!, `points[${limit - 1}]`);
  if (!samePoint(retained[retained.length - 1]!, last)) retained.push(last);
  return retained;
};

export const clipPointToExtent = (pointInput: AnalysisPoint, extentInput: AnalysisExtent): AnalysisPoint => {
  const point = validateAnalysisPoint(pointInput);
  const extent = normalizeExtent(extentInput);
  return {
    x: Math.max(extent.xmin, Math.min(extent.xmax, point.x)),
    y: Math.max(extent.ymin, Math.min(extent.ymax, point.y)),
    ...(point.z === undefined ? {} : { z: point.z }),
  };
};
