import {
  normalizeStoreRuntimeLimits,
  type StoreRuntimeLimits,
  type StoreStateProjection,
} from './contracts';

export interface EncodedStoreSnapshot {
  readonly schemaVersion: 1;
  readonly generatedAt: number;
  readonly projection: StoreStateProjection;
}

const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isProjection = (value: unknown): value is StoreStateProjection => {
  if (!isRecord(value) || value.schemaVersion !== 1) return false;
  if (!isRecord(value.common) || !isRecord(value.map)) return false;
  if (!isRecord(value.contextMenu) || !isRecord(value.dynamicLayers)) return false;
  if (!Array.isArray(value.common.windows) || !Array.isArray(value.common.services)) return false;
  return true;
};

export const encodeStoreSnapshot = (
  projection: StoreStateProjection,
  limitsInput: Partial<StoreRuntimeLimits> | StoreRuntimeLimits = {},
): string => {
  const limits = normalizeStoreRuntimeLimits(limitsInput);
  const envelope: EncodedStoreSnapshot = Object.freeze({
    schemaVersion: 1,
    generatedAt: projection.generatedAt,
    projection,
  });
  const serialized = JSON.stringify(envelope);
  if (byteLength(serialized) > limits.maxSnapshotBytes) {
    throw Object.assign(new Error('Store snapshot exceeds the configured byte budget.'), {
      code: 'STORE_SNAPSHOT_TOO_LARGE',
    });
  }
  return serialized;
};

export const decodeStoreSnapshot = (
  serialized: string,
  limitsInput: Partial<StoreRuntimeLimits> | StoreRuntimeLimits = {},
  now = Date.now(),
): EncodedStoreSnapshot => {
  const limits = normalizeStoreRuntimeLimits(limitsInput);
  if (typeof serialized !== 'string' || !serialized.trim()) {
    throw Object.assign(new Error('Store snapshot payload is required.'), {
      code: 'STORE_SNAPSHOT_REQUIRED',
    });
  }
  if (byteLength(serialized) > limits.maxSnapshotBytes) {
    throw Object.assign(new Error('Store snapshot exceeds the configured byte budget.'), {
      code: 'STORE_SNAPSHOT_TOO_LARGE',
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw Object.assign(new Error('Store snapshot is not valid JSON.'), {
      code: 'STORE_SNAPSHOT_JSON_INVALID',
    });
  }

  if (!isRecord(parsed) || parsed.schemaVersion !== 1) {
    throw Object.assign(new Error('Unsupported store snapshot schema version.'), {
      code: 'STORE_SNAPSHOT_SCHEMA_UNSUPPORTED',
    });
  }

  const generatedAt = Number(parsed.generatedAt);
  if (!Number.isFinite(generatedAt) || generatedAt < 0) {
    throw Object.assign(new Error('Store snapshot timestamp is invalid.'), {
      code: 'STORE_SNAPSHOT_TIMESTAMP_INVALID',
    });
  }
  if (generatedAt > now + 60_000) {
    throw Object.assign(new Error('Store snapshot timestamp is in the future.'), {
      code: 'STORE_SNAPSHOT_FUTURE',
    });
  }
  if (now - generatedAt > limits.maxSnapshotAgeMs) {
    throw Object.assign(new Error('Store snapshot exceeds the configured maximum age.'), {
      code: 'STORE_SNAPSHOT_EXPIRED',
    });
  }
  if (!isProjection(parsed.projection)) {
    throw Object.assign(new Error('Store snapshot projection shape is invalid.'), {
      code: 'STORE_SNAPSHOT_PROJECTION_INVALID',
    });
  }

  return Object.freeze({
    schemaVersion: 1,
    generatedAt,
    projection: parsed.projection,
  });
};
