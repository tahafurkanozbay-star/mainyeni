import { describe, expect, it } from 'vitest';
import type {
  ResourceBudgetSnapshot,
  RuntimeBudget,
  RuntimePhase,
  SchedulerSnapshot,
} from './contracts';
import type { AdaptiveRuntimeSnapshot } from './adaptiveRuntimeControl';
import type { RuntimePressureLevel } from './pressureController';
import { createRuntimeHealthJournal } from './runtimeHealthJournal';
import { createRuntimeHealthCoordinator } from './runtimeHealthCoordinator';

const BUDGET: RuntimeBudget = Object.freeze({
  tier: 'balanced',
  maxConcurrentNetwork: 4,
  maxConcurrentCpu: 2,
  maxQueuedTasks: 10,
  maxCacheEntries: 20,
  maxCacheBytes: 1000,
  maxVisibleFeatures2d: 1000,
  maxVisibleFeatures3d: 500,
  maxGpuHeavyLayers: 2,
  frameBudgetMs: 12,
  backgroundSliceMs: 6,
  telemetryCapacity: 64,
});

const scheduler = (overrides: Partial<SchedulerSnapshot> = {}): SchedulerSnapshot => Object.freeze({
  active: 0,
  queued: 0,
  completed: 0,
  failed: 0,
  cancelled: 0,
  timedOut: 0,
  deduplicated: 0,
  rejected: 0,
  activeByKind: Object.freeze({ network: 0, cpu: 0, memory: 0, render: 0, storage: 0 }),
  queuedByPriority: Object.freeze({ critical: 0, high: 0, normal: 0, low: 0, background: 0 }),
  ...overrides,
});

const resources = (
  used: Partial<ResourceBudgetSnapshot['used']> = {},
  overrides: Partial<Pick<ResourceBudgetSnapshot, 'rejectedReservations' | 'expiredReservations'>> = {},
): ResourceBudgetSnapshot => Object.freeze({
  budget: BUDGET,
  used: Object.freeze({ network: 0, cpu: 0, memory: 0, render: 0, storage: 0, ...used }),
  available: Object.freeze({
    network: Math.max(0, BUDGET.maxConcurrentNetwork - (used.network ?? 0)),
    cpu: Math.max(0, BUDGET.maxConcurrentCpu - (used.cpu ?? 0)),
    memory: Math.max(0, BUDGET.maxCacheBytes - (used.memory ?? 0)),
    render: Math.max(0, BUDGET.maxGpuHeavyLayers - (used.render ?? 0)),
    storage: Math.max(0, BUDGET.maxCacheEntries - (used.storage ?? 0)),
  }),
  reservationCount: 0,
  rejectedReservations: overrides.rejectedReservations ?? 0,
  expiredReservations: overrides.expiredReservations ?? 0,
});

const adaptive = (
  level: RuntimePressureLevel = 'nominal',
  counters: Partial<{
    shed: number;
    expired: number;
    cancelled: number;
    pressureShed: number;
  }> = {},
): AdaptiveRuntimeSnapshot => Object.freeze({
  admission: Object.freeze({
    active: 0,
    queued: 0,
    activeCost: 0,
    admitted: 0,
    completed: 0,
    cancelled: counters.cancelled ?? 0,
    shed: counters.shed ?? 0,
    expired: counters.expired ?? 0,
    lanes: Object.freeze({}),
  }),
  pressure: Object.freeze({
    level,
    score: level === 'critical' ? 0.9 : level === 'high' ? 0.75 : level === 'elevated' ? 0.55 : 0.1,
    previousLevel: level,
    changed: false,
    recoveryStreak: 0,
    budget: BUDGET,
    reasons: Object.freeze([]),
  }),
  effectiveBudget: BUDGET,
  pressureShed: counters.pressureShed ?? 0,
  lastPressureShed: 0,
});

const sample = (
  phase: RuntimePhase = 'ready',
  level: RuntimePressureLevel = 'nominal',
  options: {
    readonly at?: number;
    readonly scheduler?: SchedulerSnapshot;
    readonly resources?: ResourceBudgetSnapshot;
    readonly adaptive?: AdaptiveRuntimeSnapshot;
  } = {},
) => ({
  ...(options.at === undefined ? {} : { at: options.at }),
  phase,
  adaptive: options.adaptive ?? adaptive(level),
  scheduler: options.scheduler ?? scheduler(),
  resources: options.resources ?? resources(),
});

describe('runtimeHealthCoordinator', () => {
  it('records initial lifecycle and pressure evidence once', () => {
    const coordinator = createRuntimeHealthCoordinator({ now: () => 100 });
    const first = coordinator.record(sample('ready', 'nominal', { at: 10 }));
    const second = coordinator.record(sample('ready', 'nominal', { at: 20 }));

    expect(first.health.events.map((event) => event.code)).toEqual([
      'phase-ready',
      'pressure-nominal',
    ]);
    expect(second.health.events.map((event) => event.code)).toEqual([
      'phase-ready',
      'pressure-nominal',
    ]);
    expect(second.samples).toBe(2);
    coordinator.dispose();
  });

  it('records degraded lifecycle and recovery transitions', () => {
    const coordinator = createRuntimeHealthCoordinator({ now: () => 100 });
    coordinator.record(sample('degraded', 'nominal', { at: 10 }));
    const recovered = coordinator.record(sample('ready', 'nominal', { at: 20 }));

    const codes = recovered.health.events.map((event) => event.code);
    expect(codes).toContain('phase-degraded');
    expect(codes).toContain('phase-ready');
    expect(codes).toContain('phase-recovered');
    expect(recovered.health.events.find((event) => event.code === 'phase-degraded')?.severity).toBe('warning');
    coordinator.dispose();
  });

  it('records failed lifecycle evidence as an error', () => {
    const coordinator = createRuntimeHealthCoordinator({ now: () => 100 });
    const snapshot = coordinator.record(sample('failed', 'nominal', { at: 10 }));
    expect(snapshot.health.events.find((event) => event.code === 'phase-failed')).toMatchObject({
      kind: 'lifecycle',
      severity: 'error',
    });
    coordinator.dispose();
  });

  it('records pressure escalation and explicit nominal recovery', () => {
    const coordinator = createRuntimeHealthCoordinator({ now: () => 100 });
    coordinator.record(sample('ready', 'nominal', { at: 10 }));
    coordinator.record(sample('ready', 'high', { at: 20 }));
    const recovered = coordinator.record(sample('ready', 'nominal', { at: 30 }));

    const codes = recovered.health.events.map((event) => event.code);
    expect(codes).toContain('pressure-high');
    expect(codes).toContain('pressure-recovered');
    expect(recovered.health.events.find((event) => event.code === 'pressure-high')?.severity).toBe('warning');
    coordinator.dispose();
  });

  it('records critical pressure with critical severity', () => {
    const coordinator = createRuntimeHealthCoordinator({ now: () => 100 });
    const snapshot = coordinator.record(sample('ready', 'critical', { at: 10 }));
    expect(snapshot.health.events.find((event) => event.code === 'pressure-critical')?.severity).toBe('critical');
    coordinator.dispose();
  });

  it('turns admission counter deltas into bounded health evidence', () => {
    const coordinator = createRuntimeHealthCoordinator({ now: () => 100 });
    coordinator.record(sample('ready', 'nominal', {
      at: 10,
      adaptive: adaptive('nominal', { shed: 2, expired: 1, cancelled: 3, pressureShed: 1 }),
    }));
    const snapshot = coordinator.record(sample('ready', 'nominal', {
      at: 20,
      adaptive: adaptive('nominal', { shed: 5, expired: 2, cancelled: 5, pressureShed: 4 }),
    }));

    const byCode = Object.fromEntries(snapshot.health.events.map((event) => [event.code, event.value]));
    expect(byCode['admission-shed']).toBe(3);
    expect(byCode['admission-expired']).toBe(1);
    expect(byCode['admission-cancelled']).toBe(2);
    expect(byCode['pressure-shed']).toBe(3);
    coordinator.dispose();
  });

  it('does not emit counter events on the first sample baseline', () => {
    const coordinator = createRuntimeHealthCoordinator({ now: () => 100 });
    const snapshot = coordinator.record(sample('ready', 'nominal', {
      at: 10,
      adaptive: adaptive('nominal', { shed: 9, expired: 4, cancelled: 2, pressureShed: 7 }),
    }));

    expect(snapshot.health.events.some((event) => event.code === 'admission-shed')).toBe(false);
    expect(snapshot.health.events.some((event) => event.code === 'pressure-shed')).toBe(false);
    coordinator.dispose();
  });

  it('records scheduler failure, timeout and rejection deltas', () => {
    const coordinator = createRuntimeHealthCoordinator({ now: () => 100 });
    coordinator.record(sample('ready', 'nominal', {
      at: 10,
      scheduler: scheduler({ failed: 1, timedOut: 2, rejected: 3 }),
    }));
    const snapshot = coordinator.record(sample('ready', 'nominal', {
      at: 20,
      scheduler: scheduler({ failed: 3, timedOut: 5, rejected: 7 }),
    }));

    const byCode = Object.fromEntries(snapshot.health.events.map((event) => [event.code, event.value]));
    expect(byCode['scheduler-failed']).toBe(2);
    expect(byCode['scheduler-timed-out']).toBe(3);
    expect(byCode['scheduler-rejected']).toBe(4);
    expect(snapshot.health.summary.failures).toBeGreaterThanOrEqual(2);
    coordinator.dispose();
  });

  it('records queue saturation only on threshold crossings', () => {
    const coordinator = createRuntimeHealthCoordinator({
      now: () => 100,
      policy: { queueWarningRatio: 0.7 },
    });
    coordinator.record(sample('ready', 'nominal', {
      at: 10,
      scheduler: scheduler({ queued: 6 }),
    }));
    coordinator.record(sample('ready', 'nominal', {
      at: 20,
      scheduler: scheduler({ queued: 8 }),
    }));
    const stillHigh = coordinator.record(sample('ready', 'nominal', {
      at: 30,
      scheduler: scheduler({ queued: 9 }),
    }));
    const recovered = coordinator.record(sample('ready', 'nominal', {
      at: 40,
      scheduler: scheduler({ queued: 2 }),
    }));

    expect(stillHigh.health.events.filter((event) => event.code === 'scheduler-queue-pressure')).toHaveLength(1);
    expect(recovered.health.events.filter((event) => event.code === 'scheduler-queue-recovered')).toHaveLength(1);
    expect(recovered.queuePressure).toBe(0.2);
    coordinator.dispose();
  });

  it('tracks resource pressure per kind and emits recovery transitions', () => {
    const coordinator = createRuntimeHealthCoordinator({
      now: () => 100,
      policy: { resourceWarningRatio: 0.75 },
    });
    coordinator.record(sample('ready', 'nominal', {
      at: 10,
      resources: resources({ network: 1, cpu: 0 }),
    }));
    const saturated = coordinator.record(sample('ready', 'nominal', {
      at: 20,
      resources: resources({ network: 4, cpu: 2 }),
    }));

    expect(saturated.saturatedResources).toEqual(['cpu', 'network']);
    expect(saturated.resourcePressure.network).toBe(1);
    expect(saturated.resourcePressure.cpu).toBe(1);

    const recovered = coordinator.record(sample('ready', 'nominal', {
      at: 30,
      resources: resources({ network: 0, cpu: 0 }),
    }));
    const codes = recovered.health.events.map((event) => event.code);
    expect(codes).toContain('resource-network-pressure');
    expect(codes).toContain('resource-cpu-pressure');
    expect(codes).toContain('resource-network-recovered');
    expect(codes).toContain('resource-cpu-recovered');
    coordinator.dispose();
  });

  it('records budget rejection and expiration deltas', () => {
    const coordinator = createRuntimeHealthCoordinator({ now: () => 100 });
    coordinator.record(sample('ready', 'nominal', {
      at: 10,
      resources: resources({}, { rejectedReservations: 1, expiredReservations: 2 }),
    }));
    const snapshot = coordinator.record(sample('ready', 'nominal', {
      at: 20,
      resources: resources({}, { rejectedReservations: 4, expiredReservations: 5 }),
    }));

    const byCode = Object.fromEntries(snapshot.health.events.map((event) => [event.code, event.value]));
    expect(byCode['budget-rejected']).toBe(3);
    expect(byCode['budget-expired']).toBe(3);
    coordinator.dispose();
  });

  it('normalizes a non-finite sample timestamp through the injected clock', () => {
    const coordinator = createRuntimeHealthCoordinator({ now: () => 777 });
    const snapshot = coordinator.record(sample('ready', 'nominal', { at: Number.NaN }));
    expect(snapshot.health.events[0]?.at).toBe(777);
    coordinator.dispose();
  });

  it('keeps the journal bounded when supplied with a small capacity', () => {
    const journal = createRuntimeHealthJournal({ capacity: 4 }, () => 1_000);
    const coordinator = createRuntimeHealthCoordinator({ journal, now: () => 1_000 });

    coordinator.record(sample('ready', 'nominal', { at: 10 }));
    coordinator.record(sample('degraded', 'high', { at: 20 }));
    coordinator.record(sample('ready', 'critical', { at: 30 }));
    coordinator.record(sample('ready', 'nominal', { at: 40 }));

    const snapshot = coordinator.snapshot();
    expect(snapshot.health.events.length).toBeLessThanOrEqual(4);
    expect(snapshot.health.summary.dropped).toBeGreaterThan(0);

    coordinator.dispose();
    expect(() => journal.summary()).not.toThrow();
    journal.dispose();
  });

  it('resetBaselines allows a fresh phase and pressure checkpoint without clearing history', () => {
    const coordinator = createRuntimeHealthCoordinator({ now: () => 100 });
    coordinator.record(sample('ready', 'nominal', { at: 10 }));
    const before = coordinator.snapshot().health.summary.total;

    coordinator.resetBaselines();
    const after = coordinator.record(sample('ready', 'nominal', { at: 20 }));

    expect(after.health.summary.total).toBe(before + 2);
    expect(after.samples).toBe(2);
    coordinator.dispose();
  });

  it('resetBaselines clears derived saturation state', () => {
    const coordinator = createRuntimeHealthCoordinator({
      now: () => 100,
      policy: { resourceWarningRatio: 0.5, queueWarningRatio: 0.5 },
    });
    coordinator.record(sample('ready', 'high', {
      at: 10,
      scheduler: scheduler({ queued: 10 }),
      resources: resources({ network: 4 }),
    }));

    coordinator.resetBaselines();
    const snapshot = coordinator.snapshot();
    expect(snapshot.phase).toBeNull();
    expect(snapshot.pressureLevel).toBeNull();
    expect(snapshot.queuePressure).toBe(0);
    expect(snapshot.saturatedResources).toEqual([]);
    coordinator.dispose();
  });

  it('does not duplicate resource pressure events while a resource stays saturated', () => {
    const coordinator = createRuntimeHealthCoordinator({
      now: () => 100,
      policy: { resourceWarningRatio: 0.5 },
    });
    coordinator.record(sample('ready', 'nominal', {
      at: 10,
      resources: resources({ network: 4 }),
    }));
    const snapshot = coordinator.record(sample('ready', 'nominal', {
      at: 20,
      resources: resources({ network: 3 }),
    }));

    expect(snapshot.health.events.filter((event) => event.code === 'resource-network-pressure')).toHaveLength(1);
    coordinator.dispose();
  });

  it('exposes immutable derived snapshots', () => {
    const coordinator = createRuntimeHealthCoordinator({ now: () => 100 });
    const snapshot = coordinator.record(sample('ready', 'nominal', { at: 10 }));

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.resourcePressure)).toBe(true);
    expect(Object.isFrozen(snapshot.saturatedResources)).toBe(true);
    coordinator.dispose();
  });

  it('is idempotently disposable and rejects later reads or writes', () => {
    const coordinator = createRuntimeHealthCoordinator({ now: () => 100 });
    coordinator.record(sample('ready', 'nominal', { at: 10 }));
    coordinator.dispose();
    coordinator.dispose();

    expect(() => coordinator.snapshot()).toThrow('disposed');
    expect(() => coordinator.record(sample('ready', 'nominal'))).toThrow('disposed');
    expect(() => coordinator.resetBaselines()).toThrow('disposed');
  });
});
