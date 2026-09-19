export interface CacheFlightRegistryOptions {
  readonly maxFlights?: number;
  readonly maxSubscribersPerFlight?: number;
  readonly maxKeyLength?: number;
}

export interface CacheFlightRequest<T> {
  readonly key: string;
  readonly signal?: AbortSignal;
  readonly operation: (signal: AbortSignal) => Promise<T>;
}

export interface CacheFlightSnapshot {
  readonly flights: number;
  readonly subscribers: number;
  readonly started: number;
  readonly joined: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly rejected: number;
}

export class CacheFlightError extends Error {
  constructor(
    readonly code:
      | 'disposed'
      | 'flight-capacity'
      | 'subscriber-capacity'
      | 'subscriber-aborted'
      | 'operation-cancelled',
    message: string,
    readonly reason?: unknown,
  ) {
    super(message);
    this.name = 'CacheFlightError';
  }
}
