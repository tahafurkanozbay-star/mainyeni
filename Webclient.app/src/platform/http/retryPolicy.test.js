import {
  computeBackoffDelayMs,
  createRetryDecision,
  isMethodRetryable,
  isRetryableStatus,
  parseRetryAfterMs,
  waitForRetryDelay
} from './retryPolicy';

describe('retryPolicy status and method safety', () => {
  test.each([
    [null, true],
    [0, true],
    [408, true],
    [425, true],
    [429, true],
    [500, true],
    [502, true],
    [503, true],
    [504, true],
    [400, false],
    [401, false],
    [403, false],
    [404, false],
    [409, false],
    [422, false]
  ])('status %p retryable=%p', (status, expected) => {
    expect(isRetryableStatus(status)).toBe(expected);
  });

  test.each(['get', 'GET', 'head', 'HEAD', 'options'])('safe method %s retries', (method) => {
    expect(isMethodRetryable(method)).toBe(true);
  });

  test.each(['post', 'put', 'patch', 'delete'])('unsafe method %s does not retry by default', (method) => {
    expect(isMethodRetryable(method)).toBe(false);
    expect(isMethodRetryable(method, true)).toBe(true);
  });
});

describe('parseRetryAfterMs', () => {
  test('parses delay seconds', () => {
    expect(parseRetryAfterMs({ 'Retry-After': '2' })).toBe(2000);
  });

  test('supports Headers-like getter', () => {
    const headers = { get: (name) => name.toLowerCase() === 'retry-after' ? '3' : null };
    expect(parseRetryAfterMs(headers)).toBe(3000);
  });

  test('parses decimal delay conservatively by rounding milliseconds up', () => {
    expect(parseRetryAfterMs({ 'retry-after': '0.25' })).toBe(250);
  });

  test('parses HTTP dates relative to supplied clock', () => {
    const now = Date.parse('2026-09-16T06:00:00Z');
    const retryAt = new Date(now + 5000).toUTCString();
    expect(parseRetryAfterMs({ 'retry-after': retryAt }, { now })).toBe(5000);
  });

  test('expired HTTP date becomes immediate retry', () => {
    const now = Date.parse('2026-09-16T06:00:00Z');
    const retryAt = new Date(now - 5000).toUTCString();
    expect(parseRetryAfterMs({ 'retry-after': retryAt }, { now })).toBe(0);
  });

  test('caps server-supplied delay', () => {
    expect(parseRetryAfterMs({ 'retry-after': '600' }, { maxDelayMs: 5000 })).toBe(5000);
  });

  test.each([null, undefined, '', 'nonsense', '-1'])('rejects invalid value %p', (value) => {
    expect(parseRetryAfterMs({ 'retry-after': value })).toBeNull();
  });
});

describe('computeBackoffDelayMs', () => {
  test('uses exponential delay without jitter', () => {
    const options = { baseDelayMs: 100, maxDelayMs: 10000, jitterRatio: 0, random: () => 0.5 };
    expect(computeBackoffDelayMs(0, options)).toBe(100);
    expect(computeBackoffDelayMs(1, options)).toBe(200);
    expect(computeBackoffDelayMs(2, options)).toBe(400);
    expect(computeBackoffDelayMs(3, options)).toBe(800);
  });

  test('caps exponential growth', () => {
    expect(computeBackoffDelayMs(20, {
      baseDelayMs: 250,
      maxDelayMs: 2000,
      jitterRatio: 0,
      random: () => 0.5
    })).toBe(2000);
  });

  test('applies bounded negative jitter', () => {
    expect(computeBackoffDelayMs(0, {
      baseDelayMs: 1000,
      maxDelayMs: 5000,
      jitterRatio: 0.2,
      random: () => 0
    })).toBe(800);
  });

  test('applies bounded positive jitter', () => {
    expect(computeBackoffDelayMs(0, {
      baseDelayMs: 1000,
      maxDelayMs: 5000,
      jitterRatio: 0.2,
      random: () => 1
    })).toBe(1200);
  });

  test('sanitizes negative attempt', () => {
    expect(computeBackoffDelayMs(-20, {
      baseDelayMs: 100,
      maxDelayMs: 5000,
      jitterRatio: 0,
      random: () => 0.5
    })).toBe(100);
  });
});

describe('createRetryDecision', () => {
  const base = {
    method: 'get',
    attempt: 0,
    maxRetries: 2,
    baseDelayMs: 100,
    maxDelayMs: 5000,
    jitterRatio: 0,
    random: () => 0.5
  };

  test('retries transient server failure', () => {
    expect(createRetryDecision({ ...base, error: { response: { status: 503 } } })).toEqual({
      retry: true,
      reason: 'backoff',
      delayMs: 100,
      status: 503
    });
  });

  test('uses Retry-After over local backoff', () => {
    const decision = createRetryDecision({
      ...base,
      error: {
        response: {
          status: 429,
          headers: { 'retry-after': '2' }
        }
      }
    });
    expect(decision.retry).toBe(true);
    expect(decision.reason).toBe('retry-after');
    expect(decision.delayMs).toBe(2000);
  });

  test('does not retry unsafe mutation by default', () => {
    const decision = createRetryDecision({
      ...base,
      method: 'post',
      error: { response: { status: 503 } }
    });
    expect(decision).toEqual({ retry: false, reason: 'unsafe-method', delayMs: 0 });
  });

  test('allows explicit unsafe retry for idempotency-aware caller', () => {
    const decision = createRetryDecision({
      ...base,
      method: 'post',
      retryUnsafe: true,
      error: { response: { status: 503 } }
    });
    expect(decision.retry).toBe(true);
  });

  test('stops at max retry count', () => {
    const decision = createRetryDecision({
      ...base,
      attempt: 2,
      maxRetries: 2,
      error: { response: { status: 503 } }
    });
    expect(decision).toEqual({ retry: false, reason: 'retry-limit', delayMs: 0 });
  });

  test('does not retry client error', () => {
    const decision = createRetryDecision({
      ...base,
      error: { response: { status: 404 } }
    });
    expect(decision.retry).toBe(false);
    expect(decision.reason).toBe('non-retryable-status');
    expect(decision.status).toBe(404);
  });

  test('does not retry abort', () => {
    const decision = createRetryDecision({
      ...base,
      error: { name: 'AbortError', code: 'ABORTED' }
    });
    expect(decision).toEqual({ retry: false, reason: 'aborted', delayMs: 0 });
  });

  test('does not retry when signal is already aborted', () => {
    const controller = new AbortController();
    controller.abort();
    const decision = createRetryDecision({
      ...base,
      signal: controller.signal,
      error: { response: { status: 503 } }
    });
    expect(decision.reason).toBe('aborted');
  });

  test('network failure without status is retryable', () => {
    const decision = createRetryDecision({ ...base, error: { code: 'NETWORK_ERROR' } });
    expect(decision.retry).toBe(true);
    expect(decision.status).toBeNull();
  });
});

describe('waitForRetryDelay', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('resolves after delay', async () => {
    const promise = waitForRetryDelay(250);
    jest.advanceTimersByTime(249);
    await Promise.resolve();
    let settled = false;
    promise.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    jest.advanceTimersByTime(1);
    await expect(promise).resolves.toBeUndefined();
  });

  test('rejects immediately when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(waitForRetryDelay(1000, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
      code: 'ABORTED'
    });
  });

  test('cancels pending delay when signal aborts', async () => {
    const controller = new AbortController();
    const promise = waitForRetryDelay(1000, controller.signal);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });
});
