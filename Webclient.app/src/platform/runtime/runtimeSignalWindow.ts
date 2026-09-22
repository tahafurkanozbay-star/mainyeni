export type RuntimeSignalLane = 'critical' | 'interactive' | 'background';

export interface RuntimeSignalSample {
  readonly lane: RuntimeSignalLane;
  readonly latencyMs: number;
  readonly success: boolean;
  readonly timestampMs: number;
  readonly weight?: number;
}

export interface RuntimeSignalWindowOptions {
  readonly capacity?: number;
  readonly maxAgeMs?: number;
  readonly maxLatencyMs?: number;
  readonly maxWeight?: number;
}

export interface RuntimeSignalLaneSnapshot {
  readonly count: number;
  readonly weightedCount: number;
  readonly successes: number;
  readonly failures: number;
  readonly successRate: number;
  readonly errorRate: number;
  readonly meanLatencyMs: number;
  readonly p50LatencyMs: number;
  readonly p95LatencyMs: number;
  readonly maxLatencyMs: number;
}

export interface RuntimeSignalWindowSnapshot extends RuntimeSignalLaneSnapshot {
  readonly capacity: number;
  readonly maxAgeMs: number;
  readonly oldestTimestampMs: number | null;
  readonly newestTimestampMs: number | null;
  readonly evictedByCapacity: number;
  readonly evictedByAge: number;
  readonly rejected: number;
  readonly lanes: Readonly<Record<RuntimeSignalLane, RuntimeSignalLaneSnapshot>>;
}

const DEFAULT_CAPACITY = 128;
const MAX_CAPACITY = 4_096;
const DEFAULT_MAX_AGE_MS = 60_000;
const MAX_MAX_AGE_MS = 86_400_000;
const DEFAULT_MAX_LATENCY_MS = 120_000;
const MAX_MAX_LATENCY_MS = 600_000;
const DEFAULT_MAX_WEIGHT = 100;
const MAX_MAX_WEIGHT = 10_000;
const LANES: readonly RuntimeSignalLane[] = ['critical', 'interactive', 'background'];

interface StoredSample extends RuntimeSignalSample {
  readonly weight: number;
}

const finitePositive = (value: number, name: string): number => {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be a finite positive number`);
  return value;
};

const boundedInteger = (value: number, max: number, name: string): number => {
  finitePositive(value, name);
  if (!Number.isInteger(value) || value > max) throw new RangeError(`${name} must be an integer between 1 and ${max}`);
  return value;
};

const emptyLane = (): RuntimeSignalLaneSnapshot => Object.freeze({
  count: 0,
  weightedCount: 0,
  successes: 0,
  failures: 0,
  successRate: 1,
  errorRate: 0,
  meanLatencyMs: 0,
  p50LatencyMs: 0,
  p95LatencyMs: 0,
  maxLatencyMs: 0,
});

const percentile = (sorted: readonly number[], fraction: number): number => {
  if (sorted.length === 0) return 0;
  const rank = Math.max(1, Math.ceil(sorted.length * fraction));
  return sorted[Math.min(rank - 1, sorted.length - 1)] ?? 0;
};

export class RuntimeSignalWindow {
  readonly #capacity: number;
  readonly #maxAgeMs: number;
  readonly #maxLatencyMs: number;
  readonly #maxWeight: number;
  readonly #samples: StoredSample[] = [];
  #lastTimestampMs: number | null = null;
  #evictedByCapacity = 0;
  #evictedByAge = 0;
  #rejected = 0;

  public constructor(options: RuntimeSignalWindowOptions = {}) {
    this.#capacity = boundedInteger(options.capacity ?? DEFAULT_CAPACITY, MAX_CAPACITY, 'capacity');
    this.#maxAgeMs = finitePositive(options.maxAgeMs ?? DEFAULT_MAX_AGE_MS, 'maxAgeMs');
    if (this.#maxAgeMs > MAX_MAX_AGE_MS) throw new RangeError(`maxAgeMs must be <= ${MAX_MAX_AGE_MS}`);
    this.#maxLatencyMs = finitePositive(options.maxLatencyMs ?? DEFAULT_MAX_LATENCY_MS, 'maxLatencyMs');
    if (this.#maxLatencyMs > MAX_MAX_LATENCY_MS) throw new RangeError(`maxLatencyMs must be <= ${MAX_MAX_LATENCY_MS}`);
    this.#maxWeight = finitePositive(options.maxWeight ?? DEFAULT_MAX_WEIGHT, 'maxWeight');
    if (this.#maxWeight > MAX_MAX_WEIGHT) throw new RangeError(`maxWeight must be <= ${MAX_MAX_WEIGHT}`);
  }

  public record(sample: RuntimeSignalSample): boolean {
    if (!LANES.includes(sample.lane)) return this.#reject();
    if (!Number.isFinite(sample.timestampMs) || sample.timestampMs < 0) return this.#reject();
    if (this.#lastTimestampMs !== null && sample.timestampMs < this.#lastTimestampMs) return this.#reject();
    if (!Number.isFinite(sample.latencyMs) || sample.latencyMs < 0) return this.#reject();
    const weight = sample.weight ?? 1;
    if (!Number.isFinite(weight) || weight <= 0 || weight > this.#maxWeight) return this.#reject();

    this.evictExpired(sample.timestampMs);
    this.#samples.push(Object.freeze({
      lane: sample.lane,
      latencyMs: Math.min(sample.latencyMs, this.#maxLatencyMs),
      success: sample.success,
      timestampMs: sample.timestampMs,
      weight,
    }));
    this.#lastTimestampMs = sample.timestampMs;

    while (this.#samples.length > this.#capacity) {
      this.#samples.shift();
      this.#evictedByCapacity += 1;
    }
    return true;
  }

  public evictExpired(nowMs: number): number {
    if (!Number.isFinite(nowMs) || nowMs < 0) throw new RangeError('nowMs must be a finite non-negative number');
    if (this.#lastTimestampMs !== null && nowMs < this.#lastTimestampMs) throw new RangeError('nowMs must not move backwards');
    let removed = 0;
    const cutoff = nowMs - this.#maxAgeMs;
    while (this.#samples.length > 0 && (this.#samples[0]?.timestampMs ?? nowMs) < cutoff) {
      this.#samples.shift();
      removed += 1;
    }
    this.#evictedByAge += removed;
    this.#lastTimestampMs = nowMs;
    return removed;
  }

  public clear(): void {
    this.#samples.length = 0;
    this.#lastTimestampMs = null;
  }

  public snapshot(): RuntimeSignalWindowSnapshot {
    const all = this.#summarize(this.#samples);
    const lanes = Object.freeze({
      critical: this.#summarize(this.#samples.filter(sample => sample.lane === 'critical')),
      interactive: this.#summarize(this.#samples.filter(sample => sample.lane === 'interactive')),
      background: this.#summarize(this.#samples.filter(sample => sample.lane === 'background')),
    });
    return Object.freeze({
      ...all,
      capacity: this.#capacity,
      maxAgeMs: this.#maxAgeMs,
      oldestTimestampMs: this.#samples[0]?.timestampMs ?? null,
      newestTimestampMs: this.#samples.at(-1)?.timestampMs ?? null,
      evictedByCapacity: this.#evictedByCapacity,
      evictedByAge: this.#evictedByAge,
      rejected: this.#rejected,
      lanes,
    });
  }

  #reject(): false {
    this.#rejected += 1;
    return false;
  }

  #summarize(samples: readonly StoredSample[]): RuntimeSignalLaneSnapshot {
    if (samples.length === 0) return emptyLane();
    const latencies = samples.map(sample => sample.latencyMs).sort((a, b) => a - b);
    let weightedCount = 0;
    let weightedLatency = 0;
    let successWeight = 0;
    let successes = 0;
    for (const sample of samples) {
      weightedCount += sample.weight;
      weightedLatency += sample.latencyMs * sample.weight;
      if (sample.success) {
        successWeight += sample.weight;
        successes += 1;
      }
    }
    const successRate = weightedCount === 0 ? 1 : successWeight / weightedCount;
    return Object.freeze({
      count: samples.length,
      weightedCount,
      successes,
      failures: samples.length - successes,
      successRate,
      errorRate: 1 - successRate,
      meanLatencyMs: weightedCount === 0 ? 0 : weightedLatency / weightedCount,
      p50LatencyMs: percentile(latencies, 0.5),
      p95LatencyMs: percentile(latencies, 0.95),
      maxLatencyMs: latencies.at(-1) ?? 0,
    });
  }
}
