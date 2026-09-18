import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeBudget } from './contracts';
import { createResourceBudgetManager } from './resourceBudget';
import { createAdaptiveRuntimeControl } from './adaptiveRuntimeControl';
import {
  RuntimeWorkloadDisposedError,
  RuntimeWorkloadResourceRejectedError,
  RuntimeWorkloadTimeoutError,
  createRuntimeWorkloadGovernor,
} from './runtimeWorkloadGovernor';

const BUDGET: RuntimeBudget = Object.freeze({
  tier: 'balanced',
  maxConcurrentNetwork: 2,
  maxConcurrentCpu: 2,
  maxQueuedTasks: 8,
  maxCacheEntries: 16,
  maxCacheBytes: 1024,
  maxVisibleFeatures2d: 1000,
  maxVisibleFeatures3d: 500,
  maxGpuHeavyLayers: 2,
  frameBudgetMs: 12,
  backgroundSliceMs: 6,
  telemetryCapacity: 64,
});

const createHarness = (
  overrides: Partial<RuntimeBudget> = {},
  admission: { maxActive?: number; maxQueued?: number; maxCost?: number } = {},
) => {
  let clock = 1_000;
  const budget = Object.freeze({ ...BUDGET, ...overrides });
  const manager = createResourceBudgetManager({
    budget,
    now: () => clock,
    wallTime: () => clock,
  });
  const control = createAdaptiveRuntimeControl({
    budget,
    admission: {
      maxActive: admission.maxActive ?? 4,
      maxQueued: admission.maxQueued ?? 8,
      maxCost: admission.maxCost ?? 8,
      maxQueueAgeMs: 5_000,
    },
    now: () => clock,
  });
  const governor = createRuntimeWorkloadGovernor({
    control,
    budget: manager,
    now: () => clock,
    policy: { defaultDeadlineMs: 5_000, maxDeadlineMs: 10_000 },
  });
  return {
    budget,
    manager,
    control,
    governor,
    now: () => clock,
    advance: (milliseconds: number) => { clock += milliseconds; },
    dispose: () => {
      governor.dispose();
      manager.dispose();
      control.dispose();
    },
  };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('runtimeWorkloadGovernor', () => {
  it('acquires admission and resource claims atomically', async () => {
    const harness = createHarness();
    const lease = await harness.governor.acquire({
      key: 'map-query',
      lane: 'foreground',
      owner: 'map',
      cost: 2,
      resources: [
        { kind: 'network', units: 1 },
        { kind: 'cpu', units: 1 },
      ],
    });

    expect(lease.key).toBe('map-query');
    expect(lease.lane).toBe('foreground');
    expect(lease.owner).toBe('map');
    expect(lease.resources.map((reservation) => reservation.kind)).toEqual(['network', 'cpu']);
    expect(harness.manager.snapshot().used).toMatchObject({ network: 1, cpu: 1 });

    const snapshot = harness.governor.snapshot();
    expect(snapshot.active).toBe(1);
    expect(snapshot.activeByLane.foreground).toBe(1);
    expect(snapshot.activeResources).toMatchObject({ network: 1, cpu: 1 });
    expect(snapshot.counters.acquired).toBe(1);

    lease.release();
    expect(lease.released).toBe(true);
    expect(harness.manager.snapshot().used).toMatchObject({ network: 0, cpu: 0 });
    expect(harness.governor.snapshot().counters.completed).toBe(1);
    harness.dispose();
  });

  it('rolls back earlier reservations when a later resource claim is rejected', async () => {
    const harness = createHarness({ maxConcurrentNetwork: 1, maxConcurrentCpu: 1 });
    const cpuBlocker = harness.manager.reserve({ kind: 'cpu', units: 1, owner: 'blocker' });
    expect(cpuBlocker).not.toBeNull();

    await expect(harness.governor.acquire({
      key: 'atomic',
      resources: [
        { kind: 'network', units: 1 },
        { kind: 'cpu', units: 1 },
      ],
    })).rejects.toBeInstanceOf(RuntimeWorkloadResourceRejectedError);

    const budget = harness.manager.snapshot();
    expect(budget.used.network).toBe(0);
    expect(budget.used.cpu).toBe(1);
    expect(harness.governor.snapshot().active).toBe(0);
    expect(harness.governor.snapshot().counters.resourceRejected).toBe(1);

    cpuBlocker?.release();
    harness.dispose();
  });

  it('releases admission after a resource rejection so later work can proceed', async () => {
    const harness = createHarness({ maxConcurrentNetwork: 1 }, { maxActive: 1 });
    const blocker = harness.manager.reserve({ kind: 'network', units: 1 });

    await expect(harness.governor.acquire({
      key: 'rejected',
      resources: [{ kind: 'network', units: 1 }],
    })).rejects.toBeInstanceOf(RuntimeWorkloadResourceRejectedError);

    blocker?.release();
    const recovered = await harness.governor.acquire({
      key: 'recovered',
      resources: [{ kind: 'network', units: 1 }],
    });
    expect(recovered.key).toBe('recovered');
    recovered.release();
    harness.dispose();
  });

  it('fails closed when a workload asks for too many resource claims', async () => {
    const harness = createHarness();
    const governor = createRuntimeWorkloadGovernor({
      control: harness.control,
      budget: harness.manager,
      now: harness.now,
      policy: { maxClaimsPerWorkload: 2 },
    });

    await expect(governor.acquire({
      key: 'too-many',
      resources: [
        { kind: 'network' },
        { kind: 'cpu' },
        { kind: 'render' },
      ],
    })).rejects.toThrow('maximum of 2 resource claims');

    expect(harness.control.snapshot().admission.admitted).toBe(0);
    governor.dispose();
    harness.dispose();
  });

  it('normalizes blank owners and bounds long owner labels', async () => {
    const harness = createHarness();
    const bounded = createRuntimeWorkloadGovernor({
      control: harness.control,
      budget: harness.manager,
      now: harness.now,
      policy: { maxOwnerLength: 6 },
    });

    const blank = await bounded.acquire({ key: 'blank', owner: '   ' });
    expect(blank.owner).toBeNull();
    blank.release();

    const long = await bounded.acquire({ key: 'long', owner: 'abcdefghijk' });
    expect(long.owner).toBe('abcdef');
    long.release();

    bounded.dispose();
    harness.dispose();
  });

  it('executes successful work and releases all ownership in finally-safe fashion', async () => {
    const harness = createHarness();
    const result = await harness.governor.execute({
      key: 'success',
      lane: 'foreground',
      resources: [{ kind: 'network', units: 1 }],
    }, async ({ signal, lease }) => {
      expect(signal.aborted).toBe(false);
      expect(lease.released).toBe(false);
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(harness.governor.snapshot().active).toBe(0);
    expect(harness.manager.snapshot().used.network).toBe(0);
    expect(harness.governor.snapshot().counters).toMatchObject({
      acquired: 1,
      completed: 1,
      failed: 0,
    });
    harness.dispose();
  });

  it('classifies execution failures without leaking admission or resource leases', async () => {
    const harness = createHarness();

    await expect(harness.governor.execute({
      key: 'failure',
      resources: [{ kind: 'cpu', units: 1 }],
    }, () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');

    expect(harness.governor.snapshot().active).toBe(0);
    expect(harness.manager.snapshot().used.cpu).toBe(0);
    expect(harness.governor.snapshot().counters.failed).toBe(1);
    expect(harness.governor.snapshot().health.failures).toBeGreaterThanOrEqual(1);
    harness.dispose();
  });

  it('detaches caller cancellation ownership after manual release', async () => {
    const harness = createHarness();
    const controller = new AbortController();
    const lease = await harness.governor.acquire({
      key: 'released-before-abort',
      signal: controller.signal,
      resources: [{ kind: 'network', units: 1 }],
    });

    lease.release();
    controller.abort(new DOMException('late caller abort', 'AbortError'));
    await Promise.resolve();

    expect(lease.released).toBe(true);
    expect(lease.signal.aborted).toBe(false);
    expect(harness.governor.snapshot().counters).toMatchObject({
      completed: 1,
      cancelled: 0,
    });
    expect(harness.manager.snapshot().used.network).toBe(0);
    harness.dispose();
  });

  it('auto-releases active work when the caller aborts', async () => {
    const harness = createHarness();
    const controller = new AbortController();
    const lease = await harness.governor.acquire({
      key: 'cancel-me',
      owner: 'search',
      signal: controller.signal,
      resources: [{ kind: 'network', units: 1 }],
    });

    controller.abort(new DOMException('cancel', 'AbortError'));
    await Promise.resolve();

    expect(lease.released).toBe(true);
    expect(harness.governor.snapshot().active).toBe(0);
    expect(harness.manager.snapshot().used.network).toBe(0);
    expect(harness.governor.snapshot().counters.cancelled).toBe(1);
    harness.dispose();
  });

  it('cancels all active work for a normalized owner', async () => {
    const harness = createHarness();
    const first = await harness.governor.acquire({ key: 'a', owner: 'map', lane: 'background' });
    const second = await harness.governor.acquire({ key: 'b', owner: 'map', lane: 'prefetch' });
    const third = await harness.governor.acquire({ key: 'c', owner: 'search' });

    expect(harness.governor.cancelOwner(' map ')).toBe(2);
    await Promise.resolve();

    expect(first.released).toBe(true);
    expect(second.released).toBe(true);
    expect(third.released).toBe(false);
    third.release();
    harness.dispose();
  });

  it('supports selective active cancellation by lane', async () => {
    const harness = createHarness();
    const foreground = await harness.governor.acquire({ key: 'fg', lane: 'foreground' });
    const background = await harness.governor.acquire({ key: 'bg', lane: 'background' });

    expect(harness.governor.cancelActive((lease) => lease.lane === 'background')).toBe(1);
    await Promise.resolve();

    expect(background.released).toBe(true);
    expect(foreground.released).toBe(false);
    foreground.release();
    harness.dispose();
  });

  it('delegates selective queued cancellation without preempting active work', async () => {
    const harness = createHarness({}, { maxActive: 1, maxQueued: 4 });
    const active = await harness.governor.acquire({ key: 'active', lane: 'foreground' });
    const backgroundPromise = harness.governor.acquire({ key: 'bg', lane: 'background' });
    const foregroundPromise = harness.governor.acquire({ key: 'fg', lane: 'foreground' });

    await Promise.resolve();
    expect(harness.governor.snapshot().admission.queued).toBe(2);
    expect(harness.governor.cancelQueued((request) => request.lane === 'background')).toBe(1);
    await expect(backgroundPromise).rejects.toMatchObject({ name: 'AbortError' });

    active.release();
    const foreground = await foregroundPromise;
    expect(foreground.key).toBe('fg');
    foreground.release();
    harness.dispose();
  });

  it('counts immediate admission rejection when the bounded queue is full', async () => {
    const harness = createHarness({}, { maxActive: 1, maxQueued: 1 });
    const active = await harness.governor.acquire({ key: 'active' });
    const queued = harness.governor.acquire({ key: 'queued' });
    await Promise.resolve();

    await expect(harness.governor.acquire({ key: 'rejected' })).rejects.toThrow('capacity');
    expect(harness.governor.snapshot().counters.rejected).toBe(1);

    active.release();
    const queuedLease = await queued;
    queuedLease.release();
    harness.dispose();
  });

  it('enforces workload deadlines while waiting for admission', async () => {
    vi.useFakeTimers();
    const harness = createHarness({}, { maxActive: 1, maxQueued: 4 });
    const active = await harness.governor.acquire({ key: 'active', deadlineMs: 1_000 });
    const waiting = harness.governor.acquire({ key: 'waiting', deadlineMs: 25 });

    await vi.advanceTimersByTimeAsync(25);
    await expect(waiting).rejects.toBeInstanceOf(RuntimeWorkloadTimeoutError);
    expect(harness.governor.snapshot().counters.timedOut).toBe(1);

    active.release();
    harness.dispose();
  });

  it('enforces workload deadlines after admission and releases held resources', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const lease = await harness.governor.acquire({
      key: 'active-timeout',
      deadlineMs: 30,
      resources: [{ kind: 'network', units: 1 }],
    });

    await vi.advanceTimersByTimeAsync(30);
    expect(lease.signal.reason).toBeInstanceOf(RuntimeWorkloadTimeoutError);
    expect(lease.released).toBe(true);
    expect(harness.manager.snapshot().used.network).toBe(0);
    expect(harness.governor.snapshot().counters.timedOut).toBe(1);
    harness.dispose();
  });

  it('does not double-count release after an abort-driven automatic release', async () => {
    const harness = createHarness();
    const controller = new AbortController();
    const lease = await harness.governor.acquire({ key: 'once', signal: controller.signal });

    controller.abort(new DOMException('stop', 'AbortError'));
    await Promise.resolve();
    lease.release();

    expect(harness.governor.snapshot().counters).toMatchObject({
      acquired: 1,
      cancelled: 1,
      completed: 0,
    });
    harness.dispose();
  });

  it('reports active resource units by kind rather than only reservation count', async () => {
    const harness = createHarness({ maxCacheBytes: 4096 });
    const first = await harness.governor.acquire({
      key: 'one',
      resources: [
        { kind: 'memory', units: 512 },
        { kind: 'network', units: 1 },
      ],
    });
    const second = await harness.governor.acquire({
      key: 'two',
      resources: [
        { kind: 'memory', units: 1024 },
        { kind: 'cpu', units: 2 },
      ],
    });

    expect(harness.governor.snapshot().activeResources).toEqual({
      network: 1,
      cpu: 2,
      memory: 1536,
      render: 0,
      storage: 0,
    });

    first.release();
    second.release();
    harness.dispose();
  });

  it('keeps resource metadata caller-controlled without injecting workload identifiers', async () => {
    const harness = createHarness();
    const lease = await harness.governor.acquire({
      key: 'private-key',
      owner: 'private-owner',
      resources: [{ kind: 'network', metadata: { purpose: 'query' } }],
    });

    expect(lease.resources[0]?.owner).toBe('private-owner');
    expect(harness.governor.snapshot().health.retained).toBeGreaterThan(0);
    lease.release();
    harness.dispose();
  });

  it('can dispose without disposing an externally owned adaptive control', async () => {
    const harness = createHarness();
    const governor = createRuntimeWorkloadGovernor({
      control: harness.control,
      budget: harness.manager,
      now: harness.now,
    });
    const lease = await governor.acquire({ key: 'owned-by-governor' });

    governor.dispose();
    expect(lease.released).toBe(true);

    const stillUsable = await harness.control.acquire({ key: 'external-control' });
    stillUsable.release();
    harness.dispose();
  });

  it('optionally disposes a dedicated adaptive control', async () => {
    const harness = createHarness();
    const governor = createRuntimeWorkloadGovernor({
      control: harness.control,
      budget: harness.manager,
      now: harness.now,
      disposeControl: true,
    });

    governor.dispose();
    await expect(harness.control.acquire({ key: 'late' })).rejects.toThrow('disposed');
    harness.manager.dispose();
  });

  it('disposal cancels active and queued work deterministically', async () => {
    const harness = createHarness({}, { maxActive: 1, maxQueued: 2 });
    const active = await harness.governor.acquire({ key: 'active' });
    const queued = harness.governor.acquire({ key: 'queued' });
    await Promise.resolve();

    harness.governor.dispose();
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    expect(active.released).toBe(true);
    expect(() => harness.governor.snapshot()).toThrow();
    harness.manager.dispose();
    harness.control.dispose();
  });

  it('rejects new acquisitions after disposal', async () => {
    const harness = createHarness();
    harness.governor.dispose();
    await expect(harness.governor.acquire({ key: 'late' })).rejects.toBeInstanceOf(RuntimeWorkloadDisposedError);
    harness.manager.dispose();
    harness.control.dispose();
  });
});
  it('keeps manual workload release idempotent', async () => {
    const harness = createHarness();
    const lease = await harness.governor.acquire({
      key: 'idempotent-release',
      resources: [{ kind: 'network', units: 1 }],
    });

    lease.release();
    lease.release();

    expect(harness.governor.snapshot().counters).toMatchObject({
      acquired: 1,
      completed: 1,
      cancelled: 0,
      failed: 0,
    });
    expect(harness.manager.snapshot().used.network).toBe(0);
    harness.dispose();
  });

  it('stops reporting a resource claim after its reservation TTL expires', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const lease = await harness.governor.acquire({
      key: 'ttl-resource',
      deadlineMs: 1_000,
      resources: [{ kind: 'network', units: 1, ttlMs: 25 }],
    });

    expect(harness.governor.snapshot().activeResources.network).toBe(1);
    await vi.advanceTimersByTimeAsync(25);

    expect(lease.released).toBe(false);
    expect(lease.resources[0]?.released).toBe(true);
    expect(harness.governor.snapshot().activeResources.network).toBe(0);
    lease.release();
    harness.dispose();
  });

  it('treats a blank owner cancellation request as a no-op', async () => {
    const harness = createHarness();
    const lease = await harness.governor.acquire({ key: 'owned', owner: 'map' });

    expect(harness.governor.cancelOwner('   ')).toBe(0);
    expect(lease.released).toBe(false);

    lease.release();
    harness.dispose();
  });

  it('propagates caller aborts through running execute operations', async () => {
    const harness = createHarness();
    const controller = new AbortController();
    let entered = false;

    const operation = harness.governor.execute({
      key: 'abort-running',
      signal: controller.signal,
      resources: [{ kind: 'cpu', units: 1 }],
    }, async ({ signal }) => {
      entered = true;
      if (!signal.aborted) {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      }
      throw signal.reason;
    });

    await Promise.resolve();
    expect(entered).toBe(true);
    controller.abort(new DOMException('caller stopped', 'AbortError'));

    await expect(operation).rejects.toMatchObject({ name: 'AbortError' });
    expect(harness.governor.snapshot().active).toBe(0);
    expect(harness.governor.snapshot().counters.cancelled).toBe(1);
    expect(harness.manager.snapshot().used.cpu).toBe(0);
    harness.dispose();
  });

