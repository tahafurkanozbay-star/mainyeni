import { describe, expect, it, vi } from 'vitest';
import { createAdaptiveRuntimeControl } from './adaptiveRuntimeControl';
import { createResourceBudgetManager, createRuntimeBudget } from './resourceBudget';
import {
  RuntimeResilienceRejectedError,
  createRuntimeResilienceSupervisor,
} from './runtimeResilienceSupervisor';
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
    expect(resources.snapshot().used.network).toBe(1);

    lease.release();
    expect(lease.released).toBe(true);
    expect(governor.snapshot().active).toBe(0);
    expect(governor.snapshot().counters.completed).toBe(1);
    expect(resources.snapshot().used.network).toBe(0);
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
    expect(resources.snapshot().used.network).toBe(0);
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
    expect(resources.snapshot().used.cpu).toBe(0);
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
    expect(resources.snapshot().used.network).toBe(0);
    governor.dispose();
    resources.dispose();
  });
});

describe('runtime workload governor resilience integration', () => {
  const createResilientHarness = (options: {
    readonly now?: () => number;
    readonly maxConcurrentNetwork?: number;
  } = {}) => {
    const budget = createRuntimeBudget(
      {
        tier: 'balanced',
        saveData: false,
        reducedMotion: false,
        deviceMemoryGb: 8,
      },
      {
        ...(options.maxConcurrentNetwork === undefined
          ? {}
          : { maxConcurrentNetwork: options.maxConcurrentNetwork }),
      },
    );
    const resources = createResourceBudgetManager({ budget });
    const control = createAdaptiveRuntimeControl({
      budget,
      admission: {
        maxActive: 2,
        maxQueued: 4,
        maxCost: 4,
        maxQueueAgeMs: 5_000,
      },
    });
    const resilience = createRuntimeResilienceSupervisor({
      policy: {
        minimumSignalSamples: {
          critical: 1,
          interactive: 1,
          background: 1,
        },
        maxErrorRate: {
          critical: 0.5,
          interactive: 0.25,
          background: 0.2,
        },
        historyLimit: 32,
        maxKeyLength: 64,
      },
      envelope: {
        critical: {
          maxInFlight: 8,
          maxQueued: 16,
          timeoutMs: 2_000,
          maxAttempts: 3,
        },
        interactive: {
          maxInFlight: 4,
          maxQueued: 8,
          timeoutMs: 500,
          maxAttempts: 2,
        },
        background: {
          maxInFlight: 2,
          maxQueued: 4,
          timeoutMs: 200,
          maxAttempts: 2,
        },
      },
    });
    const governor = createRuntimeWorkloadGovernor({
      control,
      budget: resources,
      resilience,
      ...(options.now === undefined ? {} : { now: options.now }),
      policy: {
        defaultDeadlineMs: 1_000,
        maxDeadlineMs: 5_000,
      },
    });
    return {
      governor,
      control,
      resources,
      resilience,
    };
  };

  it('preserves legacy behavior when no supervisor is supplied', () => {
    const { governor, resources } = createHarness();
    expect(governor.snapshot().resilience).toBeNull();
    governor.dispose();
    resources.dispose();
  });

  it('records successful workload completion in resilience signals', async () => {
    let now = 100;
    const { governor, resources, resilience } = createResilientHarness({
      now: () => now,
    });
    const result = await governor.execute(
      {
        key: 'supervised-success',
        lane: 'foreground',
      },
      () => {
        now = 125;
        return 'ok';
      },
    );
    expect(result).toBe('ok');
    expect(resilience.snapshot()).toMatchObject({
      active: 0,
      counters: {
        admitted: 1,
        completed: 1,
        succeeded: 1,
      },
      signals: {
        lanes: {
          interactive: {
            count: 1,
            successes: 1,
            p95LatencyMs: 25,
          },
        },
      },
    });
    expect(governor.snapshot().resilience?.fingerprint)
      .toBe(resilience.snapshot().fingerprint);
    governor.dispose();
    resources.dispose();
  });

  it('records operation failure as resilience failure feedback', async () => {
    let now = 200;
    const { governor, resources, resilience } = createResilientHarness({
      now: () => now,
    });
    await expect(governor.execute(
      {
        key: 'supervised-failure',
        lane: 'foreground',
      },
      () => {
        now = 240;
        throw new Error('operation failed');
      },
    )).rejects.toThrow('operation failed');
    expect(resilience.snapshot()).toMatchObject({
      counters: {
        completed: 1,
        failed: 1,
      },
      signals: {
        lanes: {
          interactive: {
            count: 1,
            failures: 1,
            errorRate: 1,
          },
        },
      },
    });
    governor.dispose();
    resources.dispose();
  });

  it('maps background priority to background resilience lane', async () => {
    let now = 10;
    const { governor, resources, resilience } = createResilientHarness({
      now: () => now,
    });
    await governor.execute(
      {
        key: 'background-work',
        priority: 'background',
      },
      () => {
        now = 20;
      },
    );
    expect(resilience.snapshot().laneCounters.background).toMatchObject({
      admitted: 1,
      succeeded: 1,
    });
    governor.dispose();
    resources.dispose();
  });

  it('maps prefetch lane to background resilience lane', async () => {
    let now = 10;
    const { governor, resources, resilience } = createResilientHarness({
      now: () => now,
    });
    await governor.execute(
      {
        key: 'prefetch-work',
        lane: 'prefetch',
      },
      () => {
        now = 15;
      },
    );
    expect(resilience.snapshot().laneCounters.background.admitted).toBe(1);
    governor.dispose();
    resources.dispose();
  });

  it('maps critical priority to critical resilience lane', async () => {
    let now = 10;
    const { governor, resources, resilience } = createResilientHarness({
      now: () => now,
    });
    await governor.execute(
      {
        key: 'critical-work',
        priority: 'critical',
      },
      () => {
        now = 20;
      },
    );
    expect(resilience.snapshot().laneCounters.critical).toMatchObject({
      admitted: 1,
      succeeded: 1,
    });
    governor.dispose();
    resources.dispose();
  });

  it('rejects work before admission when resilience pressure sheds it', async () => {
    const budget = createRuntimeBudget({
      tier: 'balanced',
      saveData: false,
      reducedMotion: false,
      deviceMemoryGb: 8,
    });
    const resources = createResourceBudgetManager({ budget });
    const control = createAdaptiveRuntimeControl({
      budget,
      admission: {
        maxActive: 2,
        maxQueued: 4,
        maxCost: 4,
        maxQueueAgeMs: 5_000,
      },
    });
    const resilience = createRuntimeResilienceSupervisor({
      policy: {
        minimumSignalSamples: {
          critical: 1,
          interactive: 1,
          background: 1,
        },
        maxErrorRate: {
          critical: 0.5,
          interactive: 0.25,
          background: 0.2,
        },
        historyLimit: 32,
        maxKeyLength: 64,
      },
      envelope: {
        background: {
          maxInFlight: 1,
          maxQueued: 1,
          timeoutMs: 200,
          maxAttempts: 1,
        },
      },
    });

    resilience.recordSignal('background', 200, false, 1);
    const governor = createRuntimeWorkloadGovernor({
      control,
      budget: resources,
      resilience,
      now: () => 2,
    });

    await expect(governor.acquire({
      key: 'shed-before-admission',
      priority: 'background',
    })).rejects.toBeInstanceOf(RuntimeResilienceRejectedError);
    expect(control.snapshot().admission).toMatchObject({
      active: 0,
      queued: 0,
      admitted: 0,
    });
    expect(governor.snapshot().counters.rejected).toBe(1);
    governor.dispose();
    resources.dispose();
  });

  it('narrows workload timeout to supervisor lane envelope', async () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      const { governor, resources, resilience } = createResilientHarness({
        now: () => now,
      });
      const pending = governor.execute(
        {
          key: 'bounded-background',
          priority: 'background',
          deadlineMs: 5_000,
        },
        ({ signal }) => new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(signal.reason),
            { once: true },
          );
        }),
      );
      const assertion = expect(pending)
        .rejects.toBeInstanceOf(RuntimeWorkloadTimeoutError);
      now = 200;
      await vi.advanceTimersByTimeAsync(200);
      await assertion;
      expect(resilience.snapshot().counters.timedOut).toBe(1);
      expect(governor.snapshot().counters.timedOut).toBe(1);
      governor.dispose();
      resources.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates tighter absolute parent deadline into governor timer', async () => {
    vi.useFakeTimers();
    try {
      let now = 1_000;
      const { governor, resources, resilience } = createResilientHarness({
        now: () => now,
      });
      const pending = governor.execute(
        {
          key: 'child-deadline',
          deadlineMs: 1_000,
          parentDeadlineMs: 1_025,
        },
        ({ signal }) => new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(signal.reason),
            { once: true },
          );
        }),
      );
      const assertion = expect(pending)
        .rejects.toBeInstanceOf(RuntimeWorkloadTimeoutError);
      now = 1_025;
      await vi.advanceTimersByTimeAsync(25);
      await assertion;
      expect(resilience.snapshot().counters.timedOut).toBe(1);
      governor.dispose();
      resources.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('records caller cancellation without poisoning failure signals', async () => {
    let now = 100;
    const { governor, resources, resilience } = createResilientHarness({
      now: () => now,
    });
    const abort = new AbortController();
    const pending = governor.execute(
      {
        key: 'cancelled',
        signal: abort.signal,
      },
      ({ signal }) => new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(signal.reason),
          { once: true },
        );
      }),
    );
    const assertion = expect(pending).rejects.toMatchObject({
      name: 'AbortError',
    });
    now = 110;
    abort.abort(new DOMException('caller cancelled', 'AbortError'));
    await assertion;
    expect(resilience.snapshot()).toMatchObject({
      counters: {
        cancelled: 1,
        failed: 0,
      },
      signals: {
        lanes: {
          interactive: {
            count: 0,
          },
        },
      },
    });
    governor.dispose();
    resources.dispose();
  });

  it('records resource-capacity rejection as rejected terminal outcome', async () => {
    let now = 100;
    const { governor, resources, resilience } = createResilientHarness({
      now: () => now,
      maxConcurrentNetwork: 1,
    });
    const held = resources.reserve({
      kind: 'network',
      units: 1,
    });
    expect(held).not.toBeNull();
    now = 101;
    await expect(governor.acquire({
      key: 'resource-rejected',
      resources: [{ kind: 'network', units: 1 }],
    })).rejects.toBeInstanceOf(RuntimeWorkloadResourceRejectedError);
    expect(resilience.snapshot()).toMatchObject({
      active: 0,
      counters: {
        rejected: 1,
        failed: 0,
      },
    });
    expect(resilience.snapshot().signals.count).toBe(0);
    held?.release();
    governor.dispose();
    resources.dispose();
  });

  it('does not dispose externally owned supervisor by default', () => {
    const { governor, resources, resilience } = createResilientHarness();
    governor.dispose();
    expect(resilience.snapshot().disposed).toBe(false);
    resources.dispose();
  });

  it('can dispose supervisor only through explicit ownership option', () => {
    const budget = createRuntimeBudget({
      tier: 'balanced',
      saveData: false,
      reducedMotion: false,
      deviceMemoryGb: 8,
    });
    const resources = createResourceBudgetManager({ budget });
    const control = createAdaptiveRuntimeControl({ budget });
    const resilience = createRuntimeResilienceSupervisor();
    const governor = createRuntimeWorkloadGovernor({
      control,
      budget: resources,
      resilience,
      disposeResilience: true,
    });
    governor.dispose();
    expect(resilience.snapshot().disposed).toBe(true);
    resources.dispose();
  });
});

