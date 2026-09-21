import type { OfflineMutationDescriptor, OfflineMutationExecutor, OfflineMutationResult } from './offlineMutationQueue';
import { OfflineMutationQueue } from './offlineMutationQueue';
import type { OfflinePersistenceCoordinator } from './offlinePersistence';
import type { OfflineSnapshotMutation } from './offlineSnapshot';
import type { ConnectivityPolicy, ConnectivitySnapshot, ConnectivitySignal } from './connectivityPolicy';

export type OfflineRuntimeState = 'idle' | 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed';

export interface OfflineRuntimeOptions {
  readonly queue: OfflineMutationQueue;
  readonly persistence: OfflinePersistenceCoordinator;
  readonly connectivity: ConnectivityPolicy;
  readonly executor: OfflineMutationExecutor;
  readonly clock?: () => number;
  readonly historyLimit?: number;
  readonly persistDebounceMs?: number;
}

export interface OfflineRuntimeSnapshot {
  readonly state: OfflineRuntimeState;
  readonly connectivity: ConnectivitySnapshot['state'];
  readonly restored: number;
  readonly restoreRejected: number;
  readonly persistenceRevision: number;
  readonly pending: number;
  readonly running: number;
  readonly accepted: number;
  readonly completed: number;
  readonly failed: number;
  readonly lastTransitionAt: number;
}

export interface OfflineRuntimeEvent {
  readonly sequence: number;
  readonly at: number;
  readonly type:
    | 'start'
    | 'ready'
    | 'restore-accepted'
    | 'restore-rejected'
    | 'connectivity'
    | 'enqueue'
    | 'persist'
    | 'persist-failed'
    | 'stop'
    | 'stopped'
    | 'failed';
  readonly detail?: string;
}

const boundedInteger = (name: string, value: number, min: number, max: number): number => {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${name} must be between ${min} and ${max}`);
  return value;
};

const snapshotMutation = (descriptor: Readonly<OfflineMutationDescriptor>): OfflineSnapshotMutation => ({
  id: descriptor.id,
  owner: descriptor.owner,
  operation: descriptor.operation,
  payload: descriptor.payload,
  priority: descriptor.priority ?? 'interactive',
  createdAt: descriptor.createdAt ?? 0,
  expiresAt: descriptor.expiresAt ?? Number.MAX_SAFE_INTEGER,
  maxAttempts: descriptor.maxAttempts ?? 1,
  ...(descriptor.dedupeKey === undefined ? {} : { dedupeKey: descriptor.dedupeKey }),
  ...(descriptor.metadata === undefined ? {} : { metadata: descriptor.metadata }),
});

/**
 * Owns the boundary between connectivity evidence, durable pending mutations and
 * replay execution. It intentionally does not own browser events, storage or
 * transport; those capabilities stay injected and independently testable.
 */
export class OfflineRuntime {
  readonly #queue: OfflineMutationQueue;
  readonly #persistence: OfflinePersistenceCoordinator;
  readonly #connectivity: ConnectivityPolicy;
  readonly #executor: OfflineMutationExecutor;
  readonly #clock: () => number;
  readonly #historyLimit: number;
  readonly #persistDebounceMs: number;
  readonly #history: OfflineRuntimeEvent[] = [];
  #state: OfflineRuntimeState = 'idle';
  #sequence = 0;
  #restored = 0;
  #restoreRejected = 0;
  #accepted = 0;
  #completed = 0;
  #failed = 0;
  #lastTransitionAt: number;
  #persistTimer: ReturnType<typeof setTimeout> | undefined;
  #startPromise: Promise<void> | undefined;
  #stopPromise: Promise<void> | undefined;

  constructor(options: OfflineRuntimeOptions) {
    if (!options?.queue || !options.persistence || !options.connectivity || !options.executor) {
      throw new TypeError('queue, persistence, connectivity and executor are required');
    }
    this.#queue = options.queue;
    this.#persistence = options.persistence;
    this.#connectivity = options.connectivity;
    this.#executor = options.executor;
    this.#clock = options.clock ?? Date.now;
    this.#historyLimit = boundedInteger('historyLimit', options.historyLimit ?? 96, 0, 2048);
    this.#persistDebounceMs = boundedInteger('persistDebounceMs', options.persistDebounceMs ?? 100, 0, 60_000);
    this.#lastTransitionAt = this.#clock();
  }

  snapshot(): Readonly<OfflineRuntimeSnapshot> {
    const queue = this.#queue.snapshot();
    const persistence = this.#persistence.snapshot();
    return Object.freeze({
      state: this.#state,
      connectivity: this.#connectivity.snapshot(this.#clock()).state,
      restored: this.#restored,
      restoreRejected: this.#restoreRejected,
      persistenceRevision: persistence.revision,
      pending: queue.queued,
      running: queue.running,
      accepted: this.#accepted,
      completed: this.#completed,
      failed: this.#failed,
      lastTransitionAt: this.#lastTransitionAt,
    });
  }

  history(): readonly Readonly<OfflineRuntimeEvent>[] {
    return Object.freeze(this.#history.map(event => Object.freeze({ ...event })));
  }

  async start(): Promise<void> {
    if (this.#state === 'ready') return;
    if (this.#state === 'starting' && this.#startPromise) return this.#startPromise;
    if (this.#state === 'stopping' || this.#state === 'stopped') throw new Error('offline runtime cannot restart after stop');
    this.#transition('starting');
    this.#record('start');
    this.#queue.setOnline(false);
    this.#queue.setExecutor(this.#executor);
    const start = this.#restore();
    this.#startPromise = start;
    try {
      await start;
      this.#transition('ready');
      this.#record('ready');
      this.#applyConnectivity(this.#connectivity.snapshot(this.#clock()));
    } catch (error) {
      this.#transition('failed');
      this.#record('failed', error instanceof Error ? error.name : 'restore-failure');
      throw error;
    } finally {
      if (this.#startPromise === start) this.#startPromise = undefined;
    }
  }

  observeConnectivity(signal: ConnectivitySignal): Readonly<ConnectivitySnapshot> {
    this.#assertUsable();
    const snapshot = this.#connectivity.observe(signal);
    this.#record('connectivity', snapshot.state);
    this.#applyConnectivity(snapshot);
    return snapshot;
  }

  enqueue<TPayload>(descriptor: OfflineMutationDescriptor<TPayload>): Promise<OfflineMutationResult> {
    this.#assertReady();
    const promise = this.#queue.enqueue(descriptor);
    this.#accepted += 1;
    this.#record('enqueue', descriptor.operation);
    this.#schedulePersist();
    void promise.then(
      () => {
        this.#completed += 1;
        this.#schedulePersist();
      },
      () => {
        this.#failed += 1;
        this.#schedulePersist();
      },
    );
    return promise;
  }

  async flush(): Promise<void> {
    this.#assertUsable();
    this.#cancelPersistTimer();
    this.#capturePending();
    try {
      await this.#persistence.flush();
      this.#record('persist');
    } catch (error) {
      this.#record('persist-failed', error instanceof Error ? error.name : 'unknown');
      throw error;
    }
  }

  async stop(options: { readonly flush?: boolean; readonly reason?: string } = {}): Promise<void> {
    if (this.#state === 'stopped') return;
    if (this.#state === 'stopping' && this.#stopPromise) return this.#stopPromise;
    const reason = options.reason ?? 'offline-runtime-stopped';
    this.#transition('stopping');
    this.#record('stop', reason);
    this.#queue.setOnline(false);
    this.#cancelPersistTimer();
    const stop = this.#stop(Boolean(options.flush), reason);
    this.#stopPromise = stop;
    try {
      await stop;
    } finally {
      this.#transition('stopped');
      this.#record('stopped', reason);
      this.#stopPromise = undefined;
    }
  }

  async #restore(): Promise<void> {
    const mutations = await this.#persistence.load();
    for (const mutation of mutations) {
      try {
        void this.#queue.enqueue(mutation).then(
          () => {
            this.#completed += 1;
            this.#schedulePersist();
          },
          () => {
            this.#failed += 1;
            this.#schedulePersist();
          },
        );
        this.#restored += 1;
        this.#record('restore-accepted', mutation.operation);
      } catch {
        this.#restoreRejected += 1;
        this.#record('restore-rejected', mutation.operation);
      }
    }
    this.#capturePending();
  }

  #applyConnectivity(snapshot: Readonly<ConnectivitySnapshot>): void {
    if (this.#state !== 'ready') return;
    this.#queue.setOnline(snapshot.state === 'online');
  }

  #capturePending(): void {
    const pending = this.#queue.pending().map(snapshotMutation);
    this.#persistence.replace(pending);
  }

  #schedulePersist(): void {
    if (this.#state === 'stopping' || this.#state === 'stopped' || this.#state === 'failed') return;
    this.#cancelPersistTimer();
    if (this.#persistDebounceMs === 0) {
      this.#capturePending();
      return;
    }
    this.#persistTimer = setTimeout(() => {
      this.#persistTimer = undefined;
      if (this.#state === 'ready') this.#capturePending();
    }, this.#persistDebounceMs);
  }

  async #stop(flush: boolean, reason: string): Promise<void> {
    if (this.#startPromise) await this.#startPromise.catch(() => undefined);
    if (flush) {
      this.#capturePending();
      await this.#persistence.flush();
    }
    this.#queue.dispose(reason);
    this.#persistence.dispose();
  }

  #assertReady(): void {
    if (this.#state !== 'ready') throw new Error(`offline runtime is not ready (${this.#state})`);
  }

  #assertUsable(): void {
    if (this.#state === 'stopping' || this.#state === 'stopped') throw new Error('offline runtime is stopped');
  }

  #transition(state: OfflineRuntimeState): void {
    this.#state = state;
    this.#lastTransitionAt = this.#clock();
  }

  #cancelPersistTimer(): void {
    if (this.#persistTimer === undefined) return;
    clearTimeout(this.#persistTimer);
    this.#persistTimer = undefined;
  }

  #record(type: OfflineRuntimeEvent['type'], detail?: string): void {
    if (this.#historyLimit === 0) return;
    this.#history.push(Object.freeze({
      sequence: ++this.#sequence,
      at: this.#clock(),
      type,
      ...(detail === undefined ? {} : { detail: detail.slice(0, 96) }),
    }));
    if (this.#history.length > this.#historyLimit) this.#history.splice(0, this.#history.length - this.#historyLimit);
  }
}
