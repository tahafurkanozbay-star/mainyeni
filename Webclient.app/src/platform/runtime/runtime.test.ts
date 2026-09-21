import { vi } from 'vitest';
import {
  CircuitOpenError,
  SchedulerQueueFullError,
  capabilityChangedMaterially,
  createCapabilityProfile,
  createCircuitBreaker,
  createResourceBudgetManager,
  createRuntimeBudget,
  createRuntimeKernel,
  createRuntimeTelemetry,
  createTaskScheduler,
  createVersionedStateStore,
  executeWithRetry,
  isBudgetConstrained,
  retryAfterMs,
  retryDelayMs,
  sanitizeTelemetryAttributes,
  telemetryHealthScore,
  withTimeout,
} from './index';
import type { CapabilityDependencies, RuntimeCapabilities, StateChange } from './index';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const capabilities = (overrides: Partial<RuntimeCapabilities> = {}): RuntimeCapabilities => ({
  tier: 'balanced',
  hardwareConcurrency: 4,
  deviceMemoryGb: 4,
  reducedMotion: false,
  saveData: false,
  effectiveConnectionType: '4g',
  downlinkMbps: 10,
  roundTripTimeMs: 50,
  online: true,
  supportsWebGL2: true,
  supportsWorker: true,
  supportsOffscreenCanvas: true,
  supportsAbortSignalTimeout: true,
  supportsStructuredClone: true,
  supportsIntersectionObserver: true,
  supportsResizeObserver: true,
  supportsPerformanceObserver: true,
  supportsSchedulerPostTask: false,
  supportsViewTransition: false,
  supportsTrustedTypes: false,
  measuredAt: 1,
  ...overrides,
});

describe('adaptive capability profile', () => {
  const media = (matches = false) => ({
    matches,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });

  test('selects enhanced tier for capable devices on healthy networks', () => {
    const profile = createCapabilityProfile({
      navigatorRef: {
        hardwareConcurrency: 12,
        deviceMemory: 16,
        onLine: true,
        connection: { effectiveType: '4g', downlink: 25, rtt: 40, saveData: false },
      },
      windowRef: {
        matchMedia: () => media(false),
        Worker: function WorkerMock() {},
        OffscreenCanvas: function OffscreenCanvasMock() {},
        IntersectionObserver: function IntersectionObserverMock() {},
        ResizeObserver: function ResizeObserverMock() {},
        PerformanceObserver: function PerformanceObserverMock() {},
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
      documentRef: null,
      webglProbe: () => true,
      now: () => 42,
    });

    expect(profile.tier).toBe('enhanced');
    expect(profile.hardwareConcurrency).toBe(12);
    expect(profile.deviceMemoryGb).toBe(16);
    expect(profile.saveData).toBe(false);
    expect(profile.supportsWebGL2).toBe(true);
    expect(profile.measuredAt).toBe(42);
  });

  test('selects minimal tier for constrained devices and save-data mode', () => {
    const profile = createCapabilityProfile({
      navigatorRef: {
        hardwareConcurrency: 2,
        deviceMemory: 2,
        onLine: true,
        connection: { effectiveType: '2g', downlink: 0.5, rtt: 900, saveData: true },
      },
      windowRef: {
        matchMedia: () => media(true),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
      documentRef: null,
      webglProbe: () => false,
    });

    expect(profile.tier).toBe('minimal');
    expect(profile.saveData).toBe(true);
    expect(profile.reducedMotion).toBe(true);
    expect(profile.supportsWebGL2).toBe(false);
  });

  test('detects material runtime environment changes', () => {
    const before = capabilities();
    expect(capabilityChangedMaterially(before, capabilities())).toBe(false);
    expect(capabilityChangedMaterially(before, capabilities({ online: false }))).toBe(true);
    expect(capabilityChangedMaterially(before, capabilities({ saveData: true }))).toBe(true);
    expect(capabilityChangedMaterially(before, capabilities({ tier: 'minimal' }))).toBe(true);
    expect(capabilityChangedMaterially(before, capabilities({ downlinkMbps: 6 }))).toBe(true);
    expect(capabilityChangedMaterially(before, capabilities({ roundTripTimeMs: 180 }))).toBe(true);
  });
});

describe('adaptive runtime budgets', () => {
  test('uses tier-specific budgets', () => {
    const minimal = createRuntimeBudget(capabilities({ tier: 'minimal' }));
    const balanced = createRuntimeBudget(capabilities({ tier: 'balanced' }));
    const enhanced = createRuntimeBudget(capabilities({ tier: 'enhanced' }));

    expect(minimal.maxConcurrentNetwork).toBeLessThan(balanced.maxConcurrentNetwork);
    expect(balanced.maxConcurrentNetwork).toBeLessThan(enhanced.maxConcurrentNetwork);
    expect(minimal.maxVisibleFeatures3d).toBeLessThan(enhanced.maxVisibleFeatures3d);
    expect(enhanced.maxCacheBytes).toBeGreaterThan(balanced.maxCacheBytes);
  });

  test('tightens budgets for save-data and low-memory clients', () => {
    const constrained = createRuntimeBudget(capabilities({
      tier: 'enhanced',
      saveData: true,
      deviceMemoryGb: 2,
    }));

    expect(constrained.maxConcurrentNetwork).toBeLessThanOrEqual(3);
    expect(constrained.maxCacheBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(constrained.maxVisibleFeatures2d).toBeLessThanOrEqual(3000);
    expect(constrained.maxVisibleFeatures3d).toBeLessThanOrEqual(1000);
  });

  test('clamps unsafe overrides to defensive maxima', () => {
    const budget = createRuntimeBudget(capabilities(), {
      maxConcurrentNetwork: 999,
      maxConcurrentCpu: 999,
      maxQueuedTasks: 999999,
      frameBudgetMs: 999,
    });

    expect(budget.maxConcurrentNetwork).toBe(32);
    expect(budget.maxConcurrentCpu).toBe(16);
    expect(budget.maxQueuedTasks).toBe(2000);
    expect(budget.frameBudgetMs).toBe(32);
  });

  test('tracks resource reservations and rejects pressure beyond budget', () => {
    const budget = createRuntimeBudget(capabilities({ tier: 'minimal' }), {
      maxConcurrentNetwork: 2,
    });
    const rejected = vi.fn();
    const manager = createResourceBudgetManager({ budget, onRejected: rejected });

    const first = manager.reserve({ kind: 'network', owner: 'search' });
    const second = manager.reserve({ kind: 'network', owner: 'layers' });
    const third = manager.reserve({ kind: 'network', owner: 'identify' });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(third).toBeNull();
    expect(rejected).toHaveBeenCalledTimes(1);
    expect(manager.snapshot().used.network).toBe(2);
    expect(isBudgetConstrained(manager.snapshot(), 0.9)).toBe(true);
    if (!first) throw new TypeError('expected first resource reservation');

    expect(first.release()).toBe(true);
    expect(first.release()).toBe(false);
    expect(manager.snapshot().used.network).toBe(1);
    manager.dispose();
  });

  test('releases all reservations owned by a feature', () => {
    const manager = createResourceBudgetManager({ budget: createRuntimeBudget(capabilities()) });
    manager.reserve({ kind: 'network', owner: 'route' });
    manager.reserve({ kind: 'cpu', owner: 'route' });
    manager.reserve({ kind: 'cpu', owner: 'search' });

    expect(manager.releaseOwner('route')).toBe(2);
    expect(manager.snapshot().reservationCount).toBe(1);
  });
});

describe('privacy-safe telemetry', () => {
  test('drops sensitive keys and retains bounded operational metadata', () => {
    const sanitized = sanitizeTelemetryAttributes({
      status: 'success',
      token: 'secret-token',
      authorization: 'Bearer secret',
      address: 'private place',
      query: 'private search',
      count: 12,
      tier: 'enhanced',
      unknownField: 'discarded',
    });

    expect(sanitized).toEqual({ status: 'success', count: 12, tier: 'enhanced' });
    expect(sanitized?.token).toBeUndefined();
    expect(sanitized?.address).toBeUndefined();
    expect(sanitized?.unknownField).toBeUndefined();
  });

  test('uses a bounded ring buffer and reports dropped events', () => {
    let now = 100;
    const telemetry = createRuntimeTelemetry({ capacity: 2, now: () => ++now });
    telemetry.info('runtime', 'one', { status: 'ok' });
    telemetry.warn('runtime', 'two', { status: 'warning' });
    telemetry.error('runtime', 'three', { status: 'failed' });

    const snapshot = telemetry.snapshot();
    const summary = telemetry.summary();
    expect(snapshot).toHaveLength(2);
    expect(snapshot.map((event) => event.name)).toEqual(['two', 'three']);
    expect(summary.droppedEvents).toBe(1);
    expect(summary.countsByLevel.warn).toBe(1);
    expect(summary.countsByLevel.error).toBe(1);
    expect(telemetryHealthScore(summary)).toBeLessThan(100);
  });

  test('measures successful and failed operations without recording raw errors', async () => {
    let now = 0;
    const telemetry = createRuntimeTelemetry({ capacity: 20, now: () => (now += 10) });
    await expect(telemetry.measure('network', 'request', async () => 42, { operation: 'load' }))
      .resolves.toBe(42);
    await expect(telemetry.measure('network', 'request', async () => {
      throw Object.assign(new Error('private payload'), { code: 'SERVER_ERROR' });
    }, { operation: 'load' })).rejects.toThrow('private payload');

    const events = telemetry.snapshot();
    expect(events).toHaveLength(2);
    expect(events.at(0)?.attributes?.result).toBe('success');
    expect(events.at(1)?.attributes?.result).toBe('failure');
    expect(events.at(1)?.attributes?.code).toBe('SERVER_ERROR');
    expect(JSON.stringify(events)).not.toContain('private payload');
  });
});

describe('versioned state store', () => {
  test('supports immutable updates, history and compare-and-set', () => {
    let now = 1000;
    const store = createVersionedStateStore({
      initialState: { count: 0, mode: '2d' },
      now: () => ++now,
    });

    const changes: StateChange<{ count: number; mode: string }>[] = [];
    const unsubscribe = store.subscribe((change) => { changes.push(change); });
    const first = store.update((state) => ({ ...state, count: state.count + 1 }), 'increment');
    expect(first.version).toBe(1);
    expect(store.get()).toEqual({ count: 1, mode: '2d' });
    expect(Object.isFrozen(store.get())).toBe(true);

    expect(store.compareAndSet(0, (state) => ({ ...state, count: 9 }))).toBeNull();
    const second = store.compareAndSet(1, (state) => ({ ...state, mode: '3d' }), 'switch-mode');
    expect(second).not.toBeNull();
    if (!second) throw new TypeError('expected compare-and-set state change');
    expect(second.version).toBe(2);
    expect(store.get().mode).toBe('3d');
    expect(changes.map((change) => change.reason)).toEqual(['increment', 'switch-mode']);
    expect(store.history().map((item) => item.version)).toEqual([0, 1, 2]);
    unsubscribe();
  });

  test('detects transaction conflicts instead of overwriting newer state', () => {
    const store = createVersionedStateStore({ initialState: { count: 0 } });
    const transaction = store.transaction();
    transaction.update((state) => ({ count: state.count + 10 }));
    store.update((state) => ({ count: state.count + 1 }));

    expect(() => transaction.commit()).toThrow(/conflict/i);
    expect(store.get().count).toBe(1);
  });

  test('hydrates and persists through an injected adapter', async () => {
    let persisted: { count: number } | null = { count: 7 };
    const adapter = {
      read: vi.fn(() => persisted),
      write: vi.fn((state) => { persisted = { ...state }; }),
      clear: vi.fn(() => { persisted = null; }),
    };
    const store = createVersionedStateStore({ initialState: { count: 0 }, persistence: adapter });

    await store.hydrate();
    expect(store.get().count).toBe(7);
    store.set({ count: 8 });
    await store.persist();
    expect(persisted).toEqual({ count: 8 });
    await store.clearPersistence();
    expect(persisted).toBeNull();
  });
});

describe('resilience primitives', () => {
  test('computes exponential retry delay with bounded jitter', () => {
    const policy = {
      maxAttempts: 4,
      baseDelayMs: 100,
      maxDelayMs: 1000,
      jitterRatio: 0.2,
      retryable: () => true,
    };
    expect(retryDelayMs(1, policy, () => 0.5)).toBe(100);
    expect(retryDelayMs(2, policy, () => 0.5)).toBe(200);
    expect(retryDelayMs(8, policy, () => 0.5)).toBe(1000);
    expect(retryDelayMs(1, policy, () => 0)).toBe(80);
    expect(retryDelayMs(1, policy, () => 1)).toBe(120);
  });

  test('retries transient failures and returns the eventual value', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    let calls = 0;
    const value = await executeWithRetry(async () => {
      calls += 1;
      if (calls < 3) throw new Error('temporary');
      return 'ok';
    }, {
      policy: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, jitterRatio: 0 },
      clock: { sleep, random: () => 0.5, now: () => 0 },
    });

    expect(value).toBe('ok');
    expect(calls).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  test('does not retry errors rejected by policy', async () => {
    const operation = vi.fn(async () => { throw new Error('fatal'); });
    await expect(executeWithRetry(operation, {
      policy: { maxAttempts: 5, retryable: () => false },
      clock: { sleep: vi.fn(), random: () => 0.5, now: () => 0 },
    })).rejects.toThrow('fatal');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  test('opens a circuit after the configured failure threshold', async () => {
    let now = 1000;
    const transitions: string[] = [];
    const circuit = createCircuitBreaker({
      now: () => now,
      policy: {
        failureThreshold: 2,
        minimumSamples: 2,
        openDurationMs: 100,
        successThreshold: 1,
        rollingWindowMs: 1000,
      },
      onTransition: (next, previous) => { transitions.push(`${previous}->${next}`); },
    });

    await expect(circuit.execute(async () => { throw new Error('a'); })).rejects.toThrow('a');
    await expect(circuit.execute(async () => { throw new Error('b'); })).rejects.toThrow('b');
    expect(circuit.snapshot().state).toBe('open');
    await expect(circuit.execute(async () => 'blocked')).rejects.toBeInstanceOf(CircuitOpenError);

    now += 101;
    await expect(circuit.execute(async () => 'recovered')).resolves.toBe('recovered');
    expect(circuit.snapshot().state).toBe('closed');
    expect(transitions).toEqual(['closed->open', 'open->half-open', 'half-open->closed']);
  });

  test('parses Retry-After seconds and HTTP dates', () => {
    expect(retryAfterMs('3', 0)).toBe(3000);
    expect(retryAfterMs(1.5, 0)).toBe(1500);
    expect(retryAfterMs('Thu, 01 Jan 1970 00:00:05 GMT', 1000)).toBe(4000);
    expect(retryAfterMs('invalid', 0)).toBeNull();
  });

  test('enforces operation timeouts through AbortSignal', async () => {
    vi.useFakeTimers();
    const promise = withTimeout((signal) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      setTimeout(() => resolve('late'), 1000);
    }), 50);

    vi.advanceTimersByTime(51);
    await expect(promise).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
    vi.useRealTimers();
  });
});

describe('priority task scheduler', () => {
  const budget = () => createRuntimeBudget(capabilities(), {
    maxConcurrentCpu: 1,
    maxConcurrentNetwork: 1,
    maxQueuedTasks: 3,
  });

  test('deduplicates in-flight work by key', async () => {
    const scheduler = createTaskScheduler({ budget: budget() });
    let resolveWork!: (value: string | PromiseLike<string>) => void;
    const executor = vi.fn(() => new Promise<string>((resolve) => { resolveWork = resolve; }));
    const first = scheduler.schedule(executor, { key: 'same', kind: 'cpu' });
    const second = scheduler.schedule(executor, { key: 'same', kind: 'cpu' });

    expect(first).toBe(second);
    await flush();
    expect(executor).toHaveBeenCalledTimes(1);
    resolveWork('done');
    await expect(first).resolves.toBe('done');
    expect(scheduler.snapshot().deduplicated).toBe(1);
    scheduler.dispose();
  });

  test('prioritizes critical queued work ahead of background work', async () => {
    const scheduler = createTaskScheduler({ budget: budget() });
    const order: string[] = [];
    let releaseFirst!: () => void;
    const first = scheduler.schedule(() => new Promise<void>((resolve) => {
      releaseFirst = () => { order.push('running'); resolve(); };
    }), { key: 'running', kind: 'cpu', priority: 'normal' });

    await flush();
    const background = scheduler.schedule(async () => { order.push('background'); }, {
      key: 'background', kind: 'cpu', priority: 'background',
    });
    const critical = scheduler.schedule(async () => { order.push('critical'); }, {
      key: 'critical', kind: 'cpu', priority: 'critical',
    });
    releaseFirst();
    await Promise.all([first, background, critical]);
    expect(order).toEqual(['running', 'critical', 'background']);
    scheduler.dispose();
  });

  test('rejects work when the bounded queue is full', async () => {
    const scheduler = createTaskScheduler({ budget: createRuntimeBudget(capabilities(), {
      maxConcurrentCpu: 1,
      maxQueuedTasks: 1,
    }) });
    let release!: () => void;
    const running = scheduler.schedule(() => new Promise<void>((resolve) => { release = resolve; }), { kind: 'cpu' });
    await flush();
    const queued = scheduler.schedule(async () => 'queued', { kind: 'cpu' });
    await expect(scheduler.schedule(async () => 'overflow', { kind: 'cpu' }))
      .rejects.toBeInstanceOf(SchedulerQueueFullError);
    release();
    await Promise.all([running, queued]);
    expect(scheduler.snapshot().rejected).toBe(1);
    scheduler.dispose();
  });

  test('cancels queued work by key without running it', async () => {
    const scheduler = createTaskScheduler({ budget: budget() });
    let release!: () => void;
    const running = scheduler.schedule(() => new Promise<void>((resolve) => { release = resolve; }), { key: 'running', kind: 'cpu' });
    await flush();
    const executor = vi.fn(async () => 'never');
    const queued = scheduler.schedule(executor, { key: 'cancel-me', kind: 'cpu' });
    expect(scheduler.cancel('cancel-me')).toBe(1);
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    expect(executor).not.toHaveBeenCalled();
    release();
    await running;
    scheduler.dispose();
  });

  test('drains after all queued and active work completes', async () => {
    const scheduler = createTaskScheduler({ budget: budget() });
    let release!: () => void;
    const work = scheduler.schedule(() => new Promise<void>((resolve) => { release = resolve; }), { kind: 'cpu' });
    await flush();
    let drained = false;
    const drain = scheduler.drain().then(() => { drained = true; });
    await flush();
    expect(drained).toBe(false);
    release();
    await work;
    await drain;
    expect(drained).toBe(true);
    scheduler.dispose();
  });
});

describe('runtime kernel lifecycle', () => {
  const capabilityDependencies: CapabilityDependencies = {
    navigatorRef: {
      hardwareConcurrency: 4,
      deviceMemory: 4,
      onLine: true,
      connection: { effectiveType: '4g', downlink: 8, rtt: 50, saveData: false },
    },
    windowRef: {
      matchMedia: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
    documentRef: null,
    webglProbe: () => true,
  };

  test('starts required modules in order and stops in reverse order', async () => {
    const calls: string[] = [];
    const kernel = createRuntimeKernel({ capabilityDependencies });
    kernel.registerModule({
      id: 'second',
      order: 20,
      required: true,
      start: () => { calls.push('start-second'); },
      ready: () => { calls.push('ready-second'); },
      stop: () => { calls.push('stop-second'); },
    });
    kernel.registerModule({
      id: 'first',
      order: 10,
      required: true,
      start: () => { calls.push('start-first'); },
      ready: () => { calls.push('ready-first'); },
      stop: () => { calls.push('stop-first'); },
    });

    const started = await kernel.start();
    expect(started.phase).toBe('ready');
    expect(calls.slice(0, 4)).toEqual(['start-first', 'start-second', 'ready-first', 'ready-second']);
    const stopped = await kernel.stop({ drain: false });
    expect(stopped.phase).toBe('stopped');
    expect(calls.slice(-2)).toEqual(['stop-second', 'stop-first']);
    await kernel.dispose();
  });

  test('degrades rather than failing for optional module errors', async () => {
    const kernel = createRuntimeKernel({ capabilityDependencies });
    kernel.registerModule({ id: 'optional', start: () => { throw new Error('optional failure'); } });
    const snapshot = await kernel.start();
    expect(snapshot.phase).toBe('degraded');
    expect(snapshot.failures).toHaveLength(1);
    expect(snapshot.failures.at(0)?.domain).toContain('optional');
    await kernel.stop({ drain: false });
    await kernel.dispose();
  });

  test('fails startup for required module errors', async () => {
    const kernel = createRuntimeKernel({ capabilityDependencies });
    kernel.registerModule({ id: 'required', required: true, start: () => { throw new Error('required failure'); } });
    await expect(kernel.start()).rejects.toThrow('required failure');
    expect(kernel.phase()).toBe('failed');
    await kernel.dispose();
  });

  test('suspends and resumes registered modules', async () => {
    const calls: string[] = [];
    const kernel = createRuntimeKernel({ capabilityDependencies });
    kernel.registerModule({
      id: 'lifecycle',
      start: () => { calls.push('start'); },
      suspend: () => { calls.push('suspend'); },
      resume: () => { calls.push('resume'); },
      stop: () => { calls.push('stop'); },
    });
    await kernel.start();
    expect((await kernel.suspend()).phase).toBe('suspended');
    expect((await kernel.resume()).phase).toBe('ready');
    expect(calls).toEqual(['start', 'suspend', 'resume']);
    await kernel.stop({ drain: false });
    await kernel.dispose();
  });

  test('combines retry and circuit breaker for resilient operations', async () => {
    const kernel = createRuntimeKernel({ capabilityDependencies });
    await kernel.start();
    let attempts = 0;
    const result = await kernel.resilient(async () => {
      attempts += 1;
      if (attempts < 2) throw new Error('transient');
      return 'ready';
    }, {
      circuit: 'api',
      policy: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
      clock: { sleep: async () => undefined, random: () => 0.5, now: () => 0 },
    });
    expect(result).toBe('ready');
    expect(attempts).toBe(2);
    expect(kernel.circuit('api')).not.toBeNull();
    await kernel.stop({ drain: false });
    await kernel.dispose();
  });

  test('exposes a privacy-safe consolidated snapshot', async () => {
    const kernel = createRuntimeKernel({ capabilityDependencies });
    await kernel.start();
    kernel.telemetry.info('runtime', 'sample', { status: 'ok', token: 'must-not-leak' });
    const snapshot = kernel.snapshot();
    expect(snapshot.phase).toBe('ready');
    expect(snapshot.capabilities.tier).toBe('balanced');
    expect(snapshot.budget.tier).toBe('balanced');
    expect(JSON.stringify(kernel.telemetry.snapshot())).not.toContain('must-not-leak');
    await kernel.stop({ drain: false });
    await kernel.dispose();
  });
});
