/**
 * Geometry integrity boundary for JSON-shaped ArcGIS geometries.
 *
 * The guard never reprojects and never guesses a spatial reference. It validates
 * numeric integrity, applies explicit complexity budgets and can produce bounded
 * display geometry using deterministic simplification. Authoritative source
 * geometry remains untouched.
 */

export type Coordinate = readonly [number, number] | readonly [number, number, number];
export type GeometryKind = 'point' | 'multipoint' | 'polyline' | 'polygon' | 'extent' | 'unknown';

export interface SpatialReferenceJson {
  readonly wkid?: number;
  readonly latestWkid?: number;
  readonly wkt?: string;
}

export interface PointGeometryJson {
  readonly x: number;
  readonly y: number;
  readonly z?: number;
  readonly spatialReference?: SpatialReferenceJson;
}

export interface MultiPointGeometryJson {
  readonly points: readonly (readonly number[])[];
  readonly spatialReference?: SpatialReferenceJson;
}

export interface PolylineGeometryJson {
  readonly paths: readonly (readonly (readonly number[])[])[];
  readonly spatialReference?: SpatialReferenceJson;
}

export interface PolygonGeometryJson {
  readonly rings: readonly (readonly (readonly number[])[])[];
  readonly spatialReference?: SpatialReferenceJson;
}

export interface ExtentGeometryJson {
  readonly xmin: number;
  readonly ymin: number;
  readonly xmax: number;
  readonly ymax: number;
  readonly zmin?: number;
  readonly zmax?: number;
  readonly spatialReference?: SpatialReferenceJson;
}

export type SupportedGeometryJson =
  | PointGeometryJson
  | MultiPointGeometryJson
  | PolylineGeometryJson
  | PolygonGeometryJson
  | ExtentGeometryJson;

export interface GeometryBudget {
  readonly maxVertices?: number;
  readonly maxParts?: number;
  readonly maxRings?: number;
  readonly maxCoordinatesPerPart?: number;
  readonly maxAbsoluteCoordinate?: number;
  readonly requireSpatialReference?: boolean;
  readonly allowedWkids?: readonly number[];
  readonly allowZ?: boolean;
}

export interface NormalizedGeometryBudget {
  readonly maxVertices: number;
  readonly maxParts: number;
  readonly maxRings: number;
  readonly maxCoordinatesPerPart: number;
  readonly maxAbsoluteCoordinate: number;
  readonly requireSpatialReference: boolean;
  readonly allowedWkids: ReadonlySet<number> | null;
  readonly allowZ: boolean;
}

export type GeometryIssueCode =
  | 'not-object'
  | 'unknown-geometry'
  | 'non-finite-coordinate'
  | 'coordinate-out-of-range'
  | 'invalid-coordinate'
  | 'invalid-extent'
  | 'invalid-spatial-reference'
  | 'missing-spatial-reference'
  | 'disallowed-spatial-reference'
  | 'vertex-budget-exceeded'
  | 'part-budget-exceeded'
  | 'ring-budget-exceeded'
  | 'part-size-exceeded'
  | 'ring-not-closed'
  | 'ring-too-small'
  | 'z-not-allowed';

export interface GeometryIssue {
  readonly code: GeometryIssueCode;
  readonly severity: 'warning' | 'error';
  readonly message: string;
  readonly path: string;
}

export interface GeometryExtent {
  readonly xmin: number;
  readonly ymin: number;
  readonly xmax: number;
  readonly ymax: number;
}

export interface GeometryInspection {
  readonly kind: GeometryKind;
  readonly valid: boolean;
  readonly vertexCount: number;
  readonly partCount: number;
  readonly ringCount: number;
  readonly hasZ: boolean;
  readonly wkid: number | null;
  readonly extent: GeometryExtent | null;
  readonly issues: readonly GeometryIssue[];
}

export interface SimplifyGeometryOptions {
  readonly tolerance: number;
  readonly maxVertices?: number;
  readonly preserveClosedRings?: boolean;
}

export class GeometryGuardError extends Error {
  readonly code: GeometryIssueCode | 'INVALID_SIMPLIFICATION';
  readonly inspection?: GeometryInspection;

  constructor(
    message: string,
    code: GeometryIssueCode | 'INVALID_SIMPLIFICATION',
    inspection?: GeometryInspection,
  ) {
    super(message);
    this.name = 'GeometryGuardError';
    this.code = code;
    if (inspection) this.inspection = inspection;
  }
}

type UnknownRecord = Record<string, unknown>;

const DEFAULT_BUDGET: NormalizedGeometryBudget = Object.freeze({
  maxVertices: 100_000,
  maxParts: 2_048,
  maxRings: 2_048,
  maxCoordinatesPerPart: 50_000,
  maxAbsoluteCoordinate: 1_000_000_000,
  requireSpatialReference: false,
  allowedWkids: null,
  allowZ: true,
});

const integerBound = (value: unknown, fallback: number, minimum: number, maximum: number): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(numeric)));
};

const finiteBound = (value: unknown, fallback: number, minimum: number, maximum: number): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(maximum, Math.max(minimum, numeric));
};

export const normalizeGeometryBudget = (budget: GeometryBudget = {}): NormalizedGeometryBudget => {
  const allowed = budget.allowedWkids
    ? new Set(
        budget.allowedWkids
          .map(Number)
          .filter((value) => Number.isInteger(value) && value > 0),
      )
    : null;
  return Object.freeze({
    maxVertices: integerBound(budget.maxVertices, DEFAULT_BUDGET.maxVertices, 1, 5_000_000),
    maxParts: integerBound(budget.maxParts, DEFAULT_BUDGET.maxParts, 1, 100_000),
    maxRings: integerBound(budget.maxRings, DEFAULT_BUDGET.maxRings, 1, 100_000),
    maxCoordinatesPerPart: integerBound(
      budget.maxCoordinatesPerPart,
      DEFAULT_BUDGET.maxCoordinatesPerPart,
      2,
      5_000_000,
    ),
    maxAbsoluteCoordinate: finiteBound(
      budget.maxAbsoluteCoordinate,
      DEFAULT_BUDGET.maxAbsoluteCoordinate,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    requireSpatialReference: budget.requireSpatialReference === true,
    allowedWkids: allowed && allowed.size > 0 ? allowed : null,
    allowZ: budget.allowZ !== false,
  });
};

const isRecord = (value: unknown): value is UnknownRecord => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const issue = (
  code: GeometryIssueCode,
  severity: GeometryIssue['severity'],
  message: string,
  path: string,
): GeometryIssue => Object.freeze({ code, severity, message, path });

const geometryKind = (geometry: UnknownRecord): GeometryKind => {
  if ('x' in geometry && 'y' in geometry) return 'point';
  if (Array.isArray(geometry.points)) return 'multipoint';
  if (Array.isArray(geometry.paths)) return 'polyline';
  if (Array.isArray(geometry.rings)) return 'polygon';
  if ('xmin' in geometry && 'ymin' in geometry && 'xmax' in geometry && 'ymax' in geometry) return 'extent';
  return 'unknown';
};

const getWkid = (geometry: UnknownRecord): number | null => {
  const sr = isRecord(geometry.spatialReference) ? geometry.spatialReference : null;
  if (!sr) return null;
  const candidate = Number(sr.latestWkid ?? sr.wkid);
  return Number.isInteger(candidate) && candidate > 0 ? candidate : null;
};

const inspectSpatialReference = (
  geometry: UnknownRecord,
  budget: NormalizedGeometryBudget,
  issues: GeometryIssue[],
): number | null => {
  const raw = geometry.spatialReference;
  if (raw === undefined || raw === null) {
    if (budget.requireSpatialReference) {
      issues.push(issue(
        'missing-spatial-reference',
        'error',
        'Geometry must declare a spatial reference at this boundary.',
        'spatialReference',
      ));
    }
    return null;
  }
  if (!isRecord(raw)) {
    issues.push(issue(
      'invalid-spatial-reference',
      'error',
      'Geometry spatialReference must be an object.',
      'spatialReference',
    ));
    return null;
  }
  const wkid = getWkid(geometry);
  const wkt = typeof raw.wkt === 'string' && raw.wkt.trim().length > 0 ? raw.wkt.trim() : null;
  if (wkid === null && wkt === null) {
    issues.push(issue(
      'invalid-spatial-reference',
      'error',
      'Geometry spatialReference must include a positive WKID/latestWKID or WKT.',
      'spatialReference',
    ));
    return null;
  }
  if (wkid !== null && budget.allowedWkids && !budget.allowedWkids.has(wkid)) {
    issues.push(issue(
      'disallowed-spatial-reference',
      'error',
      `Spatial reference WKID ${wkid} is not allowed by the active geometry policy.`,
      'spatialReference.wkid',
    ));
  }
  return wkid;
};

interface MutableInspection {
  vertexCount: number;
  partCount: number;
  ringCount: number;
  hasZ: boolean;
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
  hasExtent: boolean;
}

const initialInspection = (): MutableInspection => ({
  vertexCount: 0,
  partCount: 0,
  ringCount: 0,
  hasZ: false,
  xmin: Number.POSITIVE_INFINITY,
  ymin: Number.POSITIVE_INFINITY,
  xmax: Number.NEGATIVE_INFINITY,
  ymax: Number.NEGATIVE_INFINITY,
  hasExtent: false,
});

const includeCoordinate = (state: MutableInspection, x: number, y: number): void => {
  state.xmin = Math.min(state.xmin, x);
  state.ymin = Math.min(state.ymin, y);
  state.xmax = Math.max(state.xmax, x);
  state.ymax = Math.max(state.ymax, y);
  state.hasExtent = true;
};

const inspectCoordinate = (
  raw: unknown,
  path: string,
  budget: NormalizedGeometryBudget,
  state: MutableInspection,
  issues: GeometryIssue[],
): Coordinate | null => {
  if (!Array.isArray(raw) || raw.length < 2) {
    issues.push(issue('invalid-coordinate', 'error', 'Coordinate must contain at least x and y.', path));
    return null;
  }
  const x = Number(raw[0]);
  const y = Number(raw[1]);
  const z = raw.length > 2 && raw[2] !== null && raw[2] !== undefined ? Number(raw[2]) : null;
  if (!Number.isFinite(x) || !Number.isFinite(y) || (z !== null && !Number.isFinite(z))) {
    issues.push(issue('non-finite-coordinate', 'error', 'Coordinate values must be finite numbers.', path));
    return null;
  }
  if (Math.abs(x) > budget.maxAbsoluteCoordinate || Math.abs(y) > budget.maxAbsoluteCoordinate) {
    issues.push(issue(
      'coordinate-out-of-range',
      'error',
      'Coordinate exceeds the configured absolute numeric bound.',
      path,
    ));
  }
  if (z !== null) {
    state.hasZ = true;
    if (!budget.allowZ) issues.push(issue('z-not-allowed', 'error', 'Z coordinates are disabled by policy.', path));
  }
  state.vertexCount += 1;
  includeCoordinate(state, x, y);
  return z === null ? [x, y] : [x, y, z];
};

const coordinatesEqual2d = (left: readonly number[], right: readonly number[]): boolean => (
  Number(left[0]) === Number(right[0]) && Number(left[1]) === Number(right[1])
);

const inspectPoint = (
  geometry: UnknownRecord,
  budget: NormalizedGeometryBudget,
  state: MutableInspection,
  issues: GeometryIssue[],
): void => {
  inspectCoordinate([geometry.x, geometry.y, geometry.z], 'point', budget, state, issues);
};

const inspectMultiPoint = (
  geometry: UnknownRecord,
  budget: NormalizedGeometryBudget,
  state: MutableInspection,
  issues: GeometryIssue[],
): void => {
  const points = Array.isArray(geometry.points) ? geometry.points : [];
  state.partCount = points.length > 0 ? 1 : 0;
  if (points.length > budget.maxCoordinatesPerPart) {
    issues.push(issue(
      'part-size-exceeded',
      'error',
      `Multipoint contains ${points.length} coordinates; policy allows ${budget.maxCoordinatesPerPart}.`,
      'points',
    ));
  }
  points.forEach((point, index) => inspectCoordinate(point, `points[${index}]`, budget, state, issues));
};

const inspectLineParts = (
  parts: readonly unknown[],
  property: 'paths' | 'rings',
  polygon: boolean,
  budget: NormalizedGeometryBudget,
  state: MutableInspection,
  issues: GeometryIssue[],
): void => {
  state.partCount = parts.length;
  if (parts.length > budget.maxParts) {
    issues.push(issue(
      'part-budget-exceeded',
      'error',
      `Geometry contains ${parts.length} parts; policy allows ${budget.maxParts}.`,
      property,
    ));
  }
  if (polygon) {
    state.ringCount = parts.length;
    if (parts.length > budget.maxRings) {
      issues.push(issue(
        'ring-budget-exceeded',
        'error',
        `Polygon contains ${parts.length} rings; policy allows ${budget.maxRings}.`,
        property,
      ));
    }
  }

  parts.forEach((rawPart, partIndex) => {
    if (!Array.isArray(rawPart)) {
      issues.push(issue('invalid-coordinate', 'error', 'Geometry part must be an array.', `${property}[${partIndex}]`));
      return;
    }
    if (rawPart.length > budget.maxCoordinatesPerPart) {
      issues.push(issue(
        'part-size-exceeded',
        'error',
        `Part contains ${rawPart.length} coordinates; policy allows ${budget.maxCoordinatesPerPart}.`,
        `${property}[${partIndex}]`,
      ));
    }
    if (polygon && rawPart.length < 4) {
      issues.push(issue(
        'ring-too-small',
        'error',
        'Polygon ring must contain at least four coordinates including closure.',
        `${property}[${partIndex}]`,
      ));
    }
    rawPart.forEach((coordinate, coordinateIndex) => {
      inspectCoordinate(
        coordinate,
        `${property}[${partIndex}][${coordinateIndex}]`,
        budget,
        state,
        issues,
      );
    });
    if (polygon && rawPart.length > 0) {
      const first = rawPart[0];
      const last = rawPart[rawPart.length - 1];
      if (Array.isArray(first) && Array.isArray(last) && !coordinatesEqual2d(first, last)) {
        issues.push(issue(
          'ring-not-closed',
          'error',
          'Polygon ring must be explicitly closed.',
          `${property}[${partIndex}]`,
        ));
      }
    }
  });
};

const inspectExtent = (
  geometry: UnknownRecord,
  budget: NormalizedGeometryBudget,
  state: MutableInspection,
  issues: GeometryIssue[],
): void => {
  const xmin = Number(geometry.xmin);
  const ymin = Number(geometry.ymin);
  const xmax = Number(geometry.xmax);
  const ymax = Number(geometry.ymax);
  if (![xmin, ymin, xmax, ymax].every(Number.isFinite) || xmin > xmax || ymin > ymax) {
    issues.push(issue('invalid-extent', 'error', 'Extent bounds are not finite or are inverted.', 'extent'));
    return;
  }
  if ([xmin, ymin, xmax, ymax].some((value) => Math.abs(value) > budget.maxAbsoluteCoordinate)) {
    issues.push(issue(
      'coordinate-out-of-range',
      'error',
      'Extent exceeds the configured absolute numeric bound.',
      'extent',
    ));
  }
  includeCoordinate(state, xmin, ymin);
  includeCoordinate(state, xmax, ymax);
  state.vertexCount = 2;
  const hasZ = geometry.zmin !== undefined || geometry.zmax !== undefined;
  if (hasZ) {
    state.hasZ = true;
    const zmin = geometry.zmin === undefined ? null : Number(geometry.zmin);
    const zmax = geometry.zmax === undefined ? null : Number(geometry.zmax);
    if ((zmin !== null && !Number.isFinite(zmin)) || (zmax !== null && !Number.isFinite(zmax))) {
      issues.push(issue('non-finite-coordinate', 'error', 'Extent z bounds must be finite.', 'extent.z'));
    }
    if (!budget.allowZ) issues.push(issue('z-not-allowed', 'error', 'Z coordinates are disabled by policy.', 'extent.z'));
  }
};

export const inspectGeometry = (geometry: unknown, rawBudget: GeometryBudget = {}): GeometryInspection => {
  const budget = normalizeGeometryBudget(rawBudget);
  const issues: GeometryIssue[] = [];
  if (!isRecord(geometry)) {
    return Object.freeze({
      kind: 'unknown' as const,
      valid: false,
      vertexCount: 0,
      partCount: 0,
      ringCount: 0,
      hasZ: false,
      wkid: null,
      extent: null,
      issues: Object.freeze([
        issue('not-object', 'error', 'Geometry must be a JSON object.', '$'),
      ]),
    });
  }

  const kind = geometryKind(geometry);
  const state = initialInspection();
  const wkid = inspectSpatialReference(geometry, budget, issues);
  if (kind === 'unknown') {
    issues.push(issue('unknown-geometry', 'error', 'Unsupported or unrecognised geometry shape.', '$'));
  } else if (kind === 'point') {
    inspectPoint(geometry, budget, state, issues);
  } else if (kind === 'multipoint') {
    inspectMultiPoint(geometry, budget, state, issues);
  } else if (kind === 'polyline') {
    inspectLineParts(Array.isArray(geometry.paths) ? geometry.paths : [], 'paths', false, budget, state, issues);
  } else if (kind === 'polygon') {
    inspectLineParts(Array.isArray(geometry.rings) ? geometry.rings : [], 'rings', true, budget, state, issues);
  } else {
    inspectExtent(geometry, budget, state, issues);
  }

  if (state.vertexCount > budget.maxVertices) {
    issues.push(issue(
      'vertex-budget-exceeded',
      'error',
      `Geometry contains ${state.vertexCount} vertices; policy allows ${budget.maxVertices}.`,
      '$',
    ));
  }

  const extent: GeometryExtent | null = state.hasExtent
    ? Object.freeze({ xmin: state.xmin, ymin: state.ymin, xmax: state.xmax, ymax: state.ymax })
    : null;
  return Object.freeze({
    kind,
    valid: !issues.some((entry) => entry.severity === 'error'),
    vertexCount: state.vertexCount,
    partCount: state.partCount,
    ringCount: state.ringCount,
    hasZ: state.hasZ,
    wkid,
    extent,
    issues: Object.freeze(issues.slice()),
  });
};

export const assertGeometryIntegrity = <T>(geometry: T, budget: GeometryBudget = {}): T => {
  const inspection = inspectGeometry(geometry, budget);
  if (!inspection.valid) {
    const first = inspection.issues.find((entry) => entry.severity === 'error');
    throw new GeometryGuardError(
      first?.message ?? 'Geometry failed integrity validation.',
      first?.code ?? 'unknown-geometry',
      inspection,
    );
  }
  return geometry;
};

const squaredDistanceToSegment = (
  point: readonly number[],
  start: readonly number[],
  end: readonly number[],
): number => {
  const px = Number(point[0]);
  const py = Number(point[1]);
  let x = Number(start[0]);
  let y = Number(start[1]);
  let dx = Number(end[0]) - x;
  let dy = Number(end[1]) - y;
  if (dx !== 0 || dy !== 0) {
    const t = ((px - x) * dx + (py - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) {
      x = Number(end[0]);
      y = Number(end[1]);
    } else if (t > 0) {
      x += dx * t;
      y += dy * t;
    }
  }
  dx = px - x;
  dy = py - y;
  return dx * dx + dy * dy;
};

const simplifyPart = (
  coordinates: readonly (readonly number[])[],
  tolerance: number,
  closed: boolean,
): readonly (readonly number[])[] => {
  if (coordinates.length <= (closed ? 4 : 2) || tolerance <= 0) return coordinates.map((entry) => entry.slice());
  const source = closed && coordinatesEqual2d(coordinates[0] ?? [], coordinates[coordinates.length - 1] ?? [])
    ? coordinates.slice(0, -1)
    : coordinates.slice();
  if (source.length <= 2) {
    const output = source.map((entry) => entry.slice());
    if (closed && output.length) output.push(output[0]!.slice());
    return output;
  }

  const squaredTolerance = tolerance * tolerance;
  const keep = new Uint8Array(source.length);
  keep[0] = 1;
  keep[source.length - 1] = 1;
  const stack: Array<readonly [number, number]> = [[0, source.length - 1]];
  while (stack.length) {
    const segment = stack.pop();
    if (!segment) continue;
    const [first, last] = segment;
    let maxDistance = squaredTolerance;
    let index = -1;
    const start = source[first];
    const end = source[last];
    if (!start || !end) continue;
    for (let current = first + 1; current < last; current += 1) {
      const point = source[current];
      if (!point) continue;
      const distance = squaredDistanceToSegment(point, start, end);
      if (distance > maxDistance) {
        maxDistance = distance;
        index = current;
      }
    }
    if (index > first && index < last) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  const output: number[][] = [];
  source.forEach((coordinate, index) => {
    if (keep[index] === 1) output.push(coordinate.slice());
  });
  if (closed) {
    while (output.length < 3 && source.length > output.length) {
      const candidate = source[Math.floor((source.length - 1) * (output.length / 3))];
      if (candidate && !output.some((item) => coordinatesEqual2d(item, candidate))) output.splice(-1, 0, candidate.slice());
      else break;
    }
    if (output.length) output.push(output[0]!.slice());
  }
  return output;
};

const geometryVertexCount = (geometry: unknown): number => inspectGeometry(geometry, {
  maxVertices: 5_000_000,
  maxParts: 100_000,
  maxRings: 100_000,
  maxCoordinatesPerPart: 5_000_000,
}).vertexCount;

const cloneSpatialReference = (value: unknown): SpatialReferenceJson | undefined => {
  if (!isRecord(value)) return undefined;
  const result: { wkid?: number; latestWkid?: number; wkt?: string } = {};
  const wkid = Number(value.wkid);
  const latestWkid = Number(value.latestWkid);
  if (Number.isInteger(wkid) && wkid > 0) result.wkid = wkid;
  if (Number.isInteger(latestWkid) && latestWkid > 0) result.latestWkid = latestWkid;
  if (typeof value.wkt === 'string' && value.wkt.trim()) result.wkt = value.wkt.trim();
  return Object.keys(result).length ? result : undefined;
};

export const simplifyGeometryForDisplay = (
  geometry: unknown,
  options: SimplifyGeometryOptions,
): unknown => {
  const tolerance = Number(options.tolerance);
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new GeometryGuardError('Simplification tolerance must be a finite non-negative number.', 'INVALID_SIMPLIFICATION');
  }
  const inputInspection = inspectGeometry(geometry, {
    maxVertices: 5_000_000,
    maxParts: 100_000,
    maxRings: 100_000,
    maxCoordinatesPerPart: 5_000_000,
  });
  if (!inputInspection.valid || !isRecord(geometry)) {
    throw new GeometryGuardError('Invalid geometry cannot be simplified.', 'INVALID_SIMPLIFICATION', inputInspection);
  }
  const sr = cloneSpatialReference(geometry.spatialReference);
  let simplified: unknown = geometry;
  if (inputInspection.kind === 'polyline') {
    const paths = (geometry.paths as readonly unknown[]).map((raw) => (
      Array.isArray(raw) ? simplifyPart(raw as readonly (readonly number[])[], tolerance, false) : []
    ));
    simplified = { paths, ...(sr ? { spatialReference: sr } : {}) };
  } else if (inputInspection.kind === 'polygon') {
    const preserve = options.preserveClosedRings !== false;
    const rings = (geometry.rings as readonly unknown[]).map((raw) => (
      Array.isArray(raw)
        ? simplifyPart(raw as readonly (readonly number[])[], tolerance, preserve)
        : []
    ));
    simplified = { rings, ...(sr ? { spatialReference: sr } : {}) };
  } else if (inputInspection.kind === 'multipoint') {
    const points = (geometry.points as readonly unknown[]).map((point) => (
      Array.isArray(point) ? point.slice() : point
    ));
    simplified = { points, ...(sr ? { spatialReference: sr } : {}) };
  } else {
    simplified = { ...geometry };
  }

  const maxVertices = integerBound(options.maxVertices, Number.MAX_SAFE_INTEGER, 1, 5_000_000);
  if (geometryVertexCount(simplified) > maxVertices) {
    throw new GeometryGuardError(
      `Simplified geometry still exceeds display vertex budget ${maxVertices}.`,
      'INVALID_SIMPLIFICATION',
    );
  }
  return simplified;
};

export const geometryExtent = (geometry: unknown, budget: GeometryBudget = {}): GeometryExtent | null => (
  inspectGeometry(geometry, budget).extent
);

export const extentIntersects = (left: GeometryExtent, right: GeometryExtent): boolean => !(
  left.xmax < right.xmin ||
  left.xmin > right.xmax ||
  left.ymax < right.ymin ||
  left.ymin > right.ymax
);

export const extentContains = (container: GeometryExtent, candidate: GeometryExtent): boolean => (
  container.xmin <= candidate.xmin &&
  container.ymin <= candidate.ymin &&
  container.xmax >= candidate.xmax &&
  container.ymax >= candidate.ymax
);

export const extentUnion = (extents: readonly GeometryExtent[]): GeometryExtent | null => {
  if (!extents.length) return null;
  let xmin = Number.POSITIVE_INFINITY;
  let ymin = Number.POSITIVE_INFINITY;
  let xmax = Number.NEGATIVE_INFINITY;
  let ymax = Number.NEGATIVE_INFINITY;
  for (const extent of extents) {
    const values = [extent.xmin, extent.ymin, extent.xmax, extent.ymax];
    if (!values.every(Number.isFinite) || extent.xmin > extent.xmax || extent.ymin > extent.ymax) continue;
    xmin = Math.min(xmin, extent.xmin);
    ymin = Math.min(ymin, extent.ymin);
    xmax = Math.max(xmax, extent.xmax);
    ymax = Math.max(ymax, extent.ymax);
  }
  return Number.isFinite(xmin) ? Object.freeze({ xmin, ymin, xmax, ymax }) : null;
};
