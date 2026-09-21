import { auditStoreAction } from './stateActionAudit';
import type { RootState } from '../contracts';
import {
  normalizeStoreRuntimeLimits,
  readActionType,
  readErrorCode,
  type StoreRuntimeConfiguration,
  type StoreRuntimeFailureInput,
  type StoreRuntimeHealthSnapshot,
  type StoreRuntimeSnapshot,
  type StoreRuntimeTransitionInput,
  type StoreSelectorNotification,
  type StoreSelectorSubscriptionOptions,
  type StoreStateProjection,
  type StoreStateRuntime,
  type StoreTransitionDescriptor,
} from './contracts';
import { fingerprintStoreProjection } from './stateFingerprint';
import { createStoreTransitionHistory } from './stateHistory';
import { changedStoreSlices, inspectStoreInvariants } from './stateInvariants';
import { projectStoreState } from './stateProjection';
import { encodeStoreSnapshot } from './stateSnapshotCodec';
import { createSelectorSubscriptionHub } from './stateSubscriptions';

const duration = (startedAt: number, completedAt: number): number =>
  Math.max(0, Number.isFinite(completedAt - startedAt) ? completedAt - startedAt : 0);

export class BoundedStoreStateRuntime implements StoreStateRuntime {
  readonly #limits;
  readonly #clock: () => number;
  readonly #history;
  readonly #subscriptions;
  #initialized = false;
  #disposed = false;
  #dispatches = 0;
  #changedTransitions = 0;
  #noopTransitions = 0;
  #failedTransitions = 0;
  #lastState: RootState | null = null;
  #lastProjection: StoreStateProjection | null = null;
  #lastFingerprint = '';
  #lastInvariants = null as ReturnType<typeof inspectStoreInvariants> | null;
  #lastActionType: string | null = null;

  constructor(configuration: StoreRuntimeConfiguration = {}) {
    this.#limits = normalizeStoreRuntimeLimits(configuration.limits);
    this.#clock = configuration.clock ?? Date.now;
    this.#history = createStoreTransitionHistory(this.#limits);
    this.#subscriptions = createSelectorSubscriptionHub(this.#limits);
  }

  get initialized(): boolean {
    return this.#initialized;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  initialize(state: RootState): StoreRuntimeSnapshot {
    this.#assertActive();
    const now = this.#clock();
    this.#lastState = state;
    this.#lastProjection = projectStoreState(state, this.#limits, now);
    this.#lastFingerprint = fingerprintStoreProjection(this.#lastProjection);
    this.#lastInvariants = inspectStoreInvariants(state, this.#limits, now);
    this.#subscriptions.initialize(state);
    this.#initialized = true;
    this.#lastActionType = '@@store-runtime/initialize';
    return this.inspect();
  }

  recordTransition(input: StoreRuntimeTransitionInput): StoreTransitionDescriptor {
    this.#assertActive();
    if (!this.#initialized) this.initialize(input.previousState);

    const actionType = readActionType(input.action);
    const actionAudit = auditStoreAction(input.action, this.#limits);
    const beforeProjection = projectStoreState(input.previousState, this.#limits, input.startedAt);
    const afterProjection = projectStoreState(input.nextState, this.#limits, input.completedAt);
    const beforeFingerprint = fingerprintStoreProjection(beforeProjection);
    const afterFingerprint = fingerprintStoreProjection(afterProjection);
    const changedSlices = changedStoreSlices(input.previousState, input.nextState);
    const invariants = inspectStoreInvariants(input.nextState, this.#limits, input.completedAt);
    const status = changedSlices.length > 0 || beforeFingerprint !== afterFingerprint
      ? 'changed'
      : 'noop';

    const transition = this.#history.record(Object.freeze({
      actionType,
      actionAudit,
      timestamp: input.completedAt,
      durationMs: duration(input.startedAt, input.completedAt),
      status,
      changedSlices,
      beforeFingerprint,
      afterFingerprint,
      invariantErrors: invariants.errorCount,
      invariantWarnings: invariants.warningCount,
      errorCode: null,
    }));

    this.#dispatches += 1;
    if (status === 'changed') this.#changedTransitions += 1;
    else this.#noopTransitions += 1;

    this.#lastState = input.nextState;
    this.#lastProjection = afterProjection;
    this.#lastFingerprint = afterFingerprint;
    this.#lastInvariants = invariants;
    this.#lastActionType = actionType;
    this.#subscriptions.notify(input.nextState, actionType, changedSlices);
    return transition;
  }

  recordFailure(input: StoreRuntimeFailureInput): StoreTransitionDescriptor {
    this.#assertActive();
    if (!this.#initialized) this.initialize(input.state);

    const actionType = readActionType(input.action);
    const actionAudit = auditStoreAction(input.action, this.#limits);
    const projection = projectStoreState(input.state, this.#limits, input.completedAt);
    const fingerprint = fingerprintStoreProjection(projection);
    const invariants = inspectStoreInvariants(input.state, this.#limits, input.completedAt);
    const transition = this.#history.record(Object.freeze({
      actionType,
      actionAudit,
      timestamp: input.completedAt,
      durationMs: duration(input.startedAt, input.completedAt),
      status: 'failed',
      changedSlices: Object.freeze([]),
      beforeFingerprint: fingerprint,
      afterFingerprint: fingerprint,
      invariantErrors: invariants.errorCount,
      invariantWarnings: invariants.warningCount,
      errorCode: readErrorCode(input.error),
    }));

    this.#dispatches += 1;
    this.#failedTransitions += 1;
    this.#lastState = input.state;
    this.#lastProjection = projection;
    this.#lastFingerprint = fingerprint;
    this.#lastInvariants = invariants;
    this.#lastActionType = actionType;
    return transition;
  }

  inspect(state?: RootState): StoreRuntimeSnapshot {
    const now = this.#clock();
    const projection = state
      ? projectStoreState(state, this.#limits, now)
      : this.#lastProjection;
    const invariants = state
      ? inspectStoreInvariants(state, this.#limits, now)
      : this.#lastInvariants;
    const fingerprint = projection
      ? fingerprintStoreProjection(projection)
      : this.#lastFingerprint;
    const history = this.#history.snapshot();

    return Object.freeze({
      generatedAt: now,
      health: Object.freeze({
        initialized: this.#initialized,
        disposed: this.#disposed,
        dispatches: this.#dispatches,
        changedTransitions: this.#changedTransitions,
        noopTransitions: this.#noopTransitions,
        failedTransitions: this.#failedTransitions,
        subscriberCount: this.#subscriptions.size,
        subscriberErrors: this.#subscriptions.errorCount,
        historyRetained: history.retained,
        invariantErrors: invariants?.errorCount ?? 0,
        invariantWarnings: invariants?.warningCount ?? 0,
        stateFingerprint: fingerprint,
        lastActionType: this.#lastActionType,
      } satisfies StoreRuntimeHealthSnapshot),
      projection,
      invariants,
      history,
    });
  }

  project(state?: RootState): StoreStateProjection | null {
    if (state) return projectStoreState(state, this.#limits, this.#clock());
    return this.#lastProjection;
  }

  exportSnapshot(state?: RootState): string | null {
    const projection = this.project(state);
    return projection ? encodeStoreSnapshot(projection, this.#limits) : null;
  }

  subscribeSelector<TSelected>(
    selector: (state: RootState) => TSelected,
    listener: (notification: StoreSelectorNotification<TSelected>) => void,
    options: StoreSelectorSubscriptionOptions<TSelected> = {},
  ): () => void {
    this.#assertActive();
    return this.#subscriptions.subscribe(selector, listener, options);
  }

  clearHistory(): number {
    return this.#history.clear();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#subscriptions.dispose();
    this.#lastState = null;
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw Object.assign(new Error('Store state runtime is disposed.'), {
        code: 'STORE_RUNTIME_DISPOSED',
      });
    }
  }
}

export const createStoreStateRuntime = (
  configuration: StoreRuntimeConfiguration = {},
): BoundedStoreStateRuntime => new BoundedStoreStateRuntime(configuration);
