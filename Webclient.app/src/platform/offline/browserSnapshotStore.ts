import type { OfflinePersistenceStore } from './offlinePersistence';

export interface KeyValueStoragePort {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface BrowserSnapshotStoreOptions {
  readonly key?: string;
  readonly maxBytes?: number;
  readonly storage?: KeyValueStoragePort;
}

export interface BrowserSnapshotStoreSnapshot {
  readonly available: boolean;
  readonly reads: number;
  readonly writes: number;
  readonly removes: number;
  readonly failures: number;
  readonly lastFailure?: 'read' | 'write' | 'remove' | 'budget';
}

const textBytes = (value: string): number => new TextEncoder().encode(value).byteLength;

const safeKey = (value: string): string => {
  const key = value.trim();
  if (!key || key.length > 160) throw new TypeError('storage key must be non-empty bounded text');
  for (const character of key) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code <= 31 || code === 127)) throw new TypeError('storage key contains control characters');
  }
  return key;
};

/**
 * Synchronous Web Storage is isolated behind the async persistence port so the
 * queue never depends on a browser global and storage failures never escape as
 * unhandled exceptions. Callers explicitly inject localStorage/sessionStorage.
 */
export class BrowserSnapshotStore implements OfflinePersistenceStore {
  readonly key: string;
  readonly maxBytes: number;
  readonly #storage: KeyValueStoragePort | undefined;
  #reads = 0;
  #writes = 0;
  #removes = 0;
  #failures = 0;
  #lastFailure: BrowserSnapshotStoreSnapshot['lastFailure'];

  constructor(options: BrowserSnapshotStoreOptions = {}) {
    this.key = safeKey(options.key ?? 'kent-rehberi:offline-mutations:v1');
    const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1_024 || maxBytes > 8 * 1024 * 1024) {
      throw new RangeError('maxBytes must be between 1024 and 8388608');
    }
    this.maxBytes = maxBytes;
    this.#storage = options.storage;
  }

  async read(signal?: AbortSignal): Promise<string | null> {
    this.#throwIfAborted(signal);
    if (!this.#storage) return null;
    try {
      const value = this.#storage.getItem(this.key);
      this.#throwIfAborted(signal);
      this.#reads += 1;
      if (value !== null && textBytes(value) > this.maxBytes) {
        this.#failures += 1;
        this.#lastFailure = 'budget';
        return null;
      }
      return value;
    } catch {
      if (signal?.aborted) throw signal.reason;
      this.#failures += 1;
      this.#lastFailure = 'read';
      return null;
    }
  }

  async write(value: string, signal?: AbortSignal): Promise<void> {
    this.#throwIfAborted(signal);
    if (typeof value !== 'string') throw new TypeError('snapshot value must be text');
    if (textBytes(value) > this.maxBytes) {
      this.#failures += 1;
      this.#lastFailure = 'budget';
      throw new RangeError('snapshot exceeds storage budget');
    }
    if (!this.#storage) throw new Error('snapshot storage unavailable');
    try {
      this.#storage.setItem(this.key, value);
      this.#throwIfAborted(signal);
      this.#writes += 1;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      this.#failures += 1;
      this.#lastFailure = 'write';
      throw new Error('snapshot storage write failed', { cause: error });
    }
  }

  async remove(signal?: AbortSignal): Promise<void> {
    this.#throwIfAborted(signal);
    if (!this.#storage) return;
    try {
      this.#storage.removeItem(this.key);
      this.#throwIfAborted(signal);
      this.#removes += 1;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      this.#failures += 1;
      this.#lastFailure = 'remove';
      throw new Error('snapshot storage remove failed', { cause: error });
    }
  }

  snapshot(): Readonly<BrowserSnapshotStoreSnapshot> {
    return Object.freeze({
      available: this.#storage !== undefined,
      reads: this.#reads,
      writes: this.#writes,
      removes: this.#removes,
      failures: this.#failures,
      ...(this.#lastFailure === undefined ? {} : { lastFailure: this.#lastFailure }),
    });
  }

  #throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  }
}
