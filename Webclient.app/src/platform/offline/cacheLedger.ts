import type {
  OfflineCacheLedgerSnapshot,
  OfflineCacheLimits,
  OfflineCacheRecord,
  OfflineRequestKind,
} from './contracts';

interface MutableRecord {
  key: string;
  kind: Exclude<OfflineRequestKind, 'bypass'>;
  bytes: number;
  measured: boolean;
  createdAt: number;
  accessedAt: number;
  expiresAt: number;
  hits: number;
}

export interface OfflineCacheLedgerOptions {
  readonly limits: OfflineCacheLimits;
  readonly now?: () => number;
}

export interface OfflineCacheLedger {
  readonly get: (key: string) => OfflineCacheRecord | null;
  readonly record: (
    key: string,
    input: {
      readonly kind: Exclude<OfflineRequestKind, 'bypass'>;
      readonly bytes: number;
      readonly measured?: boolean;
      readonly ttlMs?: number;
    },
  ) => OfflineCacheRecord;
  readonly touch: (key: string) => OfflineCacheRecord | null;
  readonly remove: (key: string) => boolean;
  readonly prune: () => readonly string[];
  readonly clear: () => number;
  readonly snapshot: () => OfflineCacheLedgerSnapshot;
  readonly size: () => number;
}

const frozenRecord = (record: MutableRecord): OfflineCacheRecord => Object.freeze({
  key: record.key,
  kind: record.kind,
  bytes: record.bytes,
  measured: record.measured,
  createdAt: record.createdAt,
  accessedAt: record.accessedAt,
  expiresAt: record.expiresAt,
  hits: record.hits,
});

const normalizeKey = (value: unknown): string => {
  const key = String(value ?? '').trim();
  if (!key) throw new TypeError('Offline cache ledger key is required.');
  if (key.length > 4096) throw new TypeError('Offline cache ledger key is too long.');
  return key;
};

const normalizeBytes = (value: unknown, max: number): number => {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.min(parsed, max);
};

export const createOfflineCacheLedger = (
  options: OfflineCacheLedgerOptions,
): OfflineCacheLedger => {
  const now = options.now ?? (() => Date.now());
  const limits = options.limits;
  const records = new Map<string, MutableRecord>();
  let hits = 0;
  let writes = 0;
  let evictions = 0;
  let rejections = 0;

  const totalBytes = (): number => {
    let total = 0;
    for (const record of records.values()) total += record.bytes;
    return total;
  };

  const get = (keyValue: string): OfflineCacheRecord | null => {
    const key = normalizeKey(keyValue);
    const record = records.get(key);
    if (!record) return null;
    if (record.expiresAt <= now()) {
      records.delete(key);
      evictions += 1;
      return null;
    }
    return frozenRecord(record);
  };

  const touch = (keyValue: string): OfflineCacheRecord | null => {
    const key = normalizeKey(keyValue);
    const record = records.get(key);
    if (!record) return null;
    const timestamp = now();
    if (record.expiresAt <= timestamp) {
      records.delete(key);
      evictions += 1;
      return null;
    }
    record.accessedAt = timestamp;
    record.hits += 1;
    hits += 1;
    return frozenRecord(record);
  };

  const record = (
    keyValue: string,
    input: {
      readonly kind: Exclude<OfflineRequestKind, 'bypass'>;
      readonly bytes: number;
      readonly measured?: boolean;
      readonly ttlMs?: number;
    },
  ): OfflineCacheRecord => {
    const key = normalizeKey(keyValue);
    const bytes = normalizeBytes(input.bytes, limits.maxEntryBytes);
    if (Number(input.bytes) > limits.maxEntryBytes) {
      rejections += 1;
      throw new RangeError('Offline cache entry exceeds maxEntryBytes.');
    }
    const timestamp = now();
    const ttlMs = Math.max(1000, Math.min(limits.maxAgeMs, Math.trunc(Number(input.ttlMs) || limits.maxAgeMs)));
    const previous = records.get(key);
    const next: MutableRecord = {
      key,
      kind: input.kind,
      bytes,
      measured: input.measured !== false,
      createdAt: previous?.createdAt ?? timestamp,
      accessedAt: timestamp,
      expiresAt: timestamp + ttlMs,
      hits: previous?.hits ?? 0,
    };
    records.set(key, next);
    writes += 1;
    return frozenRecord(next);
  };

  const remove = (keyValue: string): boolean => records.delete(normalizeKey(keyValue));

  const prune = (): readonly string[] => {
    const timestamp = now();
    const removed: string[] = [];
    for (const [key, record] of records) {
      if (record.expiresAt <= timestamp) {
        records.delete(key);
        removed.push(key);
        evictions += 1;
      }
    }

    const sorted = (): MutableRecord[] => [...records.values()].sort((left, right) =>
      left.accessedAt - right.accessedAt
      || left.createdAt - right.createdAt
      || left.key.localeCompare(right.key));

    while (records.size > limits.maxEntries || totalBytes() > limits.maxBytes) {
      const candidate = sorted()[0];
      if (!candidate) break;
      records.delete(candidate.key);
      removed.push(candidate.key);
      evictions += 1;
    }
    return Object.freeze(removed);
  };

  const clear = (): number => {
    const count = records.size;
    records.clear();
    return count;
  };

  const snapshot = (): OfflineCacheLedgerSnapshot => {
    const values = [...records.values()]
      .sort((left, right) => right.accessedAt - left.accessedAt || left.key.localeCompare(right.key))
      .map(frozenRecord);
    const measuredEntries = values.filter((item) => item.measured).length;
    return Object.freeze({
      entries: values.length,
      bytes: values.reduce((sum, item) => sum + item.bytes, 0),
      measuredEntries,
      unmeasuredEntries: values.length - measuredEntries,
      hits,
      writes,
      evictions,
      rejections,
      records: Object.freeze(values),
    });
  };

  return Object.freeze({
    get,
    record,
    touch,
    remove,
    prune,
    clear,
    snapshot,
    size: () => records.size,
  });
};
