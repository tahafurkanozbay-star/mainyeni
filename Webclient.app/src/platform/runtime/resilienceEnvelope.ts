export type ResilienceEnvelopeLane = 'critical' | 'interactive' | 'background';

export interface ResilienceEnvelopeBudget {
  readonly maxInFlight: number;
  readonly maxQueued: number;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
}

export interface ResilienceEnvelopeOptions {
  readonly critical?: Partial<ResilienceEnvelopeBudget>;
  readonly interactive?: Partial<ResilienceEnvelopeBudget>;
  readonly background?: Partial<ResilienceEnvelopeBudget>;
}

const DEFAULTS: Readonly<Record<ResilienceEnvelopeLane, ResilienceEnvelopeBudget>> = Object.freeze({
  critical: Object.freeze({ maxInFlight: 8, maxQueued: 32, timeoutMs: 15_000, maxAttempts: 3 }),
  interactive: Object.freeze({ maxInFlight: 6, maxQueued: 24, timeoutMs: 10_000, maxAttempts: 2 }),
  background: Object.freeze({ maxInFlight: 3, maxQueued: 12, timeoutMs: 30_000, maxAttempts: 2 }),
});

const integer = (value: number | undefined, fallback: number, max: number): number => {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) throw new RangeError('Resilience envelope values must be finite.');
  return Math.min(max, Math.max(1, Math.floor(value)));
};

const normalize = (lane: ResilienceEnvelopeLane, value: Partial<ResilienceEnvelopeBudget> | undefined): ResilienceEnvelopeBudget => {
  const fallback = DEFAULTS[lane];
  return Object.freeze({
    maxInFlight: integer(value?.maxInFlight, fallback.maxInFlight, 1_000),
    maxQueued: integer(value?.maxQueued, fallback.maxQueued, 10_000),
    timeoutMs: integer(value?.timeoutMs, fallback.timeoutMs, 600_000),
    maxAttempts: integer(value?.maxAttempts, fallback.maxAttempts, 10),
  });
};

export class ResilienceEnvelope {
  readonly #budgets: Readonly<Record<ResilienceEnvelopeLane, ResilienceEnvelopeBudget>>;

  constructor(options: ResilienceEnvelopeOptions = {}) {
    this.#budgets = Object.freeze({
      critical: normalize('critical', options.critical),
      interactive: normalize('interactive', options.interactive),
      background: normalize('background', options.background),
    });
  }

  budget(lane: ResilienceEnvelopeLane): ResilienceEnvelopeBudget {
    return this.#budgets[lane];
  }

  snapshot(): Readonly<Record<ResilienceEnvelopeLane, ResilienceEnvelopeBudget>> {
    return this.#budgets;
  }
}
