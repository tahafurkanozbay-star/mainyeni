import { describe, expect, it, vi } from 'vitest';
import { createRuntimeControlPlane } from './runtimeControlPlane';
import { createRuntimeControlPlaneModule } from './runtimeControlPlaneModule';
import { createRuntimeKernel } from './runtimeKernel';

describe('runtime governance end-to-end integration', () => {
  it('boots kernel + control plane, executes gated work, degrades, recovers, and shuts down', async () => {
    const order: string[] = [];
    const plane = createRuntimeControlPlane({
      readiness: { stableSamples: 1, defaultTimeoutMs: 0 },
      health: {
        componentId: 'runtime-health',
        healthPolicy: { minimumSamples: 10, recoverySamples: 1 },
      },
      recovery: { baseCooldownMs: 0, successQuietPeriodMs: 0 },
    });
    plane.register({
      id: 'config',
      phase: 'bootstrap',
      criticality: 'critical',
      start: () => { order.push('start:config'); },
      stop: () => { order.push('stop:config'); },
    });
    plane.register({
      id: 'api',
      phase: 'core',
      criticality: 'critical',
      dependencies: [{ id: 'config' }],
      start: () => { order.push('start:api'); },
      stop: () => { order.push('stop:api'); },
    });
    plane.register({
      id: 'search',
      phase: 'feature',
      dependencies: [{ id: 'api' }],
      start: () => { order.push('start:search'); },
      stop: () => { order.push('stop:search'); },
    });

    const kernel = createRuntimeKernel();
    kernel.registerModule(createRuntimeControlPlaneModule(plane, {
      readinessTimeoutMs: 0,
      allowDegradedReadiness: true,
      disposeControlPlane: false,
    }));
    await kernel.start({ warmup: false });
    expect(order).toEqual(['start:config', 'start:api', 'start:search']);
    expect(plane.snapshot()).toMatchObject({ phase: 'running', readiness: { status: 'ready' } });

    const first = await plane.execute(async ({ lane, key }) => `${lane}:${key}`, {
      key: 'district-query',
      lane: 'search',
      componentId: 'search',
    });
    expect(first).toBe('search:district-query');

    plane.recordHealth({
      at: 10,
      kind: 'pressure',
      severity: 'warning',
      code: 'queue-pressure',
      message: 'request queue is approaching bounded capacity',
    });
    expect(plane.snapshot().health.assessment.state).toBe('degraded');
    expect(plane.snapshot().readiness.status).toBe('degraded');
    expect(plane.phase()).toBe('degraded');

    await expect(plane.execute(async () => 'allowed-in-degraded', {
      key: 'degraded-work',
      lane: 'search',
      componentId: 'search',
      readiness: { allowDegraded: true, stableSamples: 1 },
    })).resolves.toBe('allowed-in-degraded');

    order.splice(0);
    await plane.recover({ componentId: 'api', reason: 'manual-health-recovery', urgency: 'urgent' });
    expect(order).toEqual([
      'stop:search',
      'stop:api',
      'start:api',
      'start:search',
    ]);

    plane.healthBridge.clear();
    plane.assessHealth(20);
    expect(plane.snapshot().health.assessment.state).toBe('healthy');
    expect(plane.snapshot().readiness.status).toBe('ready');
    expect(plane.phase()).toBe('running');

    order.splice(0);
    await kernel.stop({ drain: false });
    expect(order).toEqual(['stop:search', 'stop:api', 'stop:config']);
    expect(plane.phase()).toBe('stopped');
    await kernel.dispose();
    await plane.dispose();
  });

  it('fails closed for strict-ready work while runtime health is degraded', async () => {
    vi.useFakeTimers();
    try {
      const plane = createRuntimeControlPlane({
        readiness: { stableSamples: 1, defaultTimeoutMs: 50 },
        health: {
          componentId: 'runtime-health',
          healthPolicy: { minimumSamples: 10, recoverySamples: 1 },
        },
      });
      plane.register({ id: 'config', criticality: 'critical', start: () => undefined });
      await plane.start();
      plane.recordHealth({ at: 1, kind: 'pressure', severity: 'warning', code: 'pressure' });

      const operation = vi.fn(async () => 'should-not-run');
      const pending = plane.execute(operation, {
        key: 'strict-work',
        readiness: { allowDegraded: false, stableSamples: 1, timeoutMs: 50 },
      });
      await vi.advanceTimersByTimeAsync(50);
      await expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
      expect(operation).not.toHaveBeenCalled();
      await plane.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels readiness waiting on caller abort without leaking queued work', async () => {
    const plane = createRuntimeControlPlane({ readiness: { stableSamples: 1, defaultTimeoutMs: 0 } });
    plane.register({ id: 'config', criticality: 'critical', start: () => undefined });
    const controller = new AbortController();
    const operation = vi.fn(async () => 'nope');
    const pending = plane.execute(operation, {
      key: 'abort-before-ready',
      readiness: { signal: controller.signal },
    });
    controller.abort(new Error('route changed'));
    await expect(pending).rejects.toThrow('route changed');
    expect(operation).not.toHaveBeenCalled();
    expect(plane.snapshot().supervisor.requests.queued).toBe(0);
    await plane.dispose();
  });

  it('bounds diagnostics across readiness, recovery, control-plane, and ownership surfaces', async () => {
    const plane = createRuntimeControlPlane({
      eventHistoryLimit: 16,
      readiness: { stableSamples: 1, defaultTimeoutMs: 0, historyLimit: 4 },
      health: { transitionHistoryLimit: 4, healthPolicy: { minimumSamples: 10 } },
      recovery: {
        baseCooldownMs: 0,
        successQuietPeriodMs: 0,
        historyLimit: 4,
        maxAttemptsPerWindow: 8,
      },
      ownership: { maxFailures: 2 },
    });
    plane.register({ id: 'config', criticality: 'critical', start: () => undefined, stop: () => undefined });
    await plane.start();

    for (let index = 0; index < 12; index += 1) {
      plane.recordHealth({
        at: index + 1,
        kind: 'pressure',
        severity: index % 2 === 0 ? 'warning' : 'info',
        code: `event-${index}`,
      });
    }
    for (let index = 0; index < 3; index += 1) {
      await plane.recover({ componentId: 'config', reason: `recovery-${index}`, urgency: 'urgent' });
    }
    plane.ownership.own(() => { throw new Error('owned cleanup 1'); }, 'broken-1');
    plane.ownership.own(() => { throw new Error('owned cleanup 2'); }, 'broken-2');
    plane.ownership.own(() => { throw new Error('owned cleanup 3'); }, 'broken-3');

    const beforeDispose = plane.snapshot();
    expect(beforeDispose.events.length).toBeLessThanOrEqual(16);
    expect(beforeDispose.barrier.history.length).toBeLessThanOrEqual(4);
    expect(beforeDispose.health.transitions.length).toBeLessThanOrEqual(4);
    expect(beforeDispose.recovery.history.length).toBeLessThanOrEqual(4);
    await plane.dispose();
  });

  it('isolates diagnostics observers from successful business execution', async () => {
    const plane = createRuntimeControlPlane({
      onEvent: () => { throw new Error('control-plane observer failed'); },
      supervisor: { onEvent: () => { throw new Error('supervisor observer failed'); } },
      health: { onTransition: () => { throw new Error('health observer failed'); } },
      recovery: { onEvent: () => { throw new Error('recovery observer failed'); }, baseCooldownMs: 0, successQuietPeriodMs: 0 },
      ownership: { onFailure: () => { throw new Error('ownership observer failed'); } },
      readiness: { stableSamples: 1, defaultTimeoutMs: 0 },
    });
    plane.register({ id: 'config', criticality: 'critical', start: () => undefined, stop: () => undefined });
    await plane.start();
    await expect(plane.execute(async () => 'business-result', { key: 'business' })).resolves.toBe('business-result');
    plane.recordHealth({ at: 1, kind: 'latency', severity: 'info', code: 'ok', durationMs: 100 });
    await plane.recover({ componentId: 'config', reason: 'test', urgency: 'urgent' });
    await plane.dispose();
  });
});
