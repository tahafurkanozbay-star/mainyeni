import { describe, expect, test } from 'vitest';
import {
  createMutationSafetyHealthMonitor,
  evaluateMutationSafetyHealth,
  type MutationSafetyHealthPolicy,
} from './mutationSafetyHealth';
import type { MutationSafetyRuntimeSnapshot } from './mutationSafetyRuntime';
import type { MutationIdempotencyRegistrySnapshot } from './mutationIdempotency';

const registrySnapshot = (
  overrides: Partial<MutationIdempotencyRegistrySnapshot> = {},
): MutationIdempotencyRegistrySnapshot => Object.freeze({
  disposed: false,
  limits: Object.freeze({
    maxEntries: 100,
    maxEntriesPerOwner: 20,
    retentionMs: 300_000,
    staleInFlightAfterMs: 120_000,
  }),
  entries: 0,
  inFlight: 0,
  retained: 0,
  owners: 0,
  staleInFlight: 0,
  oldestInFlightAgeMs: 0,
  counters: Object.freeze({
    admitted: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    rejected: 0,
    inFlightConflicts: 0,
    retainedConflicts: 0,
    pruned: 0,
    observerFailures: 0,
  }),
  history: Object.freeze([]),
  ...overrides,
});

const runtimeSnapshot = (
  overrides: Partial<MutationSafetyRuntimeSnapshot> = {},
): MutationSafetyRuntimeSnapshot => Object.freeze({
  disposed: false,
  protectedExecutions: 0,
  bypassedExecutions: 0,
  completedExecutions: 0,
  failedExecutions: 0,
  cancelledExecutions: 0,
  rejectedExecutions: 0,
  observerFailures: 0,
  registry: registrySnapshot(),
  ...overrides,
});

const policy = (): Partial<MutationSafetyHealthPolicy> => ({
  staleWarningCount: 1,
  staleCriticalCount: 3,
  capacityWarningRatio: 0.75,
  capacityCriticalRatio: 0.9,
  inFlightConflictWarningCount: 1,
  inFlightConflictCriticalCount: 5,
  replayConflictWarningCount: 3,
  replayConflictCriticalCount: 10,
  ambiguousOutcomeWarningRatio: 0.2,
  ambiguousOutcomeCriticalRatio: 0.5,
  minimumOutcomeSamples: 5,
  observerFailureWarningCount: 1,
  observerFailureCriticalCount: 3,
  maxRisks: 12,
});

describe('evaluateMutationSafetyHealth baseline', () => {
  test('classifies empty runtime as healthy', () => {
    const health = evaluateMutationSafetyHealth(runtimeSnapshot(), policy());

    expect(health).toEqual({
      status: 'healthy',
      protectedExecutions: 0,
      inFlight: 0,
      retained: 0,
      staleInFlight: 0,
      entryCapacityRatio: 0,
      inFlightConflicts: 0,
      replayConflicts: 0,
      ambiguousOutcomes: 0,
      settledOutcomes: 0,
      ambiguousOutcomeRatio: 0,
      observerFailures: 0,
      disposed: false,
      risks: [],
    });
    expect(Object.isFrozen(health)).toBe(true);
    expect(Object.isFrozen(health.risks)).toBe(true);
  });

  test('preserves aggregate protected execution count', () => {
    const health = evaluateMutationSafetyHealth(runtimeSnapshot({
      protectedExecutions: 12,
      completedExecutions: 12,
    }));

    expect(health.protectedExecutions).toBe(12);
    expect(health.settledOutcomes).toBe(12);
    expect(health.status).toBe('healthy');
  });

  test('does not retain history, owner, route or idempotency key identity', () => {
    const registry = registrySnapshot({
      retained: 1,
      entries: 1,
      history: Object.freeze([
        Object.freeze({
          owner: '/private/account/42',
          method: 'post',
          state: 'completed',
          startedAt: 1,
          settledAt: 2,
          durationMs: 1,
          logicalAttempts: 1,
        }),
      ]),
    });
    const serialized = JSON.stringify(evaluateMutationSafetyHealth(runtimeSnapshot({
      registry,
    })));

    expect(serialized).not.toContain('/private/account/42');
    expect(serialized).not.toContain('history');
    expect(serialized).not.toContain('idempotency');
  });
});

describe('evaluateMutationSafetyHealth stale work', () => {
  test('degrades on one stale in-flight mutation', () => {
    const health = evaluateMutationSafetyHealth(runtimeSnapshot({
      registry: registrySnapshot({
        entries: 1,
        inFlight: 1,
        staleInFlight: 1,
        oldestInFlightAgeMs: 130_000,
      }),
    }), policy());

    expect(health.status).toBe('degraded');
    expect(health.risks).toContainEqual({
      code: 'stale-in-flight',
      status: 'degraded',
      metric: 'staleInFlight',
      value: 1,
      threshold: 1,
    });
  });

  test('becomes critical at stale critical threshold', () => {
    const health = evaluateMutationSafetyHealth(runtimeSnapshot({
      registry: registrySnapshot({
        entries: 3,
        inFlight: 3,
        staleInFlight: 3,
      }),
    }), policy());

    expect(health.status).toBe('critical');
    expect(health.risks[0]).toMatchObject({
      code: 'stale-in-flight',
      status: 'critical',
      value: 3,
      threshold: 3,
    });
  });
});

describe('evaluateMutationSafetyHealth capacity pressure', () => {
  test('degrades at warning utilization ratio', () => {
    const health = evaluateMutationSafetyHealth(runtimeSnapshot({
      registry: registrySnapshot({
        limits: Object.freeze({
          maxEntries: 100,
          maxEntriesPerOwner: 20,
          retentionMs: 300_000,
          staleInFlightAfterMs: 120_000,
        }),
        entries: 75,
        retained: 75,
      }),
    }), policy());

    expect(health.entryCapacityRatio).toBe(0.75);
    expect(health.risks).toContainEqual(expect.objectContaining({
      code: 'entry-capacity-pressure',
      status: 'degraded',
      threshold: 0.75,
    }));
  });

  test('becomes critical at critical utilization ratio', () => {
    const health = evaluateMutationSafetyHealth(runtimeSnapshot({
      registry: registrySnapshot({
        limits: Object.freeze({
          maxEntries: 10,
          maxEntriesPerOwner: 10,
          retentionMs: 300_000,
          staleInFlightAfterMs: 120_000,
        }),
        entries: 9,
        retained: 9,
      }),
    }), policy());

    expect(health.entryCapacityRatio).toBe(0.9);
    expect(health.status).toBe('critical');
    expect(health.risks).toContainEqual(expect.objectContaining({
      code: 'entry-capacity-pressure',
      status: 'critical',
    }));
  });

  test('bounds malformed over-capacity snapshot ratio to one', () => {
    const health = evaluateMutationSafetyHealth(runtimeSnapshot({
      registry: registrySnapshot({
        limits: Object.freeze({
          maxEntries: 2,
          maxEntriesPerOwner: 2,
          retentionMs: 300_000,
          staleInFlightAfterMs: 120_000,
        }),
        entries: 99,
      }),
    }));

    expect(health.entryCapacityRatio).toBe(1);
  });
});

describe('evaluateMutationSafetyHealth conflict signals', () => {
  test('degrades after first in-flight duplicate conflict', () => {
    const health = evaluateMutationSafetyHealth(runtimeSnapshot({
      registry: registrySnapshot({
        counters: Object.freeze({
          admitted: 1,
          completed: 0,
          failed: 0,
          cancelled: 0,
          rejected: 1,
          inFlightConflicts: 1,
          retainedConflicts: 0,
          pruned: 0,
          observerFailures: 0,
        }),
      }),
    }), policy());

    expect(health.inFlightConflicts).toBe(1);
    expect(health.risks).toContainEqual(expect.objectContaining({
      code: 'in-flight-conflict',
      status: 'degraded',
    }));
  });

  test('becomes critical after repeated in-flight conflicts', () => {
    const health = evaluateMutationSafetyHealth(runtimeSnapshot({
      registry: registrySnapshot({
        counters: Object.freeze({
          admitted: 1,
          completed: 0,
          failed: 0,
          cancelled: 0,
          rejected: 5,
          inFlightConflicts: 5,
          retainedConflicts: 0,
          pruned: 0,
          observerFailures: 0,
        }),
      }),
    }), policy());

    expect(health.status).toBe('critical');
    expect(health.risks).toContainEqual(expect.objectContaining({
      code: 'in-flight-conflict',
      status: 'critical',
      threshold: 5,
    }));
  });

  test('tracks retained replay conflicts separately', () => {
    const health = evaluateMutationSafetyHealth(runtimeSnapshot({
      registry: registrySnapshot({
        counters: Object.freeze({
          admitted: 4,
          completed: 4,
          failed: 0,
          cancelled: 0,
          rejected: 3,
          inFlightConflicts: 0,
          retainedConflicts: 3,
          pruned: 0,
          observerFailures: 0,
        }),
      }),
    }), policy());

    expect(health.replayConflicts).toBe(3);
    expect(health.risks).toContainEqual(expect.objectContaining({
      code: 'retained-replay-conflict',
      status: 'degraded',
    }));
  });
});

describe('evaluateMutationSafetyHealth ambiguous outcomes', () => {
  test('does not evaluate ratios before minimum sample floor', () => {
    const health = evaluateMutationSafetyHealth(runtimeSnapshot({
      protectedExecutions: 4,
      completedExecutions: 2,
      failedExecutions: 2,
    }), policy());

    expect(health.ambiguousOutcomeRatio).toBe(0.5);
    expect(health.risks).not.toContainEqual(expect.objectContaining({
      code: 'ambiguous-outcome-rate',
    }));
  });

  test('degrades when failure/cancellation ratio reaches warning threshold', () => {
    const health = evaluateMutationSafetyHealth(runtimeSnapshot({
      protectedExecutions: 10,
      completedExecutions: 8,
      failedExecutions: 1,
      cancelledExecutions: 1,
    }), policy());

    expect(health.ambiguousOutcomes).toBe(2);
    expect(health.settledOutcomes).toBe(10);
    expect(health.ambiguousOutcomeRatio).toBe(0.2);
    expect(health.risks).toContainEqual(expect.objectContaining({
      code: 'ambiguous-outcome-rate',
      status: 'degraded',
    }));
  });

  test('becomes critical at high ambiguous outcome ratio', () => {
    const health = evaluateMutationSafetyHealth(runtimeSnapshot({
      protectedExecutions: 10,
      completedExecutions: 5,
      failedExecutions: 3,
      cancelledExecutions: 2,
    }), policy());

    expect(health.ambiguousOutcomeRatio).toBe(0.5);
    expect(health.risks).toContainEqual(expect.objectContaining({
      code: 'ambiguous-outcome-rate',
      status: 'critical',
    }));
  });
});

describe('evaluateMutationSafetyHealth observer and invariant signals', () => {
  test('combines runtime and registry observer failures', () => {
    const health = evaluateMutationSafetyHealth(runtimeSnapshot({
      observerFailures: 1,
      registry: registrySnapshot({
        counters: Object.freeze({
          admitted: 0,
          completed: 0,
          failed: 0,
          cancelled: 0,
          rejected: 0,
          inFlightConflicts: 0,
          retainedConflicts: 0,
          pruned: 0,
          observerFailures: 1,
        }),
      }),
    }), {
      ...policy(),
      observerFailureWarningCount: 2,
      observerFailureCriticalCount: 4,
    });

    expect(health.observerFailures).toBe(2);
    expect(health.risks).toContainEqual(expect.objectContaining({
      code: 'observer-failure',
      status: 'degraded',
    }));
  });

  test('flags disposed runtime with active mutation as critical invariant break', () => {
    const health = evaluateMutationSafetyHealth(runtimeSnapshot({
      disposed: true,
      registry: registrySnapshot({
        disposed: true,
        entries: 1,
        inFlight: 1,
      }),
    }));

    expect(health.status).toBe('critical');
    expect(health.risks).toContainEqual({
      code: 'disposed-with-active-mutation',
      status: 'critical',
      metric: 'inFlight',
      value: 1,
      threshold: 0,
    });
  });
});

describe('evaluateMutationSafetyHealth ordering and bounds', () => {
  test('orders critical risks before degraded risks', () => {
    const health = evaluateMutationSafetyHealth(runtimeSnapshot({
      protectedExecutions: 10,
      completedExecutions: 8,
      failedExecutions: 2,
      registry: registrySnapshot({
        staleInFlight: 3,
        entries: 75,
        retained: 75,
      }),
    }), policy());

    expect(health.risks[0]?.status).toBe('critical');
    expect(health.risks.at(-1)?.status).toBe('degraded');
  });

  test('bounds retained risks to configured maximum', () => {
    const health = evaluateMutationSafetyHealth(runtimeSnapshot({
      disposed: true,
      protectedExecutions: 10,
      completedExecutions: 1,
      failedExecutions: 5,
      cancelledExecutions: 4,
      observerFailures: 10,
      registry: registrySnapshot({
        entries: 100,
        inFlight: 5,
        staleInFlight: 5,
        retained: 95,
        counters: Object.freeze({
          admitted: 100,
          completed: 91,
          failed: 5,
          cancelled: 4,
          rejected: 40,
          inFlightConflicts: 20,
          retainedConflicts: 20,
          pruned: 0,
          observerFailures: 10,
        }),
      }),
    }), {
      ...policy(),
      maxRisks: 3,
    });

    expect(health.risks).toHaveLength(3);
    expect(health.risks.every((risk) => Object.isFrozen(risk))).toBe(true);
    expect(health.status).toBe('critical');
  });
});

describe('evaluateMutationSafetyHealth policy validation', () => {
  test.each([
    ['staleWarningCount', -1],
    ['inFlightConflictWarningCount', -1],
    ['replayConflictWarningCount', -1],
    ['minimumOutcomeSamples', -1],
    ['observerFailureWarningCount', -1],
    ['maxRisks', 0],
  ] as const)('rejects invalid integer policy %s=%s', (key, value) => {
    expect(() => evaluateMutationSafetyHealth(runtimeSnapshot(), {
      [key]: value,
    })).toThrow(RangeError);
  });

  test.each([
    ['capacityWarningRatio', -0.1],
    ['capacityCriticalRatio', 1.1],
    ['ambiguousOutcomeWarningRatio', Number.NaN],
    ['ambiguousOutcomeCriticalRatio', 2],
  ] as const)('rejects invalid ratio policy %s=%s', (key, value) => {
    expect(() => evaluateMutationSafetyHealth(runtimeSnapshot(), {
      [key]: value,
    })).toThrow(RangeError);
  });

  test('rejects critical count below warning count', () => {
    expect(() => evaluateMutationSafetyHealth(runtimeSnapshot(), {
      staleWarningCount: 5,
      staleCriticalCount: 4,
    })).toThrow(RangeError);
  });

  test('rejects capacity critical ratio below warning ratio', () => {
    expect(() => evaluateMutationSafetyHealth(runtimeSnapshot(), {
      capacityWarningRatio: 0.8,
      capacityCriticalRatio: 0.7,
    })).toThrow(RangeError);
  });

  test('rejects ambiguous critical ratio below warning ratio', () => {
    expect(() => evaluateMutationSafetyHealth(runtimeSnapshot(), {
      ambiguousOutcomeWarningRatio: 0.5,
      ambiguousOutcomeCriticalRatio: 0.4,
    })).toThrow(RangeError);
  });
});

describe('MutationSafetyHealthMonitor', () => {
  test('samples on demand without background timers', () => {
    let now = 10;
    const monitor = createMutationSafetyHealthMonitor({
      now: () => now,
    });
    const first = monitor.sample(runtimeSnapshot());
    now = 20;
    const second = monitor.sample(runtimeSnapshot());

    expect(first).toMatchObject({
      sequence: 1,
      sampledAt: 10,
      status: 'healthy',
    });
    expect(second).toMatchObject({
      sequence: 2,
      sampledAt: 20,
    });
    expect(monitor.snapshot().samples).toBe(2);
    expect('setInterval' in monitor).toBe(false);
  });

  test('retains bounded immutable history', () => {
    let now = 100;
    const monitor = createMutationSafetyHealthMonitor({
      historyLimit: 2,
      now: () => now,
    });
    monitor.sample(runtimeSnapshot());
    now += 1;
    monitor.sample(runtimeSnapshot());
    now += 1;
    monitor.sample(runtimeSnapshot());

    const snapshot = monitor.snapshot();
    expect(snapshot.history.map((item) => item.sequence)).toEqual([2, 3]);
    expect(snapshot.current?.sequence).toBe(3);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.history)).toBe(true);
    expect(Object.isFrozen(snapshot.current)).toBe(true);
  });

  test('supports disabling history while preserving current sample', () => {
    const monitor = createMutationSafetyHealthMonitor({ historyLimit: 0 });
    const sample = monitor.sample(runtimeSnapshot());

    expect(sample.sequence).toBe(1);
    expect(monitor.snapshot().history).toEqual([]);
    expect(monitor.snapshot().current?.sequence).toBe(1);
  });

  test('uses construction-time policy consistently', () => {
    const monitor = createMutationSafetyHealthMonitor({
      policy: {
        staleWarningCount: 2,
        staleCriticalCount: 4,
      },
    });
    const sample = monitor.sample(runtimeSnapshot({
      registry: registrySnapshot({
        staleInFlight: 1,
      }),
    }));

    expect(sample.status).toBe('healthy');
  });

  test('reset clears sequence, history, current and clock baseline', () => {
    let now = 100;
    const monitor = createMutationSafetyHealthMonitor({ now: () => now });
    monitor.sample(runtimeSnapshot());
    monitor.reset();

    now = 50;
    const sample = monitor.sample(runtimeSnapshot());

    expect(sample.sequence).toBe(1);
    expect(sample.sampledAt).toBe(50);
    expect(monitor.snapshot().history).toHaveLength(1);
  });

  test('rejects non-finite monitor time', () => {
    const monitor = createMutationSafetyHealthMonitor({
      now: () => Number.NaN,
    });
    expect(() => monitor.sample(runtimeSnapshot())).toThrow(RangeError);
  });

  test('rejects backward-moving monitor time', () => {
    let now = 100;
    const monitor = createMutationSafetyHealthMonitor({ now: () => now });
    monitor.sample(runtimeSnapshot());
    now = 99;

    expect(() => monitor.sample(runtimeSnapshot())).toThrow(RangeError);
  });
});
