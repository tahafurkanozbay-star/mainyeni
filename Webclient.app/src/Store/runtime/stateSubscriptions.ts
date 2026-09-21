import type { RootState } from '../contracts';
import {
  normalizeStoreRuntimeLimits,
  type StoreRuntimeLimits,
  type StoreSelectorNotification,
  type StoreSelectorSubscriptionHub,
  type StoreSelectorSubscriptionOptions,
  type StoreSliceName,
} from './contracts';

type AnySubscription = {
  id: number;
  label: string | null;
  selector: (state: RootState) => unknown;
  listener: (notification: StoreSelectorNotification<unknown>) => void;
  equality: (left: unknown, right: unknown) => boolean;
  current: unknown;
  initialized: boolean;
};

const defaultEquality = (left: unknown, right: unknown): boolean => Object.is(left, right);

export class SelectorSubscriptionHub implements StoreSelectorSubscriptionHub {
  readonly #maxSubscribers: number;
  #subscriptions = new Map<number, AnySubscription>();
  #sequence = 0;
  #errors = 0;
  #state: RootState | null = null;
  #disposed = false;

  constructor(limitsInput: Partial<StoreRuntimeLimits> | StoreRuntimeLimits = {}) {
    this.#maxSubscribers = normalizeStoreRuntimeLimits(limitsInput).maxSubscribers;
  }

  get size(): number {
    return this.#subscriptions.size;
  }

  get errorCount(): number {
    return this.#errors;
  }

  initialize(state: RootState): void {
    if (this.#disposed) return;
    this.#state = state;
    for (const subscription of this.#subscriptions.values()) {
      this.#initializeSubscription(subscription, state, false);
    }
  }

  subscribe<TSelected>(
    selector: (state: RootState) => TSelected,
    listener: (notification: StoreSelectorNotification<TSelected>) => void,
    options: StoreSelectorSubscriptionOptions<TSelected> = {},
  ): () => void {
    if (this.#disposed) throw new Error('Store selector subscription hub is disposed.');
    if (typeof selector !== 'function' || typeof listener !== 'function') {
      throw new TypeError('Store selector subscription requires selector and listener functions.');
    }
    if (this.#subscriptions.size >= this.#maxSubscribers) {
      throw Object.assign(new Error('Store selector subscriber capacity exceeded.'), {
        code: 'STORE_SUBSCRIBER_LIMIT',
      });
    }

    const id = ++this.#sequence;
    const subscription: AnySubscription = {
      id,
      label: options.label ? String(options.label).slice(0, 120) : null,
      selector: selector as (state: RootState) => unknown,
      listener: listener as (notification: StoreSelectorNotification<unknown>) => void,
      equality: (options.equality ?? defaultEquality) as (left: unknown, right: unknown) => boolean,
      current: undefined,
      initialized: false,
    };
    this.#subscriptions.set(id, subscription);

    if (this.#state) {
      this.#initializeSubscription(subscription, this.#state, options.fireImmediately === true);
    }

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.#subscriptions.delete(id);
    };
  }

  notify(
    state: RootState,
    actionType: string,
    changedSlices: readonly StoreSliceName[],
  ): void {
    if (this.#disposed) return;
    this.#state = state;
    for (const subscription of this.#subscriptions.values()) {
      if (!subscription.initialized) {
        this.#initializeSubscription(subscription, state, false);
        continue;
      }

      let selected: unknown;
      try {
        selected = subscription.selector(state);
      } catch {
        this.#errors += 1;
        continue;
      }

      let equal = false;
      try {
        equal = subscription.equality(subscription.current, selected);
      } catch {
        this.#errors += 1;
        equal = false;
      }
      if (equal) continue;

      const previous = subscription.current;
      subscription.current = selected;
      try {
        subscription.listener(Object.freeze({
          current: selected,
          previous,
          actionType,
          changedSlices: Object.freeze([...changedSlices]),
        }));
      } catch {
        this.#errors += 1;
      }
    }
  }

  clear(): number {
    const count = this.#subscriptions.size;
    this.#subscriptions.clear();
    return count;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.clear();
    this.#state = null;
  }

  #initializeSubscription(
    subscription: AnySubscription,
    state: RootState,
    fireImmediately: boolean,
  ): void {
    try {
      const selected = subscription.selector(state);
      subscription.current = selected;
      subscription.initialized = true;
      if (fireImmediately) {
        subscription.listener(Object.freeze({
          current: selected,
          previous: selected,
          actionType: '@@store-runtime/initialize',
          changedSlices: Object.freeze([]),
        }));
      }
    } catch {
      this.#errors += 1;
    }
  }
}

export const createSelectorSubscriptionHub = (
  limits: Partial<StoreRuntimeLimits> | StoreRuntimeLimits = {},
): SelectorSubscriptionHub => new SelectorSubscriptionHub(limits);
