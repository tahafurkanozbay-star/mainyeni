import { describe, expect, it } from 'vitest';
import { DependencyCircuitBreaker, type CircuitBreakerOptions } from './dependencyCircuitBreaker';

class FakeClock {
  value = 1_000;
  now = (): number => this.value;
  advance(ms: number): void { this.value += ms; }
}
const options = (overrides: Partial<CircuitBreakerOptions> = {}): CircuitBreakerOptions => ({
  failureWindow: 4,
  minimumSamples: 4,
  failureRateThreshold: 0.5,
  timeoutWeight: 0.5,
  openDurationMs: 100,
  maxOpenDurationMs: 800,
  backoffMultiplier: 2,
  halfOpenMaxProbes: 2,
  halfOpenSuccesses: 2,
  historyLimit: 4,
  ...overrides,
});
const complete = (breaker: DependencyCircuitBreaker, outcome: 'success' | 'failure' | 'timeout'): void => {
  const lease = breaker.tryAcquire();
  expect(lease).not.toBeNull();
  breaker.complete(lease!, outcome);
};

describe('DependencyCircuitBreaker', () => {
  it('opens only after the minimum bounded sample window reaches the failure threshold', () => {
    const breaker = new DependencyCircuitBreaker(options());
    complete(breaker, 'failure');
    complete(breaker, 'success');
    complete(breaker, 'failure');
    expect(breaker.snapshot().state).toBe('closed');
    complete(breaker, 'success');
    expect(breaker.snapshot()).toMatchObject({ state: 'open', samples: 4, failureRate: 0.5, opened: 1 });
    expect(breaker.tryAcquire()).toBeNull();
    expect(breaker.snapshot().rejected).toBe(1);
  });

  it('weights timeouts independently from hard failures', () => {
    const breaker = new DependencyCircuitBreaker(options({ failureRateThreshold: 0.6 }));
    complete(breaker, 'failure');
    complete(breaker, 'timeout');
    complete(breaker, 'success');
    complete(breaker, 'success');
    expect(breaker.snapshot()).toMatchObject({ state: 'closed', weightedFailures: 1.5, failureRate: 0.375 });
  });

  it('enters half-open only after the injected clock reaches the reopen deadline', () => {
    const clock = new FakeClock();
    const breaker = new DependencyCircuitBreaker(options({ minimumSamples: 2, failureWindow: 2 }), clock);
    complete(breaker, 'failure');
    complete(breaker, 'failure');
    expect(breaker.snapshot().state).toBe('open');
    clock.advance(99);
    expect(breaker.tryAcquire()).toBeNull();
    clock.advance(1);
    const probe = breaker.tryAcquire();
    expect(probe?.state).toBe('half-open');
    expect(breaker.snapshot().activeProbes).toBe(1);
  });

  it('bounds concurrent half-open probes and recovers after the configured successes', () => {
    const clock = new FakeClock();
    const breaker = new DependencyCircuitBreaker(options({ minimumSamples: 2, failureWindow: 2 }), clock);
    complete(breaker, 'failure');
    complete(breaker, 'failure');
    clock.advance(100);
    const first = breaker.tryAcquire()!;
    const second = breaker.tryAcquire()!;
    expect(breaker.tryAcquire()).toBeNull();
    breaker.complete(first, 'success');
    expect(breaker.snapshot().state).toBe('half-open');
    breaker.complete(second, 'success');
    expect(breaker.snapshot()).toMatchObject({ state: 'closed', samples: 0, successfulProbes: 0, currentOpenDurationMs: 100 });
  });

  it('reopens on a failed probe and exponentially backs off within the cap', () => {
    const clock = new FakeClock();
    const breaker = new DependencyCircuitBreaker(options({ minimumSamples: 2, failureWindow: 2 }), clock);
    complete(breaker, 'failure'); complete(breaker, 'failure');
    clock.advance(100);
    const probe = breaker.tryAcquire()!;
    breaker.complete(probe, 'failure');
    expect(breaker.snapshot()).toMatchObject({ state: 'open', currentOpenDurationMs: 200, reopenAt: 1_300 });
    clock.advance(200);
    breaker.complete(breaker.tryAcquire()!, 'failure');
    expect(breaker.snapshot().currentOpenDurationMs).toBe(400);
  });

  it('rejects duplicate completion without mutating circuit state', () => {
    const breaker = new DependencyCircuitBreaker(options());
    const lease = breaker.tryAcquire()!;
    breaker.complete(lease, 'success');
    const before = breaker.snapshot();
    expect(() => breaker.complete(lease, 'failure')).toThrow(/already completed/);
    expect(breaker.snapshot()).toEqual(before);
  });

  it('rejects forged lease ownership without consuming the real lease', () => {
    const breaker = new DependencyCircuitBreaker(options());
    const lease = breaker.tryAcquire()!;
    expect(() => breaker.complete({ ...lease, admittedAt: lease.admittedAt + 1 }, 'failure')).toThrow(/ownership mismatch/);
    expect(breaker.snapshot().state).toBe('closed');
    breaker.complete(lease, 'success');
    expect(breaker.snapshot().samples).toBe(1);
  });

  it('keeps transition history bounded and returns defensive immutable snapshots', () => {
    const clock = new FakeClock();
    const breaker = new DependencyCircuitBreaker(options({ minimumSamples: 2, failureWindow: 2, halfOpenSuccesses: 1, historyLimit: 2 }), clock);
    for (let cycle = 0; cycle < 3; cycle += 1) {
      complete(breaker, 'failure'); complete(breaker, 'failure');
      clock.advance(breaker.snapshot().currentOpenDurationMs);
      breaker.complete(breaker.tryAcquire()!, 'success');
    }
    const history = breaker.history();
    expect(history).toHaveLength(2);
    expect(Object.isFrozen(history)).toBe(true);
    expect(Object.isFrozen(history[0])).toBe(true);
  });

  it('reset clears active leases and adaptive backoff while retaining a bounded reset transition', () => {
    const clock = new FakeClock();
    const breaker = new DependencyCircuitBreaker(options({ minimumSamples: 2, failureWindow: 2 }), clock);
    const stale = breaker.tryAcquire()!;
    breaker.reset();
    expect(() => breaker.complete(stale, 'success')).toThrow(/Unknown or already completed/);
    expect(breaker.snapshot()).toMatchObject({ state: 'closed', samples: 0, activeProbes: 0, currentOpenDurationMs: 100 });
  });

  it('validates unsafe or internally inconsistent configuration', () => {
    expect(() => new DependencyCircuitBreaker(options({ failureWindow: 1 }))).toThrow(/failureWindow/);
    expect(() => new DependencyCircuitBreaker(options({ minimumSamples: 5 }))).toThrow(/minimumSamples/);
    expect(() => new DependencyCircuitBreaker(options({ failureRateThreshold: 0 }))).toThrow(/failureRateThreshold/);
    expect(() => new DependencyCircuitBreaker(options({ timeoutWeight: 2 }))).toThrow(/timeoutWeight/);
    expect(() => new DependencyCircuitBreaker(options({ backoffMultiplier: 0.5 }))).toThrow(/backoffMultiplier/);
    expect(() => new DependencyCircuitBreaker(options({ halfOpenSuccesses: 3 }))).toThrow(/halfOpenSuccesses/);
  });

  it('fails closed when the injected clock becomes non-finite', () => {
    const clock = new FakeClock();
    const breaker = new DependencyCircuitBreaker(options(), clock);
    clock.value = Number.NaN;
    expect(() => breaker.tryAcquire()).toThrow(/clock.now/);
  });
});
