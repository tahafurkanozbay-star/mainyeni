import { vi } from 'vitest';
import { createApiClient } from './httpClient';
import { createRequestCoordinator } from './requestCoordinator';
import { createRequestScheduler } from './requestScheduler';
import { createRuntimeCapabilityReport, createRuntimeTuningProfile } from './runtimeCapabilities';
import type { RawRequestConfig, RequestTransport, RuntimeDefaults, TransportResult } from './contracts';

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

interface TestRuntimeOptions {
  saveData?: boolean;
  effectiveType?: string;
  hardwareConcurrency?: number;
  deviceMemory?: number;
  onLine?: boolean;
}

interface TestRuntime extends Record<string, unknown> {
  navigator: Record<string, unknown> & {
    onLine: boolean;
    hardwareConcurrency: number;
    deviceMemory: number;
    connection: Record<string, unknown>;
    userAgent?: string;
  };
}

const makeRuntime = ({
  saveData = false,
  effectiveType = '4g',
  hardwareConcurrency = 8,
  deviceMemory = 8,
  onLine = true,
}: TestRuntimeOptions = {}): TestRuntime => ({
  Promise,
  fetch: vi.fn(),
  AbortController,
  URL,
  URLSearchParams,
  FormData: typeof FormData === 'undefined' ? function FormDataStub() {} : FormData,
  Blob: typeof Blob === 'undefined' ? function BlobStub() {} : Blob,
  ArrayBuffer,
  navigator: {
    onLine,
    hardwareConcurrency,
    deviceMemory,
    connection: {
      saveData,
      effectiveType,
      downlink: effectiveType === '4g' ? 12 : 2,
      rtt: effectiveType === '4g' ? 50 : 450,
    },
  },
});

type TestAttemptConfig = RawRequestConfig & { readonly attempt?: number };

const makeTransport = (
  requestImpl: (config: TestAttemptConfig) => Promise<TransportResult> | TransportResult,
  defaults: RuntimeDefaults = {},
): RequestTransport => ({
  defaults: {
    timeoutMs: 15000,
    maxRetries: 0,
    cacheTtlMs: 1000,
    ...defaults,
  },
  request: vi.fn(async (config) => requestImpl(config as TestAttemptConfig)),
});

describe('typed runtime integration', () => {
  test('coordinator enforces scheduler concurrency around transport attempts', async () => {
    const scheduler = createRequestScheduler({ maxConcurrent: 2, maxConcurrentPerGroup: 2 });
    const gates = [deferred(), deferred(), deferred()];
    let active = 0;
    let peak = 0;

    const transport = makeTransport(async (config) => {
      active += 1;
      peak = Math.max(peak, active);
      const params = config.params && !(config.params instanceof URLSearchParams) ? config.params as Record<string, unknown> : {};
      const index = Number(params.index);
      const gate = gates[index];
      if (!gate) throw new RangeError(`missing request gate ${index}`);
      await gate.promise;
      active -= 1;
      return { data: index, status: 200, metadata: {} };
    });

    const coordinator = createRequestCoordinator({
      transport,
      scheduler,
      maxRetries: 0
    });

    const requests = [0, 1, 2].map((index) => coordinator.request({
      url: '/Layer/List',
      method: 'get',
      params: { index },
      schedulerGroup: 'layers'
    }));

    await flush();
    expect(active).toBe(2);
    expect(transport.request).toHaveBeenCalledTimes(2);
    expect(coordinator.getSchedulerSnapshot()).toMatchObject({ running: 2, queued: 1 });

    gates[0]?.resolve();
    await flush();
    expect(transport.request).toHaveBeenCalledTimes(3);
    gates[1]?.resolve();
    gates[2]?.resolve();

    await Promise.all(requests);
    expect(peak).toBe(2);
  });

  test('retry delay does not retain scheduler execution slot', async () => {
    const scheduler = createRequestScheduler({ maxConcurrent: 1 });
    const retryWait = deferred<void>();
    const secondGate = deferred<void>();
    const calls: string[] = [];

    const transport = makeTransport(async (config) => {
      const attempt = config.attempt ?? 0;
      calls.push(`${config.url}:${attempt}`);
      if (config.url === '/first' && attempt === 0) {
        throw Object.assign(new Error('temporary'), {
          code: 'NETWORK_ERROR',
          retryable: true
        });
      }
      if (config.url === '/second') {
        await secondGate.promise;
      }
      return { data: config.url, status: 200, metadata: {} };
    }, { maxRetries: 1 });

    const coordinator = createRequestCoordinator({
      transport,
      scheduler,
      maxRetries: 1,
      wait: () => retryWait.promise
    });

    const first = coordinator.request({ url: '/first', method: 'get', maxRetries: 1 });
    await flush();
    expect(calls).toEqual(['/first:0']);
    expect(scheduler.getRunningCount()).toBe(0);

    const second = coordinator.request({ url: '/second', method: 'get' });
    await flush();
    expect(calls).toContain('/second:0');
    expect(scheduler.getRunningCount()).toBe(1);

    secondGate.resolve(undefined);
    await second;
    retryWait.resolve(undefined);
    await first;
    expect(calls).toEqual(['/first:0', '/second:0', '/first:1']);
  });

  test('queued AbortSignal cancels before transport invocation', async () => {
    const scheduler = createRequestScheduler({ maxConcurrent: 1 });
    const gate = deferred<void>();
    const controller = new AbortController();

    const transport = makeTransport(async (config) => {
      if (config.url === '/blocker') await gate.promise;
      return { data: config.url, status: 200, metadata: {} };
    });
    const coordinator = createRequestCoordinator({ transport, scheduler });

    const blocker = coordinator.request({ url: '/blocker', method: 'get' });
    const queued = coordinator.request({
      url: '/queued',
      method: 'get',
      signal: controller.signal
    });

    await flush();
    expect(transport.request).toHaveBeenCalledTimes(1);
    controller.abort();
    await expect(queued).rejects.toMatchObject({ code: 'ABORTED' });
    expect(transport.request).toHaveBeenCalledTimes(1);

    gate.resolve(undefined);
    await blocker;
  });

  test('explicit priority is passed to scheduler events', async () => {
    const events: Array<{ name: string; metadata: Readonly<Record<string, unknown>> }> = [];
    const scheduler = createRequestScheduler({
      onEvent: (name, metadata) => events.push({ name, metadata })
    });
    const transport = makeTransport(async () => ({ data: 'ok', status: 200, metadata: {} }));
    const coordinator = createRequestCoordinator({ transport, scheduler });

    await coordinator.request({
      url: '/important',
      method: 'get',
      priority: 'critical',
      schedulerGroup: 'bootstrap'
    });

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'network.scheduler.queued',
        metadata: expect.objectContaining({ priority: 'critical', groupKey: 'bootstrap' })
      }),
      expect.objectContaining({
        name: 'network.scheduler.started',
        metadata: expect.objectContaining({ priority: 'critical', groupKey: 'bootstrap' })
      })
    ]));
  });

  test('safe duplicate requests still dedupe before scheduler work', async () => {
    const gate = deferred();
    const transport = makeTransport(async () => {
      await gate.promise;
      return { data: { value: 1 }, status: 200, metadata: {} };
    });
    const coordinator = createRequestCoordinator({ transport });

    const first = coordinator.request({ url: '/same', method: 'get', dedupe: true });
    const second = coordinator.request({ url: '/same', method: 'get', dedupe: true });
    await flush();

    expect(transport.request).toHaveBeenCalledTimes(1);
    expect(coordinator.getInFlightSize()).toBe(1);

    gate.resolve(undefined);
    const [a, b] = await Promise.all([first, second]);
    expect(a.data).toEqual({ value: 1 });
    expect(b.data).toEqual({ value: 1 });
    expect(coordinator.getInFlightSize()).toBe(0);
  });

  test('cache hits bypass transport and scheduler on subsequent request', async () => {
    const transport = makeTransport(async () => ({ data: { cached: true }, status: 200, metadata: {} }));
    const coordinator = createRequestCoordinator({ transport, cacheTtlMs: 5000 });

    const first = await coordinator.request({ url: '/cached', method: 'get', cache: true });
    const before = coordinator.getSchedulerSnapshot().counters.scheduled;
    const second = await coordinator.request({ url: '/cached', method: 'get', cache: true });
    const after = coordinator.getSchedulerSnapshot().counters.scheduled;

    expect(first.fromCache).toBe(false);
    expect(second.fromCache).toBe(true);
    expect(transport.request).toHaveBeenCalledTimes(1);
    expect(after).toBe(before);
  });
});

describe('createApiClient runtime intelligence', () => {
  test('exposes runtime capability, tuning and scheduler snapshots', () => {
    const runtime = makeRuntime();
    const capabilityReport = createRuntimeCapabilityReport(runtime);
    const tuningProfile = createRuntimeTuningProfile(runtime);
    const transport = makeTransport(async () => ({ data: 'ok', status: 200, metadata: {} }));

    const client = createApiClient({
      runtimeConfig: {
        apiBaseUrl: '/api',
        requestTimeoutMs: 10000,
        maxRetries: 1,
        cacheTtlMs: 1000
      },
      capabilityReport,
      tuningProfile,
      transport
    });

    expect(client.getRuntimeCapabilityReport()).toBe(capabilityReport);
    expect(client.getRuntimeTuningProfile()).toBe(tuningProfile);
    expect(client.getRuntimeSupportSummary()).toMatchObject({
      supported: true,
      networkQuality: 'fast'
    });
    expect(client.getSchedulerSnapshot().maxConcurrent).toBe(tuningProfile.scheduler.maxConcurrent);
  });

  test('constrained runtime creates a smaller scheduler automatically', () => {
    const runtime = makeRuntime({ saveData: true, effectiveType: '3g' });
    const capabilityReport = createRuntimeCapabilityReport(runtime);
    const tuningProfile = createRuntimeTuningProfile(runtime);
    const transport = makeTransport(async () => ({ data: 'ok', status: 200, metadata: {} }));

    const client = createApiClient({
      runtimeConfig: {
        apiBaseUrl: '/api',
        requestTimeoutMs: 10000,
        maxRetries: 0,
        cacheTtlMs: 0
      },
      capabilityReport,
      tuningProfile,
      transport
    });

    expect(client.getSchedulerSnapshot().maxConcurrent).toBeLessThanOrEqual(3);
    expect(client.getRuntimeSupportSummary()).toMatchObject({
      saveData: true,
      prefetchAllowed: false,
      backgroundWorkAllowed: false
    });
  });

  test('explicit capability assertion fails before client creation', () => {
    const report = createRuntimeCapabilityReport({
      Promise,
      AbortController,
      URL,
      URLSearchParams,
      fetch: undefined,
      navigator: {}
    });

    expect(() => createApiClient({
      runtimeConfig: {
        apiBaseUrl: '/api',
        requestTimeoutMs: 10000,
        maxRetries: 0,
        cacheTtlMs: 0
      },
      capabilityReport: report,
      tuningProfile: createRuntimeTuningProfile({ navigator: {} }),
      transport: makeTransport(async () => ({ data: 'ok', status: 200, metadata: {} })),
      assertCapabilities: true
    })).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_BROWSER_RUNTIME' }));
  });

  test('default client construction is side-effect safe in partial runtimes', () => {
    const report = createRuntimeCapabilityReport({ navigator: {} });
    const tuning = createRuntimeTuningProfile({ navigator: {} });
    const transport = makeTransport(async () => ({ data: 'ok', status: 200, metadata: {} }));

    expect(() => createApiClient({
      runtimeConfig: {
        apiBaseUrl: '/api',
        requestTimeoutMs: 10000,
        maxRetries: 0,
        cacheTtlMs: 0
      },
      capabilityReport: report,
      tuningProfile: tuning,
      transport
    })).not.toThrow();
  });

  test('runtime diagnostics contain coarse operational data, not request secrets', () => {
    const runtime = makeRuntime();
    runtime.navigator.userAgent = 'private-agent';
    const capabilityReport = createRuntimeCapabilityReport(runtime);
    const tuningProfile = createRuntimeTuningProfile(runtime);
    const transport = makeTransport(async () => ({ data: 'ok', status: 200, metadata: {} }));

    const client = createApiClient({
      runtimeConfig: {
        apiBaseUrl: '/api',
        requestTimeoutMs: 10000,
        maxRetries: 0,
        cacheTtlMs: 0
      },
      capabilityReport,
      tuningProfile,
      transport
    });

    const serialized = JSON.stringify(client.getDiagnostics());
    expect(serialized).toContain('network.runtime.capabilities');
    expect(serialized).toContain('network.runtime.tuning');
    expect(serialized).not.toContain('private-agent');
    expect(serialized).not.toMatch(/authorization|cookie|password|token/i);
  });
});
