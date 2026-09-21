export type LoadSheddingPriority = 'critical' | 'interactive' | 'background';

export interface LoadSheddingSample {
  readonly active: number;
  readonly queued: number;
  readonly latencyMs: number;
  readonly errorRate: number;
}

export interface LoadSheddingThresholds {
  readonly maxActive: number;
  readonly maxQueued: number;
  readonly maxLatencyMs: number;
  readonly maxErrorRate: number;
}

export interface LoadSheddingDecision {
  readonly admitted: boolean;
  readonly pressure: number;
  readonly reason: 'healthy' | 'capacity' | 'queue' | 'latency' | 'errors' | 'priority';
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
const ratio = (value: number, limit: number): number => limit > 0 ? Math.max(0, value) / limit : Number.POSITIVE_INFINITY;

export class LoadSheddingPolicy {
  readonly #thresholds: LoadSheddingThresholds;

  public constructor(thresholds: LoadSheddingThresholds) {
    if (thresholds.maxActive <= 0 || thresholds.maxQueued < 0 || thresholds.maxLatencyMs <= 0 || thresholds.maxErrorRate <= 0 || thresholds.maxErrorRate > 1) {
      throw new RangeError('Load shedding thresholds must be positive and bounded.');
    }
    this.#thresholds = Object.freeze({ ...thresholds });
  }

  public evaluate(sample: LoadSheddingSample, priority: LoadSheddingPriority): LoadSheddingDecision {
    const dimensions = {
      capacity: ratio(sample.active, this.#thresholds.maxActive),
      queue: this.#thresholds.maxQueued === 0 ? (sample.queued > 0 ? Number.POSITIVE_INFINITY : 0) : ratio(sample.queued, this.#thresholds.maxQueued),
      latency: ratio(sample.latencyMs, this.#thresholds.maxLatencyMs),
      errors: ratio(sample.errorRate, this.#thresholds.maxErrorRate),
    } as const;
    const pressure = Math.max(dimensions.capacity, dimensions.queue, dimensions.latency, dimensions.errors);
    if (pressure < 1) return { admitted: true, pressure: clamp01(pressure), reason: 'healthy' };
    const dominant = Object.entries(dimensions).reduce((best, current) => current[1] > best[1] ? current : best) as [Exclude<LoadSheddingDecision['reason'], 'healthy' | 'priority'>, number];
    if (priority === 'critical' && pressure < 1.5) return { admitted: true, pressure: clamp01(pressure), reason: 'priority' };
    if (priority === 'interactive' && pressure < 1.15) return { admitted: true, pressure: clamp01(pressure), reason: 'priority' };
    return { admitted: false, pressure: clamp01(pressure), reason: dominant[0] };
  }
}
