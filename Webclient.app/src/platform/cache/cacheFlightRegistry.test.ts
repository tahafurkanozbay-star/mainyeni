import { describe, expect, it, vi } from 'vitest';
import { CacheFlightError } from './cacheFlightContracts';
import { CacheFlightRegistry } from './cacheFlightRegistry';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('CacheFlightRegistry', () => {
  it('deduplicates concurrent work by key', async () => {
    const gate = deferred<number>();
    const operation = vi.fn(() => gate.promise);
    const registry = new CacheFlightRegistry();

    const first = registry.run({ key: 'catalog|GET|/places', operation });
    const second = registry.run({ key: 'catalog|GET|/places', operation });

    expect(registry.has('catalog|GET|/places')).toBe(true);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(registry.snapshot()).toMatchObject({
      flights: 1,
      subscribers: 2,
      started: 1,
      joined: 1,
    });

    gate.resolve(42);
    await expect(first).resolves.toBe(42);
    await expect(second).resolves.toBe(42);
    expect(registry.snapshot()).toMatchObject({
      flights: 0,
      subscribers: 0,
      completed: 1,
    });
  });

  it('isolates one aborted subscriber while preserving shared work', async () => {
    const gate = deferred<number>();
    const firstController = new AbortController();
    const secondController = new AbortController();
    const registry = new CacheFlightRegistry();

    const first = registry.run({
      key: 'catalog|GET|/places',
      signal: firstController.signal,
      operation: () => gate.promise,
    });
    const second = registry.run({
      key: 'catalog|GET|/places',
      signal: secondController.signal,
      operation: () => gate.promise,
    });

    firstController.abort('leave');
    await expect(first).rejects.toMatchObject({
      name: 'CacheFlightError',
      code: 'subscriber-aborted',
    });
    expect(registry.snapshot()).toMatchObject({
      flights: 1,
      subscribers: 1,
      cancelled: 0,
    });

    gate.resolve(7);
    await expect(second).resolves.toBe(7);
    expect(registry.snapshot().completed).toBe(1);
  });

  it('cancels underlying work after the last subscriber aborts', async () => {
    const gate = deferred<number>();
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const registry = new CacheFlightRegistry();

    const result = registry.run({
      key: 'catalog|GET|/places',
      signal: controller.signal,
      operation: (signal) => {
        observedSignal = signal;
        return gate.promise;
      },
    });

    controller.abort('gone');
    await expect(result).rejects.toMatchObject({ code: 'subscriber-aborted' });
    expect(observedSignal?.aborted).toBe(true);
    expect(registry.snapshot()).toMatchObject({
      flights: 0,
      subscribers: 0,
      cancelled: 1,
    });
    gate.resolve(1);
  });

  it('rejects new unique flights when capacity is exhausted', async () => {
    const gate = deferred<number>();
    const registry = new CacheFlightRegistry({ maxFlights: 1 });
    const running = registry.run({ key: 'first', operation: () => gate.promise });

    await expect(registry.run({
      key: 'second',
      operation: async () => 2,
    })).rejects.toMatchObject({ code: 'flight-capacity' });
    expect(registry.snapshot().rejected).toBe(1);

    gate.resolve(1);
    await expect(running).resolves.toBe(1);
  });

  it('rejects excessive subscribers without disturbing admitted subscribers', async () => {
    const gate = deferred<number>();
    const registry = new CacheFlightRegistry({ maxSubscribersPerFlight: 1 });
    const first = registry.run({ key: 'shared', operation: () => gate.promise });

    await expect(registry.run({
      key: 'shared',
      operation: () => gate.promise,
    })).rejects.toMatchObject({ code: 'subscriber-capacity' });

    gate.resolve(5);
    await expect(first).resolves.toBe(5);
  });

  it('normalizes synchronous throws into a failed flight', async () => {
    const registry = new CacheFlightRegistry();

    await expect(registry.run({
      key: 'failing',
      operation: () => {
        throw new Error('boom');
      },
    })).rejects.toThrow('boom');

    expect(registry.snapshot()).toMatchObject({
      flights: 0,
      failed: 1,
      started: 1,
    });
  });

  it('cancels one flight explicitly', async () => {
    const gate = deferred<number>();
    const registry = new CacheFlightRegistry();
    const running = registry.run({ key: 'a', operation: () => gate.promise });

    expect(registry.cancel('a', 'invalidate')).toBe(true);
    await expect(running).rejects.toMatchObject({
      code: 'operation-cancelled',
      reason: 'invalidate',
    });
    expect(registry.cancel('a')).toBe(false);
    gate.resolve(1);
  });

  it('cancels every active flight without disposing the registry', async () => {
    const firstGate = deferred<number>();
    const secondGate = deferred<number>();
    const registry = new CacheFlightRegistry();
    const first = registry.run({ key: 'a', operation: () => firstGate.promise });
    const second = registry.run({ key: 'b', operation: () => secondGate.promise });

    expect(registry.cancelAll('invalidate-all')).toBe(2);
    await expect(first).rejects.toMatchObject({ code: 'operation-cancelled' });
    await expect(second).rejects.toMatchObject({ code: 'operation-cancelled' });
    expect(registry.snapshot()).toMatchObject({ flights: 0, cancelled: 2 });

    await expect(registry.run({
      key: 'c',
      operation: async () => 3,
    })).resolves.toBe(3);
    firstGate.resolve(1);
    secondGate.resolve(2);
  });

  it('rejects already-aborted subscribers before starting work', async () => {
    const controller = new AbortController();
    controller.abort('already');
    const operation = vi.fn(async () => 1);
    const registry = new CacheFlightRegistry();

    await expect(registry.run({
      key: 'a',
      signal: controller.signal,
      operation,
    })).rejects.toMatchObject({ code: 'subscriber-aborted' });
    expect(operation).not.toHaveBeenCalled();
    expect(registry.snapshot()).toMatchObject({ started: 0, rejected: 1 });
  });

  it('disposes active flights and rejects future work', async () => {
    const gate = deferred<number>();
    const registry = new CacheFlightRegistry();
    const running = registry.run({ key: 'a', operation: () => gate.promise });

    registry.dispose('shutdown');
    registry.dispose('again');

    await expect(running).rejects.toMatchObject({
      code: 'operation-cancelled',
      reason: 'shutdown',
    });
    expect(registry.has('a')).toBe(false);
    await expect(registry.run({
      key: 'b',
      operation: async () => 2,
    })).rejects.toEqual(expect.objectContaining<Partial<CacheFlightError>>({
      code: 'disposed',
    }));
    gate.resolve(1);
  });

  it('validates configuration bounds', () => {
    expect(() => new CacheFlightRegistry({ maxFlights: 0 })).toThrow(RangeError);
    expect(() => new CacheFlightRegistry({ maxSubscribersPerFlight: 0 })).toThrow(RangeError);
    expect(() => new CacheFlightRegistry({ maxKeyLength: 31 })).toThrow(RangeError);
  });
});
