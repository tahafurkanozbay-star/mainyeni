import { AppError } from '../errors/appError';
import {
  DEFAULT_RETRY_AFTER_MAX_MS,
  DEFAULT_RETRY_BASE_DELAY_MS,
  DEFAULT_RETRY_JITTER_MS,
  DEFAULT_RETRY_MAX_DELAY_MS,
  calculateBackoffDelay,
  calculateRetryDelay,
  createRetryDecision,
  executeWithRetry,
  getRetryAfterHeader,
  isRetryableError,
  isRetryableStatus,
  normalizeRetryOptions,
  parseRetryAfter,
  throwIfAborted,
  waitForRetry
} from './retryPolicy';

const createSignalHarness = (initiallyAborted = false) => {
  const listeners = new Set();
  const signal = {
    aborted: initiallyAborted,
    addEventListener: vi.fn((name, callback) => {
      if (name === 'abort') listeners.add(callback);
    }),
    removeEventListener: vi.fn((name, callback) => {
      if (name === 'abort') listeners.delete(callback);
    })
  };

  return {
    signal,
    abort: () => {
      if (signal.aborted) return;
      signal.aborted = true;
      [...listeners].forEach((listener) => listener());
    },
    listenerCount: () => listeners.size
  };
};

const retryable = (status = 503, code = 'SERVER_ERROR') =>
  new AppError('temporary', { code, status, retryable: true });

describe('retryPolicy option normalization', () => {
  test('uses bounded defaults', () => {
    expect(normalizeRetryOptions()).toEqual({
      baseDelayMs: DEFAULT_RETRY_BASE_DELAY_MS,
      maxDelayMs: DEFAULT_RETRY_MAX_DELAY_MS,
      jitterMs: DEFAULT_RETRY_JITTER_MS,
      retryAfterMaxMs: DEFAULT_RETRY_AFTER_MAX_MS
    });
  });

  test('clamps negative base delay to zero', () => {
    expect(normalizeRetryOptions({ baseDelayMs: -10 }).baseDelayMs).toBe(0);
  });

  test('clamps excessive base delay', () => {
    expect(normalizeRetryOptions({ baseDelayMs: 99999 }).baseDelayMs).toBe(10000);
  });

  test('clamps max delay into supported range', () => {
    expect(normalizeRetryOptions({ maxDelayMs: 0 }).maxDelayMs).toBe(1);
    expect(normalizeRetryOptions({ maxDelayMs: 999999 }).maxDelayMs).toBe(60000);
  });

  test('clamps jitter into supported range', () => {
    expect(normalizeRetryOptions({ jitterMs: -1 }).jitterMs).toBe(0);
    expect(normalizeRetryOptions({ jitterMs: 5000 }).jitterMs).toBe(1000);
  });

  test('clamps Retry-After budget', () => {
    expect(normalizeRetryOptions({ retryAfterMaxMs: -1 }).retryAfterMaxMs).toBe(0);
    expect(normalizeRetryOptions({ retryAfterMaxMs: 999999 }).retryAfterMaxMs).toBe(120000);
  });

  test('uses defaults for non-numeric options', () => {
    expect(normalizeRetryOptions({
      baseDelayMs: 'x',
      maxDelayMs: 'x',
      jitterMs: 'x',
      retryAfterMaxMs: 'x'
    })).toEqual({
      baseDelayMs: DEFAULT_RETRY_BASE_DELAY_MS,
      maxDelayMs: DEFAULT_RETRY_MAX_DELAY_MS,
      jitterMs: DEFAULT_RETRY_JITTER_MS,
      retryAfterMaxMs: DEFAULT_RETRY_AFTER_MAX_MS
    });
  });
});

describe('retryPolicy status classification', () => {
  test.each([408, 425, 429, 500, 501, 502, 503, 504, 599])('marks status %s retryable', (status) => {
    expect(isRetryableStatus(status)).toBe(true);
  });

  test.each([200, 201, 204, 301, 400, 401, 403, 404, 409, 422, 600, null, undefined])(
    'marks status %p non-retryable',
    (status) => {
      expect(isRetryableStatus(status)).toBe(false);
    }
  );

  test('accepts numeric status strings', () => {
    expect(isRetryableStatus('503')).toBe(true);
  });

  test('rejects non-numeric status strings', () => {
    expect(isRetryableStatus('server-error')).toBe(false);
  });
});

describe('retryPolicy error classification', () => {
  test('marks TIMEOUT retryable', () => {
    expect(isRetryableError(new AppError('timeout', { code: 'TIMEOUT', retryable: true }))).toBe(true);
  });

  test('marks NETWORK_ERROR retryable', () => {
    expect(isRetryableError(new AppError('network', { code: 'NETWORK_ERROR', retryable: true }))).toBe(true);
  });

  test('honors explicit retryable errors', () => {
    expect(isRetryableError(new AppError('retry', { code: 'CUSTOM', retryable: true }))).toBe(true);
  });

  test('recognizes response status', () => {
    expect(isRetryableError({ response: { status: 503 } })).toBe(true);
  });

  test('recognizes direct status', () => {
    expect(isRetryableError({ status: 429 })).toBe(true);
  });

  test('treats fetch TypeError as network retryable', () => {
    expect(isRetryableError(new TypeError('Failed to fetch'))).toBe(true);
  });

  test('never retries typed abort errors', () => {
    expect(isRetryableError(new AppError('cancelled', { code: 'ABORTED', retryable: false }))).toBe(false);
  });

  test('never retries DOM-style AbortError', () => {
    expect(isRetryableError(Object.assign(new Error('cancelled'), { name: 'AbortError' }))).toBe(false);
  });

  test('rejects ordinary 400-class errors', () => {
    expect(isRetryableError(new AppError('bad', { code: 'BAD_REQUEST', status: 400 }))).toBe(false);
  });

  test('rejects empty errors', () => {
    expect(isRetryableError(null)).toBe(false);
    expect(isRetryableError(undefined)).toBe(false);
  });
});

describe('retryPolicy Retry-After parsing', () => {
  test.each([
    ['0', 0], ['0.25', 250], ['1', 1000], ['2.5', 2500], ['30', 30000]
  ])('parses numeric Retry-After %s', (value, expected) => {
    expect(parseRetryAfter(value)).toBe(expected);
  });

  test('clamps numeric Retry-After to configured maximum', () => {
    expect(parseRetryAfter('500', { retryAfterMaxMs: 5000 })).toBe(5000);
  });

  test('parses an HTTP date relative to supplied clock', () => {
    const now = Date.parse('2026-09-16T08:00:00.000Z');
    expect(parseRetryAfter('Wed, 16 Sep 2026 08:00:03 GMT', { now, retryAfterMaxMs: 10000 })).toBe(3000);
  });

  test('returns zero for a past HTTP date', () => {
    const now = Date.parse('2026-09-16T08:00:03.000Z');
    expect(parseRetryAfter('Wed, 16 Sep 2026 08:00:00 GMT', { now })).toBe(0);
  });

  test.each([null, undefined, '', '   ', 'later', '-1', 'NaN'])(
    'returns null for invalid Retry-After %p',
    (value) => {
      expect(parseRetryAfter(value)).toBeNull();
    }
  );

  test('returns null if supplied clock is invalid', () => {
    expect(parseRetryAfter('Wed, 16 Sep 2026 08:00:03 GMT', { now: Number.NaN })).toBeNull();
  });
});

describe('retryPolicy backoff calculation', () => {
  const base = { baseDelayMs: 250, maxDelayMs: 4000, jitterMs: 100 };

  test.each([[0, 250], [1, 500], [2, 1000], [3, 2000], [4, 4000], [5, 4000]])(
    'computes exponential delay for attempt %s',
    (attempt, expected) => {
      expect(calculateBackoffDelay(attempt, { ...base, random: () => 0 })).toBe(expected);
    }
  );

  test('adds deterministic jitter', () => {
    expect(calculateBackoffDelay(0, { ...base, random: () => 0.5 })).toBe(300);
  });

  test('clamps random values below zero', () => {
    expect(calculateBackoffDelay(0, { ...base, random: () => -10 })).toBe(250);
  });

  test('clamps random values above one', () => {
    expect(calculateBackoffDelay(0, { ...base, random: () => 10 })).toBe(350);
  });

  test('handles non-numeric random return safely', () => {
    expect(calculateBackoffDelay(0, { ...base, random: () => 'invalid' })).toBe(250);
  });

  test('clamps huge attempt values', () => {
    expect(calculateBackoffDelay(999, { ...base, random: () => 0 })).toBe(4000);
  });

  test('clamps negative attempt values to zero', () => {
    expect(calculateBackoffDelay(-4, { ...base, random: () => 0 })).toBe(250);
  });
});

describe('retryPolicy Retry-After header extraction', () => {
  test('reads Fetch Headers-like objects', () => {
    const headers = { get: vi.fn((name) => name === 'retry-after' ? '3' : null) };
    expect(getRetryAfterHeader({ response: { headers } })).toBe('3');
    expect(headers.get).toHaveBeenCalledWith('retry-after');
  });

  test('reads plain headers case-insensitively', () => {
    expect(getRetryAfterHeader({ response: { headers: { 'Retry-After': '4' } } })).toBe('4');
  });

  test('reads direct error headers', () => {
    expect(getRetryAfterHeader({ headers: { 'retry-after': '5' } })).toBe('5');
  });

  test('returns null when no headers exist', () => {
    expect(getRetryAfterHeader(new Error('x'))).toBeNull();
  });

  test('prefers Retry-After over exponential delay', () => {
    expect(calculateRetryDelay(3, {
      response: { headers: { 'Retry-After': '1' } }
    }, { random: () => 0, baseDelayMs: 250 })).toBe(1000);
  });

  test('falls back to exponential delay for invalid Retry-After', () => {
    expect(calculateRetryDelay(2, {
      response: { headers: { 'Retry-After': 'invalid' } }
    }, { random: () => 0, baseDelayMs: 250 })).toBe(1000);
  });
});

describe('retryPolicy cancellation-aware waiting', () => {
  test('resolves when the timer fires', async () => {
    let timerCallback;
    const setTimer = vi.fn((callback) => {
      timerCallback = callback;
      return 11;
    });
    const clearTimer = vi.fn();
    const promise = waitForRetry(250, null, { setTimeout: setTimer, clearTimeout: clearTimer });
    expect(setTimer).toHaveBeenCalledWith(expect.any(Function), 250);
    timerCallback();
    await expect(promise).resolves.toBeUndefined();
    expect(clearTimer).toHaveBeenCalledWith(11);
  });

  test('rejects immediately when signal is already aborted', async () => {
    const harness = createSignalHarness(true);
    await expect(waitForRetry(250, harness.signal, {
      setTimeout: vi.fn(), clearTimeout: vi.fn()
    })).rejects.toMatchObject({ code: 'ABORTED', retryable: false });
  });

  test('rejects when cancellation arrives during sleep', async () => {
    const harness = createSignalHarness();
    const clearTimer = vi.fn();
    const promise = waitForRetry(250, harness.signal, {
      setTimeout: vi.fn(() => 42), clearTimeout: clearTimer
    });
    expect(harness.listenerCount()).toBe(1);
    harness.abort();
    await expect(promise).rejects.toMatchObject({ code: 'ABORTED' });
    expect(clearTimer).toHaveBeenCalledWith(42);
    expect(harness.listenerCount()).toBe(0);
  });

  test('removes abort listener when timer wins', async () => {
    const harness = createSignalHarness();
    let callback;
    const promise = waitForRetry(10, harness.signal, {
      setTimeout: vi.fn((handler) => { callback = handler; return 7; }),
      clearTimeout: vi.fn()
    });
    expect(harness.listenerCount()).toBe(1);
    callback();
    await promise;
    expect(harness.listenerCount()).toBe(0);
  });

  test('normalizes negative wait duration to zero', () => {
    const setTimer = vi.fn(() => 1);
    waitForRetry(-500, null, { setTimeout: setTimer, clearTimeout: vi.fn() });
    expect(setTimer).toHaveBeenCalledWith(expect.any(Function), 0);
  });
});

describe('retryPolicy decision model', () => {
  test('retries a retryable failure within budget', () => {
    expect(createRetryDecision({
      error: retryable(), attempt: 0, maxRetries: 2, retryAllowed: true,
      options: { random: () => 0 }
    })).toEqual({ retry: true, reason: 'retryable', attempt: 0, delayMs: 250 });
  });

  test('stops after retry budget is exhausted', () => {
    expect(createRetryDecision({ error: retryable(), attempt: 2, maxRetries: 2, retryAllowed: true }))
      .toMatchObject({ retry: false, reason: 'retry-budget-exhausted' });
  });

  test('stops when method policy disallows retry', () => {
    expect(createRetryDecision({ error: retryable(), attempt: 0, maxRetries: 2, retryAllowed: false }))
      .toMatchObject({ retry: false, reason: 'method-not-retryable' });
  });

  test('stops for a non-retryable error', () => {
    expect(createRetryDecision({
      error: new AppError('bad', { code: 'BAD_REQUEST', status: 400 }),
      attempt: 0, maxRetries: 2, retryAllowed: true
    })).toMatchObject({ retry: false, reason: 'error-not-retryable' });
  });

  test('stops when signal is aborted', () => {
    expect(createRetryDecision({ error: retryable(), attempt: 0, maxRetries: 2, signal: { aborted: true } }))
      .toMatchObject({ retry: false, reason: 'aborted' });
  });
});

describe('retryPolicy execution', () => {
  test('returns first successful operation result', async () => {
    const operation = vi.fn().mockResolvedValue('ok');
    await expect(executeWithRetry(operation)).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(1);
    expect(operation).toHaveBeenCalledWith({ attempt: 0, signal: undefined });
  });

  test('retries until operation succeeds', async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(retryable())
      .mockRejectedValueOnce(retryable())
      .mockResolvedValueOnce('ok');
    const wait = vi.fn().mockResolvedValue(undefined);
    const onRetry = vi.fn();
    await expect(executeWithRetry(operation, {
      maxRetries: 2, wait, onRetry, retryOptions: { random: () => 0 }
    })).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  test('exposes monotonically increasing attempt numbers', async () => {
    const attempts = [];
    const operation = vi.fn(({ attempt }) => {
      attempts.push(attempt);
      if (attempt < 2) return Promise.reject(retryable());
      return Promise.resolve('ok');
    });
    await executeWithRetry(operation, {
      maxRetries: 2,
      wait: vi.fn().mockResolvedValue(undefined),
      retryOptions: { random: () => 0 }
    });
    expect(attempts).toEqual([0, 1, 2]);
  });

  test('invokes onAttempt before each operation', async () => {
    const onAttempt = vi.fn();
    const operation = vi.fn().mockRejectedValueOnce(retryable()).mockResolvedValueOnce('ok');
    await executeWithRetry(operation, {
      maxRetries: 1,
      wait: vi.fn().mockResolvedValue(undefined),
      onAttempt,
      retryOptions: { random: () => 0 }
    });
    expect(onAttempt.mock.calls.map(([value]) => value.attempt)).toEqual([0, 1]);
  });

  test('does not retry an unsafe operation when policy disables retry', async () => {
    const error = retryable();
    const operation = vi.fn().mockRejectedValue(error);
    await expect(executeWithRetry(operation, {
      maxRetries: 3, retryAllowed: false, wait: vi.fn()
    })).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  test('does not retry a non-retryable error', async () => {
    const error = new AppError('bad', { code: 'BAD_REQUEST', status: 400, retryable: false });
    const operation = vi.fn().mockRejectedValue(error);
    await expect(executeWithRetry(operation, {
      maxRetries: 3, wait: vi.fn()
    })).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  test('stops after configured retry budget', async () => {
    const error = retryable();
    const operation = vi.fn().mockRejectedValue(error);
    await expect(executeWithRetry(operation, {
      maxRetries: 2,
      wait: vi.fn().mockResolvedValue(undefined),
      retryOptions: { random: () => 0 }
    })).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(3);
  });

  test('does not execute when caller is already aborted', async () => {
    const operation = vi.fn();
    await expect(executeWithRetry(operation, { signal: { aborted: true } }))
      .rejects.toMatchObject({ code: 'ABORTED' });
    expect(operation).not.toHaveBeenCalled();
  });

  test('stops if cancellation arrives after retry wait', async () => {
    const harness = createSignalHarness();
    const operation = vi.fn().mockRejectedValue(retryable());
    const wait = vi.fn(async () => { harness.abort(); });
    await expect(executeWithRetry(operation, {
      maxRetries: 3,
      signal: harness.signal,
      wait,
      retryOptions: { random: () => 0 }
    })).rejects.toMatchObject({ code: 'ABORTED' });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  test('rejects non-function operations', async () => {
    await expect(executeWithRetry(null)).rejects.toBeInstanceOf(TypeError);
  });
});

describe('retryPolicy throwIfAborted', () => {
  test('does not throw for missing signal', () => {
    expect(() => throwIfAborted()).not.toThrow();
  });

  test('does not throw for active signal', () => {
    expect(() => throwIfAborted({ aborted: false })).not.toThrow();
  });

  test('throws typed AppError for aborted signal', () => {
    try {
      throwIfAborted({ aborted: true });
      throw new Error('expected abort');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect(error.code).toBe('ABORTED');
      expect(error.retryable).toBe(false);
    }
  });
});
