import { describe, expect, it } from 'vitest';
import { ResiliencePolicy } from './resiliencePolicy';

describe('ResiliencePolicy', () => {
  it('opens after the configured bounded failure threshold', () => {
    let now = 100;
    const policy = new ResiliencePolicy({ failureThreshold: 2, minimumSamples: 2, now: () => now });
    policy.acquire()!.complete('failure');
    expect(policy.snapshot().state).toBe('closed');
    policy.acquire()!.complete('timeout');
    expect(policy.snapshot().state).toBe('open');
    expect(policy.acquire()).toBeNull();
    expect(policy.snapshot().rejected).toBe(1);
    now += 1;
  });

  it('moves through half-open and closes after successful probes', () => {
    let now = 0;
    const policy = new ResiliencePolicy({ failureThreshold: 1, minimumSamples: 1, successThreshold: 2, openDurationMs: 50, now: () => now });
    policy.acquire()!.complete('failure');
    now = 49;
    expect(policy.acquire()).toBeNull();
    now = 50;
    const first = policy.acquire();
    expect(first?.probe).toBe(true);
    first!.complete('success');
    policy.acquire()!.complete('success');
    expect(policy.snapshot().state).toBe('closed');
  });

  it('reopens immediately when a half-open probe fails', () => {
    let now = 0;
    const policy = new ResiliencePolicy({ failureThreshold: 1, minimumSamples: 1, openDurationMs: 10, now: () => now });
    policy.acquire()!.complete('failure');
    now = 10;
    policy.acquire()!.complete('failure');
    expect(policy.snapshot().state).toBe('open');
    expect(policy.snapshot().openedAt).toBe(10);
  });

  it('limits concurrent half-open probes', () => {
    let now = 0;
    const policy = new ResiliencePolicy({ failureThreshold: 1, minimumSamples: 1, openDurationMs: 1, maxHalfOpenProbes: 1, now: () => now });
    policy.acquire()!.complete('failure');
    now = 1;
    const probe = policy.acquire();
    expect(probe).not.toBeNull();
    expect(policy.acquire()).toBeNull();
    probe!.complete('success');
  });

  it('does not count caller cancellation as service failure', () => {
    const policy = new ResiliencePolicy({ failureThreshold: 1, minimumSamples: 1 });
    policy.acquire()!.complete('cancelled');
    expect(policy.snapshot()).toMatchObject({ samples: 0, failures: 0, state: 'closed' });
  });

  it('makes permit completion idempotent', () => {
    const policy = new ResiliencePolicy({ failureThreshold: 2, minimumSamples: 2 });
    const permit = policy.acquire()!;
    permit.complete('failure');
    permit.complete('failure');
    expect(policy.snapshot().samples).toBe(1);
  });

  it('bounds the rolling outcome window', () => {
    const policy = new ResiliencePolicy({ failureThreshold: 100, minimumSamples: 1, windowSize: 3 });
    for (let index = 0; index < 8; index += 1) policy.acquire()!.complete('success');
    expect(policy.snapshot().samples).toBe(3);
  });

  it('reset returns the policy to a clean closed state', () => {
    const policy = new ResiliencePolicy({ failureThreshold: 1, minimumSamples: 1 });
    policy.acquire()!.complete('failure');
    expect(policy.acquire()).toBeNull();
    policy.reset();
    expect(policy.snapshot()).toMatchObject({ state: 'closed', samples: 0, rejected: 0, openedAt: null });
  });

  it('ignores a stale closed-state permit after another request trips the circuit', () => {
    const policy = new ResiliencePolicy({ failureThreshold: 1, minimumSamples: 1 });
    const slow = policy.acquire()!;
    policy.acquire()!.complete('failure');
    expect(policy.snapshot().state).toBe('open');

    slow.complete('success');
    expect(policy.snapshot()).toMatchObject({ state: 'open', samples: 1, successes: 0, failures: 1 });
  });

  it('ignores outstanding half-open probes after a sibling probe reopens the circuit', () => {
    let now = 0;
    const policy = new ResiliencePolicy({
      failureThreshold: 1,
      minimumSamples: 1,
      openDurationMs: 10,
      maxHalfOpenProbes: 2,
      now: () => now,
    });
    policy.acquire()!.complete('failure');
    now = 10;
    const first = policy.acquire()!;
    const second = policy.acquire()!;
    expect(policy.snapshot().halfOpenInFlight).toBe(2);

    first.complete('failure');
    expect(policy.snapshot()).toMatchObject({ state: 'open', openedAt: 10, halfOpenInFlight: 0 });
    second.complete('success');
    expect(policy.snapshot()).toMatchObject({ state: 'open', openedAt: 10, halfOpenInFlight: 0 });
  });

  it('ignores permits issued before an explicit reset', () => {
    const policy = new ResiliencePolicy({ failureThreshold: 1, minimumSamples: 1 });
    const permit = policy.acquire()!;
    policy.reset();
    permit.complete('failure');
    expect(policy.snapshot()).toMatchObject({ state: 'closed', samples: 0, failures: 0, rejected: 0 });
  });
});
