export const GEOMETRY_KIND = Object.freeze({
  POINT: 'point',
  MULTIPOINT: 'multipoint',
  POLYLINE: 'polyline',
  POLYGON: 'polygon',
  EXTENT: 'extent',
  UNKNOWN: 'unknown',
} as const);

export type GeometryKind = typeof GEOMETRY_KIND[keyof typeof GEOMETRY_KIND];

export const GEOMETRY_ISSUE = Object.freeze({
  MISSING: 'missing',
  UNKNOWN_TYPE: 'unknown-type',
  INVALID_COORDINATE: 'invalid-coordinate',
  OUT_OF_RANGE: 'out-of-range',
  EMPTY_PART: 'empty-part',
  OPEN_RING: 'open-ring',
  TOO_FEW_VERTICES: 'too-few-vertices',
  INVALID_EXTENT: 'invalid-extent',
  INVALID_SPATIAL_REFERENCE: 'invalid-spatial-reference',
  VERTEX_BUDGET_EXCEEDED: 'vertex-budget-exceeded',
} as const);

export type GeometryIssueCode = typeof GEOMETRY_ISSUE[keyof typeof GEOMETRY_ISSUE];
export type Coordinate = number[];

export interface SpatialReferenceLike {
  wkid?: unknown;
  latestWkid?: unknown;
  wkt?: unknown;
  [key: string]: unknown;
}

export interface NormalizedSpatialReference {
  readonly wkid?: number;
  readonly wkt?: string;
}

export interface GeometryLike extends Record<string, unknown> {
  type?: unknown;
  spatialReference?: SpatialReferenceLike | unknown;
  x?: unknown;
  y?: unknown;
  z?: unknown;
  m?: unknown;
  points?: unknown;
  paths?: unknown;
  rings?: unknown;
  xmin?: unknown;
  ymin?: unknown;
  xmax?: unknown;
  ymax?: unknown;
  zmin?: unknown;
  zmax?: unknown;
}

export interface GeometryNormalizeOptions {
  defaultWkid?: unknown;
  preserveZ?: boolean;
  preserveM?: boolean;
  dropOutOfRange?: boolean;
  repairRings?: boolean;
  dropInvalidParts?: boolean;
  failOnOutOfRange?: boolean;
  requireSpatialReference?: boolean;
  returnInvalidGeometry?: boolean;
  maxVertices?: number;
}

export interface GeometryIssue {
  readonly code: GeometryIssueCode;
  readonly [key: string]: unknown;
}

export interface GeometryDiagnostics {
  kind: GeometryKind;
  spatialReference: Readonly<NormalizedSpatialReference> | null;
  issues: GeometryIssue[];
  droppedVertices: number;
  repairedRings: number;
  vertexCount: number;
  partCount: number;
  hasZ: boolean;
  hasM: boolean;
  budgetExceeded: boolean;
}

export interface GeometryNormalizationDiagnostics extends Omit<GeometryDiagnostics, 'issues'> {
  readonly issues: readonly GeometryIssue[];
  readonly valid: boolean;
  readonly fingerprint?: string;
}

export interface GeometryNormalizationResult {
  readonly geometry: Readonly<Record<string, unknown>> | null;
  readonly diagnostics: Readonly<GeometryNormalizationDiagnostics>;
}

export interface GeometryExtentResult {
  readonly xmin: number;
  readonly ymin: number;
  readonly xmax: number;
  readonly ymax: number;
  readonly spatialReference?: Readonly<NormalizedSpatialReference>;
}

export interface GeometryCollectionAssessment {
  total: number;
  valid: number;
  invalid: number;
  missing: number;
  repaired: number;
  droppedVertices: number;
  vertices: number;
  byKind: Record<string, number>;
  issueCounts: Record<string, number>;
  invalidIndexes: number[];
  validRatio: number;
  invalidRatio: number;
}

const finite = (value: unknown): boolean => Number.isFinite(Number(value));
const number = (value: unknown): number => Number(value);
const isArray = Array.isArray;
const hasOwn = (value: unknown, key: PropertyKey): boolean => (
  Boolean(value) && Object.prototype.hasOwnProperty.call(value, key)
);

const asRecord = (value: unknown): GeometryLike => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as GeometryLike
    : {}
);

const asCoordinateParts = (value: unknown): unknown[][] => (
  Array.isArray(value) ? value.filter(Array.isArray) as unknown[][] : []
);

const normalizeWkid = (spatialReference: unknown): number | null => {
  const record = asRecord(spatialReference);
  const candidate = record.latestWkid ?? record.wkid ?? spatialReference;
  const numeric = Number(candidate);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
};

export const normalizeSpatialReference = (
  spatialReference: unknown,
  fallback: unknown = null,
): Readonly<NormalizedSpatialReference> | null => {
  const wkid = normalizeWkid(spatialReference);
  if (wkid) return Object.freeze({ wkid });
  const record = asRecord(spatialReference);
  const wkt = typeof record.wkt === 'string' ? record.wkt.trim() : '';
  if (wkt) return Object.freeze({ wkt });
  const fallbackWkid = normalizeWkid(fallback);
  return fallbackWkid ? Object.freeze({ wkid: fallbackWkid }) : null;
};

const isGeometryKind = (value: string): value is GeometryKind => (
  Object.values(GEOMETRY_KIND).some((kind) => kind === value)
);

export const detectGeometryKind = (geometryInput: unknown): GeometryKind => {
  if (!geometryInput || typeof geometryInput !== 'object') return GEOMETRY_KIND.UNKNOWN;
  const geometry = asRecord(geometryInput);
  const explicit = String(geometry.type ?? '').toLowerCase();
  if (isGeometryKind(explicit)) return explicit;
  if (hasOwn(geometry, 'x') && hasOwn(geometry, 'y')) return GEOMETRY_KIND.POINT;
  if (isArray(geometry.points)) return GEOMETRY_KIND.MULTIPOINT;
  if (isArray(geometry.paths)) return GEOMETRY_KIND.POLYLINE;
  if (isArray(geometry.rings)) return GEOMETRY_KIND.POLYGON;
  if (['xmin', 'ymin', 'xmax', 'ymax'].every((key) => hasOwn(geometry, key))) return GEOMETRY_KIND.EXTENT;
  return GEOMETRY_KIND.UNKNOWN;
};

const coordinate = (value: unknown, options: GeometryNormalizeOptions = {}): Coordinate | null => {
  if (!isArray(value) || value.length < 2 || !finite(value[0]) || !finite(value[1])) return null;
  const x = number(value[0]);
  const y = number(value[1]);
  const normalized: number[] = [x, y];
  if (options.preserveZ !== false && value.length > 2 && finite(value[2])) normalized.push(number(value[2]));
  if (options.preserveM !== false && value.length > 3 && finite(value[3])) normalized.push(number(value[3]));
  return normalized;
};

const coordinateEquals = (left: unknown, right: unknown): boolean => {
  if (!isArray(left) || !isArray(right) || left.length < 2 || right.length < 2) return false;
  return left[0] === right[0]
    && left[1] === right[1]
    && (left.length < 3 || right.length < 3 || left[2] === right[2]);
};

const geographicRangeIssue = (coord: Coordinate | null, wkid: number | undefined): boolean => {
  if (wkid !== 4326 || !coord) return false;
  const x = coord[0];
  const y = coord[1];
  if (x === undefined || y === undefined) return true;
  return x < -180 || x > 180 || y < -90 || y > 90;
};

const stablePrimitive = (value: unknown): string => {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? String(value) : serialized;
};

const stable = (value: unknown, seen = new WeakSet<object>()): string => {
  if (value === null || typeof value !== 'object') return stablePrimitive(value);
  if (seen.has(value)) return '"[Circular]"';
  seen.add(value);
  const result = isArray(value)
    ? `[${value.map((item) => stable(item, seen)).join(',')}]`
    : `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key], seen)}`
    )).join(',')}}`;
  seen.delete(value);
  return result;
};

const hashString = (value: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

export const geometryFingerprint = (geometry: unknown): string => `geom:${hashString(stable(geometry ?? null))}`;

const createDiagnostics = (
  kind: GeometryKind,
  spatialReference: Readonly<NormalizedSpatialReference> | null,
): GeometryDiagnostics => ({
  kind,
  spatialReference,
  issues: [],
  droppedVertices: 0,
  repairedRings: 0,
  vertexCount: 0,
  partCount: 0,
  hasZ: false,
  hasM: false,
  budgetExceeded: false,
});

const pushIssue = (
  diagnostics: GeometryDiagnostics,
  code: GeometryIssueCode,
  details: Readonly<Record<string, unknown>> = {},
): void => {
  diagnostics.issues.push(Object.freeze({ code, ...details }));
};

const vertexBudget = (options: GeometryNormalizeOptions): number => {
  if (options.maxVertices === undefined) return Number.MAX_SAFE_INTEGER;
  const numeric = Math.floor(Number(options.maxVertices));
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : Number.MAX_SAFE_INTEGER;
};

const consumeCoordinate = (
  raw: unknown,
  diagnostics: GeometryDiagnostics,
  options: GeometryNormalizeOptions,
): Coordinate | null => {
  if (diagnostics.vertexCount >= vertexBudget(options)) {
    if (!diagnostics.budgetExceeded) {
      diagnostics.budgetExceeded = true;
      pushIssue(diagnostics, GEOMETRY_ISSUE.VERTEX_BUDGET_EXCEEDED, {
        maxVertices: vertexBudget(options),
      });
    }
    diagnostics.droppedVertices += 1;
    return null;
  }

  const normalized = coordinate(raw, options);
  if (!normalized) {
    diagnostics.droppedVertices += 1;
    pushIssue(diagnostics, GEOMETRY_ISSUE.INVALID_COORDINATE, { value: raw });
    return null;
  }
  diagnostics.vertexCount += 1;
  diagnostics.hasZ = diagnostics.hasZ || normalized.length >= 3;
  diagnostics.hasM = diagnostics.hasM || normalized.length >= 4;
  if (geographicRangeIssue(normalized, diagnostics.spatialReference?.wkid)) {
    pushIssue(diagnostics, GEOMETRY_ISSUE.OUT_OF_RANGE, { coordinate: normalized.slice(0, 2) });
    if (options.dropOutOfRange === true) {
      diagnostics.droppedVertices += 1;
      return null;
    }
  }
  return normalized;
};

const normalizePoint = (
  geometry: GeometryLike,
  diagnostics: GeometryDiagnostics,
  options: GeometryNormalizeOptions,
): Readonly<Record<string, unknown>> | null => {
  const value = consumeCoordinate([geometry.x, geometry.y], diagnostics, options);
  if (!value) return null;
  const x = value[0];
  const y = value[1];
  if (x === undefined || y === undefined) return null;

  const hasZ = options.preserveZ !== false && finite(geometry.z);
  const hasM = options.preserveM !== false && finite(geometry.m);
  diagnostics.hasZ = diagnostics.hasZ || hasZ;
  diagnostics.hasM = diagnostics.hasM || hasM;

  return Object.freeze({
    type: GEOMETRY_KIND.POINT,
    x,
    y,
    ...(hasZ ? { z: number(geometry.z) } : {}),
    ...(hasM ? { m: number(geometry.m) } : {}),
    ...(diagnostics.spatialReference ? { spatialReference: diagnostics.spatialReference } : {}),
  });
};

const normalizeMultipoint = (
  geometry: GeometryLike,
  diagnostics: GeometryDiagnostics,
  options: GeometryNormalizeOptions,
): Readonly<Record<string, unknown>> => {
  const points: Coordinate[] = [];
  const rawPoints = isArray(geometry.points) ? geometry.points : [];
  for (const raw of rawPoints) {
    const value = consumeCoordinate(raw, diagnostics, options);
    if (value) points.push(value);
  }
  diagnostics.partCount = points.length ? 1 : 0;
  if (!points.length) pushIssue(diagnostics, GEOMETRY_ISSUE.EMPTY_PART, { partIndex: 0 });
  return Object.freeze({
    type: GEOMETRY_KIND.MULTIPOINT,
    points,
    ...(diagnostics.spatialReference ? { spatialReference: diagnostics.spatialReference } : {}),
  });
};

const normalizePathCollection = (
  partsInput: unknown,
  diagnostics: GeometryDiagnostics,
  options: GeometryNormalizeOptions,
  polygon = false,
): Coordinate[][] => {
  const normalizedParts: Coordinate[][] = [];
  const parts = isArray(partsInput) ? partsInput : [];
  parts.forEach((part, partIndex) => {
    if (!isArray(part)) {
      pushIssue(diagnostics, GEOMETRY_ISSUE.EMPTY_PART, { partIndex });
      return;
    }
    const normalized: Coordinate[] = [];
    part.forEach((raw) => {
      const value = consumeCoordinate(raw, diagnostics, options);
      if (value) normalized.push(value);
    });

    if (polygon) {
      const first = normalized[0];
      const last = normalized.at(-1);
      if (first && last && !coordinateEquals(first, last)) {
        pushIssue(diagnostics, GEOMETRY_ISSUE.OPEN_RING, { partIndex });
        if (options.repairRings !== false && diagnostics.vertexCount < vertexBudget(options)) {
          normalized.push([...first]);
          diagnostics.vertexCount += 1;
          diagnostics.repairedRings += 1;
        }
      }
      if (normalized.length > 0 && normalized.length < 4) {
        pushIssue(diagnostics, GEOMETRY_ISSUE.TOO_FEW_VERTICES, { partIndex, vertexCount: normalized.length });
        if (options.dropInvalidParts !== false) return;
      }
    } else if (normalized.length > 0 && normalized.length < 2) {
      pushIssue(diagnostics, GEOMETRY_ISSUE.TOO_FEW_VERTICES, { partIndex, vertexCount: normalized.length });
      if (options.dropInvalidParts !== false) return;
    }

    if (!normalized.length) {
      pushIssue(diagnostics, GEOMETRY_ISSUE.EMPTY_PART, { partIndex });
      return;
    }
    normalizedParts.push(normalized);
  });
  diagnostics.partCount = normalizedParts.length;
  return normalizedParts;
};

const normalizePolyline = (
  geometry: GeometryLike,
  diagnostics: GeometryDiagnostics,
  options: GeometryNormalizeOptions,
): Readonly<Record<string, unknown>> => Object.freeze({
  type: GEOMETRY_KIND.POLYLINE,
  paths: normalizePathCollection(geometry.paths, diagnostics, options, false),
  ...(diagnostics.spatialReference ? { spatialReference: diagnostics.spatialReference } : {}),
});

const normalizePolygon = (
  geometry: GeometryLike,
  diagnostics: GeometryDiagnostics,
  options: GeometryNormalizeOptions,
): Readonly<Record<string, unknown>> => Object.freeze({
  type: GEOMETRY_KIND.POLYGON,
  rings: normalizePathCollection(geometry.rings, diagnostics, options, true),
  ...(diagnostics.spatialReference ? { spatialReference: diagnostics.spatialReference } : {}),
});

const normalizeExtent = (
  geometry: GeometryLike,
  diagnostics: GeometryDiagnostics,
): Readonly<Record<string, unknown>> | null => {
  const values = [geometry.xmin, geometry.ymin, geometry.xmax, geometry.ymax].map(number);
  const [xmin, ymin, xmax, ymax] = values;
  if (
    xmin === undefined || ymin === undefined || xmax === undefined || ymax === undefined
    || !values.every(Number.isFinite)
    || xmin > xmax
    || ymin > ymax
  ) {
    pushIssue(diagnostics, GEOMETRY_ISSUE.INVALID_EXTENT, {
      xmin: geometry.xmin,
      ymin: geometry.ymin,
      xmax: geometry.xmax,
      ymax: geometry.ymax,
    });
    return null;
  }
  diagnostics.vertexCount = 4;
  diagnostics.partCount = 1;
  return Object.freeze({
    type: GEOMETRY_KIND.EXTENT,
    xmin,
    ymin,
    xmax,
    ymax,
    ...(finite(geometry.zmin) ? { zmin: number(geometry.zmin) } : {}),
    ...(finite(geometry.zmax) ? { zmax: number(geometry.zmax) } : {}),
    ...(diagnostics.spatialReference ? { spatialReference: diagnostics.spatialReference } : {}),
  });
};

const finalizeDiagnostics = (
  diagnostics: GeometryDiagnostics,
  valid: boolean,
  fingerprint?: string,
): Readonly<GeometryNormalizationDiagnostics> => Object.freeze({
  ...diagnostics,
  issues: Object.freeze([...diagnostics.issues]),
  valid,
  ...(fingerprint === undefined ? {} : { fingerprint }),
});

export const normalizeGeometry = (
  geometryInput: unknown,
  options: GeometryNormalizeOptions = {},
): GeometryNormalizationResult => {
  const geometry = asRecord(geometryInput);
  const kind = detectGeometryKind(geometryInput);
  const spatialReference = normalizeSpatialReference(geometry.spatialReference, options.defaultWkid);
  const diagnostics = createDiagnostics(kind, spatialReference);

  if (!geometryInput) {
    pushIssue(diagnostics, GEOMETRY_ISSUE.MISSING);
    return { geometry: null, diagnostics: finalizeDiagnostics(diagnostics, false) };
  }
  if (kind === GEOMETRY_KIND.UNKNOWN) {
    pushIssue(diagnostics, GEOMETRY_ISSUE.UNKNOWN_TYPE);
    return { geometry: null, diagnostics: finalizeDiagnostics(diagnostics, false) };
  }
  if (!spatialReference && options.requireSpatialReference === true) {
    pushIssue(diagnostics, GEOMETRY_ISSUE.INVALID_SPATIAL_REFERENCE);
  }

  let normalized: Readonly<Record<string, unknown>> | null = null;
  if (kind === GEOMETRY_KIND.POINT) normalized = normalizePoint(geometry, diagnostics, options);
  if (kind === GEOMETRY_KIND.MULTIPOINT) normalized = normalizeMultipoint(geometry, diagnostics, options);
  if (kind === GEOMETRY_KIND.POLYLINE) normalized = normalizePolyline(geometry, diagnostics, options);
  if (kind === GEOMETRY_KIND.POLYGON) normalized = normalizePolygon(geometry, diagnostics, options);
  if (kind === GEOMETRY_KIND.EXTENT) normalized = normalizeExtent(geometry, diagnostics);

  const fatalCodes = new Set<GeometryIssueCode>([
    GEOMETRY_ISSUE.MISSING,
    GEOMETRY_ISSUE.UNKNOWN_TYPE,
    GEOMETRY_ISSUE.INVALID_EXTENT,
    GEOMETRY_ISSUE.VERTEX_BUDGET_EXCEEDED,
    ...(options.failOnOutOfRange ? [GEOMETRY_ISSUE.OUT_OF_RANGE] : []),
    ...(options.requireSpatialReference ? [GEOMETRY_ISSUE.INVALID_SPATIAL_REFERENCE] : []),
  ]);
  const hasFatal = diagnostics.issues.some((issue) => fatalCodes.has(issue.code));
  const normalizedPoints = normalized?.points;
  const normalizedPaths = normalized?.paths;
  const normalizedRings = normalized?.rings;
  const emptyCollection = Boolean(normalized) && (
    (kind === GEOMETRY_KIND.MULTIPOINT && Array.isArray(normalizedPoints) && normalizedPoints.length === 0)
    || (kind === GEOMETRY_KIND.POLYLINE && Array.isArray(normalizedPaths) && normalizedPaths.length === 0)
    || (kind === GEOMETRY_KIND.POLYGON && Array.isArray(normalizedRings) && normalizedRings.length === 0)
  );
  const valid = Boolean(normalized) && !hasFatal && !emptyCollection;
  const fingerprint = geometryFingerprint(normalized);

  return {
    geometry: valid || options.returnInvalidGeometry === true ? normalized : null,
    diagnostics: finalizeDiagnostics(diagnostics, valid, fingerprint),
  };
};

const visitCoordinates = (
  geometryInput: unknown,
  visitor: (coordinate: unknown) => void,
): void => {
  const geometry = asRecord(geometryInput);
  const kind = detectGeometryKind(geometryInput);
  if (kind === GEOMETRY_KIND.POINT) {
    visitor([geometry.x, geometry.y]);
    return;
  }
  if (kind === GEOMETRY_KIND.MULTIPOINT) {
    (isArray(geometry.points) ? geometry.points : []).forEach(visitor);
    return;
  }
  if (kind === GEOMETRY_KIND.POLYLINE) {
    asCoordinateParts(geometry.paths).forEach((path) => path.forEach(visitor));
    return;
  }
  if (kind === GEOMETRY_KIND.POLYGON) {
    asCoordinateParts(geometry.rings).forEach((ring) => ring.forEach(visitor));
    return;
  }
  if (kind === GEOMETRY_KIND.EXTENT) {
    visitor([geometry.xmin, geometry.ymin]);
    visitor([geometry.xmax, geometry.ymax]);
  }
};

export const geometryExtent = (geometryInput: unknown): GeometryExtentResult | null => {
  const geometry = asRecord(geometryInput);
  const kind = detectGeometryKind(geometryInput);
  if (kind === GEOMETRY_KIND.EXTENT) {
    const normalized = normalizeGeometry(geometryInput, { returnInvalidGeometry: true }).geometry;
    if (!normalized) return null;
    const xmin = Number(normalized.xmin);
    const ymin = Number(normalized.ymin);
    const xmax = Number(normalized.xmax);
    const ymax = Number(normalized.ymax);
    if (![xmin, ymin, xmax, ymax].every(Number.isFinite)) return null;
    const spatialReference = normalizeSpatialReference(normalized.spatialReference);
    return {
      xmin,
      ymin,
      xmax,
      ymax,
      ...(spatialReference ? { spatialReference } : {}),
    };
  }

  let xmin = Infinity;
  let ymin = Infinity;
  let xmax = -Infinity;
  let ymax = -Infinity;
  let count = 0;
  visitCoordinates(geometryInput, (raw) => {
    const value = coordinate(raw);
    const x = value?.[0];
    const y = value?.[1];
    if (x === undefined || y === undefined) return;
    xmin = Math.min(xmin, x);
    ymin = Math.min(ymin, y);
    xmax = Math.max(xmax, x);
    ymax = Math.max(ymax, y);
    count += 1;
  });
  if (!count) return null;
  const spatialReference = normalizeSpatialReference(geometry.spatialReference);
  return {
    xmin,
    ymin,
    xmax,
    ymax,
    ...(spatialReference ? { spatialReference } : {}),
  };
};

export const countGeometryVertices = (geometry: unknown): number => {
  let count = 0;
  visitCoordinates(geometry, (raw) => {
    if (coordinate(raw)) count += 1;
  });
  return count;
};

export const assessGeometryCollection = (
  features: readonly unknown[] = [],
  options: GeometryNormalizeOptions = {},
): GeometryCollectionAssessment => {
  const result: GeometryCollectionAssessment = {
    total: 0,
    valid: 0,
    invalid: 0,
    missing: 0,
    repaired: 0,
    droppedVertices: 0,
    vertices: 0,
    byKind: {},
    issueCounts: {},
    invalidIndexes: [],
    validRatio: 1,
    invalidRatio: 0,
  };

  features.forEach((feature, index) => {
    result.total += 1;
    const featureRecord = asRecord(feature);
    const featureOwnsGeometry = feature !== null && typeof feature === 'object' && hasOwn(feature, 'geometry');
    const source = featureOwnsGeometry ? featureRecord.geometry : feature;
    const normalized = normalizeGeometry(source, options);
    const diagnostics = normalized.diagnostics;
    result.byKind[diagnostics.kind] = (result.byKind[diagnostics.kind] ?? 0) + 1;
    result.vertices += diagnostics.vertexCount;
    result.droppedVertices += diagnostics.droppedVertices;
    if (diagnostics.repairedRings > 0) result.repaired += 1;
    diagnostics.issues.forEach((issue) => {
      result.issueCounts[issue.code] = (result.issueCounts[issue.code] ?? 0) + 1;
    });
    if (diagnostics.valid) {
      result.valid += 1;
    } else {
      result.invalid += 1;
      result.invalidIndexes.push(index);
      if (diagnostics.issues.some((issue) => issue.code === GEOMETRY_ISSUE.MISSING)) result.missing += 1;
    }
  });

  result.validRatio = result.total ? result.valid / result.total : 1;
  result.invalidRatio = result.total ? result.invalid / result.total : 0;
  return result;
};

export const geometryComplexity = (geometry: unknown): number => {
  const kind = detectGeometryKind(geometry);
  const vertices = countGeometryVertices(geometry);
  const kindWeight = kind === GEOMETRY_KIND.POLYGON
    ? 3
    : kind === GEOMETRY_KIND.POLYLINE
      ? 2
      : kind === GEOMETRY_KIND.MULTIPOINT
        ? 1.25
        : 1;
  return Math.round(vertices * kindWeight);
};
