import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  CircuitOpenError,
  createCircuitBreaker,
  executeWithRetry,
  withTimeout,
} from './resilience';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('resilience deadline enforcement', () => {
  test('rejects at the deadline even when a legacy operation ignores AbortSignal', async () => {
    vi.useFakeTimers();
    const operation = vi.fn((_signal: AbortSignal) => new Promise<string>(() => undefined));

    const pending = withTimeout(operation, 50);
    await vi.advanceTimersByTimeAsync(51);

    await expect(pending).rejects.toMatchObject({
      name: 'OperationTimeoutError',
      code: 'OPERATION_TIMEOUT',
      timeoutMs: 50,
    });
    expect(operation).toHaveBeenCalledTimes(1);
    expect(operation.mock.calls[0]?.[0].aborted).toBe(true);
  });

  test('propagates parent cancellation even when the operation ignores the child signal', async () => {
    const controller = new AbortController();
    const reason = new DOMException('caller cancelled', 'AbortError');
    const pending = withTimeout(
      (_signal) => new Promise<string>(() => undefined),
      5000,
      controller.signal,
    );

    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });

  test('returns successful work and releases the deadline timer', async () => {
    vi.useFakeTimers();
    const pending = withTimeout(async (signal) => {
      expect(signal.aborted).toBe(false);
      return 'ok';
    }, 5000);

    await expect(pending).resolves.toBe('ok');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('resilience observer isolation', () => {
  test('does not let onAttempt instrumentation replace a successful business result', async () => {
    const operation = vi.fn(async () => 'ok');

    await expect(executeWithRetry(operation, {
      onAttempt: () => { throw new Error('metrics unavailable'); },
    })).resolves.toBe('ok');

    expect(operation).toHaveBeenCalledTimes(1);
  });

  test('does not let onRetry instrumentation replace retry recovery', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    let attempts = 0;

    const result = executeWithRetry(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary business failure');
      return 'recovered';
    }, {
      policy: {
        maxAttempts: 2,
        baseDelayMs: 1,
        maxDelayMs: 1,
        jitterRatio: 0,
        retryable: () => true,
      },
      clock: { sleep, random: () => 0.5, now: () => 0 },
      onRetry: () => { throw new Error('telemetry failed'); },
    });

    await expect(result).resolves.toBe('recovered');
    expect(attempts).toBe(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  test('preserves the original business error when circuit transition observers fail', async () => {
    let now = 100;
    const observer = vi.fn(() => { throw new Error('observer failure'); });
    const circuit = createCircuitBreaker({
      now: () => now,
      policy: {
        failureThreshold: 1,
        minimumSamples: 1,
        openDurationMs: 10,
        successThreshold: 1,
        rollingWindowMs: 1000,
      },
      onTransition: observer,
    });
    const businessError = new Error('service unavailable');

    await expect(circuit.execute(async () => { throw businessError; })).rejects.toBe(businessError);
    expect(circuit.snapshot().state).toBe('open');
    expect(observer).toHaveBeenCalledWith('open', 'closed', expect.objectContaining({ state: 'open' }));
    await expect(circuit.execute(async () => 'blocked')).rejects.toBeInstanceOf(CircuitOpenError);

    now += 11;
    await expect(circuit.execute(async () => 'recovered')).resolves.toBe('recovered');
    expect(circuit.snapshot().state).toBe('closed');
    expect(observer).toHaveBeenCalledTimes(3);
  });
});
