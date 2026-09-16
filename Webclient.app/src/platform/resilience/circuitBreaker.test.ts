import { AppError } from '../errors/appError';
import {
  CircuitBreaker,
  CircuitBreakerRegistry,
  CircuitOpenError,
  createCircuitBreaker
} from './circuitBreaker';

describe('CircuitBreaker', () => {
  test('starts closed with bounded defaults', () => {
    const breaker = createCircuitBreaker();
    expect(breaker.canExecute()).toBe(true);
    expect(breaker.snapshot()).toMatchObject({
      state: 'closed',
      sampleCount: 0,
      totalExecutions: 0,
      rejectedExecutions: 0,
      transitions: 0
    });
  });

  test('opens after the configured consecutive failure threshold', async () => {
    let now = 100;
    const transitions = [];
    const breaker = new CircuitBreaker({
      failureThreshold: 3,
      minimumSamples: 10,
      clock: () => now,
      onTransition: (event) => transitions.push(event)
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(breaker.execute(() => Promise.reject(new Error(`failure-${attempt}`))))
        .rejects.toThrow(`failure-${attempt}`);
      now += 1;
    }

    expect(breaker.snapshot()).toMatchObject({
      state: 'open',
      consecutiveFailures: 3,
      failureCount: 3,
      transitions: 1
    });
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      from: 'closed',
      to: 'open',
      reason: 'consecutive-failure-threshold'
    });
  });

  test('opens on rolling failure rate after minimum samples', async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 20,
      minimumSamples: 4,
      failureRateThreshold: 0.5,
      sampleWindowSize: 4
    });

    await breaker.execute(() => 1);
    await expect(breaker.execute(() => { throw new Error('one'); })).rejects.toThrow('one');
    await breaker.execute(() => 2);
    await expect(breaker.execute(() => { throw new Error('two'); })).rejects.toThrow('two');

    expect(breaker.snapshot()).toMatchObject({
      state: 'open',
      sampleCount: 4,
      successCount: 2,
      failureCount: 2,
      failureRate: 0.5
    });
  });

  test('rejects immediately while open without invoking the operation', async () => {
    const operation = jest.fn(() => Promise.resolve('ok'));
    const breaker = new CircuitBreaker({ failureThreshold: 1, openDurationMs: 5000 });
    await expect(breaker.execute(() => Promise.reject(new Error('trip')))).rejects.toThrow('trip');

    await expect(breaker.execute(operation)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(operation).not.toHaveBeenCalled();
    expect(breaker.snapshot().rejectedExecutions).toBe(1);
  });

  test('moves to half-open after cooldown and closes after successful probes', async () => {
    let now = 1000;
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      openDurationMs: 100,
      halfOpenSuccessThreshold: 2,
      clock: () => now
    });
    await expect(breaker.execute(() => Promise.reject(new Error('trip')))).rejects.toThrow();
    expect(breaker.canExecute()).toBe(false);

    now += 100;
    expect(breaker.canExecute()).toBe(true);
    expect(breaker.snapshot().state).toBe('half-open');
    await expect(breaker.execute(() => Promise.resolve('probe-1'))).resolves.toBe('probe-1');
    expect(breaker.snapshot().state).toBe('half-open');
    await expect(breaker.execute(() => Promise.resolve('probe-2'))).resolves.toBe('probe-2');
    expect(breaker.snapshot()).toMatchObject({
      state: 'closed',
      sampleCount: 0,
      consecutiveFailures: 0
    });
  });

  test('reopens and lengthens cooldown when a half-open probe fails', async () => {
    let now = 0;
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      openDurationMs: 100,
      maxOpenDurationMs: 1000,
      clock: () => now
    });
    await expect(breaker.execute(() => Promise.reject(new Error('trip')))).rejects.toThrow();
    expect(breaker.snapshot().openDurationMs).toBe(100);

    now = 100;
    expect(breaker.canExecute()).toBe(true);
    await expect(breaker.execute(() => Promise.reject(new Error('probe failed'))))
      .rejects.toThrow('probe failed');
    expect(breaker.snapshot()).toMatchObject({ state: 'open', openDurationMs: 200 });
  });

  test('limits concurrent half-open probes', async () => {
    let now = 0;
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      openDurationMs: 100,
      halfOpenMaxConcurrent: 1,
      halfOpenSuccessThreshold: 1,
      clock: () => now
    });
    await expect(breaker.execute(() => Promise.reject(new Error('trip')))).rejects.toThrow();
    now = 100;

    let resolveProbe;
    const first = breaker.execute(() => new Promise((resolve) => { resolveProbe = resolve; }));
    expect(breaker.snapshot()).toMatchObject({ state: 'half-open', halfOpenInFlight: 1 });
    await expect(breaker.execute(() => Promise.resolve('second'))).rejects.toBeInstanceOf(CircuitOpenError);
    resolveProbe('first');
    await expect(first).resolves.toBe('first');
    expect(breaker.snapshot().state).toBe('closed');
  });

  test('caller aborts do not poison circuit health', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1 });
    await expect(breaker.execute(() => Promise.reject({ name: 'AbortError' }))).rejects.toEqual({ name: 'AbortError' });
    expect(breaker.snapshot()).toMatchObject({
      state: 'closed',
      sampleCount: 0,
      consecutiveFailures: 0
    });
  });

  test.each([
    ['UNAUTHORIZED', 401],
    ['FORBIDDEN', 403],
    ['NOT_FOUND', 404]
  ])('does not count non-retryable application error %s', async (code, status) => {
    const breaker = new CircuitBreaker({ failureThreshold: 1 });
    const error = new AppError('expected', { code, status, retryable: false });
    await expect(breaker.execute(() => Promise.reject(error))).rejects.toBe(error);
    expect(breaker.snapshot().state).toBe('closed');
  });

  test('counts retryable application failures', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1 });
    const error = new AppError('temporary', { code: 'SERVER_ERROR', status: 503, retryable: true });
    await expect(breaker.execute(() => Promise.reject(error))).rejects.toBe(error);
    expect(breaker.snapshot().state).toBe('open');
  });

  test('forceOpen and reset are deterministic', async () => {
    const breaker = new CircuitBreaker();
    breaker.forceOpen('maintenance');
    expect(breaker.snapshot().state).toBe('open');
    await expect(breaker.execute(() => 'never')).rejects.toBeInstanceOf(CircuitOpenError);
    breaker.reset('maintenance-ended');
    expect(breaker.snapshot().state).toBe('closed');
    await expect(breaker.execute(() => 'ok')).resolves.toBe('ok');
  });

  test('monitor hook failures are isolated', async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      onTransition: () => { throw new Error('monitor failed'); }
    });
    await expect(breaker.execute(() => Promise.reject(new Error('business failure'))))
      .rejects.toThrow('business failure');
    expect(breaker.snapshot().state).toBe('open');
  });

  test('custom failure classifier can exclude domain-specific errors', async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      shouldCountFailure: (error) => error !== 'expected-domain-error'
    });
    await expect(breaker.execute(() => Promise.reject('expected-domain-error')))
      .rejects.toBe('expected-domain-error');
    expect(breaker.snapshot().state).toBe('closed');
    await expect(breaker.execute(() => Promise.reject('unexpected'))).rejects.toBe('unexpected');
    expect(breaker.snapshot().state).toBe('open');
  });
});

describe('CircuitBreakerRegistry', () => {
  test('normalizes query-bearing keys and reuses the same breaker', () => {
    const registry = new CircuitBreakerRegistry();
    const first = registry.get('/api/layers?token=secret');
    const second = registry.get('/api/layers?other=value');
    expect(first).toBe(second);
    expect(Object.keys(registry.snapshot())).toEqual(['/api/layers']);
  });

  test('keeps registry bounded using insertion-order eviction', () => {
    const registry = new CircuitBreakerRegistry({ maxBreakers: 2 });
    registry.get('a');
    registry.get('b');
    registry.get('c');
    expect(registry.size()).toBe(2);
    expect(Object.keys(registry.snapshot())).toEqual(['b', 'c']);
  });

  test('executes operations through named breakers', async () => {
    const registry = new CircuitBreakerRegistry({ failureThreshold: 2 });
    await expect(registry.execute('service-a', () => Promise.resolve(42))).resolves.toBe(42);
    await expect(registry.execute('service-b', () => Promise.reject(new Error('fail')))).rejects.toThrow('fail');
    expect(registry.snapshot()['service-a']).toMatchObject({ totalExecutions: 1, state: 'closed' });
    expect(registry.snapshot()['service-b']).toMatchObject({ totalExecutions: 1, state: 'closed' });
  });

  test('reset can target one breaker without changing another', async () => {
    const registry = new CircuitBreakerRegistry({ failureThreshold: 1 });
    await expect(registry.execute('a', () => Promise.reject(new Error('a')))).rejects.toThrow();
    await expect(registry.execute('b', () => Promise.reject(new Error('b')))).rejects.toThrow();
    registry.reset('a');
    expect(registry.snapshot()['a'].state).toBe('closed');
    expect(registry.snapshot()['b'].state).toBe('open');
  });

  test('clear removes all breaker state', () => {
    const registry = new CircuitBreakerRegistry();
    registry.get('a');
    registry.get('b');
    expect(registry.size()).toBe(2);
    registry.clear();
    expect(registry.size()).toBe(0);
    expect(registry.snapshot()).toEqual({});
  });
});
