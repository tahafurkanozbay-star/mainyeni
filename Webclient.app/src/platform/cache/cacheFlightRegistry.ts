import { cacheInteger, cacheKey } from './cacheContracts';
import {
  CacheFlightError,
  type CacheFlightRegistryOptions,
  type CacheFlightRequest,
  type CacheFlightSnapshot,
} from './cacheFlightContracts';

interface Subscriber<T> {
  readonly id: number;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
  readonly signal?: AbortSignal;
  unlink: (() => void) | null;
  settled: boolean;
}

interface Flight<T> {
  readonly key: string;
  readonly controller: AbortController;
  readonly subscribers: Map<number, Subscriber<T>>;
  settled: boolean;
}

export class CacheFlightRegistry {
  readonly #maxFlights: number;
  readonly #maxSubscribers: number;
  readonly #maxKeyLength: number;
  readonly #flights = new Map<string, Flight<unknown>>();
  #sequence = 0;
  #started = 0;
  #joined = 0;
  #completed = 0;
  #failed = 0;
  #cancelled = 0;
  #rejected = 0;
  #disposed = false;

  constructor(options: CacheFlightRegistryOptions = {}) {
    this.#maxFlights = cacheInteger('maxFlights', options.maxFlights ?? 64, 1, 4096);
    this.#maxSubscribers = cacheInteger(
      'maxSubscribersPerFlight',
      options.maxSubscribersPerFlight ?? 64,
      1,
      4096,
    );
    this.#maxKeyLength = cacheInteger('maxKeyLength', options.maxKeyLength ?? 2048, 32, 16384);
  }

  run<T>(request: CacheFlightRequest<T>): Promise<T> {
    if (this.#disposed) return this.#reject('disposed', 'cache flight registry is disposed');
    if (request.signal?.aborted) {
      return this.#reject('subscriber-aborted', 'cache flight subscriber is aborted');
    }
    const key = cacheKey(request.key, this.#maxKeyLength);
    const existing = this.#flights.get(key) as Flight<T> | undefined;
    if (existing) {
      this.#joined += 1;
      return this.#subscribe(existing, request.signal);
    }
    if (this.#flights.size >= this.#maxFlights) {
      return this.#reject('flight-capacity', 'cache flight capacity is exhausted');
    }

    const flight: Flight<T> = {
      key,
      controller: new AbortController(),
      subscribers: new Map(),
      settled: false,
    };
    this.#flights.set(key, flight as Flight<unknown>);
    this.#started += 1;
    const subscriber = this.#subscribe(flight, request.signal);
    this.#start(flight, request.operation);
    return subscriber;
  }

  has(rawKey: string): boolean {
    if (this.#disposed) return false;
    const key = cacheKey(rawKey, this.#maxKeyLength);
    return this.#flights.has(key);
  }

  snapshot(): CacheFlightSnapshot {
    let subscribers = 0;
    for (const flight of this.#flights.values()) subscribers += flight.subscribers.size;
    return Object.freeze({
      flights: this.#flights.size,
      subscribers,
      started: this.#started,
      joined: this.#joined,
      completed: this.#completed,
      failed: this.#failed,
      cancelled: this.#cancelled,
      rejected: this.#rejected,
    });
  }

  cancel(rawKey: string, reason?: unknown): boolean {
    const key = cacheKey(rawKey, this.#maxKeyLength);
    const flight = this.#flights.get(key);
    if (!flight || flight.settled) return false;
    flight.settled = true;
    this.#cancelled += 1;
    const error = new CacheFlightError('operation-cancelled', 'cache flight was cancelled', reason);
    if (!flight.controller.signal.aborted) flight.controller.abort(error);
    this.#settleAll(flight, error);
    this.#flights.delete(key);
    return true;
  }

  cancelAll(reason?: unknown): number {
    if (this.#disposed) return 0;
    const keys = [...this.#flights.keys()];
    let cancelled = 0;
    for (const key of keys) {
      if (this.cancel(key, reason)) cancelled += 1;
    }
    return cancelled;
  }

  dispose(reason?: unknown): void {
    if (this.#disposed) return;
    this.cancelAll(reason);
    this.#disposed = true;
  }

  #subscribe<T>(flight: Flight<T>, signal?: AbortSignal): Promise<T> {
    if (flight.subscribers.size >= this.#maxSubscribers) {
      return this.#reject('subscriber-capacity', 'cache flight subscriber capacity is exhausted');
    }
    return new Promise<T>((resolve, reject) => {
      const subscriber: Subscriber<T> = {
        id: ++this.#sequence,
        resolve,
        reject,
        ...(signal ? { signal } : {}),
        unlink: null,
        settled: false,
      };
      if (signal) {
        const onAbort = (): void => this.#abortSubscriber(flight, subscriber);
        signal.addEventListener('abort', onAbort, { once: true });
        subscriber.unlink = () => signal.removeEventListener('abort', onAbort);
      }
      flight.subscribers.set(subscriber.id, subscriber);
    });
  }

  #start<T>(flight: Flight<T>, operation: (signal: AbortSignal) => Promise<T>): void {
    let work: Promise<T>;
    try {
      work = Promise.resolve(operation(flight.controller.signal));
    } catch (error) {
      work = Promise.reject(error);
    }
    void work.then(
      (value) => {
        if (flight.settled) return;
        flight.settled = true;
        this.#completed += 1;
        for (const subscriber of flight.subscribers.values()) {
          this.#settle(subscriber, () => subscriber.resolve(value));
        }
        flight.subscribers.clear();
        this.#flights.delete(flight.key);
      },
      (error: unknown) => {
        if (flight.settled) return;
        flight.settled = true;
        this.#failed += 1;
        this.#settleAll(flight, error);
        this.#flights.delete(flight.key);
      },
    );
  }

  #abortSubscriber<T>(flight: Flight<T>, subscriber: Subscriber<T>): void {
    if (subscriber.settled) return;
    flight.subscribers.delete(subscriber.id);
    this.#settle(subscriber, () => subscriber.reject(new CacheFlightError(
      'subscriber-aborted',
      'cache flight subscriber aborted',
      subscriber.signal?.reason,
    )));
    if (flight.subscribers.size === 0 && !flight.settled) {
      flight.settled = true;
      this.#cancelled += 1;
      const error = new CacheFlightError(
        'operation-cancelled',
        'cache flight has no subscribers',
      );
      if (!flight.controller.signal.aborted) flight.controller.abort(error);
      this.#flights.delete(flight.key);
    }
  }

  #settleAll<T>(flight: Flight<T>, error: unknown): void {
    for (const subscriber of flight.subscribers.values()) {
      this.#settle(subscriber, () => subscriber.reject(error));
    }
    flight.subscribers.clear();
  }

  #settle<T>(subscriber: Subscriber<T>, action: () => void): void {
    if (subscriber.settled) return;
    subscriber.settled = true;
    subscriber.unlink?.();
    subscriber.unlink = null;
    action();
  }

  #reject<T>(code: CacheFlightError['code'], message: string): Promise<T> {
    this.#rejected += 1;
    return Promise.reject(new CacheFlightError(code, message));
  }
}
