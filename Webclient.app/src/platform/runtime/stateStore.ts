import {
  abortError,
  positiveInteger,
  throwIfAborted,
  type PersistenceAdapter,
  type StateChange,
  type StateListener,
  type StateSnapshot,
} from './contracts';

export type StateUpdater<TState> = (current: Readonly<TState>) => TState;
export type StateValidator<TState> = (candidate: Readonly<TState>) => void;

export interface StateStoreOptions<TState> {
  readonly initialState: TState;
  readonly now?: () => number;
  readonly validate?: StateValidator<TState>;
  readonly persistence?: PersistenceAdapter<TState>;
  readonly clone?: (state: TState) => TState;
  readonly freeze?: (state: TState) => Readonly<TState>;
  readonly historyLimit?: number;
  readonly onListenerError?: (error: unknown) => void;
}

export interface StateStoreTransaction<TState> {
  readonly baseVersion: number;
  readonly state: Readonly<TState>;
  readonly update: (updater: StateUpdater<TState>) => void;
  readonly replace: (state: TState) => void;
  readonly commit: (reason?: string) => StateSnapshot<TState>;
  readonly rollback: () => void;
  readonly isClosed: () => boolean;
}

export interface VersionedStateStore<TState> {
  readonly snapshot: () => StateSnapshot<TState>;
  readonly get: () => Readonly<TState>;
  readonly set: (state: TState, reason?: string) => StateSnapshot<TState>;
  readonly update: (updater: StateUpdater<TState>, reason?: string) => StateSnapshot<TState>;
  readonly compareAndSet: (expectedVersion: number, updater: StateUpdater<TState>, reason?: string) => StateSnapshot<TState> | null;
  readonly transaction: () => StateStoreTransaction<TState>;
  readonly subscribe: (listener: StateListener<TState>, emitCurrent?: boolean) => () => void;
  readonly hydrate: (signal?: AbortSignal) => Promise<StateSnapshot<TState>>;
  readonly persist: (signal?: AbortSignal) => Promise<void>;
  readonly clearPersistence: () => Promise<void>;
  readonly history: () => readonly StateSnapshot<TState>[];
  readonly dispose: () => void;
}

const defaultClone = <TState>(state: TState): TState => {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(state);
    } catch {
      // Fall back for values not supported by structured clone.
    }
  }
  if (Array.isArray(state)) return [...state] as TState;
  if (state && typeof state === 'object') return { ...(state as Record<string, unknown>) } as TState;
  return state;
};

const defaultFreeze = <TState>(state: TState): Readonly<TState> => {
  if (state && typeof state === 'object' && !Object.isFrozen(state)) Object.freeze(state);
  return state;
};

const normalizeReason = (value: unknown, fallback: string): string => {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, 120) : fallback;
};

export const createVersionedStateStore = <TState>(
  options: StateStoreOptions<TState>,
): VersionedStateStore<TState> => {
  const now = options.now ?? Date.now;
  const clone = options.clone ?? defaultClone;
  const freeze = options.freeze ?? defaultFreeze;
  const historyLimit = positiveInteger(options.historyLimit, 20, 200);
  const listeners = new Set<StateListener<TState>>();
  const snapshots: StateSnapshot<TState>[] = [];
  let disposed = false;
  let currentState = freeze(clone(options.initialState));
  let version = 0;
  let updatedAt = now();

  const assertUsable = (): void => {
    if (disposed) throw new Error('State store has been disposed.');
  };

  const validate = (candidate: Readonly<TState>): void => {
    options.validate?.(candidate);
  };

  validate(currentState);

  const makeSnapshot = (): StateSnapshot<TState> => Object.freeze({
    version,
    updatedAt,
    state: currentState,
  });

  const remember = (snapshot: StateSnapshot<TState>): void => {
    snapshots.push(snapshot);
    while (snapshots.length > historyLimit) snapshots.shift();
  };

  remember(makeSnapshot());

  const notify = (previous: StateSnapshot<TState>, current: StateSnapshot<TState>, reason: string): void => {
    const change: StateChange<TState> = Object.freeze({ previous, current, reason });
    for (const listener of Array.from(listeners)) {
      try {
        listener(change);
      } catch (error) {
        options.onListenerError?.(error);
      }
    }
  };

  const commitState = (nextState: TState, reason: string): StateSnapshot<TState> => {
    assertUsable();
    const candidate = freeze(clone(nextState));
    validate(candidate);
    const previous = makeSnapshot();
    currentState = candidate;
    version += 1;
    updatedAt = now();
    const current = makeSnapshot();
    remember(current);
    notify(previous, current, reason);
    return current;
  };

  const snapshot = (): StateSnapshot<TState> => makeSnapshot();
  const get = (): Readonly<TState> => currentState;

  const set = (state: TState, reason = 'set'): StateSnapshot<TState> =>
    commitState(state, normalizeReason(reason, 'set'));

  const update = (updater: StateUpdater<TState>, reason = 'update'): StateSnapshot<TState> => {
    assertUsable();
    if (typeof updater !== 'function') throw new TypeError('State updater must be a function.');
    return commitState(updater(currentState), normalizeReason(reason, 'update'));
  };

  const compareAndSet = (
    expectedVersion: number,
    updater: StateUpdater<TState>,
    reason = 'compare-and-set',
  ): StateSnapshot<TState> | null => {
    assertUsable();
    if (version !== expectedVersion) return null;
    return update(updater, reason);
  };

  const transaction = (): StateStoreTransaction<TState> => {
    assertUsable();
    const baseVersion = version;
    let working = clone(currentState as TState);
    let closed = false;

    const assertOpen = (): void => {
      if (closed) throw new Error('State transaction is already closed.');
    };

    return Object.freeze({
      baseVersion,
      get state() { return freeze(clone(working)); },
      update: (updater: StateUpdater<TState>) => {
        assertOpen();
        if (typeof updater !== 'function') throw new TypeError('State updater must be a function.');
        working = clone(updater(freeze(clone(working))));
        validate(freeze(clone(working)));
      },
      replace: (state: TState) => {
        assertOpen();
        working = clone(state);
        validate(freeze(clone(working)));
      },
      commit: (reason = 'transaction') => {
        assertOpen();
        if (version !== baseVersion) {
          closed = true;
          throw new Error(`State transaction conflict: expected version ${baseVersion}, actual ${version}.`);
        }
        closed = true;
        return commitState(working, normalizeReason(reason, 'transaction'));
      },
      rollback: () => { closed = true; },
      isClosed: () => closed,
    });
  };

  const subscribe = (listener: StateListener<TState>, emitCurrent = false): (() => void) => {
    assertUsable();
    if (typeof listener !== 'function') throw new TypeError('State listener must be a function.');
    listeners.add(listener);
    if (emitCurrent) {
      const current = makeSnapshot();
      try {
        listener(Object.freeze({ previous: current, current, reason: 'subscribe' }));
      } catch (error) {
        options.onListenerError?.(error);
      }
    }
    return () => listeners.delete(listener);
  };

  const hydrate = async (signal?: AbortSignal): Promise<StateSnapshot<TState>> => {
    assertUsable();
    throwIfAborted(signal);
    if (!options.persistence) return makeSnapshot();
    const persisted = await options.persistence.read();
    throwIfAborted(signal);
    if (persisted === null || persisted === undefined) return makeSnapshot();
    return commitState(persisted, 'hydrate');
  };

  const persist = async (signal?: AbortSignal): Promise<void> => {
    assertUsable();
    throwIfAborted(signal);
    if (!options.persistence) return;
    await options.persistence.write(currentState);
    throwIfAborted(signal);
  };

  const clearPersistence = async (): Promise<void> => {
    assertUsable();
    await options.persistence?.clear?.();
  };

  const history = (): readonly StateSnapshot<TState>[] => Object.freeze([...snapshots]);

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    listeners.clear();
    snapshots.splice(0);
  };

  return Object.freeze({
    snapshot,
    get,
    set,
    update,
    compareAndSet,
    transaction,
    subscribe,
    hydrate,
    persist,
    clearPersistence,
    history,
    dispose,
  });
};

export interface WebStoragePersistenceOptions<TState> {
  readonly storage: Storage;
  readonly key: string;
  readonly serialize?: (state: Readonly<TState>) => string;
  readonly deserialize?: (raw: string) => TState;
  readonly maxBytes?: number;
}

export const createWebStoragePersistence = <TState>(
  options: WebStoragePersistenceOptions<TState>,
): PersistenceAdapter<TState> => {
  const key = options.key.trim();
  if (!key) throw new Error('Persistence key is required.');
  const serialize = options.serialize ?? ((state: Readonly<TState>) => JSON.stringify(state));
  const deserialize = options.deserialize ?? ((raw: string) => JSON.parse(raw) as TState);
  const maxBytes = positiveInteger(options.maxBytes, 256 * 1024, 5 * 1024 * 1024);

  return Object.freeze({
    read: () => {
      const raw = options.storage.getItem(key);
      if (raw === null) return null;
      if (raw.length * 2 > maxBytes) {
        options.storage.removeItem(key);
        return null;
      }
      try {
        return deserialize(raw);
      } catch {
        options.storage.removeItem(key);
        return null;
      }
    },
    write: (state: Readonly<TState>) => {
      const raw = serialize(state);
      if (raw.length * 2 > maxBytes) throw new Error('Persisted state exceeds storage budget.');
      options.storage.setItem(key, raw);
    },
    clear: () => options.storage.removeItem(key),
  });
};

export const awaitState = <TState>(
  store: VersionedStateStore<TState>,
  predicate: (state: Readonly<TState>) => boolean,
  options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
): Promise<StateSnapshot<TState>> => {
  if (predicate(store.get())) return Promise.resolve(store.snapshot());
  if (options.signal?.aborted) return Promise.reject(options.signal.reason ?? abortError());

  return new Promise<StateSnapshot<TState>>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      unsubscribe();
      options.signal?.removeEventListener('abort', onAbort);
      if (timer) clearTimeout(timer);
    };
    const onAbort = () => {
      cleanup();
      reject(options.signal?.reason ?? abortError());
    };
    const unsubscribe = store.subscribe(({ current }) => {
      if (!predicate(current.state)) return;
      cleanup();
      resolve(current);
    });
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.timeoutMs !== undefined) {
      const timeoutMs = positiveInteger(options.timeoutMs, 5000, 10 * 60 * 1000);
      timer = setTimeout(() => {
        cleanup();
        reject(new Error(`State wait timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
    }
  });
};
