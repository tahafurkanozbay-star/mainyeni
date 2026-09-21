export type ViewportMode = "2d" | "3d";

export interface SpatialExtent {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
  wkid: number;
}

export interface SpatialViewportRequest {
  extent: SpatialExtent;
  mode: ViewportMode;
  widthPx: number;
  heightPx: number;
  scale: number;
  tilt?: number;
  heading?: number;
}

export interface SpatialViewportPolicy {
  minWidthPx: number;
  maxWidthPx: number;
  minHeightPx: number;
  maxHeightPx: number;
  minScale: number;
  maxScale: number;
  maxCoordinateMagnitude: number;
  maxAspectRatio: number;
  maxExtentSpan: number;
}

export interface SpatialViewportValidation {
  valid: boolean;
  normalized: SpatialViewportRequest | null;
  errors: readonly string[];
}

export const DEFAULT_SPATIAL_VIEWPORT_POLICY: SpatialViewportPolicy = Object.freeze({
  minWidthPx: 1,
  maxWidthPx: 16_384,
  minHeightPx: 1,
  maxHeightPx: 16_384,
  minScale: 50,
  maxScale: 750_000_000,
  maxCoordinateMagnitude: 1_000_000_000,
  maxAspectRatio: 32,
  maxExtentSpan: 500_000_000,
});

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

const normalizeWkid = (wkid: number): number => wkid === 102100 || wkid === 102113 ? 3857 : wkid;

const normalizeAngle = (angle: number): number => {
  const normalized = angle % 360;
  return normalized < 0 ? normalized + 360 : normalized;
};

const validatePolicy = (policy: SpatialViewportPolicy): void => {
  if (!finite(policy.minWidthPx) || policy.minWidthPx <= 0) throw new Error("minWidthPx must be positive");
  if (!finite(policy.maxWidthPx) || policy.maxWidthPx < policy.minWidthPx) throw new Error("maxWidthPx must be >= minWidthPx");
  if (!finite(policy.minHeightPx) || policy.minHeightPx <= 0) throw new Error("minHeightPx must be positive");
  if (!finite(policy.maxHeightPx) || policy.maxHeightPx < policy.minHeightPx) throw new Error("maxHeightPx must be >= minHeightPx");
  if (!finite(policy.minScale) || policy.minScale <= 0) throw new Error("minScale must be positive");
  if (!finite(policy.maxScale) || policy.maxScale < policy.minScale) throw new Error("maxScale must be >= minScale");
  if (!finite(policy.maxCoordinateMagnitude) || policy.maxCoordinateMagnitude <= 0) throw new Error("maxCoordinateMagnitude must be positive");
  if (!finite(policy.maxAspectRatio) || policy.maxAspectRatio < 1) throw new Error("maxAspectRatio must be >= 1");
  if (!finite(policy.maxExtentSpan) || policy.maxExtentSpan <= 0) throw new Error("maxExtentSpan must be positive");
};

const extentErrors = (extent: SpatialExtent, policy: SpatialViewportPolicy): string[] => {
  const errors: string[] = [];
  if (![extent.xmin, extent.ymin, extent.xmax, extent.ymax].every(finite)) errors.push("extent-non-finite");
  if (!Number.isInteger(extent.wkid) || extent.wkid <= 0) errors.push("wkid-invalid");
  if (errors.length > 0) return errors;
  if (extent.xmin >= extent.xmax) errors.push("extent-x-order");
  if (extent.ymin >= extent.ymax) errors.push("extent-y-order");
  if (Math.max(Math.abs(extent.xmin), Math.abs(extent.ymin), Math.abs(extent.xmax), Math.abs(extent.ymax)) > policy.maxCoordinateMagnitude) {
    errors.push("coordinate-budget");
  }
  if (extent.xmax - extent.xmin > policy.maxExtentSpan || extent.ymax - extent.ymin > policy.maxExtentSpan) errors.push("extent-span-budget");
  return errors;
};

export function validateSpatialViewport(
  request: SpatialViewportRequest,
  policyInput: Partial<SpatialViewportPolicy> = {},
): SpatialViewportValidation {
  const policy: SpatialViewportPolicy = { ...DEFAULT_SPATIAL_VIEWPORT_POLICY, ...policyInput };
  validatePolicy(policy);
  const errors = extentErrors(request.extent, policy);
  if (!finite(request.widthPx) || request.widthPx < policy.minWidthPx || request.widthPx > policy.maxWidthPx) errors.push("width-budget");
  if (!finite(request.heightPx) || request.heightPx < policy.minHeightPx || request.heightPx > policy.maxHeightPx) errors.push("height-budget");
  if (finite(request.widthPx) && finite(request.heightPx) && request.widthPx > 0 && request.heightPx > 0) {
    const ratio = Math.max(request.widthPx / request.heightPx, request.heightPx / request.widthPx);
    if (ratio > policy.maxAspectRatio) errors.push("aspect-ratio-budget");
  }
  if (!finite(request.scale) || request.scale < policy.minScale || request.scale > policy.maxScale) errors.push("scale-budget");
  if (request.mode !== "2d" && request.mode !== "3d") errors.push("mode-invalid");
  if (request.mode === "2d") {
    if (request.tilt !== undefined && request.tilt !== 0) errors.push("tilt-not-allowed-2d");
  } else if (request.tilt !== undefined && (!finite(request.tilt) || request.tilt < 0 || request.tilt > 90)) {
    errors.push("tilt-budget");
  }
  if (request.heading !== undefined && !finite(request.heading)) errors.push("heading-non-finite");
  if (errors.length > 0) return { valid: false, normalized: null, errors: Object.freeze(errors) };
  const normalized: SpatialViewportRequest = {
    extent: { ...request.extent, wkid: normalizeWkid(request.extent.wkid) },
    mode: request.mode,
    widthPx: request.widthPx,
    heightPx: request.heightPx,
    scale: request.scale,
    ...(request.mode === "3d" ? { tilt: request.tilt ?? 0 } : {}),
    heading: normalizeAngle(request.heading ?? 0),
  };
  return { valid: true, normalized: Object.freeze(normalized), errors: Object.freeze([]) };
}

export function viewportGroundResolution(viewport: SpatialViewportRequest): number | null {
  const width = viewport.extent.xmax - viewport.extent.xmin;
  const height = viewport.extent.ymax - viewport.extent.ymin;
  if (!finite(width) || !finite(height) || width <= 0 || height <= 0) return null;
  if (!finite(viewport.widthPx) || !finite(viewport.heightPx) || viewport.widthPx <= 0 || viewport.heightPx <= 0) return null;
  return Math.max(width / viewport.widthPx, height / viewport.heightPx);
}

export function viewportContainsPoint(extent: SpatialExtent, x: number, y: number, wkid: number): boolean {
  if (![x, y].every(finite)) return false;
  if (normalizeWkid(extent.wkid) !== normalizeWkid(wkid)) return false;
  return x >= extent.xmin && x <= extent.xmax && y >= extent.ymin && y <= extent.ymax;
}

export function viewportIntersection(a: SpatialExtent, b: SpatialExtent): SpatialExtent | null {
  if (normalizeWkid(a.wkid) !== normalizeWkid(b.wkid)) return null;
  if (![a.xmin, a.ymin, a.xmax, a.ymax, b.xmin, b.ymin, b.xmax, b.ymax].every(finite)) return null;
  const xmin = Math.max(a.xmin, b.xmin);
  const ymin = Math.max(a.ymin, b.ymin);
  const xmax = Math.min(a.xmax, b.xmax);
  const ymax = Math.min(a.ymax, b.ymax);
  if (xmin >= xmax || ymin >= ymax) return null;
  return { xmin, ymin, xmax, ymax, wkid: normalizeWkid(a.wkid) };
}

export function viewportOverlapRatio(a: SpatialExtent, b: SpatialExtent): number {
  const intersection = viewportIntersection(a, b);
  if (!intersection) return 0;
  const intersectionArea = (intersection.xmax - intersection.xmin) * (intersection.ymax - intersection.ymin);
  const aArea = (a.xmax - a.xmin) * (a.ymax - a.ymin);
  if (!finite(intersectionArea) || !finite(aArea) || aArea <= 0) return 0;
  return Math.min(1, Math.max(0, intersectionArea / aArea));
}
