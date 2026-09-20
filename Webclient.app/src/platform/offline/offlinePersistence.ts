import type { OfflineSnapshot, OfflineSnapshotEntry } from './offlineSnapshot';

export type OfflinePersistenceState = 'idle' | 'loading' | 'saving' | 'ready' | 'failed' | 'disposed';
export type OfflinePersistenceFailureKind = 'read' | 'write' | 'remove' | 'validation' | 'disposed';

export interface OfflinePersistenceStore {
  read(signal: AbortSignal): Promise<unknown | null>;
  write(snapshot: OfflineSnapshot, signal: AbortSignal): Promise<void>;
  remove(signal: AbortSignal): Promise<void>;
}

export interface OfflinePersistenceCodec {
  decode(value: unknown, now?: number): OfflineSnapshot;
  encode(entries: readonly OfflineSnapshotEntry[], now?: number): OfflineSnapshot;
}

export interface OfflinePersistenceOptions {
  readonly store: OfflinePersistenceStore;
  readonly codec: OfflinePersistenceCodec;
  readonly clock?: () => number;
  readonly historyLimit?: number;
  readonly saveDebounceMs?: number;
  readonly maxConsecutiveFailures?: number;
}

export interface OfflinePersistenceSnapshot {
  readonly state: OfflinePersistenceState;
  readonly revision: number;
  readonly persistedRevision: number;
  readonly pendingSave: boolean;
  readonly consecutiveFailures: number;
  readonly lastLoadedAt?: number;
  readonly lastSavedAt?: number;
  readonly lastFailureAt?: number;
}

export interface OfflinePersistenceEvent {
  readonly sequence: number;
  readonly at: number;
  readonly type: 'load-started' | 'load-completed' | 'save-scheduled' | 'save-started' | 'save-completed' | 'cleared' | 'failed' | 'disposed';
  readonly revision: number;
  readonly failure?: OfflinePersistenceFailureKind;
}

export class OfflinePersistenceError extends Error {
  constructor(readonly kind: OfflinePersistenceFailureKind, options?: ErrorOptions) {
    super(`Offline persistence ${kind} failure`, options);
    this.name = 'OfflinePersistenceError';
  }
}

const boundedInteger = (name: string, value: number, min: number, max: number): number => {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${name} must be between ${min} and ${max}`);
  return value;
};

/**
 * Coordinates durable offline state without choosing a browser storage mechanism.
 * The store is deliberately injected so IndexedDB/localStorage/service-worker caches
 * cannot leak into the platform domain boundary. All operations are serialized,
 * abortable and generation-aware; stale writes can never replace a newer revision.
 */
export class OfflinePersistenceCoordinator {
  readonly #store: OfflinePersistenceStore;
  readonly #codec: OfflinePersistenceCodec;
  readonly #clock: () => number;
  readonly #historyLimit: number;
  readonly #saveDebounceMs: number;
  readonly #maxConsecutiveFailures: number;
  readonly #history: OfflinePersistenceEvent[] = [];
  readonly #lifetime = new AbortController();
  #state: OfflinePersistenceState = 'idle';
  #revision = 0;
  #persistedRevision = 0;
  #entries: readonly OfflineSnapshotEntry[] = Object.freeze([]);
  #sequence = 0;
  #consecutiveFailures = 0;
  #lastLoadedAt: number | undefined;
  #lastSavedAt: number | undefined;
  #lastFailureAt: number | undefined;
  #saveTimer: ReturnType<typeof setTimeout> | undefined;
  #operation: Promise<void> = Promise.resolve();
  #disposed = false;

  constructor(options: OfflinePersistenceOptions) {
    if (!options?.store || !options.codec) throw new TypeError('store and codec are required');
    this.#store = options.store;
    this.#codec = options.codec;
    this.#clock = options.clock ?? Date.now;
    this.#historyLimit = boundedInteger('historyLimit', options.historyLimit ?? 64, 0, 1024);
    this.#saveDebounceMs = boundedInteger('saveDebounceMs', options.saveDebounceMs ?? 250, 0, 60_000);
    this.#maxConsecutiveFailures = boundedInteger('maxConsecutiveFailures', options.maxConsecutiveFailures ?? 3, 1, 20);
  }

  snapshot(): OfflinePersistenceSnapshot {
    return Object.freeze({
      state: this.#state,
      revision: this.#revision,
      persistedRevision: this.#persistedRevision,
      pendingSave: this.#saveTimer !== undefined || this.#persistedRevision < this.#revision,
      consecutiveFailures: this.#consecutiveFailures,
      ...(this.#lastLoadedAt === undefined ? {} : { lastLoadedAt: this.#lastLoadedAt }),
      ...(this.#lastSavedAt === undefined ? {} : { lastSavedAt: this.#lastSavedAt }),
      ...(this.#lastFailureAt === undefined ? {} : { lastFailureAt: this.#lastFailureAt }),
    });
  }

  history(): readonly OfflinePersistenceEvent[] {
    return Object.freeze(this.#history.map(event => Object.freeze({ ...event })));
  }

  entries(): readonly OfflineSnapshotEntry[] {
    return this.#entries;
  }

  async load(): Promise<readonly OfflineSnapshotEntry[]> {
    this.#assertActive();
    this.#cancelScheduledSave();
    const requestedRevision = this.#revision;
    this.#state = 'loading';
    this.#record('load-started', requestedRevision);
    let loaded: readonly OfflineSnapshotEntry[] = Object.freeze([]);
    await this.#serialize(async () => {
      this.#assertActive();
      try {
        const raw = await this.#store.read(this.#lifetime.signal);
        if (raw !== null) loaded = this.#codec.decode(raw, this.#clock()).entries;
        if (this.#revision === requestedRevision) {
          this.#entries = Object.freeze(loaded.map(entry => Object.freeze({ ...entry })));
          this.#revision += 1;
          this.#persistedRevision = this.#revision;
        }
        this.#consecutiveFailures = 0;
        this.#lastLoadedAt = this.#clock();
        this.#state = 'ready';
        this.#record('load-completed', this.#revision);
      } catch (error) {
        if (this.#disposed) throw new OfflinePersistenceError('disposed', { cause: error });
        this.#fail('read', error);
      }
    });
    return this.#entries;
  }

  replace(entries: readonly OfflineSnapshotEntry[]): number {
    this.#assertActive();
    if (!Array.isArray(entries)) throw new TypeError('entries must be an array');
    // Encode now as a synchronous validation pass. This keeps invalid or oversized
    // data out of coordinator memory even before a durable write is attempted.
    const validated = this.#codec.encode(entries, this.#clock()).entries;
    this.#entries = Object.freeze(validated.map(entry => Object.freeze({ ...entry })));
    this.#revision += 1;
    this.#state = 'ready';
    this.#scheduleSave();
    return this.#revision;
  }

  async flush(): Promise<void> {
    this.#assertActive();
    this.#cancelScheduledSave();
    const targetRevision = this.#revision;
    if (targetRevision <= this.#persistedRevision) return;
    const snapshot = this.#codec.encode(this.#entries, this.#clock());
    this.#record('save-started', targetRevision);
    this.#state = 'saving';
    await this.#serialize(async () => {
      this.#assertActive();
      try {
        await this.#store.write(snapshot, this.#lifetime.signal);
        if (targetRevision > this.#persistedRevision) this.#persistedRevision = targetRevision;
        this.#consecutiveFailures = 0;
        this.#lastSavedAt = this.#clock();
        this.#state = 'ready';
        this.#record('save-completed', targetRevision);
        if (this.#revision > targetRevision) this.#scheduleSave();
      } catch (error) {
        if (this.#disposed) throw new OfflinePersistenceError('disposed', { cause: error });
        this.#fail('write', error);
      }
    });
  }

  async clear(): Promise<void> {
    this.#assertActive();
    this.#cancelScheduledSave();
    const targetRevision = ++this.#revision;
    this.#entries = Object.freeze([]);
    await this.#serialize(async () => {
      this.#assertActive();
      try {
        await this.#store.remove(this.#lifetime.signal);
        this.#persistedRevision = Math.max(this.#persistedRevision, targetRevision);
        this.#consecutiveFailures = 0;
        this.#state = 'ready';
        this.#record('cleared', targetRevision);
      } catch (error) {
        if (this.#disposed) throw new OfflinePersistenceError('disposed', { cause: error });
        this.#fail('remove', error);
      }
    });
  }

  async drain(): Promise<void> {
    if (this.#disposed) return;
    this.#cancelScheduledSave();
    if (this.#persistedRevision < this.#revision) await this.flush();
    await this.#operation;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#cancelScheduledSave();
    this.#lifetime.abort('offline-persistence-disposed');
    this.#state = 'disposed';
    this.#record('disposed', this.#revision);
  }

  #scheduleSave(): void {
    this.#cancelScheduledSave();
    this.#record('save-scheduled', this.#revision);
    if (this.#saveDebounceMs === 0) {
      void this.flush().catch(() => undefined);
      return;
    }
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = undefined;
      if (!this.#disposed) void this.flush().catch(() => undefined);
    }, this.#saveDebounceMs);
  }

  #cancelScheduledSave(): void {
    if (this.#saveTimer === undefined) return;
    clearTimeout(this.#saveTimer);
    this.#saveTimer = undefined;
  }

  async #serialize(operation: () => Promise<void>): Promise<void> {
    const previous = this.#operation;
    let release!: () => void;
    this.#operation = new Promise<void>(resolve => { release = resolve; });
    await previous.catch(() => undefined);
    try {
      await operation();
    } finally {
      release();
    }
  }

  #fail(kind: Exclude<OfflinePersistenceFailureKind, 'disposed'>, cause: unknown): never {
    this.#consecutiveFailures += 1;
    this.#lastFailureAt = this.#clock();
    this.#state = 'failed';
    this.#record('failed', this.#revision, kind);
    // Failure count is intentionally observable rather than triggering an
    // unbounded retry loop. The owning runtime decides when retry is safe.
    if (this.#consecutiveFailures > this.#maxConsecutiveFailures) this.#cancelScheduledSave();
    throw new OfflinePersistenceError(kind, { cause });
  }

  #assertActive(): void {
    if (this.#disposed) throw new OfflinePersistenceError('disposed');
  }

  #record(type: OfflinePersistenceEvent['type'], revision: number, failure?: OfflinePersistenceFailureKind): void {
    if (this.#historyLimit === 0) return;
    this.#history.push(Object.freeze({ sequence: ++this.#sequence, at: this.#clock(), type, revision, ...(failure ? { failure } : {}) }));
    if (this.#history.length > this.#historyLimit) this.#history.splice(0, this.#history.length - this.#historyLimit);
  }
}
