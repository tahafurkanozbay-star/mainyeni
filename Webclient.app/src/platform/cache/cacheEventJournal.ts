import { type CacheClock, SYSTEM_CACHE_CLOCK } from './cacheContracts';

export interface CacheEvent {
  readonly sequence: number;
  readonly at: number;
  readonly kind: string;
}

export class CacheEventJournal {
  readonly #events: CacheEvent[] = [];
  readonly #clock: CacheClock;
  readonly #limit: number;
  #sequence = 0;

  constructor(limit = 256, clock: CacheClock = SYSTEM_CACHE_CLOCK) {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 4096) {
      throw new RangeError('cache journal limit is invalid');
    }
    this.#limit = limit;
    this.#clock = clock;
  }

  record(kind: string): void {
    if (this.#limit === 0) return;
    this.#events.push(Object.freeze({
      sequence: ++this.#sequence,
      at: this.#clock.now(),
      kind,
    }));
    while (this.#events.length > this.#limit) this.#events.shift();
  }

  entries(): readonly CacheEvent[] {
    return Object.freeze(this.#events.map((event) => Object.freeze({ ...event })));
  }
}
