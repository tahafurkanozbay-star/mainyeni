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
  #lastAt: number | undefined;

  constructor(limit = 256, clock: CacheClock = SYSTEM_CACHE_CLOCK) {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 4096) {
      throw new RangeError('cache journal limit is invalid');
    }
    this.#limit = limit;
    this.#clock = clock;
  }

  record(kind: string): void {
    if (this.#limit === 0) return;
    const normalizedKind = kind.trim();
    if (!normalizedKind || normalizedKind.length > 64) {
      throw new RangeError('cache event kind must contain 1-64 characters');
    }
    const at = this.#clock.now();
    if (!Number.isFinite(at) || at < 0) {
      throw new RangeError('cache event clock returned an invalid timestamp');
    }
    if (this.#lastAt !== undefined && at < this.#lastAt) {
      throw new RangeError('cache event clock must be monotonic');
    }
    this.#lastAt = at;
    this.#events.push(Object.freeze({
      sequence: ++this.#sequence,
      at,
      kind: normalizedKind,
    }));
    const overflow = this.#events.length - this.#limit;
    if (overflow > 0) this.#events.splice(0, overflow);
  }

  entries(): readonly CacheEvent[] {
    return Object.freeze(this.#events.map((event) => Object.freeze({ ...event })));
  }
}
