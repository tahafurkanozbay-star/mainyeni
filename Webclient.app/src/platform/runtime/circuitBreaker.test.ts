import { describe, expect, it, vi } from 'vitest';
import { BoundedCircuitBreaker, CircuitOpenError } from './circuitBreaker';

describe('BoundedCircuitBreaker', () => {
  it('passes successful calls and keeps the circuit closed', async () => {
    const breaker = new BoundedCircuitBreaker({ clock: () => 10 });
    await expect(breaker.execute(async () => 'ok')).resolves.toBe('ok');
    expect(breaker.snapshot()).toMatchObject({ state: 'closed', consecutiveFailures: 0, totalCalls: 1, totalRejected: 0 });
  });

  it('opens after the configured consecutive failure threshold', async () => {
    const failure = new Error('upstream unavailable');
    const breaker = new BoundedCircuitBreaker({ failureThreshold: 2, clock: () => 100 });
    await expect(breaker.execute(async () => { throw failure; })).rejects.toBe(failure);
    expect(breaker.snapshot().state).toBe('closed');
    await expect(breaker.execute(async () => { throw failure; })).rejects.toBe(failure);
    expect(breaker.snapshot()).toMatchObject({ state: 'open', consecutiveFailures: 2, openedAt: 100, retryAt: 15_100 });
  });

  it('rejects work while open without invoking the operation', async () => {
    let now = 0;
    const breaker = new BoundedCircuitBreaker({ failureThreshold: 1, recoveryTimeoutMs: 50, clock: () => now });
    await expect(breaker.execute(async () => { throw new Error('down'); })).rejects.toThrow('down');
    const operation = vi.fn(async () => 'never');
    await expect(breaker.execute(operation)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(operation).not.toHaveBeenCalled();
    expect(breaker.snapshot().totalRejected).toBe(1);
  });

  it('moves to half-open after the recovery timeout and closes after a successful probe', async () => {
    let now = 0;
    const breaker = new BoundedCircuitBreaker({ failureThreshold: 1, recoveryTimeoutMs: 50, clock: () => now });
    await expect(breaker.execute(async () => { throw new Error('down'); })).rejects.toThrow();
    now = 49;
    expect(breaker.snapshot().state).toBe('open');
    now = 50;
    expect(breaker.snapshot().state).toBe('half-open');
    await expect(breaker.execute(async () => 'healthy')).resolves.toBe('healthy');
    expect(breaker.snapshot()).toMatchObject({ state: 'closed', consecutiveFailures: 0, openedAt: null });
  });

  it('reopens immediately when a half-open probe fails', async () => {
    let now = 0;
    const breaker = new BoundedCircuitBreaker({ failureThreshold: 1, recoveryTimeoutMs: 10, clock: () => now });
    await expect(breaker.execute(async () => { throw new Error('first'); })).rejects.toThrow();
    now = 10;
    await expect(breaker.execute(async () => { throw new Error('probe'); })).rejects.toThrow('probe');
    expect(breaker.snapshot()).toMatchObject({ state: 'open', openedAt: 10 });
  });

  it('bounds concurrent half-open probes', async () => {
    let now = 0;
    const breaker = new BoundedCircuitBreaker({ failureThreshold: 1, recoveryTimeoutMs: 10, halfOpenMaxCalls: 1, clock: () => now });
    await expect(breaker.execute(async () => { throw new Error('first'); })).rejects.toThrow();
    now = 10;
    let resolveProbe: ((value: string) => void) | undefined;
    const firstProbe = breaker.execute(() => new Promise<string>(resolve => { resolveProbe = resolve; }));
    await Promise.resolve();
    const blocked = vi.fn(async () => 'blocked');
    await expect(breaker.execute(blocked)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(blocked).not.toHaveBeenCalled();
    resolveProbe?.('recovered');
    await expect(firstProbe).resolves.toBe('recovered');
  });

  it('requires the configured number of half-open successes before closing', async () => {
    let now = 0;
    const breaker = new BoundedCircuitBreaker({
      failureThreshold: 1,
      recoveryTimeoutMs: 5,
      halfOpenMaxCalls: 2,
      successThreshold: 2,
      clock: () => now,
    });
    await expect(breaker.execute(async () => { throw new Error('down'); })).rejects.toThrow();
    now = 5;
    await expect(breaker.execute(async () => 'one')).resolves.toBe('one');
    expect(breaker.snapshot().state).toBe('half-open');
    await expect(breaker.execute(async () => 'two')).resolves.toBe('two');
    expect(breaker.snapshot().state).toBe('closed');
  });

  it('does not count explicitly ignored failures toward opening', async () => {
    const breaker = new BoundedCircuitBreaker({
      failureThreshold: 1,
      classifyFailure: error => error instanceof TypeError,
      clock: () => 0,
    });
    await expect(breaker.execute(async () => { throw new RangeError('client input'); })).rejects.toThrow('client input');
    expect(breaker.snapshot()).toMatchObject({ state: 'closed', consecutiveFailures: 0 });
    await expect(breaker.execute(async () => { throw new TypeError('transport'); })).rejects.toThrow('transport');
    expect(breaker.snapshot().state).toBe('open');
  });

  it('resets a circuit deterministically', async () => {
    const breaker = new BoundedCircuitBreaker({ failureThreshold: 1, clock: () => 20 });
    await expect(breaker.execute(async () => { throw new Error('down'); })).rejects.toThrow();
    breaker.reset();
    expect(breaker.snapshot()).toMatchObject({ state: 'closed', consecutiveFailures: 0, openedAt: null });
    await expect(breaker.execute(async () => 'ok')).resolves.toBe('ok');
  });

  it('keeps bounded immutable history', async () => {
    const breaker = new BoundedCircuitBreaker({ historyLimit: 2, clock: () => 0 });
    await breaker.execute(async () => 1);
    await breaker.execute(async () => 2);
    await breaker.execute(async () => 3);
    const history = breaker.history();
    expect(history).toHaveLength(2);
    expect(history.map(event => event.sequence)).toEqual([2, 3]);
    expect(Object.isFrozen(history)).toBe(true);
    expect(Object.isFrozen(history[0])).toBe(true);
  });

  it('can disable retained history', async () => {
    const breaker = new BoundedCircuitBreaker({ historyLimit: 0, clock: () => 0 });
    await breaker.execute(async () => 'ok');
    expect(breaker.history()).toEqual([]);
  });

  it.each([
    [{ failureThreshold: 0 }, 'failureThreshold'],
    [{ failureThreshold: 101 }, 'failureThreshold'],
    [{ recoveryTimeoutMs: 0 }, 'recoveryTimeoutMs'],
    [{ halfOpenMaxCalls: 0 }, 'halfOpenMaxCalls'],
    [{ successThreshold: 0 }, 'successThreshold'],
    [{ historyLimit: -1 }, 'historyLimit'],
    [{ historyLimit: 1_001 }, 'historyLimit'],
  ] as const)('rejects unsafe configuration %#', (options, expected) => {
    expect(() => new BoundedCircuitBreaker(options)).toThrow(expected);
  });

  it('rejects a half-open success threshold larger than probe capacity', () => {
    expect(() => new BoundedCircuitBreaker({ halfOpenMaxCalls: 1, successThreshold: 2 })).toThrow('successThreshold');
  });

  it('exposes retry timing through CircuitOpenError', async () => {
    let now = 7;
    const breaker = new BoundedCircuitBreaker({ failureThreshold: 1, recoveryTimeoutMs: 100, clock: () => now });
    await expect(breaker.execute(async () => { throw new Error('down'); })).rejects.toThrow();
    now = 20;
    try {
      await breaker.execute(async () => 'no');
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(CircuitOpenError);
      expect((error as CircuitOpenError).retryAt).toBe(107);
    }
  });
});