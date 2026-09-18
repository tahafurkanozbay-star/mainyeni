export type SpatialReferenceDescriptor = Readonly<{
  wkid?: number;
  latestWkid?: number;
  wkt?: string;
  vcsWkid?: number;
  latestVcsWkid?: number;
}>;

export type NormalizedSpatialReference = Readonly<{
  wkid: number | null;
  latestWkid: number | null;
  wkt: string | null;
  vcsWkid: number | null;
  latestVcsWkid: number | null;
  geographic: boolean;
  webMercator: boolean;
  key: string;
}>;

export type Coordinate2D = readonly [number, number];
export type Extent2D = Readonly<{ xmin: number; ymin: number; xmax: number; ymax: number }>;

export type SpatialReferenceRuntimeOptions = Readonly<{
  maxCoordinates?: number;
  maxWktLength?: number;
}>;

const DEFAULT_MAX_COORDINATES = 100_000;
const DEFAULT_MAX_WKT_LENGTH = 16_384;
const WEB_MERCATOR_WKIDS = new Set([3857, 102100, 102113]);
const GEOGRAPHIC_WKIDS = new Set([4326, 4269, 4258]);
const MAX_MERCATOR_LATITUDE = 85.0511287798066;
const EARTH_RADIUS = 6378137;

function finiteInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function finiteCoordinate(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be finite`);
  }
  return value;
}

function normalizeWkt(value: unknown, maxLength: number): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new TypeError("spatial reference WKT must be a string");
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLength) throw new RangeError("spatial reference WKT exceeds configured budget");
  return trimmed;
}

function assertPositiveBudget(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new RangeError(`${label} must be a positive safe integer`);
  return resolved;
}

function effectiveWkid(reference: Pick<NormalizedSpatialReference, "wkid" | "latestWkid">): number | null {
  return reference.latestWkid ?? reference.wkid;
}

function inferGeographic(wkid: number | null, wkt: string | null): boolean {
  if (wkid != null && GEOGRAPHIC_WKIDS.has(wkid)) return true;
  return wkt != null && /^\s*(GEOGCS|GEODCRS|GEOGRAPHICCRS)\s*\[/i.test(wkt);
}

function inferWebMercator(wkid: number | null, wkt: string | null): boolean {
  if (wkid != null && WEB_MERCATOR_WKIDS.has(wkid)) return true;
  if (wkt == null) return false;
  return /Web[_ ]Mercator|Pseudo[_ -]Mercator|Auxiliary[_ ]Sphere/i.test(wkt);
}

export function normalizeSpatialReference(
  descriptor: SpatialReferenceDescriptor | null | undefined,
  options: SpatialReferenceRuntimeOptions = {},
): NormalizedSpatialReference {
  if (descriptor == null || typeof descriptor !== "object") throw new TypeError("spatial reference descriptor is required");
  const maxWktLength = assertPositiveBudget(options.maxWktLength, DEFAULT_MAX_WKT_LENGTH, "maxWktLength");
  const wkid = descriptor.wkid == null ? null : finiteInteger(descriptor.wkid);
  const latestWkid = descriptor.latestWkid == null ? null : finiteInteger(descriptor.latestWkid);
  const vcsWkid = descriptor.vcsWkid == null ? null : finiteInteger(descriptor.vcsWkid);
  const latestVcsWkid = descriptor.latestVcsWkid == null ? null : finiteInteger(descriptor.latestVcsWkid);
  if (descriptor.wkid != null && wkid == null) throw new TypeError("wkid must be a positive safe integer");
  if (descriptor.latestWkid != null && latestWkid == null) throw new TypeError("latestWkid must be a positive safe integer");
  if (descriptor.vcsWkid != null && vcsWkid == null) throw new TypeError("vcsWkid must be a positive safe integer");
  if (descriptor.latestVcsWkid != null && latestVcsWkid == null) throw new TypeError("latestVcsWkid must be a positive safe integer");
  const wkt = normalizeWkt(descriptor.wkt, maxWktLength);
  if (wkid == null && latestWkid == null && wkt == null) throw new TypeError("spatial reference must contain wkid/latestWkid or WKT");
  const horizontal = latestWkid ?? wkid;
  const vertical = latestVcsWkid ?? vcsWkid;
  const key = horizontal != null ? `wkid:${horizontal}${vertical != null ? `:vcs:${vertical}` : ""}` : `wkt:${wkt}`;
  return Object.freeze({
    wkid,
    latestWkid,
    wkt,
    vcsWkid,
    latestVcsWkid,
    geographic: inferGeographic(horizontal, wkt),
    webMercator: inferWebMercator(horizontal, wkt),
    key,
  });
}

export function spatialReferencesEquivalent(a: NormalizedSpatialReference, b: NormalizedSpatialReference): boolean {
  if (a.key === b.key) return true;
  const aWkid = effectiveWkid(a);
  const bWkid = effectiveWkid(b);
  if (aWkid != null && bWkid != null) {
    const horizontalEqual = aWkid === bWkid || (WEB_MERCATOR_WKIDS.has(aWkid) && WEB_MERCATOR_WKIDS.has(bWkid));
    const aVcs = a.latestVcsWkid ?? a.vcsWkid;
    const bVcs = b.latestVcsWkid ?? b.vcsWkid;
    return horizontalEqual && aVcs === bVcs;
  }
  return a.wkt != null && b.wkt != null && a.wkt === b.wkt;
}

function clampLatitude(latitude: number): number {
  return Math.max(-MAX_MERCATOR_LATITUDE, Math.min(MAX_MERCATOR_LATITUDE, latitude));
}

export function geographicToWebMercator(coordinate: Coordinate2D): Coordinate2D {
  const longitude = finiteCoordinate(coordinate[0], "longitude");
  const latitude = clampLatitude(finiteCoordinate(coordinate[1], "latitude"));
  const x = EARTH_RADIUS * longitude * Math.PI / 180;
  const y = EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + latitude * Math.PI / 360));
  return Object.freeze([x, y]);
}

export function webMercatorToGeographic(coordinate: Coordinate2D): Coordinate2D {
  const x = finiteCoordinate(coordinate[0], "x");
  const y = finiteCoordinate(coordinate[1], "y");
  const longitude = x / EARTH_RADIUS * 180 / Math.PI;
  const latitude = (2 * Math.atan(Math.exp(y / EARTH_RADIUS)) - Math.PI / 2) * 180 / Math.PI;
  return Object.freeze([longitude, clampLatitude(latitude)]);
}

export function projectCoordinate(
  coordinate: Coordinate2D,
  source: NormalizedSpatialReference,
  target: NormalizedSpatialReference,
): Coordinate2D {
  if (spatialReferencesEquivalent(source, target)) {
    return Object.freeze([finiteCoordinate(coordinate[0], "x"), finiteCoordinate(coordinate[1], "y")]);
  }
  if (source.geographic && target.webMercator) return geographicToWebMercator(coordinate);
  if (source.webMercator && target.geographic) return webMercatorToGeographic(coordinate);
  throw new RangeError(`unsupported client projection ${source.key} -> ${target.key}`);
}

export function projectCoordinates(
  coordinates: readonly Coordinate2D[],
  source: NormalizedSpatialReference,
  target: NormalizedSpatialReference,
  options: SpatialReferenceRuntimeOptions & Readonly<{ signal?: AbortSignal }> = {},
): readonly Coordinate2D[] {
  const maxCoordinates = assertPositiveBudget(options.maxCoordinates, DEFAULT_MAX_COORDINATES, "maxCoordinates");
  if (coordinates.length > maxCoordinates) throw new RangeError("coordinate projection exceeds configured budget");
  const result: Coordinate2D[] = [];
  for (let index = 0; index < coordinates.length; index += 1) {
    if (options.signal?.aborted) throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
    result.push(projectCoordinate(coordinates[index]!, source, target));
  }
  return Object.freeze(result);
}

export function normalizeExtent(extent: Extent2D): Extent2D {
  const xmin = finiteCoordinate(extent.xmin, "xmin");
  const ymin = finiteCoordinate(extent.ymin, "ymin");
  const xmax = finiteCoordinate(extent.xmax, "xmax");
  const ymax = finiteCoordinate(extent.ymax, "ymax");
  if (xmax < xmin || ymax < ymin) throw new RangeError("extent bounds are inverted");
  return Object.freeze({ xmin, ymin, xmax, ymax });
}

export function projectExtent(
  extent: Extent2D,
  source: NormalizedSpatialReference,
  target: NormalizedSpatialReference,
): Extent2D {
  const normalized = normalizeExtent(extent);
  const corners = [
    projectCoordinate([normalized.xmin, normalized.ymin], source, target),
    projectCoordinate([normalized.xmin, normalized.ymax], source, target),
    projectCoordinate([normalized.xmax, normalized.ymin], source, target),
    projectCoordinate([normalized.xmax, normalized.ymax], source, target),
  ] as const;
  return Object.freeze({
    xmin: Math.min(...corners.map(([x]) => x)),
    ymin: Math.min(...corners.map(([, y]) => y)),
    xmax: Math.max(...corners.map(([x]) => x)),
    ymax: Math.max(...corners.map(([, y]) => y)),
  });
}

export function chooseAnalysisSpatialReference(
  references: readonly NormalizedSpatialReference[],
  preferred?: NormalizedSpatialReference,
): NormalizedSpatialReference {
  if (references.length === 0) {
    if (preferred) return preferred;
    throw new RangeError("at least one spatial reference is required");
  }
  if (preferred && references.every((candidate) => spatialReferencesEquivalent(candidate, preferred))) return preferred;
  const first = references[0]!;
  if (references.every((candidate) => spatialReferencesEquivalent(candidate, first))) return first;
  const projected = references.find((candidate) => !candidate.geographic);
  if (projected && references.every((candidate) => spatialReferencesEquivalent(candidate, projected))) return projected;
  throw new RangeError("mixed spatial references require an explicit verified projection path");
}
