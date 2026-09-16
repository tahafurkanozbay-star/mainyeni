export const GEOMETRY_KIND = Object.freeze({
  POINT: 'point',
  MULTIPOINT: 'multipoint',
  POLYLINE: 'polyline',
  POLYGON: 'polygon',
  EXTENT: 'extent',
  UNKNOWN: 'unknown',
});

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
});

const finite = (value) => Number.isFinite(Number(value));
const number = (value) => Number(value);
const isArray = Array.isArray;

const normalizeWkid = (spatialReference) => {
  const candidate = spatialReference?.latestWkid ?? spatialReference?.wkid ?? spatialReference;
  const numeric = Number(candidate);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
};

export const normalizeSpatialReference = (spatialReference, fallback = null) => {
  const wkid = normalizeWkid(spatialReference);
  if (wkid) return Object.freeze({ wkid });
  const wkt = typeof spatialReference?.wkt === 'string' ? spatialReference.wkt.trim() : '';
  if (wkt) return Object.freeze({ wkt });
  const fallbackWkid = normalizeWkid(fallback);
  return fallbackWkid ? Object.freeze({ wkid: fallbackWkid }) : null;
};

export const detectGeometryKind = (geometry) => {
  if (!geometry || typeof geometry !== 'object') return GEOMETRY_KIND.UNKNOWN;
  const explicit = String(geometry.type || '').toLowerCase();
  if (Object.values(GEOMETRY_KIND).includes(explicit)) return explicit;
  if (finite(geometry.x) && finite(geometry.y)) return GEOMETRY_KIND.POINT;
  if (isArray(geometry.points)) return GEOMETRY_KIND.MULTIPOINT;
  if (isArray(geometry.paths)) return GEOMETRY_KIND.POLYLINE;
  if (isArray(geometry.rings)) return GEOMETRY_KIND.POLYGON;
  if ([geometry.xmin, geometry.ymin, geometry.xmax, geometry.ymax].every(finite)) return GEOMETRY_KIND.EXTENT;
  return GEOMETRY_KIND.UNKNOWN;
};

const coordinate = (value, options = {}) => {
  if (!isArray(value) || value.length < 2 || !finite(value[0]) || !finite(value[1])) return null;
  const normalized = [number(value[0]), number(value[1])];
  if (options.preserveZ !== false && value.length > 2 && finite(value[2])) normalized.push(number(value[2]));
  if (options.preserveM !== false && value.length > 3 && finite(value[3])) normalized.push(number(value[3]));
  return normalized;
};

const coordinateEquals = (left, right) => (
  isArray(left) && isArray(right) &&
  left.length >= 2 && right.length >= 2 &&
  left[0] === right[0] && left[1] === right[1] &&
  (left.length < 3 || right.length < 3 || left[2] === right[2])
);

const geographicRangeIssue = (coord, wkid) => {
  if (wkid !== 4326 || !coord) return false;
  return coord[0] < -180 || coord[0] > 180 || coord[1] < -90 || coord[1] > 90;
};

const stable = (value, seen = new WeakSet()) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (seen.has(value)) return '"[Circular]"';
  seen.add(value);
  const result = isArray(value)
    ? `[${value.map((item) => stable(item, seen)).join(',')}]`
    : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key], seen)}`).join(',')}}`;
  seen.delete(value);
  return result;
};

const hashString = (value) => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

export const geometryFingerprint = (geometry) => `geom:${hashString(stable(geometry || null))}`;

const createDiagnostics = (kind, spatialReference) => ({
  kind,
  spatialReference,
  issues: [],
  droppedVertices: 0,
  repairedRings: 0,
  vertexCount: 0,
  partCount: 0,
  hasZ: false,
  hasM: false,
});

const pushIssue = (diagnostics, code, details = {}) => {
  diagnostics.issues.push({ code, ...details });
};

const consumeCoordinate = (raw, diagnostics, options) => {
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

const normalizePoint = (geometry, diagnostics, options) => {
  const raw = [geometry.x, geometry.y];
  if (finite(geometry.z)) raw.push(number(geometry.z));
  if (finite(geometry.m)) {
    if (raw.length === 2) raw.push(undefined);
    raw.push(number(geometry.m));
  }
  const value = consumeCoordinate(raw, diagnostics, options);
  if (!value) return null;
  return {
    type: GEOMETRY_KIND.POINT,
    x: value[0],
    y: value[1],
    ...(value.length >= 3 && finite(value[2]) ? { z: value[2] } : {}),
    ...(value.length >= 4 && finite(value[3]) ? { m: value[3] } : {}),
    ...(diagnostics.spatialReference ? { spatialReference: diagnostics.spatialReference } : {}),
  };
};

const normalizeMultipoint = (geometry, diagnostics, options) => {
  const points = [];
  for (const raw of geometry.points || []) {
    const value = consumeCoordinate(raw, diagnostics, options);
    if (value) points.push(value);
  }
  diagnostics.partCount = points.length ? 1 : 0;
  if (!points.length) pushIssue(diagnostics, GEOMETRY_ISSUE.EMPTY_PART, { partIndex: 0 });
  return {
    type: GEOMETRY_KIND.MULTIPOINT,
    points,
    ...(diagnostics.spatialReference ? { spatialReference: diagnostics.spatialReference } : {}),
  };
};

const normalizePathCollection = (parts, diagnostics, options, polygon = false) => {
  const normalizedParts = [];
  (parts || []).forEach((part, partIndex) => {
    if (!isArray(part)) {
      pushIssue(diagnostics, GEOMETRY_ISSUE.EMPTY_PART, { partIndex });
      return;
    }
    const normalized = [];
    part.forEach((raw) => {
      const value = consumeCoordinate(raw, diagnostics, options);
      if (value) normalized.push(value);
    });

    if (polygon) {
      if (normalized.length && !coordinateEquals(normalized[0], normalized[normalized.length - 1])) {
        pushIssue(diagnostics, GEOMETRY_ISSUE.OPEN_RING, { partIndex });
        if (options.repairRings !== false) {
          normalized.push([...normalized[0]]);
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

const normalizePolyline = (geometry, diagnostics, options) => ({
  type: GEOMETRY_KIND.POLYLINE,
  paths: normalizePathCollection(geometry.paths, diagnostics, options, false),
  ...(diagnostics.spatialReference ? { spatialReference: diagnostics.spatialReference } : {}),
});

const normalizePolygon = (geometry, diagnostics, options) => ({
  type: GEOMETRY_KIND.POLYGON,
  rings: normalizePathCollection(geometry.rings, diagnostics, options, true),
  ...(diagnostics.spatialReference ? { spatialReference: diagnostics.spatialReference } : {}),
});

const normalizeExtent = (geometry, diagnostics) => {
  const values = [geometry.xmin, geometry.ymin, geometry.xmax, geometry.ymax].map(number);
  if (!values.every(Number.isFinite) || values[0] > values[2] || values[1] > values[3]) {
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
  return {
    type: GEOMETRY_KIND.EXTENT,
    xmin: values[0],
    ymin: values[1],
    xmax: values[2],
    ymax: values[3],
    ...(finite(geometry.zmin) ? { zmin: number(geometry.zmin) } : {}),
    ...(finite(geometry.zmax) ? { zmax: number(geometry.zmax) } : {}),
    ...(diagnostics.spatialReference ? { spatialReference: diagnostics.spatialReference } : {}),
  };
};

export const normalizeGeometry = (geometry, options = {}) => {
  const kind = detectGeometryKind(geometry);
  const spatialReference = normalizeSpatialReference(geometry?.spatialReference, options.defaultWkid);
  const diagnostics = createDiagnostics(kind, spatialReference);

  if (!geometry) {
    pushIssue(diagnostics, GEOMETRY_ISSUE.MISSING);
    return { geometry: null, diagnostics: { ...diagnostics, valid: false } };
  }
  if (kind === GEOMETRY_KIND.UNKNOWN) {
    pushIssue(diagnostics, GEOMETRY_ISSUE.UNKNOWN_TYPE);
    return { geometry: null, diagnostics: { ...diagnostics, valid: false } };
  }
  if (!spatialReference && options.requireSpatialReference === true) {
    pushIssue(diagnostics, GEOMETRY_ISSUE.INVALID_SPATIAL_REFERENCE);
  }

  let normalized = null;
  if (kind === GEOMETRY_KIND.POINT) normalized = normalizePoint(geometry, diagnostics, options);
  if (kind === GEOMETRY_KIND.MULTIPOINT) normalized = normalizeMultipoint(geometry, diagnostics, options);
  if (kind === GEOMETRY_KIND.POLYLINE) normalized = normalizePolyline(geometry, diagnostics, options);
  if (kind === GEOMETRY_KIND.POLYGON) normalized = normalizePolygon(geometry, diagnostics, options);
  if (kind === GEOMETRY_KIND.EXTENT) normalized = normalizeExtent(geometry, diagnostics, options);

  const fatalCodes = new Set([
    GEOMETRY_ISSUE.MISSING,
    GEOMETRY_ISSUE.UNKNOWN_TYPE,
    GEOMETRY_ISSUE.INVALID_EXTENT,
    ...(options.failOnOutOfRange ? [GEOMETRY_ISSUE.OUT_OF_RANGE] : []),
    ...(options.requireSpatialReference ? [GEOMETRY_ISSUE.INVALID_SPATIAL_REFERENCE] : []),
  ]);
  const hasFatal = diagnostics.issues.some((issue) => fatalCodes.has(issue.code));
  const emptyCollection = normalized && (
    (kind === GEOMETRY_KIND.MULTIPOINT && normalized.points.length === 0) ||
    (kind === GEOMETRY_KIND.POLYLINE && normalized.paths.length === 0) ||
    (kind === GEOMETRY_KIND.POLYGON && normalized.rings.length === 0)
  );
  const valid = Boolean(normalized) && !hasFatal && !emptyCollection;

  return {
    geometry: valid || options.returnInvalidGeometry === true ? normalized : null,
    diagnostics: {
      ...diagnostics,
      valid,
      fingerprint: geometryFingerprint(normalized),
    },
  };
};

const visitCoordinates = (geometry, visitor) => {
  const kind = detectGeometryKind(geometry);
  if (kind === GEOMETRY_KIND.POINT) {
    visitor([geometry.x, geometry.y, geometry.z, geometry.m].filter((value, index) => index < 2 || finite(value)));
    return;
  }
  if (kind === GEOMETRY_KIND.MULTIPOINT) {
    (geometry.points || []).forEach(visitor);
    return;
  }
  if (kind === GEOMETRY_KIND.POLYLINE) {
    (geometry.paths || []).forEach((path) => (path || []).forEach(visitor));
    return;
  }
  if (kind === GEOMETRY_KIND.POLYGON) {
    (geometry.rings || []).forEach((ring) => (ring || []).forEach(visitor));
    return;
  }
  if (kind === GEOMETRY_KIND.EXTENT) {
    visitor([geometry.xmin, geometry.ymin]);
    visitor([geometry.xmax, geometry.ymax]);
  }
};

export const geometryExtent = (geometry) => {
  const kind = detectGeometryKind(geometry);
  if (kind === GEOMETRY_KIND.EXTENT) {
    const normalized = normalizeGeometry(geometry, { returnInvalidGeometry: true }).geometry;
    return normalized ? {
      xmin: normalized.xmin,
      ymin: normalized.ymin,
      xmax: normalized.xmax,
      ymax: normalized.ymax,
      ...(normalized.spatialReference ? { spatialReference: normalized.spatialReference } : {}),
    } : null;
  }

  let xmin = Infinity;
  let ymin = Infinity;
  let xmax = -Infinity;
  let ymax = -Infinity;
  let count = 0;
  visitCoordinates(geometry, (raw) => {
    const value = coordinate(raw);
    if (!value) return;
    xmin = Math.min(xmin, value[0]);
    ymin = Math.min(ymin, value[1]);
    xmax = Math.max(xmax, value[0]);
    ymax = Math.max(ymax, value[1]);
    count += 1;
  });
  if (!count) return null;
  const spatialReference = normalizeSpatialReference(geometry?.spatialReference);
  return {
    xmin,
    ymin,
    xmax,
    ymax,
    ...(spatialReference ? { spatialReference } : {}),
  };
};

export const countGeometryVertices = (geometry) => {
  let count = 0;
  visitCoordinates(geometry, (raw) => {
    if (coordinate(raw)) count += 1;
  });
  return count;
};

export const assessGeometryCollection = (features = [], options = {}) => {
  const result = {
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
  };

  (features || []).forEach((feature, index) => {
    result.total += 1;
    const source = feature?.geometry ?? feature;
    const normalized = normalizeGeometry(source, options);
    const diagnostics = normalized.diagnostics;
    result.byKind[diagnostics.kind] = (result.byKind[diagnostics.kind] || 0) + 1;
    result.vertices += diagnostics.vertexCount;
    result.droppedVertices += diagnostics.droppedVertices;
    if (diagnostics.repairedRings > 0) result.repaired += 1;
    diagnostics.issues.forEach((issue) => {
      result.issueCounts[issue.code] = (result.issueCounts[issue.code] || 0) + 1;
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

export const geometryComplexity = (geometry) => {
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
