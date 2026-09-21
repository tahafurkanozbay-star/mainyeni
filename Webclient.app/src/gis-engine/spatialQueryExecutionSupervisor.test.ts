import { describe, expect, it } from 'vitest';
import {
  createSpatialQueryExecutionSupervisor,
  normalizeSpatialQueryExecutionSupervisorPolicy,
  SpatialQuerySupervisionError,
} from './spatialQueryExecutionSupervisor';

const request = (overrides: Partial<Parameters<ReturnType<typeof createSpatialQueryExecutionSupervisor>['run']>[0]> = {}) => ({
  owner: 'map-view',
  serviceId: 'parks',
  layerId: 2,
  priority: 'normal' as const,
  estimatedFeatures: 100,
  estimatedBytes: 2_000,
  estimatedCpuMs: 20,
  estimatedGpuBytes: 4_000,
  ...overrides,
});

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

describe('normalizeSpatialQueryExecutionSupervisorPolicy', () => {
  it('returns immutable production-safe defaults', () => {
    const policy = normalizeSpatialQueryExecutionSupervisorPolicy();
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.budgetLimits)).toBe(true);
    expect(policy.budgetLimits.features).toBeGreaterThan(0);
    expect(policy.budgetLimits.maxLeases).toBeGreaterThan(0);
    expect(policy.budgetInteractiveReserveRatio).toBeGreaterThanOrEqual(0);
  });

  it('rejects zero or non-finite resource ceilings', () => {
    expect(() => normalizeSpatialQueryExecutionSupervisorPolicy({
      budgetLimits: { features: 0 } as never,
    })).toThrow(RangeError);
    expect(() => normalizeSpatialQueryExecutionSupervisorPolicy({
      budgetLimits: { responseBytes: Number.POSITIVE_INFINITY } as never,
    })).toThrow(RangeError);
  });

  it('rejects invalid reserve ratios', () => {
    expect(() => normalizeSpatialQueryExecutionSupervisorPolicy({
      budgetInteractiveReserveRatio: -0.1,
    })).toThrow(RangeError);
    expect(() => normalizeSpatialQueryExecutionSupervisorPolicy({
      budgetInteractiveReserveRatio: 1,
    })).toThrow(RangeError);
  });
});

describe('createSpatialQueryExecutionSupervisor', () => {
  it('runs admitted work and releases all resources after success', async () => {
    const supervisor = createSpatialQueryExecutionSupervisor();
    const value = await supervisor.run(request(), async ({ signal, layerEpoch }) => {
      expect(signal.aborted).toBe(false);
      expect(layerEpoch).toMatchObject({ serviceId: 'parks', layerId: 2 });
      return 'ok';
    });

    expect(value).toBe('ok');
    expect(supervisor.snapshot()).toMatchObject({
      executions: 1,
      completed: 1,
      failed: 0,
      admission: { active: 0, released: 1 },
      budget: { leases: 0, owners: 0 },
    });
  });

  it('normalizes owner and service ids before resource accounting', async () => {
    const supervisor = createSpatialQueryExecutionSupervisor();
    await supervisor.run(request({ owner: ' map ', serviceId: ' parks ' }), async () => 'ok');

    const history = supervisor.snapshot().budget.history;
    expect(history[0]).toMatchObject({ type: 'acquire', owner: 'map' });
  });

  it('rejects invalid request identity before allocating resources', async () => {
    const supervisor = createSpatialQueryExecutionSupervisor();

    await expect(supervisor.run(request({ owner: ' ' }), async () => 'never')).rejects.toThrow(TypeError);
    await expect(supervisor.run(request({ serviceId: ' ' }), async () => 'never')).rejects.toThrow(TypeError);
    await expect(supervisor.run(request({ layerId: -1 }), async () => 'never')).rejects.toThrow(RangeError);
    expect(supervisor.snapshot().admission.active).toBe(0);
    expect(supervisor.snapshot().budget.leases).toBe(0);
  });

  it('rejects invalid resource estimates before allocating resources', async () => {
    const supervisor = createSpatialQueryExecutionSupervisor();

    await expect(supervisor.run(request({ estimatedBytes: -1 }), async () => 'never')).rejects.toThrow(RangeError);
    await expect(supervisor.run(request({ estimatedCpuMs: Number.NaN }), async () => 'never')).rejects.toThrow(RangeError);
    expect(supervisor.snapshot().executions).toBe(0);
  });

  it('fails closed when a single request exceeds admission policy', async () => {
    const supervisor = createSpatialQueryExecutionSupervisor({
      admission: {
        maxEstimatedFeaturesInFlight: 100,
        maxSingleEstimatedFeatures: 100,
      },
    });

    await expect(supervisor.run(request({ estimatedFeatures: 101 }), async () => 'never'))
      .rejects.toMatchObject({
        code: 'ADMISSION_REJECTED',
        reason: 'single-request-budget',
        mayResubmit: false,
      });
    expect(supervisor.snapshot()).toMatchObject({
      admissionBlocks: 1,
      completed: 0,
      failed: 1,
    });
  });

  it('defers work when admission concurrency is saturated', async () => {
    const supervisor = createSpatialQueryExecutionSupervisor({
      admission: {
        maxConcurrent: 1,
        maxConcurrentPerService: 1,
        interactiveReserve: 0,
      },
    });
    const gate = deferred<string>();
    const firstStarted = deferred<void>();
    const first = supervisor.run(request({ serviceId: 'a' }), async () => {
      firstStarted.resolve();
      return gate.promise;
    });
    await firstStarted.promise;

    await expect(supervisor.run(request({ serviceId: 'b' }), async () => 'never'))
      .rejects.toMatchObject({
        code: 'ADMISSION_DEFERRED',
        reason: 'global-concurrency',
        mayResubmit: true,
      });

    gate.resolve('done');
    await expect(first).resolves.toBe('done');
    expect(supervisor.snapshot().admissionBlocks).toBe(1);
  });

  it('enforces the independent budget ledger ceiling', async () => {
    const supervisor = createSpatialQueryExecutionSupervisor({
      admission: {
        maxEstimatedFeaturesInFlight: 1_000,
        maxSingleEstimatedFeatures: 1_000,
      },
      budgetLimits: {
        features: 100,
        responseBytes: 100_000,
        cpuMs: 1_000,
        gpuBytes: 100_000,
        maxLeases: 4,
        maxOwners: 4,
        maxHistory: 32,
      },
    });

    await expect(supervisor.run(request({ estimatedFeatures: 101 }), async () => 'never'))
      .rejects.toMatchObject({
        code: 'BUDGET_REJECTED',
        reason: 'single-request-exceeds-budget',
      });
    expect(supervisor.snapshot()).toMatchObject({
      budgetBlocks: 1,
      admission: { active: 0, released: 1 },
      budget: { leases: 0 },
    });
  });

  it('releases admission and budget leases when operations throw', async () => {
    const supervisor = createSpatialQueryExecutionSupervisor();

    await expect(supervisor.run(request(), async () => {
      throw new Error('transport failed');
    })).rejects.toThrow('transport failed');

    expect(supervisor.snapshot()).toMatchObject({
      failed: 1,
      admission: { active: 0, released: 1 },
      budget: { leases: 0, owners: 0 },
    });
  });

  it('isolates concurrent owners while accounting aggregate pressure', async () => {
    const supervisor = createSpatialQueryExecutionSupervisor();
    const firstGate = deferred<string>();
    const secondGate = deferred<string>();
    const started = deferred<void>();
    let starts = 0;

    const runOne = (owner: string, gate: ReturnType<typeof deferred<string>>) =>
      supervisor.run(request({ owner, serviceId: owner }), async () => {
        starts += 1;
        if (starts === 2) started.resolve();
        return gate.promise;
      });

    const first = runOne('owner-a', firstGate);
    const second = runOne('owner-b', secondGate);
    await started.promise;

    expect(supervisor.snapshot()).toMatchObject({
      admission: { active: 2, activeServices: 2 },
      budget: { leases: 2, owners: 2 },
    });

    firstGate.resolve('a');
    secondGate.resolve('b');
    await expect(Promise.all([first, second])).resolves.toEqual(['a', 'b']);
    expect(supervisor.snapshot().budget.leases).toBe(0);
  });

  it('propagates pre-aborted requests without allocation', async () => {
    const supervisor = createSpatialQueryExecutionSupervisor();
    const controller = new AbortController();
    controller.abort('navigation-changed');

    await expect(supervisor.run(request({ signal: controller.signal }), async () => 'never'))
      .rejects.toMatchObject({ code: 'ABORTED', reason: 'navigation-changed' });
    expect(supervisor.snapshot()).toMatchObject({
      aborted: 1,
      admission: { active: 0 },
      budget: { leases: 0 },
    });
  });

  it('links external cancellation into the operation context', async () => {
    const supervisor = createSpatialQueryExecutionSupervisor();
    const controller = new AbortController();
    const started = deferred<void>();

    const execution = supervisor.run(request({ signal: controller.signal }), async ({ signal }) => {
      started.resolve();
      return new Promise<string>((resolve, reject) => {
        const onAbort = () => reject(new Error(String(signal.reason)));
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
        void resolve;
      });
    });

    await started.promise;
    controller.abort('view-disposed');
    await expect(execution).rejects.toThrow('view-disposed');
    expect(supervisor.snapshot()).toMatchObject({
      admission: { active: 0 },
      budget: { leases: 0 },
    });
  });

  it('blocks a slow result when the layer mutates during execution', async () => {
    const supervisor = createSpatialQueryExecutionSupervisor();
    const gate = deferred<string>();
    const started = deferred<void>();

    const execution = supervisor.run(request(), async () => {
      started.resolve();
      return gate.promise;
    });
    await started.promise;

    const epoch = supervisor.advanceLayer('parks', 2);
    expect(epoch.serviceId).toBe('parks');
    gate.resolve('stale-value');

    await expect(execution).rejects.toMatchObject({
      code: 'STALE_RESULT',
      reason: 'layer-mutated-during-query',
      mayResubmit: true,
    });
    expect(supervisor.snapshot()).toMatchObject({
      staleResultsBlocked: 1,
      mutations: 1,
      admission: { active: 0 },
      budget: { leases: 0 },
    });
  });

  it('does not invalidate a running query when another layer mutates', async () => {
    const supervisor = createSpatialQueryExecutionSupervisor();
    const gate = deferred<string>();
    const started = deferred<void>();

    const execution = supervisor.run(request({ layerId: 2 }), async () => {
      started.resolve();
      return gate.promise;
    });
    await started.promise;

    supervisor.advanceLayer('parks', 3);
    gate.resolve('current-value');

    await expect(execution).resolves.toBe('current-value');
    expect(supervisor.snapshot()).toMatchObject({
      completed: 1,
      staleResultsBlocked: 0,
      mutations: 1,
    });
  });

  it('does not invalidate a running query when another service mutates', async () => {
    const supervisor = createSpatialQueryExecutionSupervisor();
    const gate = deferred<string>();
    const started = deferred<void>();

    const execution = supervisor.run(request({ serviceId: 'parks' }), async () => {
      started.resolve();
      return gate.promise;
    });
    await started.promise;

    supervisor.advanceLayer('roads', 2);
    gate.resolve('current-value');

    await expect(execution).resolves.toBe('current-value');
  });

  it('supports zero estimates without bypassing lease accounting', async () => {
    const supervisor = createSpatialQueryExecutionSupervisor();
    await expect(supervisor.run(request({
      estimatedFeatures: 0,
      estimatedBytes: 0,
      estimatedCpuMs: 0,
      estimatedGpuBytes: 0,
    }), async () => 42)).resolves.toBe(42);

    expect(supervisor.snapshot()).toMatchObject({
      completed: 1,
      budget: { leases: 0, owners: 0 },
    });
  });

  it('returns frozen bounded snapshots', () => {
    const supervisor = createSpatialQueryExecutionSupervisor();
    const snapshot = supervisor.snapshot();

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.admission)).toBe(true);
    expect(Object.isFrozen(snapshot.budget)).toBe(true);
    expect(Object.isFrozen(snapshot.epochs)).toBe(true);
  });

  it('disposes idempotently and rejects subsequent work', async () => {
    const supervisor = createSpatialQueryExecutionSupervisor();
    supervisor.dispose();
    supervisor.dispose();

    expect(supervisor.snapshot().disposed).toBe(true);
    await expect(supervisor.run(request(), async () => 'never'))
      .rejects.toBeInstanceOf(SpatialQuerySupervisionError);
    expect(() => supervisor.advanceLayer('parks', 2)).toThrow(SpatialQuerySupervisionError);
  });
});
