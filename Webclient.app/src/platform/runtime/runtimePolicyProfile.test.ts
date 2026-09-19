import { describe, expect, it } from 'vitest';
import {
  createRuntimePolicyProfile,
  runtimePolicyCapacitySummary,
  runtimePolicyPresetNames,
} from './runtimePolicyProfile';

describe('runtimePolicyProfile', () => {
  it('exposes all supported immutable presets', () => {
    expect(runtimePolicyPresetNames()).toEqual([
      'critical',
      'interactive',
      'background',
      'bulk',
    ]);

    for (const name of runtimePolicyPresetNames()) {
      const profile = createRuntimePolicyProfile(name);
      expect(profile.name).toBe(name);
      expect(profile.version).toBe(1);
      expect(Object.isFrozen(profile)).toBe(true);
      expect(Object.isFrozen(profile.bulkhead)).toBe(true);
      expect(Object.isFrozen(profile.circuitBreaker)).toBe(true);
      expect(Object.isFrozen(profile.failureBudget)).toBe(true);
      expect(Object.isFrozen(profile.retry)).toBe(true);
      expect(Object.isFrozen(profile.resourceLeases)).toBe(true);
      expect(Object.isFrozen(profile.taskScope)).toBe(true);
    }
  });

  it('creates fresh profile graphs for consumers', () => {
    const first = createRuntimePolicyProfile('interactive');
    const second = createRuntimePolicyProfile('interactive');

    expect(first).not.toBe(second);
    expect(first.bulkhead).not.toBe(second.bulkhead);
    expect(first.retry).not.toBe(second.retry);
    expect(first.taskScope).not.toBe(second.taskScope);
    expect(first).toStrictEqual(second);
  });

  it('keeps interactive retry lifetime inside task-scope lifetime', () => {
    const profile = createRuntimePolicyProfile('interactive');

    expect(profile.retry.maxElapsedMs).toBeLessThanOrEqual(profile.taskScope.maxTimeoutMs);
    expect(profile.bulkhead.maxConcurrent).toBeLessThanOrEqual(profile.taskScope.maxActiveTasks);
    expect(profile.bulkhead.maxConcurrentPerOwner).toBeLessThanOrEqual(
      profile.taskScope.maxOwnerTasks,
    );
  });

  it('supports bounded local overrides without mutating the preset', () => {
    const overridden = createRuntimePolicyProfile('interactive', {
      bulkhead: {
        maxConcurrent: 6,
        maxConcurrentPerOwner: 3,
      },
      retry: {
        maxAttempts: 2,
        maxElapsedMs: 2_000,
      },
      taskScope: {
        maxActiveTasks: 64,
        maxOwnerTasks: 12,
      },
      resourceLeases: {
        maxActiveLeases: 100,
        maxOwnerLeases: 10,
      },
    });
    const original = createRuntimePolicyProfile('interactive');

    expect(overridden.bulkhead.maxConcurrent).toBe(6);
    expect(overridden.bulkhead.maxConcurrentPerOwner).toBe(3);
    expect(overridden.retry.maxAttempts).toBe(2);
    expect(overridden.retry.maxElapsedMs).toBe(2_000);
    expect(overridden.taskScope.maxActiveTasks).toBe(64);
    expect(overridden.resourceLeases.maxOwnerLeases).toBe(10);
    expect(original.bulkhead.maxConcurrent).toBe(12);
    expect(original.retry.maxAttempts).toBe(3);
  });

  it('preserves unspecified values when applying partial overrides', () => {
    const base = createRuntimePolicyProfile('background');
    const changed = createRuntimePolicyProfile('background', {
      bulkhead: { maxQueued: 20 },
      failureBudget: { recoverySamples: 9 },
    });

    expect(changed.bulkhead.maxQueued).toBe(20);
    expect(changed.bulkhead.maxConcurrent).toBe(base.bulkhead.maxConcurrent);
    expect(changed.failureBudget.recoverySamples).toBe(9);
    expect(changed.failureBudget.windowMs).toBe(base.failureBudget.windowMs);
    expect(changed.taskScope).toStrictEqual(base.taskScope);
  });

  it('produces a stable capacity summary for diagnostics and admission review', () => {
    const profile = createRuntimePolicyProfile('bulk');
    const summary = runtimePolicyCapacitySummary(profile);

    expect(summary).toEqual({
      profile: 'bulk',
      maxConcurrentWork: profile.bulkhead.maxConcurrent,
      maxQueuedWork: profile.bulkhead.maxQueued,
      maxOwnerConcurrentWork: profile.bulkhead.maxConcurrentPerOwner,
      maxOwnerQueuedWork: profile.bulkhead.maxQueuedPerOwner,
      maxActiveLeases: profile.resourceLeases.maxActiveLeases,
      maxOwnerLeases: profile.resourceLeases.maxOwnerLeases,
      maxScopedTasks: profile.taskScope.maxActiveTasks,
      maxScopedOwnerTasks: profile.taskScope.maxOwnerTasks,
      maxChildScopes: profile.taskScope.maxChildren,
      maxAttempts: profile.retry.maxAttempts,
      maxElapsedMs: profile.retry.maxElapsedMs,
      defaultTaskTimeoutMs: profile.taskScope.defaultTimeoutMs,
      maxTaskTimeoutMs: profile.taskScope.maxTimeoutMs,
    });
    expect(Object.isFrozen(summary)).toBe(true);
  });

  it('uses increasingly conservative queue/concurrency defaults for bulk work', () => {
    const interactive = createRuntimePolicyProfile('interactive');
    const background = createRuntimePolicyProfile('background');
    const bulk = createRuntimePolicyProfile('bulk');

    expect(interactive.bulkhead.maxConcurrent).toBeGreaterThan(background.bulkhead.maxConcurrent);
    expect(background.bulkhead.maxConcurrent).toBeGreaterThan(bulk.bulkhead.maxConcurrent);
    expect(interactive.bulkhead.maxQueued).toBeGreaterThan(background.bulkhead.maxQueued);
    expect(background.bulkhead.maxQueued).toBeGreaterThan(bulk.bulkhead.maxQueued);
  });

  it('keeps critical profile bounded despite higher capacity', () => {
    const critical = createRuntimePolicyProfile('critical');

    expect(critical.bulkhead.maxConcurrent).toBeLessThanOrEqual(256);
    expect(critical.bulkhead.maxQueued).toBeLessThanOrEqual(10_000);
    expect(critical.retry.maxAttempts).toBeLessThanOrEqual(10);
    expect(critical.taskScope.maxActiveTasks).toBeLessThanOrEqual(10_000);
    expect(critical.resourceLeases.maxActiveLeases).toBeLessThanOrEqual(100_000);
  });

  it('rejects unknown profiles instead of silently falling back', () => {
    expect(() => createRuntimePolicyProfile('fast' as never)).toThrow(
      'runtime policy profile name is invalid',
    );
  });

  it('rejects bulkhead owner concurrency above global concurrency', () => {
    expect(() => createRuntimePolicyProfile('interactive', {
      bulkhead: {
        maxConcurrent: 2,
        maxConcurrentPerOwner: 3,
      },
    })).toThrow('bulkhead.maxConcurrentPerOwner');
  });

  it('rejects bulkhead owner queue above global queue', () => {
    expect(() => createRuntimePolicyProfile('interactive', {
      bulkhead: {
        maxQueued: 2,
        maxQueuedPerOwner: 3,
      },
    })).toThrow('bulkhead.maxQueuedPerOwner');
  });

  it('rejects circuit success thresholds larger than half-open concurrency', () => {
    expect(() => createRuntimePolicyProfile('interactive', {
      circuitBreaker: {
        halfOpenMaxCalls: 1,
        successThreshold: 2,
      },
    })).toThrow('circuitBreaker.successThreshold');
  });

  it('requires failure-budget bucket divisibility for deterministic windows', () => {
    expect(() => createRuntimePolicyProfile('interactive', {
      failureBudget: {
        windowMs: 60_000,
        bucketMs: 7_000,
      },
    })).toThrow('divisible');
  });

  it('requires recovery ratio below degraded ratio', () => {
    expect(() => createRuntimePolicyProfile('interactive', {
      failureBudget: {
        recoveryFailureRatio: 0.25,
        degradedFailureRatio: 0.2,
      },
    })).toThrow('recoveryFailureRatio');
  });

  it('requires degraded ratio below exhausted ratio', () => {
    expect(() => createRuntimePolicyProfile('interactive', {
      failureBudget: {
        degradedFailureRatio: 0.7,
        exhaustedFailureRatio: 0.5,
      },
    })).toThrow('degradedFailureRatio');
  });

  it('rejects retry max delay smaller than base delay', () => {
    expect(() => createRuntimePolicyProfile('interactive', {
      retry: {
        baseDelayMs: 2_000,
        maxDelayMs: 1_000,
      },
    })).toThrow('retry.maxDelayMs');
  });

  it('rejects retry lifetime that exceeds the task-scope hard timeout', () => {
    expect(() => createRuntimePolicyProfile('interactive', {
      retry: { maxElapsedMs: 20_000 },
      taskScope: { maxTimeoutMs: 10_000, defaultTimeoutMs: 5_000 },
    })).toThrow('retry.maxElapsedMs must not exceed taskScope.maxTimeoutMs');
  });

  it('rejects bulkhead concurrency above task-scope capacity', () => {
    expect(() => createRuntimePolicyProfile('interactive', {
      bulkhead: {
        maxConcurrent: 20,
        maxConcurrentPerOwner: 4,
      },
      taskScope: {
        maxActiveTasks: 10,
        maxOwnerTasks: 4,
      },
    })).toThrow('bulkhead.maxConcurrent must not exceed taskScope.maxActiveTasks');
  });

  it('rejects per-owner bulkhead concurrency above task-scope owner capacity', () => {
    expect(() => createRuntimePolicyProfile('interactive', {
      bulkhead: {
        maxConcurrent: 8,
        maxConcurrentPerOwner: 4,
      },
      taskScope: {
        maxActiveTasks: 16,
        maxOwnerTasks: 3,
      },
    })).toThrow(
      'bulkhead.maxConcurrentPerOwner must not exceed taskScope.maxOwnerTasks',
    );
  });

  it('rejects resource lease owner capacity above total capacity', () => {
    expect(() => createRuntimePolicyProfile('interactive', {
      resourceLeases: {
        maxActiveLeases: 4,
        maxOwnerLeases: 5,
      },
    })).toThrow('resourceLeases.maxOwnerLeases');
  });

  it('rejects task owner capacity above total scoped task capacity', () => {
    expect(() => createRuntimePolicyProfile('interactive', {
      taskScope: {
        maxActiveTasks: 4,
        maxOwnerTasks: 5,
      },
    })).toThrow('taskScope.maxOwnerTasks');
  });

  it.each([
    [{ bulkhead: { maxConcurrent: 0 } }, 'bulkhead.maxConcurrent'],
    [{ bulkhead: { maxQueueWaitMs: 0 } }, 'bulkhead.maxQueueWaitMs'],
    [{ circuitBreaker: { failureThreshold: 0 } }, 'circuitBreaker.failureThreshold'],
    [{ circuitBreaker: { recoveryTimeoutMs: 0 } }, 'circuitBreaker.recoveryTimeoutMs'],
    [{ failureBudget: { windowMs: 999 } }, 'failureBudget.windowMs'],
    [{ failureBudget: { minimumSamples: 0 } }, 'failureBudget.minimumSamples'],
    [{ retry: { maxAttempts: 0 } }, 'retry.maxAttempts'],
    [{ retry: { maxAttempts: 11 } }, 'retry.maxAttempts'],
    [{ retry: { backoffFactor: 0.5 } }, 'retry.backoffFactor'],
    [{ retry: { jitterRatio: 1.1 } }, 'retry.jitterRatio'],
    [{ resourceLeases: { maxActiveLeases: 0 } }, 'resourceLeases.maxActiveLeases'],
    [{ resourceLeases: { historyLimit: 0 } }, 'resourceLeases.historyLimit'],
    [{ taskScope: { maxActiveTasks: 0 } }, 'taskScope.maxActiveTasks'],
    [{ taskScope: { maxChildren: 0 } }, 'taskScope.maxChildren'],
    [{ taskScope: { historyLimit: -1 } }, 'taskScope.historyLimit'],
  ] as const)('rejects unsafe overrides %#', (overrides, expected) => {
    expect(() => createRuntimePolicyProfile('interactive', overrides)).toThrow(expected);
  });

  it('accepts explicit history-free hot-path policies where supported', () => {
    const profile = createRuntimePolicyProfile('interactive', {
      bulkhead: { historyLimit: 0 },
      circuitBreaker: { historyLimit: 0 },
      failureBudget: { historyLimit: 0 },
      taskScope: { historyLimit: 0 },
    });

    expect(profile.bulkhead.historyLimit).toBe(0);
    expect(profile.circuitBreaker.historyLimit).toBe(0);
    expect(profile.failureBudget.historyLimit).toBe(0);
    expect(profile.taskScope.historyLimit).toBe(0);
  });

  it('does not expose runtime callback injection inside serializable policy profiles', () => {
    const profile = createRuntimePolicyProfile('interactive');
    expect('clock' in profile.bulkhead).toBe(false);
    expect('classifyFailure' in profile.circuitBreaker).toBe(false);
    expect('clock' in profile.failureBudget).toBe(false);
    expect('retryable' in profile.retry).toBe(false);
    expect('random' in profile.retry).toBe(false);
    expect('sleep' in profile.retry).toBe(false);
    expect('clock' in profile.taskScope).toBe(false);
  });

  it('round-trips safely through JSON for configuration diagnostics', () => {
    const profile = createRuntimePolicyProfile('background');
    const roundTripped = JSON.parse(JSON.stringify(profile)) as unknown;

    expect(roundTripped).toStrictEqual(profile);
  });
});
