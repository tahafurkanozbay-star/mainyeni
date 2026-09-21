import { describe, expect, test } from 'vitest';
import {
  createServiceContainerHealthMonitor,
  evaluateServiceContainerHealth,
  type ServiceContainerHealthPolicy,
} from './serviceHealth';
import type {
  ServiceContainerSnapshot,
  ServiceRuntimeSnapshot,
} from './serviceContainer';
import type { ServiceGraphSnapshot } from './serviceGraph';

const graph = (
  overrides: Partial<ServiceGraphSnapshot> = {},
): ServiceGraphSnapshot => Object.freeze({
  revision: 1,
  valid: true,
  serviceCount: 0,
  relationCount: 0,
  descriptors: Object.freeze([]),
  issues: Object.freeze([]),
  startupOrder: Object.freeze([]),
  shutdownOrder: Object.freeze([]),
  layers: Object.freeze([]),
  capabilities: Object.freeze({}),
  dependents: Object.freeze({}),
  fingerprint: 'deadbeef',
  ...overrides,
});

const service = (
  id: string,
  overrides: Partial<ServiceRuntimeSnapshot> = {},
): ServiceRuntimeSnapshot => Object.freeze({
  id,
  version: '1.0.0',
  domain: 'platform',
  criticality: 'required',
  startup: 'eager',
  status: 'ready',
  starts: 1,
  stops: 0,
  ...overrides,
});

const snapshot = (
  services: readonly ServiceRuntimeSnapshot[] = [],
  overrides: Partial<ServiceContainerSnapshot> = {},
): ServiceContainerSnapshot => Object.freeze({
  state: 'ready',
  sealed: true,
  generation: 1,
  graph: graph({ serviceCount: services.length }),
  services: Object.freeze([...services]),
  counters: Object.freeze({
    registered: services.length,
    removed: 0,
    starts: services.length,
    startFailures: 0,
    optionalFailures: 0,
    stops: 0,
    stopFailures: 0,
    rollbacks: 0,
    rejected: 0,
    observerFailures: 0,
  }),
  events: Object.freeze([]),
  fingerprint: 'cafebabe',
  ...overrides,
});

const policy = (): Partial<ServiceContainerHealthPolicy> => ({
  optionalFailureWarningCount: 1,
  optionalFailureCriticalCount: 3,
  stopFailureWarningCount: 1,
  stopFailureCriticalCount: 2,
  slowStartWarningCount: 1,
  slowStartCriticalCount: 3,
  slowStopWarningCount: 1,
  slowStopCriticalCount: 3,
  observerFailureWarningCount: 1,
  observerFailureCriticalCount: 3,
  rejectionWarningCount: 2,
  rejectionCriticalCount: 4,
  slowStartMs: 100,
  slowStopMs: 100,
  maxRiskEntries: 16,
});

describe('evaluateServiceContainerHealth healthy baseline', () => {
  test('empty ready container is healthy', () => {
    expect(evaluateServiceContainerHealth(snapshot(), policy())).toEqual({
      status: 'healthy',
      containerState: 'ready',
      graphValid: true,
      totalServices: 0,
      readyServices: 0,
      failedServices: 0,
      requiredFailures: 0,
      optionalFailures: 0,
      startTimeouts: 0,
      stopFailures: 0,
      slowStarts: 0,
      slowStops: 0,
      observerFailures: 0,
      registrationRejections: 0,
      risks: [],
    });
  });

  test('ready services stay healthy below all thresholds', () => {
    const health = evaluateServiceContainerHealth(snapshot([
      service('config', { startDurationMs: 12 }),
      service('network', { startDurationMs: 20 }),
    ]), policy());
    expect(health.status).toBe('healthy');
    expect(health.readyServices).toBe(2);
    expect(health.risks).toEqual([]);
  });

  test('stopped services are not counted as failures', () => {
    const health = evaluateServiceContainerHealth(snapshot([
      service('config', {
        status: 'stopped',
        stops: 1,
        stopDurationMs: 10,
      }),
    ], {
      state: 'stopped',
    }), policy());
    expect(health.failedServices).toBe(0);
    expect(health.status).toBe('healthy');
  });

  test('health output never includes runtime instance values', () => {
    const health = evaluateServiceContainerHealth(snapshot([
      service('config'),
    ]), policy());
    expect(JSON.stringify(health)).not.toContain('private-instance');
    expect(Object.isFrozen(health)).toBe(true);
    expect(Object.isFrozen(health.risks)).toBe(true);
  });
});

describe('evaluateServiceContainerHealth failure severity', () => {
  test('required service failure is critical', () => {
    const health = evaluateServiceContainerHealth(snapshot([
      service('config', {
        status: 'failed',
        failureCode: 'START_FAILED',
        errorName: 'Error',
      }),
    ], {
      state: 'failed',
    }), policy());

    expect(health.status).toBe('critical');
    expect(health.requiredFailures).toBe(1);
    expect(health.risks).toContainEqual(expect.objectContaining({
      code: 'required-service-failure',
      status: 'critical',
      count: 1,
    }));
  });

  test('container failed state is independently critical', () => {
    const health = evaluateServiceContainerHealth(snapshot([], {
      state: 'failed',
    }), policy());
    expect(health.risks).toContainEqual(expect.objectContaining({
      code: 'container-failed',
      status: 'critical',
    }));
  });

  test('invalid service graph is critical', () => {
    const invalidGraph = graph({
      valid: false,
      serviceCount: 1,
      issues: Object.freeze([
        Object.freeze({
          code: 'missing-dependency' as const,
          serviceId: 'network',
          target: 'config',
        }),
      ]),
    });
    const health = evaluateServiceContainerHealth(snapshot([], {
      graph: invalidGraph,
    }), policy());
    expect(health.status).toBe('critical');
    expect(health.graphValid).toBe(false);
    expect(health.risks).toContainEqual(expect.objectContaining({
      code: 'invalid-graph',
      count: 1,
      affectedServices: 1,
    }));
  });

  test('single optional failure degrades by default policy', () => {
    const health = evaluateServiceContainerHealth(snapshot([
      service('telemetry', {
        criticality: 'optional',
        status: 'failed',
        failureCode: 'START_FAILED',
      }),
    ], {
      state: 'degraded',
    }), policy());
    expect(health.status).toBe('degraded');
    expect(health.optionalFailures).toBe(1);
    expect(health.risks).toContainEqual(expect.objectContaining({
      code: 'optional-service-failure',
      status: 'degraded',
      threshold: 1,
    }));
  });

  test('optional failure pressure can become critical', () => {
    const health = evaluateServiceContainerHealth(snapshot([
      service('one', { criticality: 'optional', status: 'failed' }),
      service('two', { criticality: 'optional', status: 'failed' }),
      service('three', { criticality: 'optional', status: 'failed' }),
    ], {
      state: 'degraded',
    }), policy());
    expect(health.status).toBe('critical');
    expect(health.risks).toContainEqual(expect.objectContaining({
      code: 'optional-service-failure',
      status: 'critical',
      count: 3,
      threshold: 3,
    }));
  });

  test('startup timeout is always critical', () => {
    const health = evaluateServiceContainerHealth(snapshot([
      service('network', {
        status: 'failed',
        failureCode: 'START_TIMEOUT',
      }),
    ], {
      state: 'failed',
    }), policy());
    expect(health.startTimeouts).toBe(1);
    expect(health.risks).toContainEqual(expect.objectContaining({
      code: 'startup-timeout',
      status: 'critical',
    }));
  });

  test('stop failure is degraded at warning threshold', () => {
    const health = evaluateServiceContainerHealth(snapshot([
      service('network', {
        status: 'stopped',
        stops: 0,
        failureCode: 'STOP_FAILED',
      }),
    ], {
      state: 'stopped',
    }), policy());
    expect(health.stopFailures).toBe(1);
    expect(health.risks).toContainEqual(expect.objectContaining({
      code: 'stop-failure',
      status: 'degraded',
    }));
  });

  test('stop timeout counts as stop failure', () => {
    const health = evaluateServiceContainerHealth(snapshot([
      service('network', {
        status: 'stopped',
        failureCode: 'STOP_TIMEOUT',
      }),
    ], {
      state: 'stopped',
    }), policy());
    expect(health.stopFailures).toBe(1);
  });

  test('multiple stop failures become critical', () => {
    const health = evaluateServiceContainerHealth(snapshot([
      service('one', { status: 'stopped', failureCode: 'STOP_FAILED' }),
      service('two', { status: 'stopped', failureCode: 'STOP_TIMEOUT' }),
    ], {
      state: 'stopped',
    }), policy());
    expect(health.status).toBe('critical');
    expect(health.risks).toContainEqual(expect.objectContaining({
      code: 'stop-failure',
      status: 'critical',
      threshold: 2,
    }));
  });
});

describe('evaluateServiceContainerHealth lifecycle latency', () => {
  test('slow startup degrades at threshold', () => {
    const health = evaluateServiceContainerHealth(snapshot([
      service('config', { startDurationMs: 100 }),
    ]), policy());
    expect(health.slowStarts).toBe(1);
    expect(health.risks).toContainEqual(expect.objectContaining({
      code: 'slow-start',
      status: 'degraded',
    }));
  });

  test('startup just below threshold is healthy', () => {
    const health = evaluateServiceContainerHealth(snapshot([
      service('config', { startDurationMs: 99 }),
    ]), policy());
    expect(health.slowStarts).toBe(0);
    expect(health.status).toBe('healthy');
  });

  test('multiple slow startups become critical', () => {
    const health = evaluateServiceContainerHealth(snapshot([
      service('one', { startDurationMs: 101 }),
      service('two', { startDurationMs: 120 }),
      service('three', { startDurationMs: 200 }),
    ]), policy());
    expect(health.slowStarts).toBe(3);
    expect(health.status).toBe('critical');
  });

  test('slow stop degrades independently', () => {
    const health = evaluateServiceContainerHealth(snapshot([
      service('one', {
        status: 'stopped',
        stopDurationMs: 150,
      }),
    ], {
      state: 'stopped',
    }), policy());
    expect(health.slowStops).toBe(1);
    expect(health.risks).toContainEqual(expect.objectContaining({
      code: 'slow-stop',
      status: 'degraded',
    }));
  });

  test('undefined lifecycle timing does not count as slow', () => {
    const health = evaluateServiceContainerHealth(snapshot([
      service('one', {
        startDurationMs: undefined,
        stopDurationMs: undefined,
      }),
    ]), policy());
    expect(health.slowStarts).toBe(0);
    expect(health.slowStops).toBe(0);
  });
});

describe('evaluateServiceContainerHealth operational pressure', () => {
  test('observer failure degrades at configured threshold', () => {
    const base = snapshot();
    const health = evaluateServiceContainerHealth(Object.freeze({
      ...base,
      counters: Object.freeze({
        ...base.counters,
        observerFailures: 1,
      }),
    }), policy());
    expect(health.observerFailures).toBe(1);
    expect(health.risks).toContainEqual(expect.objectContaining({
      code: 'observer-failure',
      status: 'degraded',
    }));
  });

  test('observer failure pressure can become critical', () => {
    const base = snapshot();
    const health = evaluateServiceContainerHealth(Object.freeze({
      ...base,
      counters: Object.freeze({
        ...base.counters,
        observerFailures: 3,
      }),
    }), policy());
    expect(health.status).toBe('critical');
  });

  test('single registration rejection remains healthy below threshold', () => {
    const base = snapshot();
    const health = evaluateServiceContainerHealth(Object.freeze({
      ...base,
      counters: Object.freeze({
        ...base.counters,
        rejected: 1,
      }),
    }), policy());
    expect(health.registrationRejections).toBe(1);
    expect(health.status).toBe('healthy');
  });

  test('registration rejection pressure degrades', () => {
    const base = snapshot();
    const health = evaluateServiceContainerHealth(Object.freeze({
      ...base,
      counters: Object.freeze({
        ...base.counters,
        rejected: 2,
      }),
    }), policy());
    expect(health.risks).toContainEqual(expect.objectContaining({
      code: 'registration-rejection',
      status: 'degraded',
    }));
  });

  test('registration rejection pressure can become critical', () => {
    const base = snapshot();
    const health = evaluateServiceContainerHealth(Object.freeze({
      ...base,
      counters: Object.freeze({
        ...base.counters,
        rejected: 4,
      }),
    }), policy());
    expect(health.status).toBe('critical');
  });
});

describe('evaluateServiceContainerHealth policy validation', () => {
  test.each([
    ['optionalFailureWarningCount', 0],
    ['stopFailureWarningCount', 0],
    ['slowStartWarningCount', 0],
    ['slowStopWarningCount', 0],
    ['observerFailureWarningCount', 0],
    ['rejectionWarningCount', 0],
    ['slowStartMs', 0],
    ['slowStopMs', 0],
    ['maxRiskEntries', 0],
  ] as const)('rejects zero or invalid %s', (key, value) => {
    expect(() => evaluateServiceContainerHealth(snapshot(), {
      [key]: value,
    })).toThrow(RangeError);
  });

  test.each([
    ['optionalFailureWarningCount', 2, 'optionalFailureCriticalCount', 1],
    ['stopFailureWarningCount', 2, 'stopFailureCriticalCount', 1],
    ['slowStartWarningCount', 2, 'slowStartCriticalCount', 1],
    ['slowStopWarningCount', 2, 'slowStopCriticalCount', 1],
    ['observerFailureWarningCount', 2, 'observerFailureCriticalCount', 1],
    ['rejectionWarningCount', 2, 'rejectionCriticalCount', 1],
  ] as const)(
    'rejects %s above %s',
    (warningKey, warning, criticalKey, critical) => {
      expect(() => evaluateServiceContainerHealth(snapshot(), {
        [warningKey]: warning,
        [criticalKey]: critical,
      })).toThrow(RangeError);
    },
  );

  test('bounds retained risk entries', () => {
    const base = snapshot([
      service('required', {
        status: 'failed',
        failureCode: 'START_TIMEOUT',
        startDurationMs: 500,
      }),
      service('optional', {
        criticality: 'optional',
        status: 'failed',
        failureCode: 'START_FAILED',
      }),
    ], {
      state: 'failed',
    });
    const pressured = Object.freeze({
      ...base,
      counters: Object.freeze({
        ...base.counters,
        observerFailures: 10,
        rejected: 10,
      }),
    });
    const health = evaluateServiceContainerHealth(pressured, {
      ...policy(),
      maxRiskEntries: 3,
    });
    expect(health.risks).toHaveLength(3);
    expect(health.risks.every((risk) => risk.status === 'critical')).toBe(true);
  });

  test('sorts critical risks before degraded risks', () => {
    const base = snapshot([
      service('required', {
        status: 'failed',
        failureCode: 'START_FAILED',
      }),
      service('optional', {
        criticality: 'optional',
        status: 'failed',
      }),
    ], {
      state: 'failed',
    });
    const health = evaluateServiceContainerHealth(base, policy());
    expect(health.risks[0]?.status).toBe('critical');
    expect(health.risks.at(-1)?.status).toBe('degraded');
  });
});

describe('ServiceContainerHealthMonitor', () => {
  test('samples only on demand without scheduling background work', () => {
    let now = 100;
    const monitor = createServiceContainerHealthMonitor({ now: () => now });
    const first = monitor.sample(snapshot());
    now = 120;
    const second = monitor.sample(snapshot());

    expect(first.sequence).toBe(1);
    expect(first.sampledAt).toBe(100);
    expect(second.sequence).toBe(2);
    expect(second.sampledAt).toBe(120);
    expect('setInterval' in monitor).toBe(false);
    expect('setTimeout' in monitor).toBe(false);
  });

  test('retains bounded immutable history', () => {
    let now = 1;
    const monitor = createServiceContainerHealthMonitor({
      historyLimit: 2,
      now: () => now,
    });
    monitor.sample(snapshot());
    now += 1;
    monitor.sample(snapshot());
    now += 1;
    monitor.sample(snapshot());

    const state = monitor.snapshot();
    expect(state.samples).toBe(3);
    expect(state.history.map((item) => item.sequence)).toEqual([2, 3]);
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.history)).toBe(true);
    expect(Object.isFrozen(state.current)).toBe(true);
  });

  test('history can be disabled while current sample remains available', () => {
    const monitor = createServiceContainerHealthMonitor({ historyLimit: 0 });
    const sample = monitor.sample(snapshot());
    expect(sample.sequence).toBe(1);
    expect(monitor.snapshot().history).toEqual([]);
    expect(monitor.snapshot().current?.sequence).toBe(1);
  });

  test('sample fingerprint is deterministic for equal health', () => {
    let now = 1;
    const monitor = createServiceContainerHealthMonitor({ now: () => now });
    const first = monitor.sample(snapshot());
    now += 1;
    const second = monitor.sample(snapshot());
    expect(second.fingerprint).toBe(first.fingerprint);
  });

  test('fingerprint changes when health changes', () => {
    let now = 1;
    const monitor = createServiceContainerHealthMonitor({ now: () => now });
    const first = monitor.sample(snapshot());
    now += 1;
    const second = monitor.sample(snapshot([
      service('required', {
        status: 'failed',
        failureCode: 'START_FAILED',
      }),
    ], {
      state: 'failed',
    }));
    expect(second.fingerprint).not.toBe(first.fingerprint);
  });

  test('reset clears history, current sample and monotonic baseline', () => {
    let now = 100;
    const monitor = createServiceContainerHealthMonitor({ now: () => now });
    monitor.sample(snapshot());
    monitor.reset();
    now = 50;
    const afterReset = monitor.sample(snapshot());
    expect(afterReset.sequence).toBe(1);
    expect(afterReset.sampledAt).toBe(50);
    expect(monitor.snapshot().history).toHaveLength(1);
  });

  test('rejects non-finite clock values', () => {
    const monitor = createServiceContainerHealthMonitor({
      now: () => Number.NaN,
    });
    expect(() => monitor.sample(snapshot())).toThrow(RangeError);
  });

  test('rejects backward-moving clock values', () => {
    let now = 100;
    const monitor = createServiceContainerHealthMonitor({ now: () => now });
    monitor.sample(snapshot());
    now = 99;
    expect(() => monitor.sample(snapshot())).toThrow(RangeError);
  });

  test('captures fixed policy at construction', () => {
    const monitor = createServiceContainerHealthMonitor({
      policy: {
        slowStartMs: 5,
        slowStartWarningCount: 1,
        slowStartCriticalCount: 2,
      },
    });
    const sample = monitor.sample(snapshot([
      service('config', { startDurationMs: 6 }),
    ]));
    expect(sample.status).toBe('degraded');
    expect(sample.risks).toContainEqual(expect.objectContaining({
      code: 'slow-start',
    }));
  });

  test('does not retain service ids or error detail in health risk records', () => {
    const monitor = createServiceContainerHealthMonitor();
    const sample = monitor.sample(snapshot([
      service('private-service-name', {
        status: 'failed',
        failureCode: 'START_FAILED',
        errorName: 'PrivateError',
      }),
    ], {
      state: 'failed',
    }));
    const serializedRisks = JSON.stringify(sample.risks);
    expect(serializedRisks).not.toContain('private-service-name');
    expect(serializedRisks).not.toContain('PrivateError');
  });
});
