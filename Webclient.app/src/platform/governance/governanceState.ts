import {
  boundedInteger,
  boundedText,
  type GovernanceClock,
  type GovernanceKernelState,
} from './contracts';

export interface GovernanceStateSnapshot {
  readonly version: number;
  readonly updatedAt: number;
  readonly state: Readonly<GovernanceKernelState>;
}

export interface GovernanceStateChange {
  readonly previous: GovernanceStateSnapshot;
  readonly current: GovernanceStateSnapshot;
  readonly reason: string;
}

export interface GovernanceStateStore {
  readonly snapshot: () => GovernanceStateSnapshot;
  readonly get: () => Readonly<GovernanceKernelState>;
  readonly set: (state: GovernanceKernelState, reason?: string) => GovernanceStateSnapshot;
  readonly update: (
    updater: (current: Readonly<GovernanceKernelState>) => GovernanceKernelState,
    reason?: string,
  ) => GovernanceStateSnapshot;
  readonly subscribe: (
    listener: (change: GovernanceStateChange) => void,
    emitCurrent?: boolean,
  ) => () => void;
  readonly history: () => readonly GovernanceStateSnapshot[];
  readonly dispose: () => void;
}

export interface GovernanceStateStoreOptions {
  readonly initialState: GovernanceKernelState;
  readonly clock: GovernanceClock;
  readonly validate: (state: Readonly<GovernanceKernelState>) => void;
  readonly historyLimit?: number;
  readonly onListenerError?: (error: unknown) => void;
}

const freezeState = (
  state: GovernanceKernelState,
): Readonly<GovernanceKernelState> => Object.freeze({ ...state });

const normalizeReason = (value: unknown, fallback: string): string =>
  boundedText(value, fallback, 120) || fallback;

export const createGovernanceStateStore = (
  options: GovernanceStateStoreOptions,
): GovernanceStateStore => {
  const historyLimit = boundedInteger(options.historyLimit, 64, 1, 512);
  const history: GovernanceStateSnapshot[] = [];
  const listeners = new Set<(change: GovernanceStateChange) => void>();
  let current = freezeState(options.initialState);
  let version = 0;
  let updatedAt = options.clock.now();
  let disposed = false;

  const assertActive = (): void => {
    if (disposed) throw new Error('governance state store has been disposed');
  };

  const validate = (state: Readonly<GovernanceKernelState>): void => {
    options.validate(state);
  };

  validate(current);

  const snapshot = (): GovernanceStateSnapshot => Object.freeze({
    version,
    updatedAt,
    state: current,
  });

  const remember = (value: GovernanceStateSnapshot): void => {
    history.push(value);
    if (history.length > historyLimit) {
      history.splice(0, history.length - historyLimit);
    }
  };

  remember(snapshot());

  const notify = (
    previous: GovernanceStateSnapshot,
    next: GovernanceStateSnapshot,
    reason: string,
  ): void => {
    const change: GovernanceStateChange = Object.freeze({
      previous,
      current: next,
      reason,
    });
    for (const listener of listeners) {
      try {
        listener(change);
      } catch (error) {
        options.onListenerError?.(error);
      }
    }
  };

  const commit = (
    nextState: GovernanceKernelState,
    reasonInput: unknown,
    fallbackReason: string,
  ): GovernanceStateSnapshot => {
    assertActive();
    const candidate = freezeState(nextState);
    validate(candidate);
    const previous = snapshot();
    current = candidate;
    version += 1;
    updatedAt = options.clock.now();
    const next = snapshot();
    remember(next);
    notify(previous, next, normalizeReason(reasonInput, fallbackReason));
    return next;
  };

  const set = (
    state: GovernanceKernelState,
    reason = 'set',
  ): GovernanceStateSnapshot => commit(state, reason, 'set');

  const update = (
    updater: (currentState: Readonly<GovernanceKernelState>) => GovernanceKernelState,
    reason = 'update',
  ): GovernanceStateSnapshot => {
    assertActive();
    if (typeof updater !== 'function') {
      throw new TypeError('governance state updater must be a function');
    }
    return commit(updater(current), reason, 'update');
  };

  const subscribe = (
    listener: (change: GovernanceStateChange) => void,
    emitCurrent = false,
  ): (() => void) => {
    assertActive();
    if (typeof listener !== 'function') {
      throw new TypeError('governance state listener must be a function');
    }
    listeners.add(listener);
    if (emitCurrent) {
      const value = snapshot();
      try {
        listener(Object.freeze({
          previous: value,
          current: value,
          reason: 'subscribe',
        }));
      } catch (error) {
        options.onListenerError?.(error);
      }
    }
    return () => {
      listeners.delete(listener);
    };
  };

  const readHistory = (): readonly GovernanceStateSnapshot[] =>
    Object.freeze(history.slice());

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    listeners.clear();
  };

  return Object.freeze({
    snapshot,
    get: () => current,
    set,
    update,
    subscribe,
    history: readHistory,
    dispose,
  });
};
