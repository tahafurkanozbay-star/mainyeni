export type DrainPhase = 'accepting' | 'draining' | 'drained' | 'disposed';

export interface DrainLease {
  readonly id: string;
  readonly key: string;
  readonly lane: string;
  readonly startedAt: number;
  readonly signal: AbortSignal;
  readonly release: () => boolean;
}

export interface DrainCoordinatorPolicy {
  readonly maxActive: number;
  readonly maxKeyLength: number;
  readonly maxLaneLength: number;
  readonly defaultTimeoutMs: number;
  readonly maxTimeoutMs: number;
}

export interface DrainRequest {
  readonly timeoutMs?: number;
  readonly cancelOnTimeout?: boolean;
  readonly reason?: unknown;
  readonly signal?: AbortSignal;
}

export interface DrainOutcome {
  readonly drained: boolean;
  readonly timedOut: boolean;
  readonly cancelled: number;
  readonly remaining: number;
  readonly durationMs: number;
  readonly phase: DrainPhase;
}

export interface DrainSnapshot {
  readonly phase: DrainPhase;
  readonly accepting: boolean;
  readonly active: number;
  readonly started: number;
  readonly completed: number;
  readonly cancelled: number;
  readonly rejected: number;
  readonly forced: number;
  readonly drainStartedAt: number | null;
  readonly byLane: Readonly<Record<string, number>>;
}

export interface DrainCoordinator {
  readonly enter: (key: string, lane?: string, signal?: AbortSignal) => DrainLease;
  readonly stopAccepting: () => void;
  readonly resumeAccepting: () => boolean;
  readonly drain: (request?: DrainRequest) => Promise<DrainOutcome>;
  readonly cancel: (predicate?: (lease: Readonly<DrainLease>) => boolean, reason?: unknown) => number;
  readonly snapshot: () => DrainSnapshot;
  readonly dispose: (reason?: unknown) => void;
}

export interface DrainCoordinatorClock {
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
}

export class DrainRejectedError extends Error {
  readonly code = 'PLATFORM_DRAIN_REJECTED';

  constructor(message = 'Runtime is not accepting new work.') {
    super(message);
    this.name = 'DrainRejectedError';
  }
}

export class DrainCapacityError extends Error {
  readonly code = 'PLATFORM_DRAIN_CAPACITY';

  constructor(message = 'Runtime drain coordinator active capacity is exhausted.') {
    super(message);
    this.name = 'DrainCapacityError';
  }
}

interface ActiveWork {
  readonly id: string;
  readonly key: string;
  readonly lane: string;
  readonly startedAt: number;
  readonly controller: AbortController;
  readonly lease: DrainLease;
  readonly externalSignal?: AbortSignal;
  externalCleanup?: () => void;
  released: boolean;
}

interface DrainWaiter {
  readonly startedAt: number;
  readonly cancelOnTimeout: boolean;
  readonly reason: unknown;
  readonly resolve: (outcome: DrainOutcome) => void;
  readonly signal?: AbortSignal;
  timeout: ReturnType<typeof setTimeout> | null;
  signalCleanup?: () => void;
  settled: boolean;
}

const DEFAULT_POLICY: DrainCoordinatorPolicy = Object.freeze({
  maxActive: 256,
  maxKeyLength: 160,
  maxLaneLength: 80,
  defaultTimeoutMs: 10_000,
  maxTimeoutMs: 120_000,
});

const DEFAULT_CLOCK: DrainCoordinatorClock = Object.freeze({
  now: () => Date.now(),
  setTimeout: (callback: () => void, delayMs: number) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(handle),
});

const positiveInt = (
  value: number | undefined,
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number => {
  if (!Number.isFinite(value) || Number(value) <= 0) return fallback;
  return Math.max(1, Math.min(maximum, Math.floor(Number(value))));
};

const boundedText = (value: string, maximum: number, fallback: string): string => {
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maximum) : fallback;
};

const abortError = (message: string): Error => {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
};

const normalizePolicy = (
  overrides: Partial<DrainCoordinatorPolicy>,
): DrainCoordinatorPolicy => Object.freeze({
  maxActive: positiveInt(overrides.maxActive, DEFAULT_POLICY.maxActive, 10_000),
  maxKeyLength: positiveInt(overrides.maxKeyLength, DEFAULT_POLICY.maxKeyLength, 1_024),
  maxLaneLength: positiveInt(overrides.maxLaneLength, DEFAULT_POLICY.maxLaneLength, 512),
  defaultTimeoutMs: positiveInt(
    overrides.defaultTimeoutMs,
    DEFAULT_POLICY.defaultTimeoutMs,
    DEFAULT_POLICY.maxTimeoutMs,
  ),
  maxTimeoutMs: positiveInt(overrides.maxTimeoutMs, DEFAULT_POLICY.maxTimeoutMs, 30 * 60_000),
});

export const createDrainCoordinator = (
  overrides: Partial<DrainCoordinatorPolicy> = {},
  clock: DrainCoordinatorClock = DEFAULT_CLOCK,
): DrainCoordinator => {
  const policy = normalizePolicy(overrides);
  const active = new Map<string, ActiveWork>();
  const waiters = new Set<DrainWaiter>();
  let sequence = 0;
  let phase: DrainPhase = 'accepting';
  let accepting = true;
  let started = 0;
  let completed = 0;
  let cancelled = 0;
  let rejected = 0;
  let forced = 0;
  let drainStartedAt: number | null = null;

  const nextId = (): string => {
    sequence = sequence >= Number.MAX_SAFE_INTEGER ? 1 : sequence + 1;
    return `drain-${sequence.toString(36)}`;
  };

  const activeByLane = (): Readonly<Record<string, number>> => {
    const lanes: Record<string, number> = {};
    for (const item of active.values()) {
      lanes[item.lane] = (lanes[item.lane] ?? 0) + 1;
    }
    return Object.freeze(lanes);
  };

  const snapshot = (): DrainSnapshot => Object.freeze({
    phase,
    accepting,
    active: active.size,
    started,
    completed,
    cancelled,
    rejected,
    forced,
    drainStartedAt,
    byLane: activeByLane(),
  });

  const detachExternalSignal = (work: ActiveWork): void => {
    work.externalCleanup?.();
    delete work.externalCleanup;
  };

  const settleWaiter = (
    waiter: DrainWaiter,
    timedOut: boolean,
    cancelledCount: number,
  ): void => {
    if (waiter.settled) return;
    waiter.settled = true;
    if (waiter.timeout !== null) {
      clock.clearTimeout(waiter.timeout);
      waiter.timeout = null;
    }
    waiter.signalCleanup?.();
    delete waiter.signalCleanup;
    waiters.delete(waiter);
    if (active.size === 0 && phase !== 'disposed') phase = 'drained';
    const endedAt = clock.now();
    waiter.resolve(Object.freeze({
      drained: active.size === 0,
      timedOut,
      cancelled: cancelledCount,
      remaining: active.size,
      durationMs: Math.max(0, endedAt - waiter.startedAt),
      phase,
    }));
  };

  const settleDrainedWaiters = (): void => {
    if (active.size !== 0) return;
    for (const waiter of waiters) settleWaiter(waiter, false, 0);
  };

  const releaseWork = (
    work: ActiveWork,
    wasCancelled: boolean,
  ): boolean => {
    if (work.released) return false;
    work.released = true;
    detachExternalSignal(work);
    if (!active.delete(work.id)) return false;
    if (wasCancelled) cancelled += 1;
    else completed += 1;
    settleDrainedWaiters();
    return true;
  };

  const forceCancel = (
    work: ActiveWork,
    reason: unknown,
  ): boolean => {
    if (work.released) return false;
    if (!work.controller.signal.aborted) {
      work.controller.abort(reason);
    }
    forced += 1;
    return releaseWork(work, true);
  };

  const enter = (
    rawKey: string,
    rawLane = 'default',
    externalSignal?: AbortSignal,
  ): DrainLease => {
    if (phase === 'disposed') {
      rejected += 1;
      throw new DrainRejectedError('Runtime drain coordinator is disposed.');
    }
    if (!accepting || phase === 'draining' || phase === 'drained') {
      rejected += 1;
      throw new DrainRejectedError();
    }
    if (active.size >= policy.maxActive) {
      rejected += 1;
      throw new DrainCapacityError();
    }
    if (externalSignal?.aborted) {
      rejected += 1;
      const reason = externalSignal.reason;
      throw reason instanceof Error ? reason : abortError('Runtime work was already aborted.');
    }

    const id = nextId();
    const key = boundedText(rawKey, policy.maxKeyLength, id);
    const lane = boundedText(rawLane, policy.maxLaneLength, 'default');
    const controller = new AbortController();
    let work!: ActiveWork;
    let released = false;

    const lease: DrainLease = Object.freeze({
      id,
      key,
      lane,
      startedAt: clock.now(),
      signal: controller.signal,
      release: () => {
        if (released) return false;
        released = true;
        return releaseWork(work, controller.signal.aborted);
      },
    });

    work = {
      id,
      key,
      lane,
      startedAt: lease.startedAt,
      controller,
      lease,
      ...(externalSignal ? { externalSignal } : {}),
      released: false,
    };

    if (externalSignal) {
      const onAbort = (): void => {
        const reason = externalSignal.reason instanceof Error
          ? externalSignal.reason
          : abortError('Runtime work was externally aborted.');
        if (!controller.signal.aborted) controller.abort(reason);
        released = true;
        releaseWork(work, true);
      };
      externalSignal.addEventListener('abort', onAbort, { once: true });
      work.externalCleanup = () => externalSignal.removeEventListener('abort', onAbort);
    }

    active.set(id, work);
    started += 1;
    return lease;
  };

  const stopAccepting = (): void => {
    if (phase === 'disposed') return;
    accepting = false;
    if (active.size === 0) phase = 'drained';
    else if (phase === 'accepting') phase = 'draining';
    if (drainStartedAt === null) drainStartedAt = clock.now();
    settleDrainedWaiters();
  };

  const resumeAccepting = (): boolean => {
    if (phase === 'disposed' || active.size !== 0 || waiters.size !== 0) return false;
    accepting = true;
    phase = 'accepting';
    drainStartedAt = null;
    return true;
  };

  const cancel = (
    predicate: (lease: Readonly<DrainLease>) => boolean = () => true,
    reason: unknown = abortError('Runtime work cancelled by drain coordinator.'),
  ): number => {
    if (phase === 'disposed') return 0;
    let count = 0;
    for (const work of active.values()) {
      if (!predicate(work.lease)) continue;
      if (forceCancel(work, reason)) count += 1;
    }
    return count;
  };

  const drain = (request: DrainRequest = {}): Promise<DrainOutcome> => {
    if (phase === 'disposed') {
      return Promise.resolve(Object.freeze({
        drained: true,
        timedOut: false,
        cancelled: 0,
        remaining: 0,
        durationMs: 0,
        phase,
      }));
    }

    stopAccepting();
    const startedAt = clock.now();
    if (active.size === 0) {
      phase = 'drained';
      return Promise.resolve(Object.freeze({
        drained: true,
        timedOut: false,
        cancelled: 0,
        remaining: 0,
        durationMs: 0,
        phase,
      }));
    }

    if (request.signal?.aborted) {
      const reason = request.signal.reason instanceof Error
        ? request.signal.reason
        : abortError('Drain request aborted.');
      return Promise.reject(reason);
    }

    const timeoutMs = positiveInt(
      request.timeoutMs,
      policy.defaultTimeoutMs,
      policy.maxTimeoutMs,
    );
    const cancelOnTimeout = request.cancelOnTimeout !== false;
    const reason = request.reason ?? abortError('Runtime drain deadline exceeded.');

    return new Promise<DrainOutcome>((resolve, reject) => {
      const waiter: DrainWaiter = {
        startedAt,
        cancelOnTimeout,
        reason,
        resolve,
        ...(request.signal ? { signal: request.signal } : {}),
        timeout: null,
        settled: false,
      };

      if (request.signal) {
        const onAbort = (): void => {
          if (waiter.settled) return;
          waiter.settled = true;
          if (waiter.timeout !== null) clock.clearTimeout(waiter.timeout);
          waiters.delete(waiter);
          waiter.signalCleanup?.();
          const signalReason = request.signal?.reason;
          reject(signalReason instanceof Error ? signalReason : abortError('Drain request aborted.'));
        };
        request.signal.addEventListener('abort', onAbort, { once: true });
        waiter.signalCleanup = () => request.signal?.removeEventListener('abort', onAbort);
      }

      waiter.timeout = clock.setTimeout(() => {
        if (waiter.settled) return;
        let cancelledCount = 0;
        if (waiter.cancelOnTimeout) {
          for (const work of active.values()) {
            if (forceCancel(work, waiter.reason)) cancelledCount += 1;
          }
        }
        settleWaiter(waiter, true, cancelledCount);
      }, timeoutMs);

      waiters.add(waiter);
      settleDrainedWaiters();
    });
  };

  const dispose = (
    reason: unknown = abortError('Runtime drain coordinator disposed.'),
  ): void => {
    if (phase === 'disposed') return;
    accepting = false;
    for (const work of active.values()) forceCancel(work, reason);
    phase = 'disposed';
    drainStartedAt ??= clock.now();
    for (const waiter of waiters) settleWaiter(waiter, false, 0);
  };

  return Object.freeze({
    enter,
    stopAccepting,
    resumeAccepting,
    drain,
    cancel,
    snapshot,
    dispose,
  });
};
