export interface SpatialReferenceLike {
  readonly wkid?: number | null;
  readonly latestWkid?: number | null;
  readonly wkt?: string | null;
  readonly vcsWkid?: number | null;
  readonly latestVcsWkid?: number | null;
}

export type SpatialReferenceFamily = "wgs84" | "web-mercator" | "projected" | "geographic" | "wkt" | "unknown";
export type ProjectionRequirement = "none" | "projection-required" | "unsupported";

export interface NormalizedSpatialReference {
  readonly wkid: number | null;
  readonly latestWkid: number | null;
  readonly canonicalWkid: number | null;
  readonly wkt: string | null;
  readonly vcsWkid: number | null;
  readonly latestVcsWkid: number | null;
  readonly family: SpatialReferenceFamily;
  readonly isGeographic: boolean;
  readonly isWebMercator: boolean;
  readonly hasVerticalReference: boolean;
  readonly identity: string;
}

export interface ProjectionDecision {
  readonly requirement: ProjectionRequirement;
  readonly source: NormalizedSpatialReference;
  readonly target: NormalizedSpatialReference;
  readonly reason: "same-reference" | "wgs84-alias" | "web-mercator-alias" | "different-reference" | "unknown-source" | "unknown-target";
}

const WGS84 = new Set([4326]);
const WEB_MERCATOR = new Set([3857, 102100, 102113, 900913]);
const finitePositiveInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const normalizeWkid = (value: unknown): number | null => finitePositiveInteger(value) ? value : null;
const normalizeWkt = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed.length > 0 && trimmed.length <= 32_768 ? trimmed : null;
};

const canonicalizeWkid = (wkid: number | null, latestWkid: number | null): number | null => {
  const candidate = latestWkid ?? wkid;
  if (candidate === null) return null;
  if (WEB_MERCATOR.has(candidate)) return 3857;
  if (WGS84.has(candidate)) return 4326;
  return candidate;
};

const inferFamily = (canonicalWkid: number | null, wkt: string | null): SpatialReferenceFamily => {
  if (canonicalWkid === 4326) return "wgs84";
  if (canonicalWkid === 3857) return "web-mercator";
  if (canonicalWkid !== null) {
    if (canonicalWkid >= 4000 && canonicalWkid < 5000) return "geographic";
    return "projected";
  }
  return wkt ? "wkt" : "unknown";
};

export const normalizeSpatialReference = (input: SpatialReferenceLike | null | undefined): NormalizedSpatialReference => {
  const wkid = normalizeWkid(input?.wkid);
  const latestWkid = normalizeWkid(input?.latestWkid);
  const canonicalWkid = canonicalizeWkid(wkid, latestWkid);
  const wkt = normalizeWkt(input?.wkt);
  const vcsWkid = normalizeWkid(input?.vcsWkid);
  const latestVcsWkid = normalizeWkid(input?.latestVcsWkid);
  const family = inferFamily(canonicalWkid, wkt);
  const identity = canonicalWkid !== null ? `wkid:${canonicalWkid}` : wkt ? `wkt:${wkt}` : "unknown";
  return Object.freeze({
    wkid,
    latestWkid,
    canonicalWkid,
    wkt,
    vcsWkid,
    latestVcsWkid,
    family,
    isGeographic: family === "wgs84" || family === "geographic",
    isWebMercator: family === "web-mercator",
    hasVerticalReference: vcsWkid !== null || latestVcsWkid !== null,
    identity,
  });
};

export const spatialReferencesEquivalent = (left: SpatialReferenceLike | null | undefined, right: SpatialReferenceLike | null | undefined): boolean => {
  const a = normalizeSpatialReference(left);
  const b = normalizeSpatialReference(right);
  if (a.identity === "unknown" || b.identity === "unknown") return false;
  return a.identity === b.identity;
};

export const decideProjectionRequirement = (source: SpatialReferenceLike | null | undefined, target: SpatialReferenceLike | null | undefined): ProjectionDecision => {
  const normalizedSource = normalizeSpatialReference(source);
  const normalizedTarget = normalizeSpatialReference(target);
  if (normalizedSource.identity === "unknown") return Object.freeze({ requirement: "unsupported", source: normalizedSource, target: normalizedTarget, reason: "unknown-source" });
  if (normalizedTarget.identity === "unknown") return Object.freeze({ requirement: "unsupported", source: normalizedSource, target: normalizedTarget, reason: "unknown-target" });
  if (normalizedSource.identity === normalizedTarget.identity) {
    const reason = normalizedSource.family === "wgs84" ? "wgs84-alias" : normalizedSource.family === "web-mercator" ? "web-mercator-alias" : "same-reference";
    return Object.freeze({ requirement: "none", source: normalizedSource, target: normalizedTarget, reason });
  }
  return Object.freeze({ requirement: "projection-required", source: normalizedSource, target: normalizedTarget, reason: "different-reference" });
};

export const validateSpatialReference = (input: SpatialReferenceLike | null | undefined): readonly string[] => {
  const issues: string[] = [];
  if (!input) return Object.freeze(["spatial-reference-missing"]);
  const normalized = normalizeSpatialReference(input);
  if (normalized.identity === "unknown") issues.push("spatial-reference-identity-missing");
  if (input.wkid != null && normalized.wkid === null) issues.push("wkid-invalid");
  if (input.latestWkid != null && normalized.latestWkid === null) issues.push("latest-wkid-invalid");
  if (input.vcsWkid != null && normalized.vcsWkid === null) issues.push("vertical-wkid-invalid");
  if (input.latestVcsWkid != null && normalized.latestVcsWkid === null) issues.push("latest-vertical-wkid-invalid");
  if (typeof input.wkt === "string" && input.wkt.trim().length > 0 && normalized.wkt === null) issues.push("wkt-invalid-or-too-large");
  return Object.freeze(issues);
};