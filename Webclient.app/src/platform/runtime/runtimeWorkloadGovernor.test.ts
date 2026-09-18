import { describe, expect, it, vi } from 'vitest';
import { createAdaptiveRuntimeControl } from './adaptiveRuntimeControl';
import { createResourceBudgetManager, createRuntimeBudget } from './resourceBudget';
import {
  createRuntimeWorkloadGovernor,
  RuntimeWorkloadResourceRejectedError,
  RuntimeWorkloadTimeoutError,
} from './runtimeWorkloadGovernor';

const createHarness = (overrides: { maxConcurrentNetwork?: number } = {}) => {
  const budget = createRuntimeBudget(
    { tier: 'balanced', saveData: false, reducedMotion: false, deviceMemoryGb: 8 },
    overrides,
  );
  const resources = createResourceBudgetManager({ budget });
  const control = createAdaptiveRuntimeControl({
    budget,
    admission: { maxActive: 2, maxQueued: 4, maxCost: 4, maxQueueAgeMs: 5_000 },
  });
  const governor = createRuntimeWorkloadGovernor({
    control,
    budget: resources,
    policy: { defaultDeadlineMs: 1_000, maxDeadlineMs: 5_000 },
  });
  return { governor, control, resources };
};

describe('runtime workload governor', () => {
  it('accounts admission and resource reservations through release', async () => {
    const { governor, resources } = createHarness();
    const lease = await governor.acquire({
      key: 'parcel-query',
      lane: 'foreground',
      owner: 'map-shell',
      resources: [{ kind: 'network', units: 1 }, { kind: 'cpu', units: 1 }],
    });

    expect(lease.owner).toBe('map-shell');
    expect(governor.snapshot().active).toBe(1);
    expect(governor.snapshot().activeResources.network).toBe(1);
    expect(resources.snapshot().usage.network).toBe(1);

    lease.release();
    expect(lease.released).toBe(true);
    expect(governor.snapshot().active).toBe(0);
    expect(governor.snapshot().counters.completed).toBe(1);
    expect(resources.snapshot().usage.network).toBe(0);
    governor.dispose();
    resources.dispose();
  });

  it('releases capacity after execute succeeds', async () => {
    const { governor, resources } = createHarness();
    const result = await governor.execute(
      { key: 'identify', resources: [{ kind: 'network' }] },
      async ({ lease, signal }) => {
        expect(signal.aborted).toBe(false);
        expect(lease.released).toBe(false);
        return 42;
      },
    );
    expect(result).toBe(42);
    expect(governor.snapshot().counters.completed).toBe(1);
    expect(resources.snapshot().usage.network).toBe(0);
    governor.dispose();
    resources.dispose();
  });

  it('classifies operation failures and releases reservations', async () => {
    const { governor, resources } = createHarness();
    await expect(governor.execute(
      { key: 'failing-work', resources: [{ kind: 'cpu' }] },
      () => { throw new Error('boom'); },
    )).rejects.toThrow('boom');
    expect(governor.snapshot().counters.failed).toBe(1);
    expect(resources.snapshot().usage.cpu).toBe(0);
    governor.dispose();
    resources.dispose();
  });

  it('rolls back admission when a resource claim cannot be reserved', async () => {
    const { governor, resources } = createHarness({ maxConcurrentNetwork: 1 });
    const held = resources.reserve({ kind: 'network', units: 1 });
    expect(held).not.toBeNull();
    await expect(governor.acquire({
      key: 'resource-pressure',
      resources: [{ kind: 'network', units: 1 }],
    })).rejects.toBeInstanceOf(RuntimeWorkloadResourceRejectedError);
    expect(governor.snapshot().active).toBe(0);
    expect(governor.snapshot().admission.active).toBe(0);
    expect(governor.snapshot().counters.resourceRejected).toBe(1);
    held?.release();
    governor.dispose();
    resources.dispose();
  });

  it('cancels all active work owned by the same normalized owner', async () => {
    const { governor, resources } = createHarness();
    const first = await governor.acquire({ key: 'one', owner: ' search-panel ' });
    const second = await governor.acquire({ key: 'two', owner: 'search-panel' });
    expect(governor.cancelOwner('search-panel')).toBe(2);
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(governor.snapshot().active).toBe(0);
    expect(governor.snapshot().counters.cancelled).toBe(2);
    governor.dispose();
    resources.dispose();
  });

  it('enforces workload deadlines and records timeout outcomes', async () => {
    vi.useFakeTimers();
    try {
      const { governor, resources } = createHarness();
      const pending = governor.execute(
        { key: 'slow-work', deadlineMs: 25 },
        ({ signal }) => new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
      );
      // Attach the rejection observer before advancing fake timers. Otherwise the
      // deadline can reject between microtasks and Vitest correctly reports an
      // unhandled rejection even though the assertion is attached immediately after.
      const timeoutAssertion = expect(pending).rejects.toBeInstanceOf(RuntimeWorkloadTimeoutError);
      await vi.advanceTimersByTimeAsync(25);
      await timeoutAssertion;
      expect(governor.snapshot().counters.timedOut).toBe(1);
      expect(governor.snapshot().active).toBe(0);
      governor.dispose();
      resources.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates an already-aborted caller signal without leaking admission', async () => {
    const { governor, resources } = createHarness();
    const controller = new AbortController();
    controller.abort(new DOMException('caller stopped', 'AbortError'));
    await expect(governor.acquire({ key: 'aborted', signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(governor.snapshot().active).toBe(0);
    expect(governor.snapshot().counters.cancelled).toBe(1);
    governor.dispose();
    resources.dispose();
  });

  it('rejects excessive claim fan-out before acquiring admission', async () => {
    const { governor, resources } = createHarness();
    const claims = Array.from({ length: 9 }, () => ({ kind: 'network' as const }));
    await expect(governor.acquire({ key: 'too-many-claims', resources: claims }))
      .rejects.toBeInstanceOf(RuntimeWorkloadResourceRejectedError);
    expect(governor.snapshot().admission.active).toBe(0);
    expect(resources.snapshot().usage.network).toBe(0);
    governor.dispose();
    resources.dispose();
  });
});
