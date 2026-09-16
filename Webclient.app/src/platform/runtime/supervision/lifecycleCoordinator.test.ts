import { afterEach, describe, expect, test, vi } from 'vitest';
import { type LifecycleComponent } from './contracts';
import { LifecycleCoordinator } from './lifecycleCoordinator';

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('LifecycleCoordinator orchestration', () => {
  test('starts dependencies before dependents and shuts down in reverse order', async () => {
    const events: string[] = [];
    const coordinator = new LifecycleCoordinator({ concurrency: 4 });
    coordinator.register({
      id: 'config',
      phase: 'bootstrap',
      criticality: 'critical',
      start: () => { events.push('start:config'); },
      stop: () => { events.push('stop:config'); },
    });
    coordinator.register({
      id: 'http',
      phase: 'core',
      criticality: 'critical',
      dependencies: [{ id: 'config' }],
      start: () => { events.push('start:http'); },
      stop: () => { events.push('stop:http'); },
    });
    coordinator.register({
      id: 'search',
      dependencies: [{ id: 'http' }],
      start: () => { events.push('start:search'); },
      stop: () => { events.push('stop:search'); },
    });

    const started = await coordinator.startAll();
    expect(started.success).toBe(true);
    expect(started.started).toEqual(['config', 'http', 'search']);
    expect(events).toEqual(['start:config', 'start:http', 'start:search']);
    expect(coordinator.health.readiness().status).toBe('ready');

    const stopped = await coordinator.stopAll();
    expect(stopped.success).toBe(true);
    expect(stopped.stopped).toEqual(['search', 'http', 'config']);
    expect(events).toEqual([
      'start:config',
      'start:http',
      'start:search',
      'stop:search',
      'stop:http',
      'stop:config',
    ]);
  });

  test('starts independent nodes from the same dependency level concurrently', async () => {
    const first = { resolve: () => undefined as void };
    let resolveA!: () => void;
    let resolveB!: () => void;
    const gateA = new Promise<void>((resolve) => { resolveA = resolve; first.resolve = resolve; });
    const gateB = new Promise<void>((resolve) => { resolveB = resolve; });
    const starts: string[] = [];
    const coordinator = new LifecycleCoordinator({ concurrency: 2 });
    coordinator.register({ id: 'root', start: () => undefined });
    coordinator.register({
      id: 'a', dependencies: [{ id: 'root' }], start: async () => { starts.push('a'); await gateA; },
    });
    coordinator.register({
      id: 'b', dependencies: [{ id: 'root' }], start: async () => { starts.push('b'); await gateB; },
    });
    const pending = coordinator.startAll();
    await flush();
    await flush();
    expect(starts.sort()).toEqual(['a', 'b']);
    resolveA();
    resolveB();
    await expect(pending).resolves.toMatchObject({ success: true });
  });

  test('rolls back already-started components when a critical component fails', async () => {
    const events: string[] = [];
    const coordinator = new LifecycleCoordinator();
    coordinator.register({
      id: 'config', criticality: 'critical',
      start: () => { events.push('start:config'); },
      stop: ({ reason }) => { events.push(`stop:config:${reason}`); },
    });
    coordinator.register({
      id: 'http', criticality: 'critical', dependencies: [{ id: 'config' }],
      start: () => { events.push('start:http'); throw new Error('backend unavailable'); },
    });
    coordinator.register({
      id: 'search', dependencies: [{ id: 'http' }], start: () => { events.push('start:search'); },
    });

    const result = await coordinator.startAll();
    expect(result.success).toBe(false);
    expect(result.started).toEqual(['config']);
    expect(result.failed).toEqual(['http']);
    expect(result.rolledBack).toEqual(['config']);
    expect(events).toEqual(['start:config', 'start:http', 'stop:config:rollback']);
    expect(coordinator.state('config')?.state).toBe('stopped');
    expect(coordinator.state('http')?.state).toBe('failed');
  });

  test('optional component failure does not prevent unrelated critical startup', async () => {
    const coordinator = new LifecycleCoordinator({ continueOnOptionalFailure: true });
    coordinator.register({ id: 'config', criticality: 'critical', start: () => undefined });
    coordinator.register({
      id: 'telemetry', criticality: 'optional', dependencies: [{ id: 'config' }],
      start: () => { throw new Error('telemetry offline'); },
    });
    coordinator.register({
      id: 'map', criticality: 'critical', dependencies: [{ id: 'config' }], start: () => undefined,
    });

    const result = await coordinator.startAll();
    expect(result.success).toBe(false);
    expect(result.started).toEqual(expect.arrayContaining(['config', 'map']));
    expect(result.failed).toEqual(['telemetry']);
    expect(coordinator.running).toBe(true);
    expect(coordinator.health.readiness().status).toBe('ready');
  });

  test('important component failure is fatal by default', async () => {
    const coordinator = new LifecycleCoordinator();
    coordinator.register({ id: 'config', criticality: 'critical', start: () => undefined, stop: () => undefined });
    coordinator.register({
      id: 'workspace', criticality: 'important', dependencies: [{ id: 'config' }],
      start: () => { throw new Error('broken workspace'); },
    });
    const result = await coordinator.startAll();
    expect(result.success).toBe(false);
    expect(result.rolledBack).toEqual(['config']);
    expect(coordinator.running).toBe(false);
  });

  test('policy can continue after important component failure', async () => {
    const coordinator = new LifecycleCoordinator({ continueOnImportantFailure: true });
    coordinator.register({ id: 'config', criticality: 'critical', start: () => undefined });
    coordinator.register({
      id: 'workspace', criticality: 'important', dependencies: [{ id: 'config' }],
      start: () => { throw new Error('workspace unavailable'); },
    });
    coordinator.register({
      id: 'background', criticality: 'optional', dependencies: [{ id: 'config' }], start: () => undefined,
    });
    const result = await coordinator.startAll();
    expect(result.failed).toEqual(['workspace']);
    expect(result.started).toEqual(expect.arrayContaining(['config', 'background']));
    expect(coordinator.running).toBe(true);
  });

  test('required dependent is skipped when its dependency did not reach running state', async () => {
    const coordinator = new LifecycleCoordinator({ continueOnOptionalFailure: true });
    coordinator.register({
      id: 'optional-provider', criticality: 'optional',
      start: () => { throw new Error('provider unavailable'); },
    });
    coordinator.register({
      id: 'feature', criticality: 'optional', dependencies: [{ id: 'optional-provider' }], start: () => undefined,
    });
    const result = await coordinator.startAll();
    expect(result.failed).toEqual(['optional-provider']);
    expect(result.skipped).toEqual(['feature']);
    expect(coordinator.state('feature')).toMatchObject({ state: 'failed', failures: 1 });
  });
});

describe('LifecycleCoordinator deadlines and cancellation', () => {
  test('start deadline rejects work that ignores AbortSignal and rolls back', async () => {
    vi.useFakeTimers();
    const coordinator = new LifecycleCoordinator({ startTimeoutMs: 25 });
    coordinator.register({
      id: 'hung', criticality: 'critical',
      start: () => new Promise<void>(() => undefined),
    });
    const pending = coordinator.startAll();
    await vi.advanceTimersByTimeAsync(26);
    const result = await pending;
    expect(result.success).toBe(false);
    expect(result.failed).toEqual(['hung']);
    expect(coordinator.state('hung')).toMatchObject({
      state: 'failed',
      lastError: expect.stringContaining('25ms'),
    });
  });

  test('stop deadline records failure without blocking later shutdown entries forever', async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const coordinator = new LifecycleCoordinator({ stopTimeoutMs: 20 });
    coordinator.register({
      id: 'root', criticality: 'critical',
      start: () => undefined,
      stop: () => { events.push('root-stop'); },
    });
    coordinator.register({
      id: 'hung', dependencies: [{ id: 'root' }],
      start: () => undefined,
      stop: () => new Promise<void>(() => undefined),
    });
    await coordinator.startAll();
    const pending = coordinator.stopAll();
    await vi.advanceTimersByTimeAsync(21);
    const result = await pending;
    expect(result.success).toBe(false);
    expect(result.failed).toEqual(['hung']);
    expect(result.stopped).toEqual(['root']);
    expect(events).toEqual(['root-stop']);
  });

  test('parent cancellation is propagated into component start signal', async () => {
    const controller = new AbortController();
    let childSignal: AbortSignal | null = null;
    const coordinator = new LifecycleCoordinator();
    coordinator.register({
      id: 'abortable', criticality: 'critical',
      start: ({ signal }) => new Promise<void>((_resolve, reject) => {
        childSignal = signal;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    });
    const pending = coordinator.startAll(controller.signal);
    await flush();
    const reason = new DOMException('navigation cancelled', 'AbortError');
    controller.abort(reason);
    const result = await pending;
    expect((childSignal as AbortSignal | null)?.aborted).toBe(true);
    expect(result.success).toBe(false);
  });
});

describe('LifecycleCoordinator state and restart', () => {
  test('startAll and stopAll are idempotent at stable states', async () => {
    const start = vi.fn();
    const stop = vi.fn();
    const coordinator = new LifecycleCoordinator();
    coordinator.register({ id: 'one', start, stop });
    await coordinator.startAll();
    const duplicateStart = await coordinator.startAll();
    expect(duplicateStart.started).toEqual([]);
    expect(start).toHaveBeenCalledTimes(1);
    await coordinator.stopAll();
    const duplicateStop = await coordinator.stopAll();
    expect(duplicateStop.stopped).toEqual([]);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  test('restart stops transitive dependents then starts them in dependency order', async () => {
    const events: string[] = [];
    const component = (id: string, dependencies: string[] = []): LifecycleComponent => ({
      id,
      dependencies: dependencies.map((dependencyId) => ({ id: dependencyId })),
      start: () => { events.push(`start:${id}`); },
      stop: () => { events.push(`stop:${id}`); },
    });
    const coordinator = new LifecycleCoordinator();
    coordinator.register(component('config'));
    coordinator.register(component('http', ['config']));
    coordinator.register(component('search', ['http']));
    coordinator.register(component('unrelated', ['config']));
    await coordinator.startAll();
    events.splice(0);

    await coordinator.restart('http');
    expect(events).toEqual([
      'stop:search',
      'stop:http',
      'start:http',
      'start:search',
    ]);
  });

  test('state snapshots count starts, stops and failures', async () => {
    let fail = true;
    const coordinator = new LifecycleCoordinator({ continueOnOptionalFailure: true });
    coordinator.register({
      id: 'optional', criticality: 'optional',
      start: () => { if (fail) throw new Error('first failure'); },
      stop: () => undefined,
    });
    await coordinator.startAll();
    expect(coordinator.state('optional')).toMatchObject({ starts: 1, failures: 1, state: 'failed' });
    await coordinator.stopAll();
    fail = false;
    await coordinator.startAll();
    expect(coordinator.state('optional')).toMatchObject({ starts: 2, failures: 1, state: 'running' });
  });

  test('event observer failures do not replace lifecycle results', async () => {
    const observer = vi.fn(() => { throw new Error('event sink unavailable'); });
    const coordinator = new LifecycleCoordinator({ onEvent: observer });
    coordinator.register({ id: 'component', start: () => undefined, stop: () => undefined });
    await expect(coordinator.startAll()).resolves.toMatchObject({ success: true });
    await expect(coordinator.stopAll()).resolves.toMatchObject({ success: true });
    expect(observer).toHaveBeenCalled();
  });

  test('unregister while idle updates graph and readiness requirements', () => {
    const coordinator = new LifecycleCoordinator();
    coordinator.register({ id: 'critical', criticality: 'critical', start: () => undefined });
    coordinator.register({ id: 'optional', criticality: 'optional', start: () => undefined });
    expect(coordinator.health.readiness().required).toEqual(['critical']);
    expect(coordinator.unregister('critical')).toBe(true);
    expect(coordinator.graph().startupOrder).toEqual(['optional']);
    expect(coordinator.health.readiness().required).toEqual([]);
  });

  test('invalid state lookup is safe for caller-provided input', () => {
    const coordinator = new LifecycleCoordinator();
    expect(coordinator.state('   ')).toBeNull();
  });
});
