export interface SpatialLayerEpochIdentity {
  readonly serviceId: string;
  readonly layerId: number;
}

export interface SpatialLayerEpochToken extends SpatialLayerEpochIdentity {
  readonly version: number;
}

export interface SpatialLayerEpochRegistryPolicy {
  readonly maxLayers: number;
}

export interface SpatialLayerEpochRegistrySnapshot {
  readonly trackedLayers: number;
  readonly captures: number;
  readonly advances: number;
  readonly evictions: number;
  readonly removals: number;
  readonly invalidTokens: number;
  readonly generation: number;
}

interface LayerEpochEntry {
  readonly key: string;
  readonly serviceId: string;
  readonly layerId: number;
  version: number;
  accessSequence: number;
}

const DEFAULT_POLICY: SpatialLayerEpochRegistryPolicy = Object.freeze({
  maxLayers: 4096,
});

const normalizeServiceId = (value: string): string => {
  const normalized = value.trim();
  if (!normalized) throw new TypeError('serviceId is required');
  if (normalized.length > 512) throw new RangeError('serviceId must not exceed 512 characters');
  return normalized;
};

const normalizeLayerId = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('layerId must be a non-negative safe integer');
  }
  return value;
};

const layerKey = (serviceId: string, layerId: number): string => `${serviceId}::${layerId}`;

const normalizeMaxLayers = (value: number): number => {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 100_000) {
    throw new RangeError('maxLayers must be a positive safe integer no greater than 100000');
  }
  return value;
};

export const normalizeSpatialLayerEpochRegistryPolicy = (
  policy: Partial<SpatialLayerEpochRegistryPolicy> = {},
): SpatialLayerEpochRegistryPolicy => Object.freeze({
  maxLayers: normalizeMaxLayers(policy.maxLayers ?? DEFAULT_POLICY.maxLayers),
});

/**
 * Tracks a bounded mutation generation for each service/layer pair.
 *
 * Query work captures a token immediately before executing. A mutation advances
 * the layer generation. Results are accepted only while the captured token is
 * current, which prevents a slow pre-mutation response from being written into
 * the cache after an edit/schema change even when the underlying transport does
 * not observe cancellation promptly.
 */
export const createSpatialLayerEpochRegistry = (
  policyInput: Partial<SpatialLayerEpochRegistryPolicy> = {},
): Readonly<{
  capture(identity: SpatialLayerEpochIdentity): SpatialLayerEpochToken;
  advance(identity: SpatialLayerEpochIdentity): SpatialLayerEpochToken;
  isCurrent(token: SpatialLayerEpochToken): boolean;
  remove(identity: SpatialLayerEpochIdentity): boolean;
  clear(): number;
  snapshot(): SpatialLayerEpochRegistrySnapshot;
}> => {
  const policy = normalizeSpatialLayerEpochRegistryPolicy(policyInput);
  const entries = new Map<string, LayerEpochEntry>();
  let versionSequence = 0;
  let accessSequence = 0;
  let captures = 0;
  let advances = 0;
  let evictions = 0;
  let removals = 0;
  let invalidTokens = 0;
  let generation = 0;

  const nextVersion = (): number => {
    if (versionSequence >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError('spatial layer epoch sequence exhausted');
    }
    versionSequence += 1;
    return versionSequence;
  };

  const nextAccessSequence = (): number => {
    if (accessSequence >= Number.MAX_SAFE_INTEGER) {
      accessSequence = 0;
      for (const entry of entries.values()) {
        entry.accessSequence = ++accessSequence;
      }
    }
    accessSequence += 1;
    return accessSequence;
  };

  const normalizedIdentity = (identity: SpatialLayerEpochIdentity): Readonly<{
    serviceId: string;
    layerId: number;
    key: string;
  }> => {
    const serviceId = normalizeServiceId(identity.serviceId);
    const layerId = normalizeLayerId(identity.layerId);
    return Object.freeze({ serviceId, layerId, key: layerKey(serviceId, layerId) });
  };

  const evictOne = (): void => {
    let victim: LayerEpochEntry | undefined;
    for (const candidate of entries.values()) {
      if (
        !victim ||
        candidate.accessSequence < victim.accessSequence ||
        (candidate.accessSequence === victim.accessSequence && candidate.key.localeCompare(victim.key) < 0)
      ) {
        victim = candidate;
      }
    }
    if (!victim) return;
    entries.delete(victim.key);
    evictions += 1;
    generation += 1;
  };

  const ensureEntry = (identity: SpatialLayerEpochIdentity): LayerEpochEntry => {
    const normalized = normalizedIdentity(identity);
    const existing = entries.get(normalized.key);
    if (existing) {
      existing.accessSequence = nextAccessSequence();
      return existing;
    }
    while (entries.size >= policy.maxLayers) evictOne();
    const entry: LayerEpochEntry = {
      key: normalized.key,
      serviceId: normalized.serviceId,
      layerId: normalized.layerId,
      version: nextVersion(),
      accessSequence: nextAccessSequence(),
    };
    entries.set(entry.key, entry);
    generation += 1;
    return entry;
  };

  const tokenFor = (entry: LayerEpochEntry): SpatialLayerEpochToken => Object.freeze({
    serviceId: entry.serviceId,
    layerId: entry.layerId,
    version: entry.version,
  });

  const capture = (identity: SpatialLayerEpochIdentity): SpatialLayerEpochToken => {
    const entry = ensureEntry(identity);
    captures += 1;
    return tokenFor(entry);
  };

  const advance = (identity: SpatialLayerEpochIdentity): SpatialLayerEpochToken => {
    const entry = ensureEntry(identity);
    entry.version = nextVersion();
    entry.accessSequence = nextAccessSequence();
    advances += 1;
    generation += 1;
    return tokenFor(entry);
  };

  const isCurrent = (token: SpatialLayerEpochToken): boolean => {
    let normalized: Readonly<{ serviceId: string; layerId: number; key: string }>;
    try {
      normalized = normalizedIdentity(token);
    } catch {
      invalidTokens += 1;
      return false;
    }
    if (!Number.isSafeInteger(token.version) || token.version <= 0) {
      invalidTokens += 1;
      return false;
    }
    const entry = entries.get(normalized.key);
    const current = Boolean(entry && entry.version === token.version);
    if (!current) invalidTokens += 1;
    if (entry) entry.accessSequence = nextAccessSequence();
    return current;
  };

  const remove = (identity: SpatialLayerEpochIdentity): boolean => {
    const normalized = normalizedIdentity(identity);
    const removed = entries.delete(normalized.key);
    if (removed) {
      removals += 1;
      generation += 1;
    }
    return removed;
  };

  const clear = (): number => {
    const count = entries.size;
    if (count === 0) return 0;
    entries.clear();
    removals += count;
    generation += 1;
    return count;
  };

  const snapshot = (): SpatialLayerEpochRegistrySnapshot => Object.freeze({
    trackedLayers: entries.size,
    captures,
    advances,
    evictions,
    removals,
    invalidTokens,
    generation,
  });

  return Object.freeze({ capture, advance, isCurrent, remove, clear, snapshot });
};
