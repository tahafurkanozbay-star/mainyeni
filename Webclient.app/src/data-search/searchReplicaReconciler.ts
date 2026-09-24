import type { NormalizedRecord } from './contracts';
import {
  hashFingerprint,
  normalizeInteger,
  normalizeSearchText,
  normalizeText,
  stableSerialize,
} from './normalization';
import { haversineDistanceMeters } from './spatialIndex';
import { datasetRecordKey } from './datasetDeltaRuntime';

export const SEARCH_REPLICA_RECONCILER_VERSION = '2026-09-24.v1';

export type ReplicaConflictKind =
  | 'fingerprint-mismatch'
  | 'title-mismatch'
  | 'category-mismatch'
  | 'type-mismatch'
  | 'address-mismatch'
  | 'coordinate-divergence'
  | 'missing-from-source';

export interface SearchReplicaSource {
  readonly key: string;
  readonly priority?: number;
  readonly records: readonly NormalizedRecord[];
}

export interface SearchReplicaReconcilerOptions {
  readonly quorum?: number;
  readonly maxRecords?: number;
  readonly maxConflicts?: number;
  readonly coordinateToleranceMeters?: number;
  readonly includeMissingSourceConflicts?: boolean;
}

export interface ReplicaFieldConflict {
  readonly kind: ReplicaConflictKind;
  readonly recordKey: string;
  readonly sourceKeys: readonly string[];
  readonly canonicalSourceKey: string;
  readonly values: Readonly<Record<string, string | number | null>>;
  readonly severity: 'info' | 'warning' | 'error';
  readonly detail: string;
}

export interface ReconciledReplicaRecord {
  readonly key: string;
  readonly record: NormalizedRecord;
  readonly canonicalSourceKey: string;
  readonly presentInSources: readonly string[];
  readonly agreeingSources: readonly string[];
  readonly conflictingSources: readonly string[];
  readonly quorumMet: boolean;
  readonly conflicts: readonly ReplicaFieldConflict[];
}

export interface SearchReplicaReconciliation {
  readonly version: string;
  readonly sourceCount: number;
  readonly recordCount: number;
  readonly quorum: number;
  readonly quorumMetCount: number;
  readonly conflictRecordCount: number;
  readonly conflictCount: number;
  readonly conflictTruncated: boolean;
  readonly sources: readonly string[];
  readonly records: readonly ReconciledReplicaRecord[];
  readonly conflicts: readonly ReplicaFieldConflict[];
  readonly fingerprint: string;
}

interface NormalizedSource {
  readonly key: string;
  readonly priority: number;
  readonly records: readonly NormalizedRecord[];
}

interface NormalizedOptions {
  readonly quorum: number;
  readonly maxRecords: number;
  readonly maxConflicts: number;
  readonly coordinateToleranceMeters: number;
  readonly includeMissingSourceConflicts: boolean;
}

const normalizeSourceKey = (value: unknown): string => normalizeSearchText(value)
  .replace(/[^a-z0-9._:-]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 120);

const normalizeSources = (sources: readonly SearchReplicaSource[]): readonly NormalizedSource[] => {
  const seen = new Set<string>();
  return Object.freeze(sources.map((source, index) => {
    const key = normalizeSourceKey(source.key);
    if (!key) throw new TypeError(`Replica source at index ${index} has an invalid key.`);
    if (seen.has(key)) throw new Error(`Duplicate replica source key: ${key}`);
    seen.add(key);
    return Object.freeze({
      key,
      priority: normalizeInteger(source.priority, { min: -10_000, max: 10_000, fallback: 100 + index }),
      records: Object.freeze([...source.records]),
    });
  }).sort((left, right) => left.priority - right.priority || left.key.localeCompare(right.key, 'en')));
};

const normalizeOptions = (
  sourceCount: number,
  options: SearchReplicaReconcilerOptions = {},
): NormalizedOptions => Object.freeze({
  quorum: normalizeInteger(options.quorum, {
    min: 1,
    max: Math.max(1, sourceCount),
    fallback: Math.max(1, Math.floor(sourceCount / 2) + 1),
  }),
  maxRecords: normalizeInteger(options.maxRecords, { min: 1, max: 1_000_000, fallback: 100_000 }),
  maxConflicts: normalizeInteger(options.maxConflicts, { min: 0, max: 1_000_000, fallback: 10_000 }),
  coordinateToleranceMeters: normalizeInteger(options.coordinateToleranceMeters, {
    min: 0,
    max: 1_000_000,
    fallback: 25,
  }),
  includeMissingSourceConflicts: options.includeMissingSourceConflicts === true,
});

const fieldValue = (
  record: NormalizedRecord,
  field: 'title' | 'category' | 'type' | 'address',
): string => normalizeSearchText(record[field]);

const uniqueValues = (
  entries: readonly { readonly source: NormalizedSource; readonly record: NormalizedRecord }[],
  field: 'title' | 'category' | 'type' | 'address',
): Map<string, string[]> => {
  const values = new Map<string, string[]>();
  for (const entry of entries) {
    const value = fieldValue(entry.record, field);
    const list = values.get(value) ?? [];
    list.push(entry.source.key);
    values.set(value, list);
  }
  return values;
};

const valueMap = (
  entries: readonly { readonly source: NormalizedSource; readonly record: NormalizedRecord }[],
  value: (record: NormalizedRecord) => string | number | null,
): Readonly<Record<string, string | number | null>> => Object.freeze(entries.reduce<Record<string, string | number | null>>(
  (result, entry) => {
    result[entry.source.key] = value(entry.record);
    return result;
  },
  {},
));

const createTextConflict = (
  kind: ReplicaConflictKind,
  field: 'title' | 'category' | 'type' | 'address',
  recordKey: string,
  canonicalSourceKey: string,
  entries: readonly { readonly source: NormalizedSource; readonly record: NormalizedRecord }[],
): ReplicaFieldConflict | null => {
  const values = uniqueValues(entries, field);
  if (values.size <= 1) return null;
  return Object.freeze({
    kind,
    recordKey,
    sourceKeys: Object.freeze(entries.map(entry => entry.source.key)),
    canonicalSourceKey,
    values: valueMap(entries, record => normalizeText(record[field])),
    severity: field === 'category' || field === 'type' ? 'warning' : 'info',
    detail: `Replica field ${field} differs across ${values.size} canonicalized value(s).`,
  });
};

const createFingerprintConflict = (
  recordKey: string,
  canonicalSourceKey: string,
  entries: readonly { readonly source: NormalizedSource; readonly record: NormalizedRecord }[],
): ReplicaFieldConflict | null => {
  const values = new Set(entries.map(entry => entry.record.fingerprint));
  if (values.size <= 1) return null;
  return Object.freeze({
    kind: 'fingerprint-mismatch' as const,
    recordKey,
    sourceKeys: Object.freeze(entries.map(entry => entry.source.key)),
    canonicalSourceKey,
    values: valueMap(entries, record => record.fingerprint),
    severity: 'warning' as const,
    detail: `Replica record fingerprints differ across ${values.size} version(s).`,
  });
};

const createCoordinateConflict = (
  recordKey: string,
  canonicalSourceKey: string,
  entries: readonly { readonly source: NormalizedSource; readonly record: NormalizedRecord }[],
  toleranceMeters: number,
): ReplicaFieldConflict | null => {
  const geocoded = entries.filter(entry => entry.record.coordinates !== null);
  if (geocoded.length <= 1) return null;
  let maxDistance = 0;
  for (let left = 0; left < geocoded.length; left += 1) {
    for (let right = left + 1; right < geocoded.length; right += 1) {
      const a = geocoded[left]?.record.coordinates;
      const b = geocoded[right]?.record.coordinates;
      if (!a || !b) continue;
      const distance = haversineDistanceMeters(a, b);
      if (distance !== null) maxDistance = Math.max(maxDistance, distance);
    }
  }
  if (maxDistance <= toleranceMeters) return null;
  return Object.freeze({
    kind: 'coordinate-divergence' as const,
    recordKey,
    sourceKeys: Object.freeze(geocoded.map(entry => entry.source.key)),
    canonicalSourceKey,
    values: valueMap(entries, record => record.coordinates
      ? `${record.coordinates.latitude},${record.coordinates.longitude}`
      : null),
    severity: 'error' as const,
    detail: `Replica coordinates diverge by up to ${Math.round(maxDistance)}m, beyond ${toleranceMeters}m tolerance.`,
  });
};

const createMissingConflict = (
  recordKey: string,
  canonicalSourceKey: string,
  present: readonly string[],
  allSources: readonly string[],
): ReplicaFieldConflict | null => {
  const presentSet = new Set(present);
  const missing = allSources.filter(source => !presentSet.has(source));
  if (missing.length === 0) return null;
  const values = allSources.reduce<Record<string, string>>((result, source) => {
    result[source] = presentSet.has(source) ? 'present' : 'missing';
    return result;
  }, {});
  return Object.freeze({
    kind: 'missing-from-source' as const,
    recordKey,
    sourceKeys: Object.freeze([...allSources]),
    canonicalSourceKey,
    values: Object.freeze(values),
    severity: 'info' as const,
    detail: `Record is absent from ${missing.length} replica source(s): ${missing.join(', ')}.`,
  });
};

const isAgreementConflict = (conflict: ReplicaFieldConflict): boolean =>
  conflict.kind === 'fingerprint-mismatch'
  || conflict.kind === 'category-mismatch'
  || conflict.kind === 'type-mismatch'
  || conflict.kind === 'coordinate-divergence';

export const reconcileSearchReplicas = (
  sourceInput: readonly SearchReplicaSource[],
  options: SearchReplicaReconcilerOptions = {},
): SearchReplicaReconciliation => {
  const sources = normalizeSources(sourceInput);
  const normalizedOptions = normalizeOptions(sources.length, options);
  const allSourceKeys = Object.freeze(sources.map(source => source.key));
  const byRecord = new Map<string, Array<{ source: NormalizedSource; record: NormalizedRecord }>>();
  for (const source of sources) {
    const seenInSource = new Set<string>();
    for (const record of source.records) {
      const key = datasetRecordKey(record);
      if (seenInSource.has(key)) continue;
      seenInSource.add(key);
      const entries = byRecord.get(key) ?? [];
      entries.push({ source, record });
      byRecord.set(key, entries);
      if (byRecord.size > normalizedOptions.maxRecords) {
        throw new RangeError(`Replica reconciliation record budget ${normalizedOptions.maxRecords} exceeded.`);
      }
    }
  }

  const records: ReconciledReplicaRecord[] = [];
  const allConflicts: ReplicaFieldConflict[] = [];
  let conflictTruncated = false;
  const keys = Array.from(byRecord.keys()).sort((left, right) => left.localeCompare(right, 'en'));
  for (const key of keys) {
    const entries = (byRecord.get(key) ?? [])
      .sort((left, right) => left.source.priority - right.source.priority || left.source.key.localeCompare(right.source.key, 'en'));
    const canonical = entries[0];
    if (!canonical) continue;
    const conflicts: ReplicaFieldConflict[] = [];
    const candidates = [
      createFingerprintConflict(key, canonical.source.key, entries),
      createTextConflict('title-mismatch', 'title', key, canonical.source.key, entries),
      createTextConflict('category-mismatch', 'category', key, canonical.source.key, entries),
      createTextConflict('type-mismatch', 'type', key, canonical.source.key, entries),
      createTextConflict('address-mismatch', 'address', key, canonical.source.key, entries),
      createCoordinateConflict(key, canonical.source.key, entries, normalizedOptions.coordinateToleranceMeters),
      normalizedOptions.includeMissingSourceConflicts
        ? createMissingConflict(key, canonical.source.key, entries.map(entry => entry.source.key), allSourceKeys)
        : null,
    ];
    for (const conflict of candidates) {
      if (!conflict) continue;
      conflicts.push(conflict);
      if (allConflicts.length < normalizedOptions.maxConflicts) allConflicts.push(conflict);
      else conflictTruncated = true;
    }
    const agreeingSources = entries
      .filter(entry => entry.record.fingerprint === canonical.record.fingerprint)
      .map(entry => entry.source.key);
    const conflictingSources = entries
      .filter(entry => entry.record.fingerprint !== canonical.record.fingerprint)
      .map(entry => entry.source.key);
    const quorumMet = agreeingSources.length >= normalizedOptions.quorum
      && !conflicts.some(conflict => conflict.severity === 'error' && isAgreementConflict(conflict));
    records.push(Object.freeze({
      key,
      record: canonical.record,
      canonicalSourceKey: canonical.source.key,
      presentInSources: Object.freeze(entries.map(entry => entry.source.key)),
      agreeingSources: Object.freeze(agreeingSources),
      conflictingSources: Object.freeze(conflictingSources),
      quorumMet,
      conflicts: Object.freeze(conflicts),
    }));
  }

  const frozenRecords = Object.freeze(records);
  const frozenConflicts = Object.freeze(allConflicts);
  const fingerprint = hashFingerprint(stableSerialize({
    version: SEARCH_REPLICA_RECONCILER_VERSION,
    sources: allSourceKeys,
    quorum: normalizedOptions.quorum,
    records: frozenRecords.map(record => ({
      key: record.key,
      canonicalSourceKey: record.canonicalSourceKey,
      fingerprint: record.record.fingerprint,
      quorumMet: record.quorumMet,
      conflicts: record.conflicts.map(conflict => conflict.kind),
    })),
  }));
  return Object.freeze({
    version: SEARCH_REPLICA_RECONCILER_VERSION,
    sourceCount: sources.length,
    recordCount: frozenRecords.length,
    quorum: normalizedOptions.quorum,
    quorumMetCount: frozenRecords.filter(record => record.quorumMet).length,
    conflictRecordCount: frozenRecords.filter(record => record.conflicts.length > 0).length,
    conflictCount: frozenConflicts.length,
    conflictTruncated,
    sources: allSourceKeys,
    records: frozenRecords,
    conflicts: frozenConflicts,
    fingerprint,
  });
};

export const selectQuorumRecords = (
  reconciliation: SearchReplicaReconciliation,
): readonly NormalizedRecord[] => Object.freeze(reconciliation.records
  .filter(record => record.quorumMet)
  .map(record => record.record));

export const summarizeReplicaConflicts = (
  reconciliation: SearchReplicaReconciliation,
): Readonly<Record<ReplicaConflictKind, number>> => {
  const result: Record<ReplicaConflictKind, number> = {
    'fingerprint-mismatch': 0,
    'title-mismatch': 0,
    'category-mismatch': 0,
    'type-mismatch': 0,
    'address-mismatch': 0,
    'coordinate-divergence': 0,
    'missing-from-source': 0,
  };
  for (const conflict of reconciliation.conflicts) result[conflict.kind] += 1;
  return Object.freeze(result);
};