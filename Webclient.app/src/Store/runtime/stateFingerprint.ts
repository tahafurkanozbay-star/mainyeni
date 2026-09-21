import type { SafeJsonValue, StoreStateProjection } from './contracts';

const stableSerialize = (value: SafeJsonValue): string => {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((item) => stableSerialize(item)).join(',') + ']';

  const record = value as Readonly<Record<string, SafeJsonValue>>;
  const keys = Object.keys(record).sort((left, right) => left.localeCompare(right, 'en'));
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + stableSerialize(record[key]!)).join(',') + '}';
};

const fnv1a = (value: string): string => {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

export const fingerprintSafeValue = (value: SafeJsonValue): string =>
  fnv1a(stableSerialize(value));

export const fingerprintStoreProjection = (
  projection: StoreStateProjection,
): string => {
  const stable: SafeJsonValue = Object.freeze({
    schemaVersion: projection.schemaVersion,
    common: projection.common,
    map: projection.map,
    contextMenu: projection.contextMenu,
    dynamicLayers: projection.dynamicLayers,
  }) as SafeJsonValue;
  return fingerprintSafeValue(stable);
};

export const stableStoreProjectionText = (
  projection: StoreStateProjection,
): string => stableSerialize(Object.freeze({
  schemaVersion: projection.schemaVersion,
  common: projection.common,
  map: projection.map,
  contextMenu: projection.contextMenu,
  dynamicLayers: projection.dynamicLayers,
}) as SafeJsonValue);
