const STORAGE_PREFIX = 'kr:v2:';
const MAX_SERIALIZED_BYTES = 512 * 1024;

interface StorageEnvelope<TValue> {
  readonly version: 2;
  readonly savedAt: number;
  readonly value: TValue;
}

export interface StorageResult<TValue> {
  readonly ok: boolean;
  readonly value: TValue | null;
  readonly reason?: 'unavailable' | 'missing' | 'invalid' | 'quota' | 'oversized';
}

const getStorage = (): Storage | null => {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
};

const safeKey = (key: unknown): string | null => {
  if (typeof key !== 'string') return null;
  const normalized = key.trim();
  if (!normalized || normalized.length > 256) return null;
  for (let index = 0; index < normalized.length; index += 1) {
    const code = normalized.charCodeAt(index);
    if (code <= 31 || code === 127) return null;
  }
  return normalized;
};

const byteLength = (value: string): number => {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).byteLength;
  return value.length * 2;
};

const parseEnvelope = <TValue>(text: string): TValue | null => {
  const payload = text.startsWith(STORAGE_PREFIX) ? text.slice(STORAGE_PREFIX.length) : text;
  try {
    const parsed: unknown = JSON.parse(payload);
    if (
      parsed !== null
      && typeof parsed === 'object'
      && !Array.isArray(parsed)
      && (parsed as { version?: unknown }).version === 2
      && 'value' in parsed
    ) {
      return (parsed as StorageEnvelope<TValue>).value;
    }
    return parsed as TValue;
  } catch {
    // Historical AES values used a key bundled with the browser and therefore were not
    // a security boundary. The crypto-js dependency has been removed from the modern
    // client; unreadable legacy ciphertext fails closed instead of restoring fake crypto.
    return null;
  }
};

const serializeEnvelope = <TValue>(value: TValue): string | null => {
  try {
    const payload: StorageEnvelope<TValue> = Object.freeze({
      version: 2,
      savedAt: Date.now(),
      value,
    });
    const serialized = `${STORAGE_PREFIX}${JSON.stringify(payload)}`;
    return byteLength(serialized) <= MAX_SERIALIZED_BYTES ? serialized : null;
  } catch {
    return null;
  }
};

export const LocalStorageHelper = Object.freeze({
  Get: <TValue = unknown>(key: string): TValue | null => {
    const storage = getStorage();
    const normalizedKey = safeKey(key);
    if (!storage || !normalizedKey) return null;
    try {
      const raw = storage.getItem(normalizedKey);
      if (raw === null || raw === '') return null;
      return parseEnvelope<TValue>(raw);
    } catch {
      return null;
    }
  },

  Set: <TValue>(key: string, value: TValue): void => {
    const storage = getStorage();
    const normalizedKey = safeKey(key);
    if (!storage || !normalizedKey) return;
    const serialized = serializeEnvelope(value);
    if (!serialized) return;
    try {
      storage.setItem(normalizedKey, serialized);
    } catch {
      // Storage can be disabled, sandboxed, or quota constrained; persistence is best effort.
    }
  },

  Remove: (key: string): boolean => {
    const storage = getStorage();
    const normalizedKey = safeKey(key);
    if (!storage || !normalizedKey) return false;
    try {
      storage.removeItem(normalizedKey);
      return true;
    } catch {
      return false;
    }
  },

  Read: <TValue = unknown>(key: string): StorageResult<TValue> => {
    const storage = getStorage();
    const normalizedKey = safeKey(key);
    if (!storage || !normalizedKey) return Object.freeze({ ok: false, value: null, reason: 'unavailable' });
    try {
      const raw = storage.getItem(normalizedKey);
      if (raw === null || raw === '') return Object.freeze({ ok: false, value: null, reason: 'missing' });
      const value = parseEnvelope<TValue>(raw);
      return value === null
        ? Object.freeze({ ok: false, value: null, reason: 'invalid' })
        : Object.freeze({ ok: true, value });
    } catch {
      return Object.freeze({ ok: false, value: null, reason: 'unavailable' });
    }
  },

  ClearNamespace: (prefix: string): number => {
    const storage = getStorage();
    const normalizedPrefix = safeKey(prefix);
    if (!storage || !normalizedPrefix) return 0;
    const removing: string[] = [];
    try {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key?.startsWith(normalizedPrefix)) removing.push(key);
      }
      removing.forEach((key) => storage.removeItem(key));
      return removing.length;
    } catch {
      return 0;
    }
  },
});
