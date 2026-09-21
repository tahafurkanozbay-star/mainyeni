import { describe, expect, it } from 'vitest';
import { AdaptiveResilienceController, type ResilienceControllerOptions, type ResilienceSample } from './adaptiveResilienceController';

const options = (override: Partial<ResilienceControllerOptions> = {}): ResilienceControllerOptions => ({
  minConcurrency: 2,
  maxConcurrency: 10,
  initialConcurrency: 6,
  queueCapacity: 8,
  targetLatencyMs: 100,
  errorRateLimit: 0.25,
  sampleWindow: 4,
  recoveryStep: 1,
  pressureDecreaseFactor: 0.5,
  retryBudgetRatio: 0.2,
  retryBudgetMinimum: 1,
  retryBudgetMaximum: 4,
  cooldownMs: 0,
  ...override,
});

const complete = (controller: AdaptiveResilienceController, latencyMs: number, success = true): void => {
  const lease = controller.acquire('background');
  expect(lease).not.toBeNull();
  lease?.complete({ latencyMs, success });
};

const completeBatch = (controller: AdaptiveResilienceController, samples: readonly ResilienceSample[]): void => {
  const leases = samples.map(() => controller.acquire('critical'));
  expect(leases.every(lease => lease !== null)).toBe(true);
  leases.forEach((lease, index) => lease?.complete(samples[index] ?? { latencyMs: 0, success: true }));
};

describe('AdaptiveResilienceController', () => {
  it('starts with configured bounded state', () => {
    const controller = new AdaptiveResilienceController(options());
    expect(controller.snapshot()).toMatchObject({ active: 0, queued: 0, concurrencyLimit: 6, sampleCount: 0, retryTokens: 1 });
  });

  it('rejects invalid configuration deterministically', () => {
    expect(() => new AdaptiveResilienceController(options({ minConcurrency: 0 }))).toThrow(RangeError);
    expect(() => new AdaptiveResilienceController(options({ initialConcurrency: 11 }))).toThrow(RangeError);
    expect(() => new AdaptiveResilienceController(options({ targetLatencyMs: 0 }))).toThrow(RangeError);
    expect(() => new AdaptiveResilienceController(options({ errorRateLimit: 2 }))).toThrow(RangeError);
    expect(() => new AdaptiveResilienceController(options({ sampleWindow: 3 }))).toThrow(RangeError);
    expect(() => new AdaptiveResilienceController(options({ pressureDecreaseFactor: 1 }))).toThrow(RangeError);
    expect(() => new AdaptiveResilienceController(options({ retryBudgetRatio: -1 }))).toThrow(RangeError);
  });

  it('enforces active concurrency without a timer or queue owner', () => {
    const controller = new AdaptiveResilienceController(options({ initialConcurrency: 2 }));
    const first = controller.acquire('background');
    const second = controller.acquire('background');
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(controller.acquire('critical')).toBeNull();
    expect(controller.snapshot()).toMatchObject({ active: 2, admitted: 2, rejected: 1 });
    first?.complete({ latencyMs: 10, success: true });
    expect(controller.snapshot().active).toBe(1);
  });

  it('makes lease completion idempotent', () => {
    const controller = new AdaptiveResilienceController(options());
    const lease = controller.acquire('interactive');
    expect(lease).not.toBeNull();
    lease?.complete({ latencyMs: 10, success: true });
    lease?.complete({ latencyMs: 999, success: false });
    expect(controller.snapshot()).toMatchObject({ active: 0, completed: 1, failed: 0, sampleCount: 1 });
  });

  it('bounds externally reported queue pressure', () => {
    const controller = new AdaptiveResilienceController(options());
    controller.setQueued(1_000_000);
    expect(controller.snapshot().queued).toBe(9);
    expect(controller.evaluate('background')).toMatchObject({ admitted: false, reason: 'queue' });
  });

  it('rejects invalid queue counts', () => {
    const controller = new AdaptiveResilienceController(options());
    expect(() => controller.setQueued(-1)).toThrow(RangeError);
    expect(() => controller.setQueued(1.5)).toThrow(RangeError);
  });

  it('multiplicatively decreases concurrency under sustained latency pressure', () => {
    const controller = new AdaptiveResilienceController(options());
    completeBatch(controller, [120, 130, 140, 150].map(latencyMs => ({ latencyMs, success: true })));
    expect(controller.snapshot()).toMatchObject({ concurrencyLimit: 3, adjustments: 1, latencyP95Ms: 150 });
  });

  it('never decreases below the configured minimum', () => {
    const controller = new AdaptiveResilienceController(options({ initialConcurrency: 4 }));
    completeBatch(controller, Array.from({ length: 4 }, () => ({ latencyMs: 500, success: true })));
    expect(controller.snapshot().concurrencyLimit).toBe(2);
  });

  it('additively recovers when the rolling window is healthy', () => {
    const controller = new AdaptiveResilienceController(options({ initialConcurrency: 4 }));
    complete(controller, 10);
    complete(controller, 10);
    complete(controller, 10);
    complete(controller, 10);
    expect(controller.snapshot().concurrencyLimit).toBe(5);
    complete(controller, 10);
    expect(controller.snapshot().concurrencyLimit).toBe(6);
  });

  it('never recovers above maximum concurrency', () => {
    const controller = new AdaptiveResilienceController(options({ initialConcurrency: 10 }));
    for (let i = 0; i < 8; i += 1) complete(controller, 1);
    expect(controller.snapshot().concurrencyLimit).toBe(10);
  });

  it('decreases on rolling error pressure', () => {
    const controller = new AdaptiveResilienceController(options());
    completeBatch(controller, [
      { latencyMs: 10, success: false },
      { latencyMs: 10, success: true },
      { latencyMs: 10, success: true },
      { latencyMs: 10, success: true },
    ]);
    expect(controller.snapshot()).toMatchObject({ concurrencyLimit: 3, errorRate: 0.25, failed: 1 });
  });

  it('keeps only the configured rolling sample window', () => {
    const controller = new AdaptiveResilienceController(options());
    for (let i = 0; i < 20; i += 1) complete(controller, 10);
    expect(controller.snapshot().sampleCount).toBe(4);
  });

  it('uses deterministic p95 latency from the bounded window', () => {
    const controller = new AdaptiveResilienceController(options({ sampleWindow: 5 }));
    for (const latencyMs of [10, 20, 30, 40, 50]) complete(controller, latencyMs);
    expect(controller.snapshot().latencyP95Ms).toBe(50);
  });

  it('spends retry tokens only when retry work is admitted', () => {
    const controller = new AdaptiveResilienceController(options({ retryBudgetMinimum: 1, retryBudgetMaximum: 1 }));
    const retry = controller.acquire('interactive', true);
    expect(retry).not.toBeNull();
    expect(controller.snapshot().retryTokens).toBe(0);
    expect(controller.acquire('interactive', true)).toBeNull();
    retry?.complete({ latencyMs: 10, success: false });
  });

  it('replenishes retry budget from successful completions', () => {
    const controller = new AdaptiveResilienceController(options({ retryBudgetMinimum: 0, retryBudgetRatio: 0.5, retryBudgetMaximum: 3 }));
    expect(controller.evaluate('interactive', true).retryAllowed).toBe(false);
    complete(controller, 10, true);
    expect(controller.snapshot().retryTokens).toBe(1);
  });

  it('caps retry tokens at the configured maximum', () => {
    const controller = new AdaptiveResilienceController(options({ retryBudgetMinimum: 0, retryBudgetRatio: 1, retryBudgetMaximum: 2 }));
    for (let i = 0; i < 8; i += 1) complete(controller, 10, true);
    expect(controller.snapshot().retryTokens).toBe(2);
  });

  it('honors adjustment cooldown using an injected monotonic clock', () => {
    let now = 100;
    const controller = new AdaptiveResilienceController(options({ cooldownMs: 100 }), { now: () => now });
    completeBatch(controller, [120, 120, 120, 120].map(latencyMs => ({ latencyMs, success: true })));
    expect(controller.snapshot().concurrencyLimit).toBe(3);
    const duringCooldown = controller.acquire('critical');
    expect(duringCooldown).not.toBeNull();
    duringCooldown?.complete({ latencyMs: 120, success: true });
    expect(controller.snapshot().concurrencyLimit).toBe(3);
    now = 201;
    const afterCooldown = controller.acquire('critical');
    expect(afterCooldown).not.toBeNull();
    afterCooldown?.complete({ latencyMs: 120, success: true });
    expect(controller.snapshot().concurrencyLimit).toBe(2);
  });

  it('rejects a non-finite clock result once adjustment is eligible', () => {
    const controller = new AdaptiveResilienceController(options(), { now: () => Number.NaN });
    complete(controller, 10);
    complete(controller, 10);
    complete(controller, 10);
    expect(() => complete(controller, 10)).toThrow(RangeError);
  });

  it('keeps lease ownership when completion validation fails', () => {
    const controller = new AdaptiveResilienceController(options());
    const lease = controller.acquire('interactive');
    expect(lease).not.toBeNull();
    expect(() => lease?.complete({ latencyMs: Number.NaN, success: true })).toThrow(RangeError);
    expect(controller.snapshot()).toMatchObject({ active: 1, completed: 0, sampleCount: 0 });
    lease?.complete({ latencyMs: 10, success: true });
    expect(controller.snapshot()).toMatchObject({ active: 0, completed: 1, sampleCount: 1 });
  });

  it('tracks admission and completion counters independently', () => {
    const controller = new AdaptiveResilienceController(options({ initialConcurrency: 2 }));
    const first = controller.acquire('background');
    const second = controller.acquire('background');
    expect(controller.acquire('background')).toBeNull();
    first?.complete({ latencyMs: 10, success: true });
    second?.complete({ latencyMs: 10, success: false });
    expect(controller.snapshot()).toMatchObject({ admitted: 2, rejected: 1, completed: 2, failed: 1 });
  });

  it('returns immutable snapshots', () => {
    const controller = new AdaptiveResilienceController(options());
    expect(Object.isFrozen(controller.snapshot())).toBe(true);
  });
});