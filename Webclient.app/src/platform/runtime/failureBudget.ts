export type FailureBudgetOutcome = 'success' | 'failure' | 'ignored';
export type FailureBudgetState = 'healthy' | 'degraded' | 'exhausted';

export interface FailureBudgetOptions {
  readonly windowMs?: number;
  readonly bucketMs?: number;
  readonly minimumSamples?: number;
  readonly degradedFailureRatio?: number;
  readonly exhaustedFailureRatio?: number;
  readonly recoveryFailureRatio?: number;
  readonly recoverySamples?: number;
  readonly historyLimit?: number;
  readonly clock?: () => number;
}

export interface FailureBudgetRecordOptions {
  readonly weight?: number;
  readonly owner?: string;
}

export interface FailureBudgetSnapshot {
  readonly state: FailureBudgetState;
  readonly windowStartedAt: number;
  readonly windowEndsAt: number;
  readonly totalWeight: number;
  readonly successWeight: number;
  readonly failureWeight: number;
  readonly ignoredWeight: number;
  readonly failureRatio: number;
  readonly samples: number;
  readonly recoveryProgress: number;
  readonly transitionCount: number;
}

export interface FailureBudgetEvent {
  readonly sequence: number;
  readonly at: number;
  readonly kind: 'recorded' | 'transition' | 'reset';
  readonly state: FailureBudgetState;
  readonly outcome?: FailureBudgetOutcome;
  readonly owner?: string;
  readonly weight?: number;
  readonly failureRatio?: number;
}

interface Bucket {
  readonly startedAt: number;
  successWeight: number;
  failureWeight: number;
  ignoredWeight: number;
  samples: number;
}

const integer = (name: string, value: number, min: number, max: number): number => {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be between ${min} and ${max}`);
  }
  return value;
};

const ratio = (name: string, value: number): number => {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${name} must be between 0 and 1`);
  }
  return value;
};

const ownerKey = (owner: string | undefined): string | undefined => {
  if (owner === undefined) return undefined;
  const value = owner.trim();
  if (value.length === 0) throw new RangeError('owner must not be empty');
  if (value.length > 128) throw new RangeError('owner must be at most 128 characters');
  return value;
};

const recordWeight = (weight: number | undefined): number => {
  const value = weight ?? 1;
  if (!Number.isFinite(value) || value <= 0 || value > 1_000) {
    throw new RangeError('weight must be greater than 0 and at most 1000');
  }
  return value;
};

/**
 * A deterministic rolling failure budget for shared browser runtime work.
 *
 * This primitive deliberately does not retry, poll, perform network I/O, or
 * schedule background timers. Consumers record outcomes at an existing
 * ownership boundary and inspect the bounded rolling window when deciding
 * whether optional work should be admitted or degraded.
 */
export class BoundedFailureBudget {
  readonly windowMs: number;
  readonly bucketMs: number;
  readonly minimumSamples: number;
  readonly degradedFailureRatio: number;
  readonly exhaustedFailureRatio: number;
  readonly recoveryFailureRatio: number;
  readonly recoverySamples: number;
  readonly historyLimit: number;
  readonly #clock: () => number;
  readonly #buckets: Bucket[] = [];
  readonly #history: FailureBudgetEvent[] = [];
  #state: FailureBudgetState = 'healthy';
  #recoveryProgress = 0;
  #transitionCount = 0;
  #sequence = 0;
  #lastObservedAt: number | undefined;

  constructor(options: FailureBudgetOptions = {}) {
    this.windowMs = integer('windowMs', options.windowMs ?? 60_000, 1_000, 3_600_000);
    this.bucketMs = integer('bucketMs', options.bucketMs ?? 5_000, 100, this.windowMs);
    if (this.windowMs % this.bucketMs !== 0) {
      throw new RangeError('windowMs must be divisible by bucketMs');
    }
    this.minimumSamples = integer('minimumSamples', options.minimumSamples ?? 10, 1, 100_000);
    this.degradedFailureRatio = ratio('degradedFailureRatio', options.degradedFailureRatio ?? 0.2);
    this.exhaustedFailureRatio = ratio('exhaustedFailureRatio', options.exhaustedFailureRatio ?? 0.5);
    this.recoveryFailureRatio = ratio('recoveryFailureRatio', options.recoveryFailureRatio ?? 0.1);
    if (this.degradedFailureRatio >= this.exhaustedFailureRatio) {
      throw new RangeError('degradedFailureRatio must be lower than exhaustedFailureRatio');
    }
    if (this.recoveryFailureRatio >= this.degradedFailureRatio) {
      throw new RangeError('recoveryFailureRatio must be lower than degradedFailureRatio');
    }
    this.recoverySamples = integer('recoverySamples', options.recoverySamples ?? 5, 1, 100_000);
    this.historyLimit = integer('historyLimit', options.historyLimit ?? 64, 0, 1_000);
    this.#clock = options.clock ?? Date.now;
  }

  record(outcome: FailureBudgetOutcome, options: FailureBudgetRecordOptions = {}): FailureBudgetSnapshot {
    if (outcome !== 'success' && outcome !== 'failure' && outcome !== 'ignored') {
      throw new TypeError('outcome must be success, failure, or ignored');
    }
    const owner = ownerKey(options.owner);
    const weight = recordWeight(options.weight);
    const now = this.#now();
    this.#prune(now);
    const bucket = this.#bucketFor(now);
    if (outcome === 'success') bucket.successWeight += weight;
    else if (outcome === 'failure') bucket.failureWeight += weight;
    else bucket.ignoredWeight += weight;
    bucket.samples += 1;

    const aggregate = this.#aggregate(now);
    this.#record({ kind: 'recorded', state: this.#state, outcome, ...(owner ? { owner } : {}), weight, failureRatio: aggregate.failureRatio }, now);
    this.#evaluate(aggregate, outcome, now);
    return this.#snapshotFrom(now, aggregate);
  }

  snapshot(): FailureBudgetSnapshot {
    const now = this.#now();
    this.#prune(now);
    const aggregate = this.#aggregate(now);
    this.#evaluate(aggregate, undefined, now);
    return this.#snapshotFrom(now, aggregate);
  }

  history(): readonly FailureBudgetEvent[] {
    return Object.freeze(this.#history.map(event => Object.freeze({ ...event })));
  }

  allowsOptionalWork(): boolean {
    return this.snapshot().state !== 'exhausted';
  }

  reset(): FailureBudgetSnapshot {
    const now = this.#now();
    this.#buckets.length = 0;
    this.#state = 'healthy';
    this.#recoveryProgress = 0;
    this.#record({ kind: 'reset', state: 'healthy' }, now);
    return this.#snapshotFrom(now, this.#aggregate(now));
  }

  #now(): number {
    const now = this.#clock();
    if (!Number.isFinite(now) || now < 0) throw new RangeError('clock must return a finite non-negative timestamp');
    if (this.#lastObservedAt !== undefined && now < this.#lastObservedAt) {
      throw new RangeError('clock must be monotonic');
    }
    this.#lastObservedAt = now;
    return now;
  }

  #bucketFor(now: number): Bucket {
    const startedAt = Math.floor(now / this.bucketMs) * this.bucketMs;
    const existing = this.#buckets.at(-1);
    if (existing?.startedAt === startedAt) return existing;
    const bucket: Bucket = { startedAt, successWeight: 0, failureWeight: 0, ignoredWeight: 0, samples: 0 };
    this.#buckets.push(bucket);
    return bucket;
  }

  #prune(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.#buckets[0] && this.#buckets[0].startedAt <= cutoff) this.#buckets.shift();
  }

  #aggregate(now: number): {
    successWeight: number;
    failureWeight: number;
    ignoredWeight: number;
    totalWeight: number;
    failureRatio: number;
    samples: number;
    windowStartedAt: number;
  } {
    let successWeight = 0;
    let failureWeight = 0;
    let ignoredWeight = 0;
    let samples = 0;
    for (const bucket of this.#buckets) {
      successWeight += bucket.successWeight;
      failureWeight += bucket.failureWeight;
      ignoredWeight += bucket.ignoredWeight;
      samples += bucket.samples;
    }
    const consideredWeight = successWeight + failureWeight;
    return {
      successWeight,
      failureWeight,
      ignoredWeight,
      totalWeight: consideredWeight + ignoredWeight,
      failureRatio: consideredWeight === 0 ? 0 : failureWeight / consideredWeight,
      samples,
      windowStartedAt: this.#buckets[0]?.startedAt ?? now,
    };
  }

  #evaluate(
    aggregate: { failureRatio: number; samples: number },
    outcome: FailureBudgetOutcome | undefined,
    now: number,
  ): void {
    if (aggregate.samples < this.minimumSamples) {
      this.#recoveryProgress = 0;
      if (this.#state !== 'healthy') this.#transition('healthy', aggregate.failureRatio, now);
      return;
    }

    if (aggregate.failureRatio >= this.exhaustedFailureRatio) {
      this.#recoveryProgress = 0;
      if (this.#state !== 'exhausted') this.#transition('exhausted', aggregate.failureRatio, now);
      return;
    }

    if (aggregate.failureRatio >= this.degradedFailureRatio) {
      this.#recoveryProgress = 0;
      if (this.#state !== 'degraded') this.#transition('degraded', aggregate.failureRatio, now);
      return;
    }

    if (this.#state === 'healthy') {
      this.#recoveryProgress = 0;
      return;
    }

    if (aggregate.failureRatio <= this.recoveryFailureRatio && outcome === 'success') {
      this.#recoveryProgress += 1;
      if (this.#recoveryProgress >= this.recoverySamples) {
        this.#recoveryProgress = 0;
        this.#transition('healthy', aggregate.failureRatio, now);
      }
      return;
    }

    this.#recoveryProgress = 0;
  }

  #transition(state: FailureBudgetState, failureRatio: number, now: number): void {
    this.#state = state;
    this.#transitionCount += 1;
    this.#record({ kind: 'transition', state, failureRatio }, now);
  }

  #snapshotFrom(
    now: number,
    aggregate: {
      successWeight: number;
      failureWeight: number;
      ignoredWeight: number;
      totalWeight: number;
      failureRatio: number;
      samples: number;
      windowStartedAt: number;
    },
  ): FailureBudgetSnapshot {
    return Object.freeze({
      state: this.#state,
      windowStartedAt: aggregate.windowStartedAt,
      windowEndsAt: aggregate.windowStartedAt + this.windowMs,
      totalWeight: aggregate.totalWeight,
      successWeight: aggregate.successWeight,
      failureWeight: aggregate.failureWeight,
      ignoredWeight: aggregate.ignoredWeight,
      failureRatio: aggregate.failureRatio,
      samples: aggregate.samples,
      recoveryProgress: this.#recoveryProgress,
      transitionCount: this.#transitionCount,
    });
  }

  #record(event: Omit<FailureBudgetEvent, 'sequence' | 'at'>, now: number): void {
    if (this.historyLimit === 0) return;
    this.#history.push(Object.freeze({ sequence: ++this.#sequence, at: now, ...event }));
    while (this.#history.length > this.historyLimit) this.#history.shift();
  }
}
