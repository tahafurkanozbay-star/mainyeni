import { describe, expect, it, vi } from 'vitest';
import { BoundedRetryPolicy, RetryAbortedError } from './retryPolicy';

describe('BoundedRetryPolicy', () => {
  it('returns the first successful result without sleeping', async () => {
    const sleep = vi.fn(async () => undefined);
    const policy = new BoundedRetryPolicy({ retryable: () => true, sleep, clock: () => 100 });
    const operation = vi.fn(async () => 'ok');
    await expect(policy.execute(operation)).resolves.toEqual({ ok: true, value: 'ok', attempts: 1, elapsedMs: 0 });
    expect(operation).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries only errors accepted by the retryability predicate', async () => {
    let now = 0;
    const sleep = vi.fn(async (delay: number) => { now += delay; });
    const policy = new BoundedRetryPolicy({
      maxAttempts: 3,
      baseDelayMs: 10,
      jitterRatio: 0,
      clock: () => now,
      sleep,
      retryable: error => error instanceof TypeError,
    });
    let calls = 0;
    const result = await policy.execute(async () => {
      calls += 1;
      if (calls < 3) throw new TypeError('temporary');
      return 42;
    });
    expect(result).toEqual({ ok: true, value: 42, attempts: 3, elapsedMs: 30 });
    expect(sleep).toHaveBeenNthCalledWith(1, 10, undefined);
    expect(sleep).toHaveBeenNthCalledWith(2, 20, undefined);
  });

  it('fails closed for non-retryable errors', async () => {
    const failure = new Error('bad request');
    const policy = new BoundedRetryPolicy({ retryable: () => false, clock: () => 5 });
    const result = await policy.execute(async () => { throw failure; });
    expect(result).toEqual({ ok: false, error: failure, attempts: 1, elapsedMs: 0, reason: 'non-retryable' });
  });

  it('stops at the attempt budget', async () => {
    const failure = new TypeError('offline');
    const policy = new BoundedRetryPolicy({ maxAttempts: 2, baseDelayMs: 0, retryable: () => true, clock: () => 0 });
    const operation = vi.fn(async () => { throw failure; });
    const result = await policy.execute(operation);
    expect(result).toEqual({ ok: false, error: failure, attempts: 2, elapsedMs: 0, reason: 'attempt-limit' });
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('stops before a delay would exceed the elapsed-time budget', async () => {
    let now = 90;
    const policy = new BoundedRetryPolicy({
      maxAttempts: 4,
      baseDelayMs: 20,
      maxElapsedMs: 100,
      jitterRatio: 0,
      retryable: () => true,
      clock: () => now,
      sleep: async delay => { now += delay; },
    });
    const failure = new Error('temporary');
    const result = await policy.execute(async () => { now += 90; throw failure; });
    expect(result).toEqual({ ok: false, error: failure, attempts: 1, elapsedMs: 90, reason: 'elapsed-budget' });
  });

  it('exposes a bounded remaining-time context to each attempt', async () => {
    let now = 100;
    const contexts: Array<{ attempt: number; elapsedMs: number; remainingMs: number }> = [];
    const policy = new BoundedRetryPolicy({
      maxAttempts: 2,
      baseDelayMs: 10,
      maxElapsedMs: 100,
      jitterRatio: 0,
      retryable: () => true,
      clock: () => now,
      sleep: async delay => { now += delay; },
    });
    await policy.execute(async context => {
      contexts.push({ attempt: context.attempt, elapsedMs: context.elapsedMs, remainingMs: context.remainingMs });
      if (context.attempt === 1) throw new Error('again');
      return 'done';
    });
    expect(contexts).toEqual([
      { attempt: 1, elapsedMs: 0, remainingMs: 100 },
      { attempt: 2, elapsedMs: 10, remainingMs: 90 },
    ]);
  });

  it('does not start work when already aborted', async () => {
    const controller = new AbortController();
    controller.abort('disposed');
    const operation = vi.fn(async () => 'never');
    const policy = new BoundedRetryPolicy({ retryable: () => true, clock: () => 0 });
    const result = await policy.execute(operation, controller.signal);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toBe('aborted');
    expect(result.error).toBeInstanceOf(RetryAbortedError);
    expect(result.attempts).toBe(0);
    expect(operation).not.toHaveBeenCalled();
  });

  it('reports aborts that happen while waiting', async () => {
    const controller = new AbortController();
    const policy = new BoundedRetryPolicy({
      maxAttempts: 3,
      retryable: () => true,
      clock: () => 0,
      sleep: async (_delay, signal) => {
        controller.abort('route disposed');
        throw new RetryAbortedError(signal?.reason);
      },
    });
    const result = await policy.execute(async () => { throw new TypeError('offline'); }, controller.signal);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toBe('aborted');
    expect(result.attempts).toBe(1);
  });

  it('calculates deterministic exponential backoff without jitter', () => {
    const policy = new BoundedRetryPolicy({ maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 500, backoffFactor: 2, jitterRatio: 0 });
    expect([1, 2, 3, 4, 5].map(attempt => policy.delayForAttempt(attempt))).toEqual([100, 200, 400, 500, 500]);
  });

  it('bounds jitter and validates random samples', () => {
    const low = new BoundedRetryPolicy({ maxAttempts: 2, baseDelayMs: 100, jitterRatio: 0.25, random: () => 0 });
    const high = new BoundedRetryPolicy({ maxAttempts: 2, baseDelayMs: 100, jitterRatio: 0.25, random: () => 1 });
    expect(low.delayForAttempt(1)).toBe(75);
    expect(high.delayForAttempt(1)).toBe(125);
    const invalid = new BoundedRetryPolicy({ random: () => 2 });
    expect(() => invalid.delayForAttempt(1)).toThrow('random() must return a value in [0, 1]');
  });

  it.each([
    [{ maxAttempts: 0 }, 'maxAttempts'],
    [{ maxAttempts: 11 }, 'maxAttempts'],
    [{ baseDelayMs: -1 }, 'baseDelayMs'],
    [{ maxElapsedMs: 0 }, 'maxElapsedMs'],
    [{ backoffFactor: 0.9 }, 'backoffFactor'],
    [{ jitterRatio: 1.1 }, 'jitterRatio'],
  ] as const)('rejects unsafe policy options %#', (options, expected) => {
    expect(() => new BoundedRetryPolicy(options)).toThrow(expected);
  });

  it('rejects a maximum delay smaller than the base delay', () => {
    expect(() => new BoundedRetryPolicy({ baseDelayMs: 100, maxDelayMs: 99 })).toThrow('maxDelayMs must be >= baseDelayMs');
  });

  it('rejects invalid attempt numbers', () => {
    const policy = new BoundedRetryPolicy({ maxAttempts: 3 });
    expect(() => policy.delayForAttempt(0)).toThrow('attempt');
    expect(() => policy.delayForAttempt(4)).toThrow('attempt');
  });
});
