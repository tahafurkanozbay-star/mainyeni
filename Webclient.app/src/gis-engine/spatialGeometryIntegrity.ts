export type SpatialGeometryKind = 'point' | 'multipoint' | 'polyline' | 'polygon' | 'extent';

export interface SpatialReferenceContract {
  readonly wkid?: number;
  readonly latestWkid?: number;
}

export interface SpatialPoint {
  readonly x: number;
  readonly y: number;
  readonly z?: number;
  readonly m?: number;
}

export interface SpatialExtent {
  readonly xmin: number;
  readonly ymin: number;
  readonly xmax: number;
  readonly ymax: number;
}

export interface SpatialGeometryInput {
  readonly type: SpatialGeometryKind;
  readonly spatialReference?: SpatialReferenceContract;
  readonly x?: number;
  readonly y?: number;
  readonly z?: number;
  readonly m?: number;
  readonly points?: readonly (readonly number[])[];
  readonly paths?: readonly (readonly (readonly number[])[])[];
  readonly rings?: readonly (readonly (readonly number[])[])[];
  readonly xmin?: number;
  readonly ymin?: number;
  readonly xmax?: number;
  readonly ymax?: number;
}

export interface SpatialGeometryIntegrityConfiguration {
  readonly maxParts?: number;
  readonly maxVerticesPerPart?: number;
  readonly maxVertices?: number;
  readonly maxCoordinateMagnitude?: number;
  readonly requireSpatialReference?: boolean;
  readonly allowedWkids?: readonly number[];
}

export interface SpatialGeometryIssue {
  readonly code:
    | 'missing-spatial-reference'
    | 'unsupported-spatial-reference'
    | 'invalid-coordinate'
    | 'coordinate-out-of-range'
    | 'too-many-parts'
    | 'too-many-vertices'
    | 'empty-geometry'
    | 'invalid-extent'
    | 'invalid-ring';
  readonly path: string;
  readonly message: string;
}

export interface SpatialGeometryIntegrityResult {
  readonly valid: boolean;
  readonly kind: SpatialGeometryKind;
  readonly spatialReference: Readonly<SpatialReferenceContract> | null;
  readonly extent: Readonly<SpatialExtent> | null;
  readonly partCount: number;
  readonly vertexCount: number;
  readonly issues: readonly SpatialGeometryIssue[];
  readonly fingerprint: string;
}

interface NormalizedConfiguration {
  readonly maxParts: number;
  readonly maxVerticesPerPart: number;
  readonly maxVertices: number;
  readonly maxCoordinateMagnitude: number;
  readonly requireSpatialReference: boolean;
  readonly allowedWkids: ReadonlySet<number> | null;
}

const DEFAULT_MAX_PARTS = 2_048;
const DEFAULT_MAX_VERTICES_PER_PART = 100_000;
const DEFAULT_MAX_VERTICES = 500_000;
const DEFAULT_MAX_COORDINATE_MAGNITUDE = 1_000_000_000;

const finitePositiveInteger = (value: unknown, fallback: number, maximum: number): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.min(maximum, Math.max(1, Math.floor(numeric)));
};

const normalizeConfiguration = (
  configuration: SpatialGeometryIntegrityConfiguration = {},
): NormalizedConfiguration => {
  const allowed = configuration.allowedWkids
    ?.map((value) => Number(value))
    .filter((value) => Number.isSafeInteger(value) && value > 0);
  return Object.freeze({
    maxParts: finitePositiveInteger(configuration.maxParts, DEFAULT_MAX_PARTS, 100_000),
    maxVerticesPerPart: finitePositiveInteger(
      configuration.maxVerticesPerPart,
      DEFAULT_MAX_VERTICES_PER_PART,
      1_000_000,
    ),
    maxVertices: finitePositiveInteger(configuration.maxVertices, DEFAULT_MAX_VERTICES, 2_000_000),
    maxCoordinateMagnitude: Math.min(
      Number.MAX_SAFE_INTEGER,
      Math.max(1, Number.isFinite(configuration.maxCoordinateMagnitude)
        ? Number(configuration.maxCoordinateMagnitude)
        : DEFAULT_MAX_COORDINATE_MAGNITUDE),
    ),
    requireSpatialReference: configuration.requireSpatialReference !== false,
    allowedWkids: allowed == null ? null : new Set(allowed),
  });
};

const issue = (
  code: SpatialGeometryIssue['code'],
  path: string,
  message: string,
): SpatialGeometryIssue => Object.freeze({ code, path, message });

const normalizeSpatialReference = (
  input: SpatialReferenceContract | undefined,
  configuration: NormalizedConfiguration,
  issues: SpatialGeometryIssue[],
): Readonly<SpatialReferenceContract> | null => {
  if (input == null) {
    if (configuration.requireSpatialReference) {
      issues.push(issue('missing-spatial-reference', 'spatialReference', 'Spatial reference is required.'));
    }
    return null;
  }
  const wkid = Number(input.latestWkid ?? input.wkid);
  if (!Number.isSafeInteger(wkid) || wkid <= 0) {
    issues.push(issue('unsupported-spatial-reference', 'spatialReference', 'WKID must be a positive integer.'));
    return null;
  }
  if (configuration.allowedWkids != null && !configuration.allowedWkids.has(wkid)) {
    issues.push(issue('unsupported-spatial-reference', 'spatialReference', `WKID ${wkid} is not allowed.`));
  }
  const normalized: SpatialReferenceContract = {};
  if (input.wkid !== undefined && Number.isSafeInteger(Number(input.wkid))) normalized.wkid = Number(input.wkid);
  if (input.latestWkid !== undefined && Number.isSafeInteger(Number(input.latestWkid))) {
    normalized.latestWkid = Number(input.latestWkid);
  }
  if (normalized.wkid === undefined && normalized.latestWkid === undefined) normalized.wkid = wkid;
  return Object.freeze(normalized);
};

class ExtentAccumulator {
  #xmin = Number.POSITIVE_INFINITY;
  #ymin = Number.POSITIVE_INFINITY;
  #xmax = Number.NEGATIVE_INFINITY;
  #ymax = Number.NEGATIVE_INFINITY;
  #count = 0;

  add(x: number, y: number): void {
    this.#xmin = Math.min(this.#xmin, x);
    this.#ymin = Math.min(this.#ymin, y);
    this.#xmax = Math.max(this.#xmax, x);
    this.#ymax = Math.max(this.#ymax, y);
    this.#count += 1;
  }

  snapshot(): Readonly<SpatialExtent> | null {
    if (this.#count === 0) return null;
    return Object.freeze({ xmin: this.#xmin, ymin: this.#ymin, xmax: this.#xmax, ymax: this.#ymax });
  }
}

const validateCoordinate = (
  value: unknown,
  path: string,
  configuration: NormalizedConfiguration,
  issues: SpatialGeometryIssue[],
): number | null => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    issues.push(issue('invalid-coordinate', path, 'Coordinate must be finite.'));
    return null;
  }
  if (Math.abs(numeric) > configuration.maxCoordinateMagnitude) {
    issues.push(issue('coordinate-out-of-range', path, 'Coordinate exceeds configured magnitude.'));
    return null;
  }
  return numeric;
};

const validateVertex = (
  vertex: readonly number[],
  path: string,
  configuration: NormalizedConfiguration,
  issues: SpatialGeometryIssue[],
  extent: ExtentAccumulator,
): boolean => {
  if (vertex.length < 2) {
    issues.push(issue('invalid-coordinate', path, 'Vertex requires x and y ordinates.'));
    return false;
  }
  const x = validateCoordinate(vertex[0], `${path}[0]`, configuration, issues);
  const y = validateCoordinate(vertex[1], `${path}[1]`, configuration, issues);
  if (x == null || y == null) return false;
  extent.add(x, y);
  for (let ordinate = 2; ordinate < Math.min(vertex.length, 4); ordinate += 1) {
    validateCoordinate(vertex[ordinate], `${path}[${ordinate}]`, configuration, issues);
  }
  return true;
};

const validateParts = (
  parts: readonly (readonly (readonly number[])[])[],
  kind: 'paths' | 'rings',
  configuration: NormalizedConfiguration,
  issues: SpatialGeometryIssue[],
  extent: ExtentAccumulator,
): { partCount: number; vertexCount: number } => {
  if (parts.length === 0) {
    issues.push(issue('empty-geometry', kind, 'Geometry must contain at least one part.'));
    return { partCount: 0, vertexCount: 0 };
  }
  if (parts.length > configuration.maxParts) {
    issues.push(issue('too-many-parts', kind, `Geometry exceeds ${configuration.maxParts} parts.`));
  }
  const partLimit = Math.min(parts.length, configuration.maxParts);
  let vertexCount = 0;
  for (let partIndex = 0; partIndex < partLimit; partIndex += 1) {
    const part = parts[partIndex] ?? [];
    if (part.length > configuration.maxVerticesPerPart) {
      issues.push(issue(
        'too-many-vertices',
        `${kind}[${partIndex}]`,
        `Part exceeds ${configuration.maxVerticesPerPart} vertices.`,
      ));
    }
    const vertexLimit = Math.min(part.length, configuration.maxVerticesPerPart);
    for (let vertexIndex = 0; vertexIndex < vertexLimit && vertexCount < configuration.maxVertices; vertexIndex += 1) {
      validateVertex(part[vertexIndex] ?? [], `${kind}[${partIndex}][${vertexIndex}]`, configuration, issues, extent);
      vertexCount += 1;
    }
    if (kind === 'rings' && part.length > 0) {
      const first = part[0];
      const last = part[part.length - 1];
      if (first == null || last == null || first[0] !== last[0] || first[1] !== last[1]) {
        issues.push(issue('invalid-ring', `${kind}[${partIndex}]`, 'Polygon ring must be explicitly closed.'));
      }
    }
    if (vertexCount >= configuration.maxVertices) break;
  }
  const actualVertices = parts.reduce((total, part) => total + part.length, 0);
  if (actualVertices > configuration.maxVertices) {
    issues.push(issue('too-many-vertices', kind, `Geometry exceeds ${configuration.maxVertices} total vertices.`));
  }
  return { partCount: parts.length, vertexCount: actualVertices };
};

const fingerprint = (
  kind: SpatialGeometryKind,
  spatialReference: Readonly<SpatialReferenceContract> | null,
  extent: Readonly<SpatialExtent> | null,
  partCount: number,
  vertexCount: number,
  issues: readonly SpatialGeometryIssue[],
): string => {
  let hash = 2_166_136_261;
  const feed = (value: string): void => {
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16_777_619) >>> 0;
    }
  };
  feed(kind);
  feed(String(spatialReference?.latestWkid ?? spatialReference?.wkid ?? 'none'));
  if (extent != null) feed(`${extent.xmin}:${extent.ymin}:${extent.xmax}:${extent.ymax}`);
  feed(`${partCount}:${vertexCount}`);
  for (const entry of issues) feed(`${entry.code}:${entry.path}`);
  return hash.toString(16).padStart(8, '0');
};

export const inspectSpatialGeometry = (
  geometry: SpatialGeometryInput,
  configurationInput: SpatialGeometryIntegrityConfiguration = {},
): SpatialGeometryIntegrityResult => {
  const configuration = normalizeConfiguration(configurationInput);
  const issues: SpatialGeometryIssue[] = [];
  const spatialReference = normalizeSpatialReference(geometry.spatialReference, configuration, issues);
  const extent = new ExtentAccumulator();
  let partCount = 0;
  let vertexCount = 0;

  if (geometry.type === 'point') {
    const x = validateCoordinate(geometry.x, 'x', configuration, issues);
    const y = validateCoordinate(geometry.y, 'y', configuration, issues);
    if (x != null && y != null) extent.add(x, y);
    if (geometry.z !== undefined) validateCoordinate(geometry.z, 'z', configuration, issues);
    if (geometry.m !== undefined) validateCoordinate(geometry.m, 'm', configuration, issues);
    partCount = 1;
    vertexCount = 1;
  } else if (geometry.type === 'multipoint') {
    const points = geometry.points ?? [];
    if (points.length === 0) issues.push(issue('empty-geometry', 'points', 'Multipoint must contain points.'));
    if (points.length > configuration.maxVertices) {
      issues.push(issue('too-many-vertices', 'points', `Geometry exceeds ${configuration.maxVertices} vertices.`));
    }
    const limit = Math.min(points.length, configuration.maxVertices);
    for (let index = 0; index < limit; index += 1) {
      validateVertex(points[index] ?? [], `points[${index}]`, configuration, issues, extent);
    }
    partCount = points.length === 0 ? 0 : 1;
    vertexCount = points.length;
  } else if (geometry.type === 'polyline') {
    const result = validateParts(geometry.paths ?? [], 'paths', configuration, issues, extent);
    partCount = result.partCount;
    vertexCount = result.vertexCount;
  } else if (geometry.type === 'polygon') {
    const result = validateParts(geometry.rings ?? [], 'rings', configuration, issues, extent);
    partCount = result.partCount;
    vertexCount = result.vertexCount;
  } else {
    const xmin = validateCoordinate(geometry.xmin, 'xmin', configuration, issues);
    const ymin = validateCoordinate(geometry.ymin, 'ymin', configuration, issues);
    const xmax = validateCoordinate(geometry.xmax, 'xmax', configuration, issues);
    const ymax = validateCoordinate(geometry.ymax, 'ymax', configuration, issues);
    if (xmin != null && ymin != null && xmax != null && ymax != null) {
      if (xmin > xmax || ymin > ymax) {
        issues.push(issue('invalid-extent', 'extent', 'Extent minimums must not exceed maximums.'));
      } else {
        extent.add(xmin, ymin);
        extent.add(xmax, ymax);
      }
    }
    partCount = 1;
    vertexCount = 2;
  }

  const extentSnapshot = extent.snapshot();
  const frozenIssues = Object.freeze([...issues]);
  return Object.freeze({
    valid: frozenIssues.length === 0,
    kind: geometry.type,
    spatialReference,
    extent: extentSnapshot,
    partCount,
    vertexCount,
    issues: frozenIssues,
    fingerprint: fingerprint(geometry.type, spatialReference, extentSnapshot, partCount, vertexCount, frozenIssues),
  });
};

export const geometriesShareSpatialReference = (
  left: SpatialGeometryInput,
  right: SpatialGeometryInput,
): boolean => {
  const leftWkid = Number(left.spatialReference?.latestWkid ?? left.spatialReference?.wkid);
  const rightWkid = Number(right.spatialReference?.latestWkid ?? right.spatialReference?.wkid);
  return Number.isSafeInteger(leftWkid) && leftWkid > 0 && leftWkid === rightWkid;
};
