import type { OfflineSnapshotMutation } from './offlineSnapshot';

export type OfflinePersistenceState = 'idle' | 'loading' | 'saving' | 'ready' | 'failed' | 'disposed';
export type OfflinePersistenceFailureKind = 'read' | 'write' | 'remove' | 'disposed';

export interface OfflinePersistenceStore {
  read(signal: AbortSignal): Promise<string | null>;
  write(serialized: string, signal: AbortSignal): Promise<void>;
  remove(signal: AbortSignal): Promise<void>;
}

export interface OfflinePersistenceCodec {
  decode(serialized: string, now?: number): { readonly snapshot: { readonly mutations: readonly OfflineSnapshotMutation[] } };
  encode(mutations: readonly OfflineSnapshotMutation[], writtenAt?: number): string;
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

/** Storage-agnostic, serialized persistence ownership for the offline mutation domain. */
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
  #mutations: readonly OfflineSnapshotMutation[] = Object.freeze([]);
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
    return Object.freeze({ state: this.#state, revision: this.#revision, persistedRevision: this.#persistedRevision,
      pendingSave: this.#saveTimer !== undefined || this.#persistedRevision < this.#revision,
      consecutiveFailures: this.#consecutiveFailures,
      ...(this.#lastLoadedAt === undefined ? {} : { lastLoadedAt: this.#lastLoadedAt }),
      ...(this.#lastSavedAt === undefined ? {} : { lastSavedAt: this.#lastSavedAt }),
      ...(this.#lastFailureAt === undefined ? {} : { lastFailureAt: this.#lastFailureAt }) });
  }

  history(): readonly OfflinePersistenceEvent[] {
    return Object.freeze(this.#history.map(event => Object.freeze({ ...event })));
  }

  mutations(): readonly OfflineSnapshotMutation[] { return this.#mutations; }

  async load(): Promise<readonly OfflineSnapshotMutation[]> {
    this.#assertActive();
    this.#cancelScheduledSave();
    const requestedRevision = this.#revision;
    this.#state = 'loading';
    this.#record('load-started', requestedRevision);
    await this.#serialize(async () => {
      this.#assertActive();
      try {
        const raw = await this.#store.read(this.#lifetime.signal);
        const loaded = raw === null ? Object.freeze([]) : this.#codec.decode(raw, this.#clock()).snapshot.mutations;
        if (this.#revision === requestedRevision) {
          this.#mutations = Object.freeze(loaded.map(mutation => Object.freeze({ ...mutation })));
          this.#revision += 1;
          this.#persistedRevision = this.#revision;
        }
        this.#consecutiveFailures = 0;
        this.#lastLoadedAt = this.#clock();
        this.#state = 'ready';
        this.#record('load-completed', this.#revision);
      } catch (error) { if (this.#disposed) throw new OfflinePersistenceError('disposed', { cause: error }); this.#fail('read', error); }
    });
    return this.#mutations;
  }

  replace(mutations: readonly OfflineSnapshotMutation[]): number {
    this.#assertActive();
    if (!Array.isArray(mutations)) throw new TypeError('mutations must be an array');
    const serialized = this.#codec.encode(mutations, this.#clock());
    const validated = this.#codec.decode(serialized, this.#clock()).snapshot.mutations;
    this.#mutations = Object.freeze(validated.map(mutation => Object.freeze({ ...mutation })));
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
    const serialized = this.#codec.encode(this.#mutations, this.#clock());
    this.#record('save-started', targetRevision);
    this.#state = 'saving';
    await this.#serialize(async () => {
      this.#assertActive();
      try {
        await this.#store.write(serialized, this.#lifetime.signal);
        if (targetRevision > this.#persistedRevision) this.#persistedRevision = targetRevision;
        this.#consecutiveFailures = 0;
        this.#lastSavedAt = this.#clock();
        this.#state = 'ready';
        this.#record('save-completed', targetRevision);
        if (this.#revision > targetRevision) this.#scheduleSave();
      } catch (error) { if (this.#disposed) throw new OfflinePersistenceError('disposed', { cause: error }); this.#fail('write', error); }
    });
  }

  async clear(): Promise<void> {
    this.#assertActive();
    this.#cancelScheduledSave();
    const targetRevision = ++this.#revision;
    this.#mutations = Object.freeze([]);
    await this.#serialize(async () => {
      this.#assertActive();
      try {
        await this.#store.remove(this.#lifetime.signal);
        this.#persistedRevision = Math.max(this.#persistedRevision, targetRevision);
        this.#consecutiveFailures = 0;
        this.#state = 'ready';
        this.#record('cleared', targetRevision);
      } catch (error) { if (this.#disposed) throw new OfflinePersistenceError('disposed', { cause: error }); this.#fail('remove', error); }
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
    if (this.#saveDebounceMs === 0) { void this.flush().catch(() => undefined); return; }
    this.#saveTimer = setTimeout(() => { this.#saveTimer = undefined; if (!this.#disposed) void this.flush().catch(() => undefined); }, this.#saveDebounceMs);
  }

  #cancelScheduledSave(): void { if (this.#saveTimer !== undefined) { clearTimeout(this.#saveTimer); this.#saveTimer = undefined; } }

  async #serialize(operation: () => Promise<void>): Promise<void> {
    const previous = this.#operation;
    let release!: () => void;
    this.#operation = new Promise<void>(resolve => { release = resolve; });
    await previous.catch(() => undefined);
    try { await operation(); } finally { release(); }
  }

  #fail(kind: Exclude<OfflinePersistenceFailureKind, 'disposed'>, cause: unknown): never {
    this.#consecutiveFailures += 1;
    this.#lastFailureAt = this.#clock();
    this.#state = 'failed';
    this.#record('failed', this.#revision, kind);
    if (this.#consecutiveFailures > this.#maxConsecutiveFailures) this.#cancelScheduledSave();
    throw new OfflinePersistenceError(kind, { cause });
  }

  #assertActive(): void { if (this.#disposed) throw new OfflinePersistenceError('disposed'); }

  #record(type: OfflinePersistenceEvent['type'], revision: number, failure?: OfflinePersistenceFailureKind): void {
    if (this.#historyLimit === 0) return;
    this.#history.push(Object.freeze({ sequence: ++this.#sequence, at: this.#clock(), type, revision, ...(failure ? { failure } : {}) }));
    if (this.#history.length > this.#historyLimit) this.#history.splice(0, this.#history.length - this.#historyLimit);
  }
}
