import { describe, expect, test, vi } from 'vitest';
import type {
  NormalizedRequestConfig,
  Transport,
  TransportResult,
} from './contracts';
import { createRequestCoordinator } from './requestCoordinator';

const envelope = <T>(data: T): TransportResult<T> => Object.freeze({
  data,
  status: 200,
  statusText: 'OK',
  metadata: Object.freeze({
    status: 200,
    method: 'get',
    url: '/items',
  }),
});

const transport = (
  implementation: (config: NormalizedRequestConfig) => Promise<TransportResult<unknown>>,
): Transport => ({
  defaults: Object.freeze({
    baseUrl: '/api',
    timeoutMs: 5_000,
    maxRetries: 0,
    cacheTtlMs: 30_000,
  }),
  request: vi.fn(implementation) as Transport['request'],
});

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
};

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const abortableTransport = () => transport(async (config) =>
  new Promise<TransportResult<unknown>>((_resolve, reject) => {
    const signal = config.signal;
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));

describe('RequestCoordinator structured lifecycle ownership', () => {
  test('tracks a logical request from admission through settlement', async () => {
    const gate = deferred<TransportResult<unknown>>();
    const custom = transport(async () => gate.promise);
    const coordinator = createRequestCoordinator({ transport: custom });

    const request = coordinator.request({ method: 'get', url: '/items' });
    await flush();

    expect(coordinator.getRequestScopeSnapshot()).toMatchObject({
      state: 'open',
      active: 1,
      owners: 1,
      started: 1,
      succeeded: 0,
    });

    gate.resolve(envelope({ ok: true }));
    await expect(request).resolves.toMatchObject({ data: { ok: true } });

    expect(coordinator.getRequestScopeSnapshot()).toMatchObject({
      state: 'open',
      active: 0,
      owners: 0,
      started: 1,
      succeeded: 1,
      failed: 0,
    });
  });

  test('links caller cancellation through scope, cache runtime, scheduler and transport', async () => {
    const custom = abortableTransport();
    const coordinator = createRequestCoordinator({ transport: custom });
    const controller = new AbortController();
    const reason = new Error('route-left');

    const request = coordinator.request({
      method: 'get',
      url: '/items',
      signal: controller.signal,
    });
    await flush();
    controller.abort(reason);

    await expect(request).rejects.toBe(reason);
    expect(coordinator.getRequestScopeSnapshot()).toMatchObject({
      active: 0,
      cancelled: 1,
    });
  });

  test('disposes all active work from one client-owned root', async () => {
    const custom = abortableTransport();
    const coordinator = createRequestCoordinator({ transport: custom });
    const reason = new Error('application-shutdown');

    const first = coordinator.request({ method: 'get', url: '/items/1' });
    const second = coordinator.request({ method: 'get', url: '/items/2' });
    await flush();

    expect(coordinator.getRequestScopeSnapshot()).toMatchObject({ active: 2 });
    coordinator.dispose(reason);

    await expect(first).rejects.toBe(reason);
    await expect(second).rejects.toBe(reason);
    expect(coordinator.getRequestScopeSnapshot()).toMatchObject({
      state: 'disposed',
      active: 0,
      cancelled: 2,
    });
  });

  test('rejects new work after disposal without reaching transport', async () => {
    const custom = transport(async () => envelope({ ok: true }));
    const coordinator = createRequestCoordinator({ transport: custom });
    coordinator.dispose();

    await expect(coordinator.request({
      method: 'get',
      url: '/late',
    })).rejects.toMatchObject({ code: 'SCOPE_NOT_OPEN' });

    expect(custom.request).not.toHaveBeenCalled();
  });

  test('dispose is idempotent for application teardown paths', () => {
    const custom = transport(async () => envelope({ ok: true }));
    const coordinator = createRequestCoordinator({ transport: custom });

    expect(() => coordinator.dispose('first')).not.toThrow();
    expect(() => coordinator.dispose('second')).not.toThrow();
    expect(coordinator.getRequestScopeSnapshot()).toMatchObject({
      state: 'disposed',
    });
  });
});

describe('RequestCoordinator graceful drain', () => {
  test('waits for active work and stops admitting later work', async () => {
    const gate = deferred<TransportResult<unknown>>();
    const custom = transport(async () => gate.promise);
    const coordinator = createRequestCoordinator({ transport: custom });

    const running = coordinator.request({ method: 'get', url: '/slow' });
    await flush();

    let drained = false;
    const drain = coordinator.drain().then(() => {
      drained = true;
    });
    await flush();

    expect(coordinator.getRequestScopeSnapshot()).toMatchObject({
      state: 'closing',
      active: 1,
    });
    expect(drained).toBe(false);

    await expect(coordinator.request({
      method: 'get',
      url: '/late',
    })).rejects.toMatchObject({ code: 'SCOPE_NOT_OPEN' });

    gate.resolve(envelope({ ok: true }));
    await expect(running).resolves.toMatchObject({ data: { ok: true } });
    await drain;

    expect(drained).toBe(true);
    expect(coordinator.getRequestScopeSnapshot()).toMatchObject({
      state: 'closed',
      active: 0,
    });
  });

  test('cancelActive drain aborts active work before completing shutdown', async () => {
    const custom = abortableTransport();
    const coordinator = createRequestCoordinator({ transport: custom });
    const reason = new Error('navigation-reset');

    const running = coordinator.request({ method: 'get', url: '/slow' });
    await flush();
    const drain = coordinator.drain({
      cancelActive: true,
      reason,
    });

    await expect(running).rejects.toBe(reason);
    await expect(drain).resolves.toBeUndefined();
    expect(coordinator.getRequestScopeSnapshot()).toMatchObject({
      state: 'closed',
      active: 0,
      cancelled: 1,
    });
  });

  test('allows a caller to stop waiting for graceful drain without cancelling work', async () => {
    const gate = deferred<TransportResult<unknown>>();
    const custom = transport(async () => gate.promise);
    const coordinator = createRequestCoordinator({ transport: custom });
    const running = coordinator.request({ method: 'get', url: '/slow' });
    await flush();

    const controller = new AbortController();
    const drain = coordinator.drain({ signal: controller.signal });
    controller.abort('stop-waiting');

    await expect(drain).rejects.toMatchObject({ code: 'TASK_CANCELLED' });
    expect(coordinator.getRequestScopeSnapshot()).toMatchObject({
      state: 'closing',
      active: 1,
    });

    gate.resolve(envelope({ ok: true }));
    await running;
    await coordinator.requestScope.waitForIdle();
  });
});

describe('RequestCoordinator bounded ownership', () => {
  test('enforces global logical-request capacity before hidden work is queued', async () => {
    const gate = deferred<TransportResult<unknown>>();
    const custom = transport(async () => gate.promise);
    const coordinator = createRequestCoordinator({
      transport: custom,
      requestScopeOptions: {
        maxActiveTasks: 1,
        maxOwnerTasks: 1,
      },
    });

    const first = coordinator.request({ method: 'get', url: '/one' });
    await flush();

    await expect(coordinator.request({
      method: 'get',
      url: '/two',
    })).rejects.toMatchObject({ code: 'TASK_CAPACITY_EXCEEDED' });
    expect(custom.request).toHaveBeenCalledTimes(1);

    gate.resolve(envelope({ ok: true }));
    await first;
  });

  test('enforces per-owner fairness independently of global capacity', async () => {
    const firstGate = deferred<TransportResult<unknown>>();
    const custom = transport(async () => firstGate.promise);
    const coordinator = createRequestCoordinator({
      transport: custom,
      requestScopeOptions: {
        maxActiveTasks: 4,
        maxOwnerTasks: 1,
      },
    });

    const first = coordinator.request({
      method: 'get',
      url: '/api/items',
      schedulerGroup: 'catalog',
    });
    await flush();

    await expect(coordinator.request({
      method: 'get',
      url: '/api/other',
      schedulerGroup: 'catalog',
    })).rejects.toMatchObject({ code: 'OWNER_CAPACITY_EXCEEDED' });

    firstGate.resolve(envelope({ ok: true }));
    await first;
  });

  test('allows independent owners when per-owner capacity is saturated', async () => {
    const gates = [
      deferred<TransportResult<unknown>>(),
      deferred<TransportResult<unknown>>(),
    ];
    let call = 0;
    const custom = transport(async () => gates[call++]!.promise);
    const coordinator = createRequestCoordinator({
      transport: custom,
      requestScopeOptions: {
        maxActiveTasks: 4,
        maxOwnerTasks: 1,
      },
    });

    const catalog = coordinator.request({
      method: 'get',
      url: '/api/items',
      schedulerGroup: 'catalog',
    });
    const bootstrap = coordinator.request({
      method: 'get',
      url: '/api/config',
      schedulerGroup: 'bootstrap',
    });
    await flush();

    expect(coordinator.getRequestScopeSnapshot()).toMatchObject({
      active: 2,
      owners: 2,
    });

    gates[0]!.resolve(envelope({ owner: 'catalog' }));
    gates[1]!.resolve(envelope({ owner: 'bootstrap' }));
    await Promise.all([catalog, bootstrap]);
  });
});

describe('RequestCoordinator lifecycle composition with cache and dedupe', () => {
  test('cache hits still settle their own logical request scopes', async () => {
    const custom = transport(async () => envelope({ version: 1 }));
    const coordinator = createRequestCoordinator({ transport: custom });

    await coordinator.request({
      method: 'get',
      url: '/items',
      cache: true,
    });
    await coordinator.request({
      method: 'get',
      url: '/items',
      cache: true,
    });

    expect(custom.request).toHaveBeenCalledTimes(1);
    expect(coordinator.getRequestScopeSnapshot()).toMatchObject({
      active: 0,
      started: 2,
      succeeded: 2,
    });
    expect(coordinator.getCacheSize()).toBe(1);
  });

  test('subscriber-aware dedupe owns two logical requests but one transport operation', async () => {
    const gate = deferred<TransportResult<unknown>>();
    const custom = transport(async () => gate.promise);
    const coordinator = createRequestCoordinator({ transport: custom });
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = coordinator.request({
      method: 'get',
      url: '/items',
      dedupe: true,
      signal: firstController.signal,
    });
    const second = coordinator.request({
      method: 'get',
      url: '/items',
      dedupe: true,
      signal: secondController.signal,
    });
    await flush();

    expect(custom.request).toHaveBeenCalledTimes(1);
    expect(coordinator.getRequestScopeSnapshot()).toMatchObject({
      active: 2,
    });
    expect(coordinator.getInFlightSize()).toBe(1);

    gate.resolve(envelope({ value: 1 }));
    await Promise.all([first, second]);

    expect(coordinator.getRequestScopeSnapshot()).toMatchObject({
      active: 0,
      succeeded: 2,
    });
  });

  test('one cancelled dedupe subscriber does not cancel the remaining logical request', async () => {
    const gate = deferred<TransportResult<unknown>>();
    const custom = transport(async () => gate.promise);
    const coordinator = createRequestCoordinator({ transport: custom });
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = coordinator.request({
      method: 'get',
      url: '/items',
      dedupe: true,
      signal: firstController.signal,
    });
    const second = coordinator.request({
      method: 'get',
      url: '/items',
      dedupe: true,
      signal: secondController.signal,
    });
    await flush();

    firstController.abort(new Error('first-route-left'));
    await expect(first).rejects.toThrow('first-route-left');
    expect(coordinator.getInFlightSize()).toBe(1);

    gate.resolve(envelope({ value: 2 }));
    await expect(second).resolves.toMatchObject({ data: { value: 2 } });
    expect(custom.request).toHaveBeenCalledTimes(1);
  });

  test('dispose cancels cache-flight and dedupe-flight ownership together', async () => {
    const custom = abortableTransport();
    const coordinator = createRequestCoordinator({ transport: custom });

    const cached = coordinator.request({
      method: 'get',
      url: '/cached',
      cache: true,
    });
    const deduped = coordinator.request({
      method: 'get',
      url: '/deduped',
      dedupe: true,
    });
    await flush();

    expect(coordinator.getInFlightSize()).toBe(2);
    coordinator.dispose(new Error('shutdown'));

    await expect(cached).rejects.toBeDefined();
    await expect(deduped).rejects.toBeDefined();
    expect(coordinator.getInFlightSize()).toBe(0);
    expect(coordinator.getRequestScopeSnapshot()).toMatchObject({
      state: 'disposed',
      active: 0,
    });
  });
});

describe('RequestCoordinator lifecycle observability', () => {
  test('retains bounded scope history without query parameters', async () => {
    const custom = transport(async () => envelope({ ok: true }));
    const coordinator = createRequestCoordinator({ transport: custom });

    await coordinator.request({
      method: 'get',
      url: '/search',
      params: {
        q: 'private search',
      },
    });

    const snapshot = coordinator.getRequestScopeSnapshot();
    const serialized = JSON.stringify(snapshot);
    expect(serialized).toContain('/search');
    expect(serialized).not.toContain('private search');
  });

  test('records a sanitized disposal lifecycle event', () => {
    const custom = transport(async () => envelope({ ok: true }));
    const coordinator = createRequestCoordinator({ transport: custom });

    coordinator.dispose(new Error('contains sensitive internal message'));

    const serialized = JSON.stringify(coordinator.getDiagnostics());
    expect(serialized).toContain('network.client.disposed');
    expect(serialized).toContain('Error');
    expect(serialized).not.toContain('contains sensitive internal message');
  });

  test('scope snapshot is immutable from the caller perspective', async () => {
    const custom = transport(async () => envelope({ ok: true }));
    const coordinator = createRequestCoordinator({ transport: custom });

    await coordinator.request({ method: 'get', url: '/items' });
    const snapshot = coordinator.requestScope.snapshot();

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.history)).toBe(true);
    expect(Object.isFrozen(snapshot.history[0])).toBe(true);
  });
});
