import { describe, expect, it } from 'vitest';
import {
  createRuntimeResilienceHealthMonitor,
  evaluateRuntimeResilienceHealth,
} from './runtimeResilienceHealth';
import {
  createRuntimeResilienceSupervisor,
  type RuntimeResilienceLane,
  type RuntimeResilienceSupervisor,
} from './runtimeResilienceSupervisor';

const createSupervisor = () => createRuntimeResilienceSupervisor({
  policy: {
    minimumSignalSamples: {
      critical: 1,
      interactive: 1,
      background: 1,
    },
    maxErrorRate: {
      critical: 0.5,
      interactive: 0.3,
      background: 0.2,
    },
    historyLimit: 64,
    maxKeyLength: 64,
  },
  envelope: {
    critical: {
      maxInFlight: 4,
      maxQueued: 8,
      timeoutMs: 1_000,
      maxAttempts: 3,
    },
    interactive: {
      maxInFlight: 3,
      maxQueued: 6,
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

const complete = (
  supervisor: RuntimeResilienceSupervisor,
  lane: RuntimeResilienceLane,
  index: number,
  outcome: 'success' | 'failure',
  latencyMs: number,
): void => {
  const startedAt = index * 10;
  const result = supervisor.begin({
    key: lane + ':' + index,
    lane,
    nowMs: startedAt,
    load: { active: 0, queued: 0 },
  });
  expect(result.admitted).toBe(true);
  if (!result.admitted) return;
  expect(result.lease.finish({
    outcome,
    nowMs: startedAt + latencyMs,
    latencyMs,
  })).toBe(true);
};

describe('runtime resilience health evaluation baseline', () => {
  it('treats an empty supervisor as healthy', () => {
    const summary = evaluateRuntimeResilienceHealth(
      createSupervisor().snapshot(),
    );
    expect(summary).toMatchObject({
      status: 'healthy',
      score: 100,
      active: 0,
      admissionAttempts: 0,
      shedRate: 0,
      completed: 0,
      failureRate: 0,
      timeoutRate: 0,
      risks: [],
    });
  });

  it('computes total lane capacity from the envelope', () => {
    const summary = evaluateRuntimeResilienceHealth(
      createSupervisor().snapshot(),
    );
    expect(summary.activeCapacity).toBe(9);
  });

  it('keeps sparse completion data below rate thresholds', () => {
    const supervisor = createSupervisor();
    complete(supervisor, 'interactive', 0, 'failure', 20);
    const summary = evaluateRuntimeResilienceHealth(supervisor.snapshot(), {
      minimumCompleted: 5,
      minimumLaneSignals: 5,
    });
    expect(summary.status).toBe('healthy');
    expect(summary.failureRate).toBe(1);
    expect(summary.risks).toEqual([]);
  });

  it('returns immutable risk collections', () => {
    const summary = evaluateRuntimeResilienceHealth(
      createSupervisor().snapshot(),
    );
    expect(Object.isFrozen(summary)).toBe(true);
    expect(Object.isFrozen(summary.risks)).toBe(true);
  });
});

describe('runtime resilience health admission risk', () => {
  it('degrades on elevated shed rate', () => {
    const supervisor = createSupervisor();
    for (let index = 0; index < 8; index += 1) {
      supervisor.begin({
        key: 'shed:' + index,
        lane: 'background',
        nowMs: index,
        load: {
          active: index < 7 ? 0 : 2,
          queued: 0,
        },
      });
    }
    const summary = evaluateRuntimeResilienceHealth(supervisor.snapshot(), {
      minimumCompleted: 4,
      shedWarningRate: 0.1,
      shedCriticalRate: 0.5,
    });
    expect(summary.shedRate).toBe(1 / 8);
    expect(summary.risks).toContainEqual(expect.objectContaining({
      code: 'shed-rate',
      status: 'degraded',
    }));
  });

  it('becomes critical on sustained shed rate', () => {
    const supervisor = createSupervisor();
    for (let index = 0; index < 8; index += 1) {
      supervisor.begin({
        key: 'shed-critical:' + index,
        lane: 'background',
        nowMs: index,
        load: {
          active: index < 4 ? 0 : 2,
          queued: 0,
        },
      });
    }
    const summary = evaluateRuntimeResilienceHealth(supervisor.snapshot(), {
      minimumCompleted: 4,
      shedWarningRate: 0.1,
      shedCriticalRate: 0.4,
    });
    expect(summary.shedRate).toBe(0.5);
    expect(summary.status).toBe('critical');
    expect(summary.risks).toContainEqual(expect.objectContaining({
      code: 'shed-rate',
      status: 'critical',
    }));
  });

  it('does not divide by zero when no admission attempts exist', () => {
    expect(evaluateRuntimeResilienceHealth(
      createSupervisor().snapshot(),
    ).shedRate).toBe(0);
  });
});

describe('runtime resilience health completion risk', () => {
  it('degrades on elevated failure rate', () => {
    const supervisor = createSupervisor();
    for (let index = 0; index < 10; index += 1) {
      complete(
        supervisor,
        'interactive',
        index,
        index === 0 ? 'failure' : 'success',
        10,
      );
    }
    const summary = evaluateRuntimeResilienceHealth(supervisor.snapshot(), {
      minimumCompleted: 8,
      minimumLaneSignals: 50,
      failureWarningRate: 0.08,
      failureCriticalRate: 0.5,
    });
    expect(summary.failureRate).toBe(0.1);
    expect(summary.risks).toContainEqual(expect.objectContaining({
      code: 'failure-rate',
      status: 'degraded',
    }));
  });

  it('becomes critical on sustained failure rate', () => {
    const supervisor = createSupervisor();
    for (let index = 0; index < 8; index += 1) {
      complete(
        supervisor,
        'interactive',
        index,
        index < 3 ? 'failure' : 'success',
        10,
      );
    }
    const summary = evaluateRuntimeResilienceHealth(supervisor.snapshot(), {
      minimumCompleted: 8,
      minimumLaneSignals: 50,
      failureWarningRate: 0.1,
      failureCriticalRate: 0.3,
    });
    expect(summary.failureRate).toBe(3 / 8);
    expect(summary.status).toBe('critical');
  });

  it('counts timeouts as terminal failures', () => {
    const supervisor = createSupervisor();
    for (let index = 0; index < 8; index += 1) {
      const startedAt = index * 20;
      const result = supervisor.begin({
        key: 'timeout:' + index,
        lane: 'background',
        nowMs: startedAt,
        timeoutMs: 5,
        load: { active: 0, queued: 0 },
      });
      expect(result.admitted).toBe(true);
      if (!result.admitted) continue;
      result.lease.finish({
        outcome: 'success',
        nowMs: startedAt + 5,
      });
    }
    const summary = evaluateRuntimeResilienceHealth(supervisor.snapshot(), {
      minimumCompleted: 8,
      minimumLaneSignals: 50,
      timeoutWarningRate: 0.1,
      timeoutCriticalRate: 0.5,
    });
    expect(summary.timeoutRate).toBe(1);
    expect(summary.failureRate).toBe(1);
    expect(summary.risks).toContainEqual(expect.objectContaining({
      code: 'timeout-rate',
      status: 'critical',
    }));
  });

  it('does not count cancellations as failures', () => {
    const supervisor = createSupervisor();
    for (let index = 0; index < 8; index += 1) {
      const result = supervisor.begin({
        key: 'cancel:' + index,
        lane: 'interactive',
        nowMs: index * 2,
        load: { active: 0, queued: 0 },
      });
      if (result.admitted) {
        result.lease.finish({
          outcome: 'cancelled',
          nowMs: index * 2 + 1,
        });
      }
    }
    const summary = evaluateRuntimeResilienceHealth(supervisor.snapshot(), {
      minimumCompleted: 8,
    });
    expect(summary.failureRate).toBe(0);
    expect(summary.timeoutRate).toBe(0);
  });
});

describe('runtime resilience lane signal health', () => {
  it('degrades on critical-lane error rate', () => {
    const supervisor = createSupervisor();
    supervisor.recordSignal('critical', 10, false, 1);
    supervisor.recordSignal('critical', 10, true, 2);
    const summary = evaluateRuntimeResilienceHealth(supervisor.snapshot(), {
      minimumLaneSignals: 2,
      laneErrorWarningRate: {
        critical: 0.4,
        interactive: 0.4,
        background: 0.4,
      },
      laneErrorCriticalRate: {
        critical: 0.8,
        interactive: 0.8,
        background: 0.8,
      },
    });
    expect(summary.risks).toContainEqual(expect.objectContaining({
      code: 'critical-errors',
      lane: 'critical',
      status: 'degraded',
    }));
  });

  it('becomes critical on background-lane error rate', () => {
    const supervisor = createSupervisor();
    supervisor.recordSignal('background', 10, false, 1);
    supervisor.recordSignal('background', 10, false, 2);
    const summary = evaluateRuntimeResilienceHealth(supervisor.snapshot(), {
      minimumLaneSignals: 2,
      laneErrorWarningRate: {
        critical: 0.2,
        interactive: 0.2,
        background: 0.2,
      },
      laneErrorCriticalRate: {
        critical: 0.8,
        interactive: 0.8,
        background: 0.8,
      },
    });
    expect(summary.risks).toContainEqual(expect.objectContaining({
      code: 'background-errors',
      lane: 'background',
      status: 'critical',
    }));
  });

  it('degrades on lane latency pressure', () => {
    const supervisor = createSupervisor();
    supervisor.recordSignal('interactive', 400, true, 1);
    supervisor.recordSignal('interactive', 400, true, 2);
    const summary = evaluateRuntimeResilienceHealth(supervisor.snapshot(), {
      minimumLaneSignals: 2,
      laneLatencyWarningRatio: {
        critical: 0.7,
        interactive: 0.7,
        background: 0.7,
      },
      laneLatencyCriticalRatio: {
        critical: 1,
        interactive: 1,
        background: 1,
      },
    });
    expect(summary.risks).toContainEqual(expect.objectContaining({
      code: 'interactive-latency',
      lane: 'interactive',
      status: 'degraded',
      value: 0.8,
    }));
  });

  it('becomes critical when lane p95 reaches timeout', () => {
    const supervisor = createSupervisor();
    supervisor.recordSignal('background', 200, true, 1);
    supervisor.recordSignal('background', 200, true, 2);
    const summary = evaluateRuntimeResilienceHealth(supervisor.snapshot(), {
      minimumLaneSignals: 2,
    });
    expect(summary.risks).toContainEqual(expect.objectContaining({
      code: 'background-latency',
      status: 'critical',
      lane: 'background',
      value: 1,
    }));
  });

  it('ignores lane signals below configured sample minimum', () => {
    const supervisor = createSupervisor();
    supervisor.recordSignal('interactive', 500, false, 1);
    const summary = evaluateRuntimeResilienceHealth(supervisor.snapshot(), {
      minimumLaneSignals: 2,
    });
    expect(summary.risks.some((risk) =>
      risk.code === 'interactive-errors'
      || risk.code === 'interactive-latency')).toBe(false);
  });

  it('evaluates lanes independently', () => {
    const supervisor = createSupervisor();
    supervisor.recordSignal('background', 200, false, 1);
    supervisor.recordSignal('background', 200, false, 2);
    const summary = evaluateRuntimeResilienceHealth(supervisor.snapshot(), {
      minimumLaneSignals: 2,
    });
    expect(summary.risks.some((risk) =>
      risk.code === 'critical-errors'
      || risk.code === 'critical-latency')).toBe(false);
  });
});

describe('runtime resilience active saturation health', () => {
  it('degrades near aggregate active capacity', () => {
    const supervisor = createSupervisor();
    const lanes: RuntimeResilienceLane[] = [
      'critical',
      'critical',
      'critical',
      'interactive',
      'interactive',
      'background',
      'background',
    ];
    lanes.forEach((lane, index) => {
      supervisor.begin({
        key: 'active:' + index,
        lane,
        nowMs: 0,
        load: { active: 0, queued: 0 },
      });
    });
    const summary = evaluateRuntimeResilienceHealth(supervisor.snapshot(), {
      activeWarningRatio: 0.7,
      activeCriticalRatio: 0.95,
    });
    expect(summary.active).toBe(7);
    expect(summary.activeRatio).toBeCloseTo(7 / 9);
    expect(summary.risks).toContainEqual(expect.objectContaining({
      code: 'active-saturation',
      status: 'degraded',
    }));
  });

  it('becomes critical at aggregate active saturation', () => {
    const supervisor = createSupervisor();
    const laneCapacity: ReadonlyArray<[RuntimeResilienceLane, number]> = [
      ['critical', 4],
      ['interactive', 3],
      ['background', 2],
    ];
    let index = 0;
    for (const [lane, count] of laneCapacity) {
      for (let item = 0; item < count; item += 1) {
        supervisor.begin({
          key: 'capacity:' + index,
          lane,
          nowMs: 0,
          load: { active: 0, queued: 0 },
        });
        index += 1;
      }
    }
    const summary = evaluateRuntimeResilienceHealth(supervisor.snapshot(), {
      activeWarningRatio: 0.8,
      activeCriticalRatio: 0.98,
    });
    expect(summary.activeRatio).toBe(1);
    expect(summary.risks).toContainEqual(expect.objectContaining({
      code: 'active-saturation',
      status: 'critical',
    }));
  });
});

describe('runtime resilience diagnostic failure health', () => {
  it('degrades on rejected signals', () => {
    const supervisor = createRuntimeResilienceSupervisor({
      signals: { maxWeight: 1 },
    });
    const result = supervisor.begin({
      key: 'weight',
      lane: 'critical',
      nowMs: 0,
      load: { active: 0, queued: 0 },
    });
    expect(result.admitted).toBe(true);
    if (result.admitted) {
      result.lease.finish({
        outcome: 'success',
        nowMs: 1,
        weight: 2,
      });
    }
    const summary = evaluateRuntimeResilienceHealth(supervisor.snapshot());
    expect(summary.risks).toContainEqual(expect.objectContaining({
      code: 'signal-rejections',
      status: 'degraded',
    }));
  });

  it('becomes critical after bounded signal rejection threshold', () => {
    const supervisor = createRuntimeResilienceSupervisor({
      signals: { maxWeight: 1 },
    });
    for (let index = 0; index < 2; index += 1) {
      const result = supervisor.begin({
        key: 'weight:' + index,
        lane: 'critical',
        nowMs: index * 2,
        load: { active: 0, queued: 0 },
      });
      if (result.admitted) {
        result.lease.finish({
          outcome: 'success',
          nowMs: index * 2 + 1,
          weight: 2,
        });
      }
    }
    const summary = evaluateRuntimeResilienceHealth(supervisor.snapshot(), {
      signalRejectionWarningCount: 1,
      signalRejectionCriticalCount: 2,
    });
    expect(summary.risks).toContainEqual(expect.objectContaining({
      code: 'signal-rejections',
      status: 'critical',
    }));
  });

  it('degrades on observer failure evidence', () => {
    const supervisor = createRuntimeResilienceSupervisor({
      onEvent: () => {
        throw new Error('observer');
      },
    });
    supervisor.begin({
      key: 'observer',
      lane: 'critical',
      nowMs: 0,
      load: { active: 0, queued: 0 },
    });
    const summary = evaluateRuntimeResilienceHealth(supervisor.snapshot());
    expect(summary.risks).toContainEqual(expect.objectContaining({
      code: 'observer-failures',
      status: 'degraded',
    }));
  });
});

describe('runtime resilience health risk ordering and score', () => {
  it('places critical risks before degraded risks', () => {
    const supervisor = createRuntimeResilienceSupervisor({
      signals: { maxWeight: 1 },
      onEvent: () => {
        throw new Error('observer');
      },
    });
    for (let index = 0; index < 2; index += 1) {
      const result = supervisor.begin({
        key: 'mixed:' + index,
        lane: 'critical',
        nowMs: index * 2,
        load: { active: 0, queued: 0 },
      });
      if (result.admitted) {
        result.lease.finish({
          outcome: 'success',
          nowMs: index * 2 + 1,
          weight: 2,
        });
      }
    }
    const summary = evaluateRuntimeResilienceHealth(supervisor.snapshot(), {
      signalRejectionWarningCount: 1,
      signalRejectionCriticalCount: 2,
      observerFailureWarningCount: 1,
      observerFailureCriticalCount: 100,
    });
    expect(summary.risks[0]?.status).toBe('critical');
  });

  it('bounds risk entries', () => {
    const supervisor = createRuntimeResilienceSupervisor({
      signals: { maxWeight: 1 },
      onEvent: () => {
        throw new Error('observer');
      },
    });
    for (let index = 0; index < 8; index += 1) {
      const result = supervisor.begin({
        key: 'bounded:' + index,
        lane: 'critical',
        nowMs: index * 2,
        load: { active: 0, queued: 0 },
      });
      if (result.admitted) {
        result.lease.finish({
          outcome: index < 4 ? 'failure' : 'success',
          nowMs: index * 2 + 1,
          weight: 2,
        });
      }
    }
    const summary = evaluateRuntimeResilienceHealth(supervisor.snapshot(), {
      minimumCompleted: 2,
      minimumLaneSignals: 2,
      maxRisks: 2,
      signalRejectionCriticalCount: 2,
      observerFailureCriticalCount: 2,
    });
    expect(summary.risks).toHaveLength(2);
  });

  it('score falls as health becomes critical', () => {
    const healthy = evaluateRuntimeResilienceHealth(
      createSupervisor().snapshot(),
    );
    const unhealthySupervisor = createSupervisor();
    for (let index = 0; index < 8; index += 1) {
      complete(
        unhealthySupervisor,
        'interactive',
        index,
        'failure',
        500,
      );
    }
    const critical = evaluateRuntimeResilienceHealth(
      unhealthySupervisor.snapshot(),
      {
        minimumCompleted: 8,
        minimumLaneSignals: 8,
      },
    );
    expect(critical.status).toBe('critical');
    expect(critical.score).toBeLessThan(healthy.score);
  });
});

describe('runtime resilience health policy validation', () => {
  it.each([
    ['shedWarningRate', -0.1],
    ['shedCriticalRate', 1.1],
    ['failureWarningRate', -0.1],
    ['failureCriticalRate', 1.1],
    ['timeoutWarningRate', -0.1],
    ['timeoutCriticalRate', 1.1],
    ['activeWarningRatio', -0.1],
    ['activeCriticalRatio', 1.1],
  ] as const)('rejects invalid rate %s', (key, value) => {
    expect(() => evaluateRuntimeResilienceHealth(
      createSupervisor().snapshot(),
      { [key]: value },
    )).toThrow(RangeError);
  });

  it('rejects critical shed threshold below warning threshold', () => {
    expect(() => evaluateRuntimeResilienceHealth(
      createSupervisor().snapshot(),
      {
        shedWarningRate: 0.5,
        shedCriticalRate: 0.4,
      },
    )).toThrow(RangeError);
  });

  it('rejects critical failure threshold below warning threshold', () => {
    expect(() => evaluateRuntimeResilienceHealth(
      createSupervisor().snapshot(),
      {
        failureWarningRate: 0.5,
        failureCriticalRate: 0.4,
      },
    )).toThrow(RangeError);
  });

  it('rejects critical timeout threshold below warning threshold', () => {
    expect(() => evaluateRuntimeResilienceHealth(
      createSupervisor().snapshot(),
      {
        timeoutWarningRate: 0.5,
        timeoutCriticalRate: 0.4,
      },
    )).toThrow(RangeError);
  });

  it('rejects active critical threshold below warning threshold', () => {
    expect(() => evaluateRuntimeResilienceHealth(
      createSupervisor().snapshot(),
      {
        activeWarningRatio: 0.9,
        activeCriticalRatio: 0.8,
      },
    )).toThrow(RangeError);
  });

  it('rejects lane critical error threshold below warning threshold', () => {
    expect(() => evaluateRuntimeResilienceHealth(
      createSupervisor().snapshot(),
      {
        laneErrorWarningRate: {
          critical: 0.5,
          interactive: 0.1,
          background: 0.1,
        },
        laneErrorCriticalRate: {
          critical: 0.4,
          interactive: 0.2,
          background: 0.2,
        },
      },
    )).toThrow(RangeError);
  });

  it('rejects lane critical latency threshold below warning threshold', () => {
    expect(() => evaluateRuntimeResilienceHealth(
      createSupervisor().snapshot(),
      {
        laneLatencyWarningRatio: {
          critical: 0.8,
          interactive: 0.7,
          background: 0.7,
        },
        laneLatencyCriticalRatio: {
          critical: 0.7,
          interactive: 1,
          background: 1,
        },
      },
    )).toThrow(RangeError);
  });

  it.each([
    ['minimumCompleted', 0],
    ['minimumLaneSignals', 0],
    ['signalRejectionWarningCount', 0],
    ['signalRejectionCriticalCount', 0],
    ['observerFailureWarningCount', 0],
    ['observerFailureCriticalCount', 0],
    ['maxRisks', 0],
    ['recoverySamples', 0],
    ['historyLimit', 0],
  ] as const)('rejects invalid integer policy %s', (key, value) => {
    expect(() => evaluateRuntimeResilienceHealth(
      createSupervisor().snapshot(),
      { [key]: value },
    )).toThrow(RangeError);
  });
});

describe('runtime resilience health monitor', () => {
  it('samples a healthy supervisor with sequence metadata', () => {
    const monitor = createRuntimeResilienceHealthMonitor();
    const sample = monitor.sample(createSupervisor().snapshot(), 100);
    expect(sample).toMatchObject({
      sequence: 1,
      sampledAt: 100,
      status: 'healthy',
      previousStatus: 'healthy',
      changed: false,
      recoveryStreak: 0,
    });
    expect(sample.fingerprint).toMatch(/^[0-9a-f]{8}$/u);
  });

  it('requires a monotonic caller clock', () => {
    const monitor = createRuntimeResilienceHealthMonitor();
    monitor.sample(createSupervisor().snapshot(), 100);
    expect(() => monitor.sample(
      createSupervisor().snapshot(),
      99,
    )).toThrow(RangeError);
  });

  it('rejects negative sample time', () => {
    const monitor = createRuntimeResilienceHealthMonitor();
    expect(() => monitor.sample(
      createSupervisor().snapshot(),
      -1,
    )).toThrow(RangeError);
  });

  it('moves to critical immediately on strong evidence', () => {
    const supervisor = createSupervisor();
    for (let index = 0; index < 8; index += 1) {
      complete(supervisor, 'interactive', index, 'failure', 500);
    }
    const monitor = createRuntimeResilienceHealthMonitor({
      policy: {
        minimumCompleted: 8,
        minimumLaneSignals: 8,
      },
    });
    const sample = monitor.sample(supervisor.snapshot(), 1000);
    expect(sample.status).toBe('critical');
    expect(sample.changed).toBe(true);
    expect(sample.previousStatus).toBe('healthy');
  });

  it('requires consecutive healthy samples before recovery', () => {
    const bad = createSupervisor();
    for (let index = 0; index < 8; index += 1) {
      complete(bad, 'interactive', index, 'failure', 500);
    }
    const good = createSupervisor();
    const monitor = createRuntimeResilienceHealthMonitor({
      policy: {
        minimumCompleted: 8,
        minimumLaneSignals: 8,
        recoverySamples: 2,
      },
    });
    expect(monitor.sample(bad.snapshot(), 1000).status).toBe('critical');
    const firstRecovery = monitor.sample(good.snapshot(), 1001);
    expect(firstRecovery.status).toBe('critical');
    expect(firstRecovery.recoveryStreak).toBe(1);
    const secondRecovery = monitor.sample(good.snapshot(), 1002);
    expect(secondRecovery.status).toBe('healthy');
    expect(secondRecovery.changed).toBe(true);
  });

  it('resets recovery streak when pressure returns', () => {
    const bad = createSupervisor();
    for (let index = 0; index < 8; index += 1) {
      complete(bad, 'interactive', index, 'failure', 500);
    }
    const good = createSupervisor();
    const monitor = createRuntimeResilienceHealthMonitor({
      policy: {
        minimumCompleted: 8,
        minimumLaneSignals: 8,
        recoverySamples: 3,
      },
    });
    monitor.sample(bad.snapshot(), 1000);
    expect(monitor.sample(good.snapshot(), 1001).recoveryStreak).toBe(1);
    expect(monitor.sample(bad.snapshot(), 1002).recoveryStreak).toBe(0);
  });

  it('retains bounded history', () => {
    const monitor = createRuntimeResilienceHealthMonitor({
      policy: {
        historyLimit: 2,
      },
    });
    const snapshot = createSupervisor().snapshot();
    monitor.sample(snapshot, 1);
    monitor.sample(snapshot, 2);
    monitor.sample(snapshot, 3);
    const state = monitor.snapshot();
    expect(state.samples).toBe(3);
    expect(state.history.map((item) => item.sequence)).toEqual([2, 3]);
  });

  it('returns immutable monitor snapshot collections', () => {
    const monitor = createRuntimeResilienceHealthMonitor();
    monitor.sample(createSupervisor().snapshot(), 1);
    const state = monitor.snapshot();
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.history)).toBe(true);
    expect(Object.isFrozen(state.current)).toBe(true);
  });

  it('reset clears history, sequence and clock baseline', () => {
    const monitor = createRuntimeResilienceHealthMonitor();
    monitor.sample(createSupervisor().snapshot(), 100);
    monitor.reset();
    const sample = monitor.sample(createSupervisor().snapshot(), 50);
    expect(sample.sequence).toBe(1);
    expect(sample.sampledAt).toBe(50);
    expect(monitor.snapshot().history).toHaveLength(1);
  });

  it('fingerprint remains stable across equivalent health states', () => {
    const monitor = createRuntimeResilienceHealthMonitor();
    const snapshot = createSupervisor().snapshot();
    const first = monitor.sample(snapshot, 1);
    const second = monitor.sample(snapshot, 2);
    expect(second.fingerprint).toBe(first.fingerprint);
  });

  it('fingerprint changes when health evidence changes', () => {
    const monitor = createRuntimeResilienceHealthMonitor({
      policy: {
        minimumLaneSignals: 1,
      },
    });
    const supervisor = createSupervisor();
    const first = monitor.sample(supervisor.snapshot(), 1);
    supervisor.recordSignal('background', 200, false, 2);
    const second = monitor.sample(supervisor.snapshot(), 2);
    expect(second.fingerprint).not.toBe(first.fingerprint);
  });
});
