import {
  type Extent2D,
  type NormalizedSpatialReference,
  normalizeExtent,
  projectExtent,
  spatialReferencesEquivalent,
} from "./spatialReferenceRuntime";

export type SpatialViewDimension = "2d" | "3d";

export interface SpatialViewTimeExtent {
  readonly start: number;
  readonly end: number;
}

export interface SpatialViewQueryStateInput {
  readonly viewId: string;
  readonly dimension: SpatialViewDimension;
  readonly extent: Extent2D;
  readonly spatialReference: NormalizedSpatialReference;
  readonly scale: number;
  readonly visibleLayerIds: readonly string[];
  readonly rotation?: number;
  readonly tilt?: number;
  readonly timeExtent?: SpatialViewTimeExtent | null;
}

export interface SpatialViewQueryState {
  readonly viewId: string;
  readonly dimension: SpatialViewDimension;
  readonly extent: Extent2D;
  readonly spatialReference: NormalizedSpatialReference;
  readonly scale: number;
  readonly scaleBucket: number;
  readonly visibleLayerIds: readonly string[];
  readonly rotation: number;
  readonly tilt: number;
  readonly timeExtent: SpatialViewTimeExtent | null;
  readonly revision: number;
  readonly fingerprint: string;
}

export interface SpatialViewQueryStateOptions {
  readonly maxViews?: number;
  readonly maxVisibleLayers?: number;
  readonly maxIdentifierLength?: number;
  readonly scaleBucketFactor?: number;
  readonly coordinatePrecision?: number;
  readonly targetSpatialReference?: NormalizedSpatialReference;
  readonly projectToTarget?: boolean;
}

export interface SpatialViewQueryStateSnapshot {
  readonly revision: number;
  readonly views: readonly SpatialViewQueryState[];
  readonly layerRevisions: Readonly<Record<string, number>>;
}

export interface SpatialViewQueryStateCoordinator {
  readonly get: (viewId: string) => SpatialViewQueryState | undefined;
  readonly upsert: (input: SpatialViewQueryStateInput) => SpatialViewQueryState;
  readonly remove: (viewId: string) => boolean;
  readonly invalidateLayer: (layerId: string) => number;
  readonly snapshot: () => SpatialViewQueryStateSnapshot;
  readonly querySignature: (viewId: string) => string;
  readonly queryEquivalent: (leftViewId: string, rightViewId: string) => boolean;
  readonly clear: () => void;
}

const DEFAULT_MAX_VIEWS = 16;
const DEFAULT_MAX_VISIBLE_LAYERS = 512;
const DEFAULT_MAX_IDENTIFIER_LENGTH = 256;
const DEFAULT_SCALE_BUCKET_FACTOR = 1.25;
const DEFAULT_COORDINATE_PRECISION = 3;

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return resolved;
}

function finitePositive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a finite positive number`);
  }
  return value;
}

function normalizeIdentifier(value: string, maxLength: number, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) {
    throw new RangeError(`${label} has invalid length`);
  }
  return normalized;
}

function normalizeAngle(value: number | undefined): number {
  const numeric = value ?? 0;
  if (!Number.isFinite(numeric)) {
    throw new TypeError("rotation must be finite");
  }
  const normalized = numeric % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

function normalizeTilt(value: number | undefined, dimension: SpatialViewDimension): number {
  if (dimension === "2d") {
    return 0;
  }
  const numeric = value ?? 0;
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 90) {
    throw new RangeError("3d tilt must be between 0 and 90 degrees");
  }
  return numeric;
}

function normalizeTimeExtent(value: SpatialViewTimeExtent | null | undefined): SpatialViewTimeExtent | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!Number.isFinite(value.start) || !Number.isFinite(value.end)) {
    throw new TypeError("time extent bounds must be finite");
  }
  if (value.end < value.start) {
    throw new RangeError("time extent bounds are inverted");
  }
  return Object.freeze({ start: value.start, end: value.end });
}

function scaleBucket(scale: number, factor: number): number {
  if (!Number.isFinite(factor) || factor <= 1) {
    throw new RangeError("scaleBucketFactor must be greater than 1");
  }
  return Math.floor(Math.log(scale) / Math.log(factor));
}

function round(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function roundedExtent(extent: Extent2D, precision: number): Extent2D {
  return Object.freeze({
    xmin: round(extent.xmin, precision),
    ymin: round(extent.ymin, precision),
    xmax: round(extent.xmax, precision),
    ymax: round(extent.ymax, precision),
  });
}

function hash(value: string): string {
  let state = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    state = Math.imul(state ^ value.charCodeAt(index), 16777619);
  }
  return (state >>> 0).toString(16).padStart(8, "0");
}

export function createSpatialViewQueryStateCoordinator(
  options: SpatialViewQueryStateOptions = {},
): SpatialViewQueryStateCoordinator {
  const maxViews = positiveInteger(options.maxViews, DEFAULT_MAX_VIEWS, "maxViews");
  const maxVisibleLayers = positiveInteger(
    options.maxVisibleLayers,
    DEFAULT_MAX_VISIBLE_LAYERS,
    "maxVisibleLayers",
  );
  const maxIdentifierLength = positiveInteger(
    options.maxIdentifierLength,
    DEFAULT_MAX_IDENTIFIER_LENGTH,
    "maxIdentifierLength",
  );
  const factor = options.scaleBucketFactor ?? DEFAULT_SCALE_BUCKET_FACTOR;
  const precision = options.coordinatePrecision ?? DEFAULT_COORDINATE_PRECISION;
  if (!Number.isInteger(precision) || precision < 0 || precision > 9) {
    throw new RangeError("coordinatePrecision must be an integer between 0 and 9");
  }

  const views = new Map<string, SpatialViewQueryState>();
  const layerRevisions = new Map<string, number>();
  let coordinatorRevision = 0;

  const normalizedLayers = (values: readonly string[]): readonly string[] => {
    if (values.length > maxVisibleLayers) {
      throw new RangeError("visible layer set exceeds configured budget");
    }
    const unique = new Set<string>();
    for (const value of values) {
      unique.add(normalizeIdentifier(value, maxIdentifierLength, "layer id"));
    }
    return Object.freeze([...unique].sort());
  };

  const targetExtent = (
    extentInput: Extent2D,
    source: NormalizedSpatialReference,
  ): Readonly<{ extent: Extent2D; spatialReference: NormalizedSpatialReference }> => {
    const extent = normalizeExtent(extentInput);
    const target = options.targetSpatialReference;
    if (!target) {
      return Object.freeze({ extent, spatialReference: source });
    }
    if (spatialReferencesEquivalent(source, target)) {
      return Object.freeze({ extent, spatialReference: target });
    }
    if (options.projectToTarget !== true) {
      throw new TypeError("view state spatial reference does not match configured target");
    }
    return Object.freeze({
      extent: projectExtent(extent, source, target),
      spatialReference: target,
    });
  };

  const fingerprint = (
    input: Omit<SpatialViewQueryState, "fingerprint" | "revision">,
  ): string => {
    const revisions = input.visibleLayerIds.map(
      (layerId) => layerRevisions.get(layerId) ?? 0,
    );
    return hash(
      JSON.stringify({
        extent: input.extent,
        spatialReference: input.spatialReference.key,
        scaleBucket: input.scaleBucket,
        visibleLayerIds: input.visibleLayerIds,
        layerRevisions: revisions,
        timeExtent: input.timeExtent,
      }),
    );
  };

  const get = (viewId: string): SpatialViewQueryState | undefined =>
    views.get(normalizeIdentifier(viewId, maxIdentifierLength, "view id"));

  const upsert = (input: SpatialViewQueryStateInput): SpatialViewQueryState => {
    const viewId = normalizeIdentifier(input.viewId, maxIdentifierLength, "view id");
    if (!views.has(viewId) && views.size >= maxViews) {
      throw new RangeError("view-state coordinator exceeds configured view budget");
    }
    const scale = finitePositive(input.scale, "scale");
    const transformed = targetExtent(input.extent, input.spatialReference);
    const layers = normalizedLayers(input.visibleLayerIds);
    const base = Object.freeze({
      viewId,
      dimension: input.dimension,
      extent: roundedExtent(transformed.extent, precision),
      spatialReference: transformed.spatialReference,
      scale,
      scaleBucket: scaleBucket(scale, factor),
      visibleLayerIds: layers,
      rotation: normalizeAngle(input.rotation),
      tilt: normalizeTilt(input.tilt, input.dimension),
      timeExtent: normalizeTimeExtent(input.timeExtent),
    });
    const nextFingerprint = fingerprint(base);
    const previous = views.get(viewId);
    if (previous?.fingerprint === nextFingerprint) {
      return previous;
    }
    coordinatorRevision += 1;
    const next = Object.freeze({
      ...base,
      revision: coordinatorRevision,
      fingerprint: nextFingerprint,
    });
    views.set(viewId, next);
    return next;
  };

  const remove = (viewId: string): boolean => {
    const normalized = normalizeIdentifier(viewId, maxIdentifierLength, "view id");
    const removed = views.delete(normalized);
    if (removed) {
      coordinatorRevision += 1;
    }
    return removed;
  };

  const invalidateLayer = (layerId: string): number => {
    const normalized = normalizeIdentifier(layerId, maxIdentifierLength, "layer id");
    const revision = (layerRevisions.get(normalized) ?? 0) + 1;
    layerRevisions.set(normalized, revision);
    let affected = 0;
    for (const [viewId, current] of views) {
      if (!current.visibleLayerIds.includes(normalized)) {
        continue;
      }
      affected += 1;
      coordinatorRevision += 1;
      const base = {
        viewId: current.viewId,
        dimension: current.dimension,
        extent: current.extent,
        spatialReference: current.spatialReference,
        scale: current.scale,
        scaleBucket: current.scaleBucket,
        visibleLayerIds: current.visibleLayerIds,
        rotation: current.rotation,
        tilt: current.tilt,
        timeExtent: current.timeExtent,
      };
      views.set(
        viewId,
        Object.freeze({
          ...base,
          revision: coordinatorRevision,
          fingerprint: fingerprint(base),
        }),
      );
    }
    return affected;
  };

  const snapshot = (): SpatialViewQueryStateSnapshot => {
    const revisionRecord: Record<string, number> = Object.create(null) as Record<string, number>;
    for (const [key, value] of [...layerRevisions.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      revisionRecord[key] = value;
    }
    return Object.freeze({
      revision: coordinatorRevision,
      views: Object.freeze(
        [...views.values()].sort((left, right) => left.viewId.localeCompare(right.viewId)),
      ),
      layerRevisions: Object.freeze(revisionRecord),
    });
  };

  const querySignature = (viewId: string): string => {
    const state = get(viewId);
    if (!state) {
      throw new RangeError("view state is not registered");
    }
    return state.fingerprint;
  };

  const queryEquivalent = (leftViewId: string, rightViewId: string): boolean => {
    const left = get(leftViewId);
    const right = get(rightViewId);
    if (!left || !right) {
      return false;
    }
    return left.fingerprint === right.fingerprint;
  };

  const clear = (): void => {
    if (views.size === 0 && layerRevisions.size === 0) {
      return;
    }
    views.clear();
    layerRevisions.clear();
    coordinatorRevision += 1;
  };

  return Object.freeze({
    get,
    upsert,
    remove,
    invalidateLayer,
    snapshot,
    querySignature,
    queryEquivalent,
    clear,
  });
}
