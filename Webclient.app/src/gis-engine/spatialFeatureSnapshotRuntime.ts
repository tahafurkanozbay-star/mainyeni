import {
  type ArcGisAttributes,
  type SpatialFeature,
  type SpatialFeatureIntegrityOptions,
  inspectSpatialFeatures,
  spatialFeatureCollectionExtent,
} from "./spatialReferenceFeatureRuntime";
import type { Extent2D, NormalizedSpatialReference } from "./spatialReferenceRuntime";

export type SpatialFeatureIdentity = string | number;

export interface SpatialFeatureSnapshot {
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly features: readonly SpatialFeature[];
  readonly ids: readonly SpatialFeatureIdentity[];
  readonly size: number;
  readonly estimatedBytes: number;
  readonly spatialReference: NormalizedSpatialReference | null;
  readonly extent: Extent2D | null;
}

export interface SpatialFeatureSnapshotDelta {
  readonly upsert?: readonly SpatialFeature[];
  readonly deleteIds?: readonly SpatialFeatureIdentity[];
}

export interface SpatialFeatureSnapshotChange {
  readonly revision: number;
  readonly inserted: number;
  readonly updated: number;
  readonly deleted: number;
  readonly unchanged: number;
  readonly snapshot: SpatialFeatureSnapshot;
}

export interface SpatialFeatureSnapshotStoreOptions extends SpatialFeatureIntegrityOptions {
  readonly maxSnapshotFeatures?: number;
  readonly maxDeltaFeatures?: number;
  readonly maxEstimatedBytes?: number;
  readonly now?: () => number;
}

export interface SpatialFeatureSnapshotStore {
  readonly snapshot: () => SpatialFeatureSnapshot;
  readonly get: (id: SpatialFeatureIdentity) => SpatialFeature | undefined;
  readonly has: (id: SpatialFeatureIdentity) => boolean;
  readonly replace: (
    features: readonly SpatialFeature[],
    signal?: AbortSignal,
  ) => SpatialFeatureSnapshotChange;
  readonly applyDelta: (
    delta: SpatialFeatureSnapshotDelta,
    signal?: AbortSignal,
  ) => SpatialFeatureSnapshotChange;
  readonly clear: () => SpatialFeatureSnapshotChange;
}

const DEFAULT_MAX_SNAPSHOT_FEATURES = 100_000;
const DEFAULT_MAX_DELTA_FEATURES = 25_000;
const DEFAULT_MAX_ESTIMATED_BYTES = 128 * 1024 * 1024;

function positiveBudget(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return resolved;
}

function abortError(reason?: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }
  const error = new Error("spatial feature snapshot operation aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortError(signal.reason);
  }
}

function identityKey(id: SpatialFeatureIdentity): string {
  if (typeof id === "number") {
    if (!Number.isSafeInteger(id)) {
      throw new TypeError("snapshot identity number must be a safe integer");
    }
    return `n:${id}`;
  }
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new TypeError("snapshot identity string must be non-empty");
  }
  return `s:${id}`;
}

function compareIdentities(left: SpatialFeatureIdentity, right: SpatialFeatureIdentity): number {
  const leftKey = identityKey(left);
  const rightKey = identityKey(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function estimateScalarBytes(value: string | number | boolean | null): number {
  if (value === null) {
    return 4;
  }
  if (typeof value === "string") {
    return value.length * 2;
  }
  return 8;
}

function estimateAttributesBytes(attributes: ArcGisAttributes): number {
  let bytes = 0;
  for (const [key, value] of Object.entries(attributes)) {
    bytes += key.length * 2;
    bytes += estimateScalarBytes(value);
  }
  return bytes;
}

function geometryCoordinateCount(feature: SpatialFeature): number {
  const geometry = feature.geometry;
  switch (geometry.type) {
    case "point":
      return 1;
    case "extent":
      return 2;
    case "multipoint":
      return geometry.points.length;
    case "polyline":
      return geometry.paths.reduce((sum, path) => sum + path.length, 0);
    case "polygon":
      return geometry.rings.reduce((sum, ring) => sum + ring.length, 0);
  }
}

function estimateFeatureBytes(feature: SpatialFeature): number {
  const identityBytes =
    typeof feature.id === "string" ? feature.id.length * 2 : 8;
  const coordinateBytes = geometryCoordinateCount(feature) * 16;
  return Math.max(64, identityBytes + coordinateBytes + estimateAttributesBytes(feature.attributes));
}

function featureFingerprint(feature: SpatialFeature): string {
  const geometry = feature.geometry;
  const geometryValue =
    geometry.type === "point"
      ? [geometry.x, geometry.y]
      : geometry.type === "extent"
        ? geometry.extent
        : geometry.type === "multipoint"
          ? geometry.points
          : geometry.type === "polyline"
            ? geometry.paths
            : geometry.rings;
  return JSON.stringify([
    identityKey(feature.id),
    geometry.type,
    geometry.spatialReference.key,
    geometryValue,
    feature.attributes,
  ]);
}

function sameFeature(left: SpatialFeature, right: SpatialFeature): boolean {
  if (left === right) {
    return true;
  }
  return featureFingerprint(left) === featureFingerprint(right);
}

export function createSpatialFeatureSnapshotStore(
  options: SpatialFeatureSnapshotStoreOptions = {},
): SpatialFeatureSnapshotStore {
  const maxSnapshotFeatures = positiveBudget(
    options.maxSnapshotFeatures,
    DEFAULT_MAX_SNAPSHOT_FEATURES,
    "maxSnapshotFeatures",
  );
  const maxDeltaFeatures = positiveBudget(
    options.maxDeltaFeatures,
    DEFAULT_MAX_DELTA_FEATURES,
    "maxDeltaFeatures",
  );
  const maxEstimatedBytes = positiveBudget(
    options.maxEstimatedBytes,
    DEFAULT_MAX_ESTIMATED_BYTES,
    "maxEstimatedBytes",
  );
  const now = options.now ?? Date.now;

  const integrityOptions: SpatialFeatureIntegrityOptions = {
    ...options,
    maxFeatures: Math.min(options.maxFeatures ?? maxSnapshotFeatures, maxSnapshotFeatures),
    rejectDuplicateIds: true,
    rejectInvalidFeatures: true,
  };

  const index = new Map<string, SpatialFeature>();
  let createdAt = now();
  let updatedAt = createdAt;
  let revision = 0;

  const buildSnapshot = (
    source: ReadonlyMap<string, SpatialFeature>,
    snapshotRevision = revision,
    snapshotUpdatedAt = updatedAt,
  ): SpatialFeatureSnapshot => {
    const features = [...source.values()].sort((left, right) =>
      compareIdentities(left.id, right.id),
    );
    let estimatedBytes = 0;
    for (const feature of features) {
      estimatedBytes += estimateFeatureBytes(feature);
      if (estimatedBytes > maxEstimatedBytes) {
        throw new RangeError("snapshot estimated-byte budget exceeded");
      }
    }

    let spatialReference: NormalizedSpatialReference | null = null;
    let extent: Extent2D | null = null;
    if (features.length > 0) {
      const collection = spatialFeatureCollectionExtent(features, integrityOptions);
      spatialReference = collection.spatialReference;
      extent = collection.extent;
    }

    return Object.freeze({
      revision: snapshotRevision,
      createdAt,
      updatedAt: snapshotUpdatedAt,
      features: Object.freeze(features),
      ids: Object.freeze(features.map((feature) => feature.id)),
      size: features.length,
      estimatedBytes,
      spatialReference,
      extent,
    });
  };

  let current = buildSnapshot(index);

  const commit = (
    staged: ReadonlyMap<string, SpatialFeature>,
    inserted: number,
    updated: number,
    deleted: number,
    unchanged: number,
  ): SpatialFeatureSnapshotChange => {
    const nextRevision = revision + 1;
    const nextUpdatedAt = now();
    const nextSnapshot = buildSnapshot(staged, nextRevision, nextUpdatedAt);

    index.clear();
    for (const [key, feature] of staged) {
      index.set(key, feature);
    }
    revision = nextRevision;
    updatedAt = nextUpdatedAt;
    current = nextSnapshot;

    return Object.freeze({
      revision,
      inserted,
      updated,
      deleted,
      unchanged,
      snapshot: current,
    });
  };

  const snapshot = (): SpatialFeatureSnapshot => current;

  const get = (id: SpatialFeatureIdentity): SpatialFeature | undefined =>
    index.get(identityKey(id));

  const has = (id: SpatialFeatureIdentity): boolean => index.has(identityKey(id));

  const replace = (
    features: readonly SpatialFeature[],
    signal?: AbortSignal,
  ): SpatialFeatureSnapshotChange => {
    throwIfAborted(signal);
    if (features.length > maxSnapshotFeatures) {
      throw new RangeError("replacement exceeds snapshot feature budget");
    }
    const normalized = inspectSpatialFeatures(features, {
      ...integrityOptions,
      ...(signal === undefined ? {} : { signal }),
    });
    const next = new Map<string, SpatialFeature>();
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;

    for (const feature of normalized.features) {
      throwIfAborted(signal);
      const key = identityKey(feature.id);
      const previous = index.get(key);
      next.set(key, feature);
      if (!previous) {
        inserted += 1;
      } else if (sameFeature(previous, feature)) {
        unchanged += 1;
      } else {
        updated += 1;
      }
    }

    let deleted = 0;
    for (const key of index.keys()) {
      if (!next.has(key)) {
        deleted += 1;
      }
    }

    return commit(next, inserted, updated, deleted, unchanged);
  };

  const applyDelta = (
    delta: SpatialFeatureSnapshotDelta,
    signal?: AbortSignal,
  ): SpatialFeatureSnapshotChange => {
    throwIfAborted(signal);
    const upsert = delta.upsert ?? [];
    const deleteIds = delta.deleteIds ?? [];
    if (upsert.length + deleteIds.length > maxDeltaFeatures) {
      throw new RangeError("snapshot delta exceeds configured operation budget");
    }

    const normalized = inspectSpatialFeatures(upsert, {
      ...integrityOptions,
      maxFeatures: Math.min(maxDeltaFeatures, maxSnapshotFeatures),
      ...(signal === undefined ? {} : { signal }),
    });

    const staged = new Map(index);
    let inserted = 0;
    let updated = 0;
    let deleted = 0;
    let unchanged = 0;

    const deleteKeys = new Set<string>();
    for (const id of deleteIds) {
      throwIfAborted(signal);
      const key = identityKey(id);
      if (deleteKeys.has(key)) {
        continue;
      }
      deleteKeys.add(key);
      if (staged.delete(key)) {
        deleted += 1;
      }
    }

    for (const feature of normalized.features) {
      throwIfAborted(signal);
      const key = identityKey(feature.id);
      const previous = staged.get(key);
      if (!previous) {
        staged.set(key, feature);
        inserted += 1;
      } else if (sameFeature(previous, feature)) {
        unchanged += 1;
      } else {
        staged.set(key, feature);
        updated += 1;
      }
    }

    if (staged.size > maxSnapshotFeatures) {
      throw new RangeError("snapshot feature budget exceeded after delta");
    }

    return commit(staged, inserted, updated, deleted, unchanged);
  };

  const clear = (): SpatialFeatureSnapshotChange => {
    const deleted = index.size;
    return commit(new Map<string, SpatialFeature>(), 0, 0, deleted, 0);
  };

  return Object.freeze({
    snapshot,
    get,
    has,
    replace,
    applyDelta,
    clear,
  });
}
