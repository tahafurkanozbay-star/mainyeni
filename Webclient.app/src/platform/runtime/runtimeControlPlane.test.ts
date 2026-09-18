import { describe, expect, it, vi } from 'vitest';
import type { RequestExecutionContext } from './supervision';
import {
  RuntimeControlPlaneDisposedError,
  createRuntimeControlPlane,
} from './runtimeControlPlane';

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('runtimeControlPlane lifecycle', () => {
  it('starts a dependency-ordered runtime and exposes aggregate snapshots', async () => {
    let now = 100;
    const plane = createRuntimeControlPlane({
      now: () => now,
      supervisor: {
        lifecycle: { clock: { now: () => now } },
        requests: { now: () => now },
      },
      readiness: { stableSamples: 1, defaultTimeoutMs: 0 },
      health: { healthPolicy: { recoverySamples: 1 } },
    });
    const events: string[] = [];
    plane.register({
      id: 'config', phase: 'bootstrap', criticality: 'critical',
      start: () => { events.push('start:config'); },
      stop: () => { events.push('stop:config'); },
    });
    plane.register({
      id: 'http', phase: 'core', criticality: 'critical', dependencies: [{ id: 'config' }],
      start: () => { events.push('start:http'); },
      stop: () => { events.push('stop:http'); },
    });

    const started = await plane.start();
    expect(events).toEqual(['start:config', 'start:http']);
    expect(started.phase).toBe('running');
    expect(started.readiness.status).toBe('ready');
    expect(started.supervisor.graph.startupOrder).toEqual(['config', 'http']);
    now = 200;
    expect(plane.snapshot().generatedAt).toBe(200);

    await plane.stop();
    expect(events.slice(-2)).toEqual(['stop:http', 'stop:config']);
    expect(plane.phase()).toBe('stopped');
  });

  it('coalesces concurrent start calls through one lifecycle operation', async () => {
    let release: (() => void) | undefined;
    const start = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const plane = createRuntimeControlPlane({ readiness: { stableSamples: 1, defaultTimeoutMs: 0 } });
    plane.register({ id: 'config', criticality: 'critical', start });
    const first = plane.start();
    const second = plane.start();
    await flush();
    expect(start).toHaveBeenCalledTimes(1);
    release?.();
    const [a, b] = await Promise.all([first, second]);
    expect(a.phase).toBe('running');
    expect(b.phase).toBe('running');
  });

  it('marks startup failed when critical lifecycle startup fails', async () => {
    const plane = createRuntimeControlPlane({ readiness: { stableSamples: 1, defaultTimeoutMs: 0 } });
    plane.register({
      id: 'config', criticality: 'critical',
      start: () => { throw new Error('config unavailable'); },
    });
    await expect(plane.start()).rejects.toThrow('config unavailable');
    expect(plane.phase()).toBe('failed');
    expect(plane.events().some((event) => event.name === 'phase-transition' && event.message?.includes('failed'))).toBe(true);
  });

  it('allows restart after a clean stop', async () => {
    const start = vi.fn();
    const plane = createRuntimeControlPlane({ readiness: { stableSamples: 1, defaultTimeoutMs: 0 } });
    plane.register({ id: 'config', criticality: 'critical', start, stop: () => undefined });
    await plane.start();
    await plane.stop();
    await plane.start();
    expect(start).toHaveBeenCalledTimes(2);
    expect(plane.phase()).toBe('running');
  });
});

describe('runtimeControlPlane readiness-gated execution', () => {
  it('waits for readiness before submitting work', async () => {
    let releaseStart: (() => void) | undefined;
    const plane = createRuntimeControlPlane({ readiness: { stableSamples: 1, defaultTimeoutMs: 0 } });
    plane.register({
      id: 'config', criticality: 'critical',
      start: () => new Promise<void>((resolve) => { releaseStart = resolve; }),
    });
    const start = plane.start();
    const operation = vi.fn(async () => 'result');
    const work = plane.execute(operation, { key: 'load-config' });
    await flush();
    expect(operation).not.toHaveBeenCalled();
    releaseStart?.();
    await start;
    await expect(work).resolves.toBe('result');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('can bypass barrier waiting for explicit recovery work', async () => {
    const plane = createRuntimeControlPlane();
    const operation = vi.fn(async () => 'recovery');
    await expect(plane.execute(operation, {
      key: 'recovery',
      waitForReady: false,
      requireReady: false,
    })).resolves.toBe('recovery');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('preserves supervisor component availability enforcement', async () => {
    const plane = createRuntimeControlPlane({ readiness: { stableSamples: 1, defaultTimeoutMs: 0 } });
    plane.register({ id: 'config', criticality: 'critical', start: () => undefined });
    await plane.start();
    plane.supervisor.reportHealth({ componentId: 'config', status: 'unhealthy' });
    await expect(plane.execute(async () => 'work', {
      key: 'work', componentId: 'config', waitForReady: false, requireReady: false,
    })).rejects.toMatchObject({ code: 'COMPONENT_UNAVAILABLE' });
  });

  it('passes request lane, priority and deduplication to supervisor coordination', async () => {
    const plane = createRuntimeControlPlane();
    const operation = vi.fn(async ({ lane, key }: RequestExecutionContext) => `${lane}:${key}`);
    const first = plane.execute(operation, {
      key: 'districts', lane: 'search', priority: 'high', waitForReady: false, requireReady: false,
    });
    const second = plane.execute(operation, {
      key: 'districts', lane: 'search', priority: 'high', waitForReady: false, requireReady: false,
    });
    await expect(Promise.all([first, second])).resolves.toEqual(['search:districts', 'search:districts']);
    expect(operation).toHaveBeenCalledTimes(1);
  });
});

describe('runtimeControlPlane health integration', () => {
  it('turns warning health events into degraded control-plane readiness', async () => {
    const plane = createRuntimeControlPlane({
      readiness: { stableSamples: 1, defaultTimeoutMs: 0 },
      health: { componentId: 'runtime-health', healthPolicy: { minimumSamples: 10 } },
    });
    plane.register({ id: 'config', criticality: 'critical', start: () => undefined });
    await plane.start();
    const transition = plane.recordHealth({
      at: 10, kind: 'pressure', severity: 'warning', code: 'queue-pressure',
    });
    expect(transition.current).toBe('degraded');
    expect(plane.supervisor.health.get('runtime-health')?.status).toBe('degraded');
    expect(plane.snapshot().health.assessment.state).toBe('degraded');
  });

  it('turns critical health events into not-ready control-plane state', async () => {
    const plane = createRuntimeControlPlane({
      readiness: { stableSamples: 1, defaultTimeoutMs: 0 },
      health: { componentId: 'runtime-health', healthPolicy: { minimumSamples: 10 } },
    });
    plane.register({ id: 'config', criticality: 'critical', start: () => undefined });
    await plane.start();
    plane.recordHealth({ at: 20, kind: 'failure', severity: 'critical', code: 'runtime-critical' });
    expect(plane.supervisor.health.get('runtime-health')?.status).toBe('unhealthy');
    expect(plane.snapshot().readiness.status).toBe('not-ready');
    expect(plane.phase()).toBe('degraded');
  });

  it('recovers health after configured hysteresis', async () => {
    const plane = createRuntimeControlPlane({
      readiness: { stableSamples: 1, defaultTimeoutMs: 0 },
      health: {
        componentId: 'runtime-health',
        healthPolicy: { minimumSamples: 1, recoverySamples: 1, criticalFailureRate: 0.9 },
        journalPolicy: { failureWindowSize: 1 },
      },
    });
    plane.register({ id: 'config', criticality: 'critical', start: () => undefined });
    await plane.start();
    plane.recordHealth({ at: 1, kind: 'failure', severity: 'error', code: 'failure' });
    expect(plane.snapshot().health.assessment.state).toBe('critical');
    plane.recordHealth({ at: 2, kind: 'latency', severity: 'info', code: 'healthy', durationMs: 100 });
    expect(plane.snapshot().health.assessment.state).toBe('healthy');
    expect(plane.supervisor.health.get('runtime-health')?.status).toBe('healthy');
  });

  it('supports explicit health assessment without new events', async () => {
    const plane = createRuntimeControlPlane({ health: { healthPolicy: { minimumSamples: 1 } } });
    plane.recordHealth({ at: 1, kind: 'latency', severity: 'info', code: 'latency', durationMs: 100 });
    const transition = plane.assessHealth(500);
    expect(transition.at).toBe(500);
    expect(transition.summary.retained).toBe(1);
  });
});

describe('runtimeControlPlane recovery integration', () => {
  it('restarts dependency subtree through bounded recovery coordinator', async () => {
    const events: string[] = [];
    const plane = createRuntimeControlPlane({
      readiness: { stableSamples: 1, defaultTimeoutMs: 0 },
      recovery: { baseCooldownMs: 0, successQuietPeriodMs: 0 },
    });
    plane.register({
      id: 'http', criticality: 'critical',
      start: () => { events.push('start:http'); },
      stop: () => { events.push('stop:http'); },
    });
    plane.register({
      id: 'search', dependencies: [{ id: 'http' }],
      start: () => { events.push('start:search'); },
      stop: () => { events.push('stop:search'); },
    });
    await plane.start();
    events.splice(0);
    await plane.recover({ componentId: 'http', reason: 'health-unhealthy', urgency: 'urgent' });
    expect(events).toEqual(['stop:search', 'stop:http', 'start:http', 'start:search']);
    expect(plane.snapshot().recovery.components[0]).toMatchObject({ componentId: 'http', attemptsInWindow: 1 });
  });

  it('surfaces recovery budget exhaustion without taking down the control plane', async () => {
    const plane = createRuntimeControlPlane({
      readiness: { stableSamples: 1, defaultTimeoutMs: 0 },
      recovery: {
        baseCooldownMs: 0,
        successQuietPeriodMs: 0,
        maxAttemptsPerWindow: 1,
        attemptWindowMs: 60_000,
      },
    });
    plane.register({ id: 'http', criticality: 'critical', start: () => undefined, stop: () => undefined });
    await plane.start();
    await plane.recover({ componentId: 'http', reason: 'first', urgency: 'urgent' });
    await expect(plane.recover({ componentId: 'http', reason: 'second', urgency: 'urgent' }))
      .rejects.toMatchObject({ code: 'RUNTIME_RECOVERY_BUDGET_EXCEEDED' });
    expect(plane.phase()).toBe('running');
    expect(plane.events().some((event) => event.type === 'recovery' && event.name === 'blocked')).toBe(true);
  });
});

describe('runtimeControlPlane events, subscriptions and ownership', () => {
  it('bounds control-plane event history', () => {
    const plane = createRuntimeControlPlane({ eventHistoryLimit: 16 });
    for (let index = 0; index < 30; index += 1) {
      plane.supervisor.reportHealth({ componentId: `component-${index}`, status: 'healthy' });
    }
    expect(plane.events()).toHaveLength(16);
    expect(plane.events(4)).toHaveLength(4);
  });

  it('isolates control-plane event observer failures', async () => {
    const plane = createRuntimeControlPlane({
      onEvent: () => { throw new Error('diagnostics unavailable'); },
      readiness: { stableSamples: 1, defaultTimeoutMs: 0 },
    });
    plane.register({ id: 'config', criticality: 'critical', start: () => undefined });
    await expect(plane.start()).resolves.toMatchObject({ phase: 'running' });
  });

  it('notifies snapshot subscribers and isolates subscriber errors', async () => {
    const listener = vi.fn();
    const plane = createRuntimeControlPlane({ readiness: { stableSamples: 1, defaultTimeoutMs: 0 } });
    plane.subscribe(listener);
    plane.subscribe(() => { throw new Error('observer failed'); });
    plane.register({ id: 'config', criticality: 'critical', start: () => undefined });
    await plane.start();
    expect(listener).toHaveBeenCalled();
    expect(listener.mock.calls.at(-1)?.[0]).toMatchObject({ phase: 'running' });
  });

  it('exposes root ownership scope for bounded application resources', async () => {
    const cleanup = vi.fn();
    const plane = createRuntimeControlPlane();
    plane.ownership.own(cleanup, 'feature-listener');
    expect(plane.snapshot().ownership.resourceCount).toBeGreaterThanOrEqual(2);
    await plane.dispose();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});

describe('runtimeControlPlane disposal', () => {
  it('stops runtime and disposes subordinate governance components', async () => {
    const stop = vi.fn();
    const plane = createRuntimeControlPlane({ readiness: { stableSamples: 1, defaultTimeoutMs: 0 } });
    plane.register({ id: 'config', criticality: 'critical', start: () => undefined, stop });
    await plane.start();
    await plane.dispose(new Error('application shutdown'));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(plane.phase()).toBe('disposed');
    expect(plane.ownership.disposed).toBe(true);
  });

  it('is idempotent and rejects future operations', async () => {
    const plane = createRuntimeControlPlane();
    await plane.dispose();
    await expect(plane.dispose()).resolves.toBeUndefined();
    expect(() => plane.register({ id: 'late' })).toThrow(RuntimeControlPlaneDisposedError);
    expect(() => plane.snapshot()).toThrow(RuntimeControlPlaneDisposedError);
    await expect(plane.execute(async () => 'late', {
      key: 'late', waitForReady: false, requireReady: false,
    })).rejects.toBeInstanceOf(RuntimeControlPlaneDisposedError);
  });

  it('best-effort disposal continues if lifecycle stop fails', async () => {
    const plane = createRuntimeControlPlane({ readiness: { stableSamples: 1, defaultTimeoutMs: 0 } });
    plane.register({
      id: 'broken-stop', criticality: 'critical',
      start: () => undefined,
      stop: () => { throw new Error('stop failed'); },
    });
    await plane.start();
    await expect(plane.dispose()).resolves.toBeUndefined();
    expect(plane.phase()).toBe('disposed');
    expect(plane.ownership.disposed).toBe(true);
  });
});
