import {
  normalizeStoreRuntimeLimits,
  type StoreHistorySnapshot,
  type StoreRuntimeLimits,
  type StoreTransitionDescriptor,
} from './contracts';

export class StoreTransitionHistory {
  readonly #capacity: number;
  #entries: StoreTransitionDescriptor[] = [];
  #totalRecorded = 0;
  #dropped = 0;
  #changed = 0;
  #noop = 0;
  #failed = 0;

  constructor(limitsInput: Partial<StoreRuntimeLimits> | StoreRuntimeLimits = {}) {
    this.#capacity = normalizeStoreRuntimeLimits(limitsInput).maxHistoryEntries;
  }

  get size(): number {
    return this.#entries.length;
  }

  record(entry: StoreTransitionDescriptor): StoreTransitionDescriptor {
    const frozen = Object.freeze({
      ...entry,
      changedSlices: Object.freeze([...entry.changedSlices]),
    });
    this.#entries.unshift(frozen);
    this.#totalRecorded += 1;
    if (entry.status === 'changed') this.#changed += 1;
    else if (entry.status === 'noop') this.#noop += 1;
    else this.#failed += 1;

    if (this.#entries.length > this.#capacity) {
      this.#entries.length = this.#capacity;
      this.#dropped += 1;
    }
    return frozen;
  }

  list(): readonly StoreTransitionDescriptor[] {
    return Object.freeze([...this.#entries]);
  }

  clear(): number {
    const removed = this.#entries.length;
    this.#entries = [];
    return removed;
  }

  snapshot(): StoreHistorySnapshot {
    return Object.freeze({
      capacity: this.#capacity,
      retained: this.#entries.length,
      totalRecorded: this.#totalRecorded,
      dropped: this.#dropped,
      changed: this.#changed,
      noop: this.#noop,
      failed: this.#failed,
      entries: this.list(),
    });
  }
}

export const createStoreTransitionHistory = (
  limits: Partial<StoreRuntimeLimits> | StoreRuntimeLimits = {},
): StoreTransitionHistory => new StoreTransitionHistory(limits);
