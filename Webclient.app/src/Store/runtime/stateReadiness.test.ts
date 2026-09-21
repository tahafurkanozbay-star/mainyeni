import { describe, expect, it } from 'vitest';
import type { StoreRuntimeSnapshot } from './contracts';
import { evaluateStoreReadiness } from './stateReadiness';

const snapshot = (
  overrides: Partial<StoreRuntimeSnapshot['health']> = {},
): StoreRuntimeSnapshot => ({
  generatedAt: 1,
  health: {
    initialized: true,
    disposed: false,
    dispatches: 1,
    changedTransitions: 1,
    noopTransitions: 0,
    failedTransitions: 0,
    subscriberCount: 0,
    subscriberErrors: 0,
    historyRetained: 1,
    invariantErrors: 0,
    invariantWarnings: 0,
    stateFingerprint: '12345678',
    lastActionType: 'x',
    ...overrides,
  },
  projection: null,
  invariants: null,
  history: {
    capacity: 10,
    retained: 0,
    totalRecorded: 0,
    dropped: 0,
    changed: 0,
    noop: 0,
    failed: 0,
    entries: [],
  },
});

describe('stateReadiness', () => {
  it('reports ready for a healthy initialized runtime', () => {
    expect(evaluateStoreReadiness(snapshot())).toEqual({
      status: 'ready',
      ready: true,
      reasons: [],
    });
  });

  it('blocks on state invariant errors', () => {
    const result = evaluateStoreReadiness(snapshot({ invariantErrors: 2 }));
    expect(result.status).toBe('blocked');
    expect(result.reasons[0]?.code).toBe('store-invariant-errors');
  });

  it('degrades on warnings, failed transitions or subscriber errors', () => {
    const result = evaluateStoreReadiness(snapshot({
      invariantWarnings: 1,
      failedTransitions: 2,
      subscriberErrors: 3,
    }));
    expect(result.status).toBe('degraded');
    expect(result.reasons.map((item) => item.code)).toEqual([
      'store-invariant-warnings',
      'store-transition-failures',
      'store-subscriber-errors',
    ]);
  });

  it('distinguishes uninitialized and disposed runtimes', () => {
    expect(evaluateStoreReadiness(snapshot({ initialized: false })).status).toBe('uninitialized');
    expect(evaluateStoreReadiness(snapshot({ disposed: true })).status).toBe('disposed');
  });
});
