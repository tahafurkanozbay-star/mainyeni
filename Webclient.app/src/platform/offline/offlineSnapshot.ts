export const OFFLINE_SNAPSHOT_VERSION = 1 as const;

export interface OfflineSnapshotMutation {
  readonly id: string;
  readonly owner: string;
  readonly operation: string;
  readonly payload: unknown;
  readonly priority: 'critical' | 'interactive' | 'background';
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly maxAttempts: number;
  readonly dedupeKey?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface OfflineSnapshotV1 {
  readonly version: typeof OFFLINE_SNAPSHOT_VERSION;
  readonly writtenAt: number;
  readonly mutations: readonly OfflineSnapshotMutation[];
}

export interface OfflineSnapshotCodecOptions {
  readonly maxEntries?: number;
  readonly maxSnapshotBytes?: number;
  readonly maxPayloadBytes?: number;
  readonly maxMetadataEntries?: number;
  readonly maxMetadataValueLength?: number;
  readonly maxTextLength?: number;
  readonly maxAgeMs?: number;
  readonly clock?: () => number;
}

export interface OfflineSnapshotDecodeResult {
  readonly snapshot: OfflineSnapshotV1;
  readonly droppedExpired: number;
  readonly droppedDuplicate: number;
}

const encoder = new TextEncoder();

const integer = (name: string, value: number, min: number, max: number): number => {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
};

const finite = (name: string, value: number, min: number, max: number): number => {
  if (!Number.isFinite(value) || value < min || value > max) throw new RangeError(`${name} must be between ${min} and ${max}`);
  return value;
};

const hasControlCodePoint = (value: string): boolean => {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) return true;
  }
  return false;
};

const text = (name: string, value: unknown, maxLength: number): string => {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || hasControlCodePoint(normalized)) {
    throw new TypeError(`${name} must be bounded printable text`);
  }
  return normalized;
};

const plainRecord = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const clonePlainData = (value: unknown, depth = 0, seen = new Set<object>()): unknown => {
  if (depth > 24) throw new RangeError('offline snapshot payload nesting exceeds 24 levels');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('offline snapshot payload numbers must be finite');
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError('offline snapshot payload must not contain cycles');
    seen.add(value);
    const clone = value.map(item => clonePlainData(item, depth + 1, seen));
    seen.delete(value);
    return clone;
  }
  if (plainRecord(value)) {
    if (seen.has(value)) throw new TypeError('offline snapshot payload must not contain cycles');
    seen.add(value);
    const clone: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new TypeError('unsafe payload key');
      clone[key] = clonePlainData(item, depth + 1, seen);
    }
    seen.delete(value);
    return clone;
  }
  throw new TypeError('offline snapshot payload must contain JSON-compatible plain data');
};

const jsonBytes = (value: unknown): number => encoder.encode(JSON.stringify(value)).byteLength;

export class OfflineSnapshotCodec {
  readonly maxEntries: number;
  readonly maxSnapshotBytes: number;
  readonly maxPayloadBytes: number;
  readonly maxMetadataEntries: number;
  readonly maxMetadataValueLength: number;
  readonly maxTextLength: number;
  readonly maxAgeMs: number;
  readonly #clock: () => number;

  constructor(options: OfflineSnapshotCodecOptions = {}) {
    this.maxEntries = integer('maxEntries', options.maxEntries ?? 256, 1, 10_000);
    this.maxSnapshotBytes = integer('maxSnapshotBytes', options.maxSnapshotBytes ?? 4 * 1024 * 1024, 1_024, 32 * 1024 * 1024);
    this.maxPayloadBytes = integer('maxPayloadBytes', options.maxPayloadBytes ?? 256 * 1024, 1, this.maxSnapshotBytes);
    this.maxMetadataEntries = integer('maxMetadataEntries', options.maxMetadataEntries ?? 16, 0, 64);
    this.maxMetadataValueLength = integer('maxMetadataValueLength', options.maxMetadataValueLength ?? 256, 1, 2_048);
    this.maxTextLength = integer('maxTextLength', options.maxTextLength ?? 192, 16, 2_048);
    this.maxAgeMs = integer('maxAgeMs', options.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000, 1_000, 30 * 24 * 60 * 60 * 1000);
    this.#clock = options.clock ?? Date.now;
  }

  encode(mutations: readonly OfflineSnapshotMutation[], writtenAt = this.#clock()): string {
    finite('writtenAt', writtenAt, 0, Number.MAX_SAFE_INTEGER);
    if (mutations.length > this.maxEntries) throw new RangeError('offline snapshot entry budget exceeded');
    const normalized = mutations.map(mutation => this.#normalizeMutation(mutation, writtenAt));
    const snapshot: OfflineSnapshotV1 = Object.freeze({
      version: OFFLINE_SNAPSHOT_VERSION,
      writtenAt,
      mutations: Object.freeze(normalized),
    });
    const serialized = JSON.stringify(snapshot);
    if (encoder.encode(serialized).byteLength > this.maxSnapshotBytes) throw new RangeError('offline snapshot byte budget exceeded');
    return serialized;
  }

  decode(serialized: string, now = this.#clock()): OfflineSnapshotDecodeResult {
    finite('now', now, 0, Number.MAX_SAFE_INTEGER);
    if (typeof serialized !== 'string') throw new TypeError('offline snapshot must be a string');
    if (encoder.encode(serialized).byteLength > this.maxSnapshotBytes) throw new RangeError('offline snapshot byte budget exceeded');
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      throw new TypeError('offline snapshot must contain valid JSON');
    }
    if (!plainRecord(parsed)) throw new TypeError('offline snapshot root must be an object');
    if (parsed.version !== OFFLINE_SNAPSHOT_VERSION) throw new RangeError('unsupported offline snapshot version');
    const writtenAt = finite('snapshot.writtenAt', parsed.writtenAt as number, 0, Number.MAX_SAFE_INTEGER);
    if (writtenAt > now) throw new RangeError('offline snapshot cannot be written in the future');
    if (now - writtenAt > this.maxAgeMs) throw new RangeError('offline snapshot is stale');
    if (!Array.isArray(parsed.mutations)) throw new TypeError('offline snapshot mutations must be an array');
    if (parsed.mutations.length > this.maxEntries) throw new RangeError('offline snapshot entry budget exceeded');

    const ids = new Set<string>();
    const dedupeKeys = new Set<string>();
    const mutations: OfflineSnapshotMutation[] = [];
    let droppedExpired = 0;
    let droppedDuplicate = 0;
    for (const raw of parsed.mutations) {
      const mutation = this.#normalizeMutation(raw, writtenAt);
      if (mutation.expiresAt <= now) {
        droppedExpired += 1;
        continue;
      }
      if (ids.has(mutation.id) || (mutation.dedupeKey !== undefined && dedupeKeys.has(mutation.dedupeKey))) {
        droppedDuplicate += 1;
        continue;
      }
      ids.add(mutation.id);
      if (mutation.dedupeKey !== undefined) dedupeKeys.add(mutation.dedupeKey);
      mutations.push(mutation);
    }
    return Object.freeze({
      snapshot: Object.freeze({ version: OFFLINE_SNAPSHOT_VERSION, writtenAt, mutations: Object.freeze(mutations) }),
      droppedExpired,
      droppedDuplicate,
    });
  }

  #normalizeMutation(value: unknown, writtenAt: number): OfflineSnapshotMutation {
    if (!plainRecord(value)) throw new TypeError('offline snapshot mutation must be an object');
    const id = text('mutation.id', value.id, this.maxTextLength);
    const owner = text('mutation.owner', value.owner, this.maxTextLength);
    const operation = text('mutation.operation', value.operation, this.maxTextLength);
    const priority = value.priority;
    if (priority !== 'critical' && priority !== 'interactive' && priority !== 'background') throw new TypeError('invalid mutation priority');
    const createdAt = finite('mutation.createdAt', value.createdAt as number, 0, Number.MAX_SAFE_INTEGER);
    const expiresAt = finite('mutation.expiresAt', value.expiresAt as number, 0, Number.MAX_SAFE_INTEGER);
    if (createdAt > writtenAt || expiresAt <= createdAt || expiresAt - createdAt > this.maxAgeMs) throw new RangeError('invalid mutation lifetime');
    const maxAttempts = integer('mutation.maxAttempts', value.maxAttempts as number, 1, 10);
    const payload = clonePlainData(value.payload);
    if (jsonBytes(payload) > this.maxPayloadBytes) throw new RangeError('mutation payload byte budget exceeded');
    const dedupeKey = value.dedupeKey === undefined ? undefined : text('mutation.dedupeKey', value.dedupeKey, this.maxTextLength);
    const metadata = this.#normalizeMetadata(value.metadata);
    return Object.freeze({ id, owner, operation, payload, priority, createdAt, expiresAt, maxAttempts, ...(dedupeKey ? { dedupeKey } : {}), ...(metadata ? { metadata } : {}) });
  }

  #normalizeMetadata(value: unknown): Readonly<Record<string, string>> | undefined {
    if (value === undefined) return undefined;
    if (!plainRecord(value)) throw new TypeError('mutation metadata must be an object');
    const entries = Object.entries(value);
    if (entries.length > this.maxMetadataEntries) throw new RangeError('mutation metadata entry budget exceeded');
    const normalized: Record<string, string> = {};
    for (const [rawKey, rawValue] of entries) {
      const key = text('metadata key', rawKey, 64);
      if (typeof rawValue !== 'string' || rawValue.length > this.maxMetadataValueLength || hasControlCodePoint(rawValue)) {
        throw new TypeError('mutation metadata value is invalid');
      }
      normalized[key] = rawValue;
    }
    return Object.freeze(normalized);
  }
}
