import { describe, expect, it } from 'vitest';
import { RuntimeResourceBudget, type ResourceLane } from './runtimeResourceBudget';

const MB = 1024 * 1024;

describe('RuntimeResourceBudget', () => {
  it('starts with empty immutable diagnostics', () => {
    const budget = new RuntimeResourceBudget({ maxBytes: 10 * MB, maxItemBytes: 5 * MB });
    const snapshot = budget.snapshot();
    expect(snapshot).toMatchObject({ items: 0, bytes: 0, remainingBytes: 10 * MB, admitted: 0, rejected: 0, released: 0 });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.lanes)).toBe(true);
    expect(Object.isFrozen(snapshot.history)).toBe(true);
  });

  it('accounts active resources by lane', () => {
    const budget = new RuntimeResourceBudget({ maxBytes: 20 * MB, maxItemBytes: 10 * MB, criticalReservedBytes: 2 * MB, interactiveReservedBytes: 2 * MB });
    budget.acquire('critical-a', 'critical', 2 * MB);
    budget.acquire('interactive-a', 'interactive', 3 * MB);
    budget.acquire('background-a', 'background', 4 * MB);
    expect(budget.snapshot()).toMatchObject({ items: 3, bytes: 9 * MB });
    expect(budget.snapshot().lanes.critical).toEqual({ items: 1, bytes: 2 * MB });
    expect(budget.snapshot().lanes.interactive).toEqual({ items: 1, bytes: 3 * MB });
    expect(budget.snapshot().lanes.background).toEqual({ items: 1, bytes: 4 * MB });
  });

  it('releases ownership idempotently', () => {
    const budget = new RuntimeResourceBudget({ maxBytes: 10 * MB, maxItemBytes: 5 * MB });
    const lease = budget.acquire('a', 'critical', MB).lease;
    expect(lease).not.toBeNull();
    lease?.release();
    lease?.release();
    expect(budget.snapshot()).toMatchObject({ items: 0, bytes: 0, admitted: 1, released: 1 });
  });

  it('rejects duplicate active ownership keys', () => {
    const budget = new RuntimeResourceBudget({ maxBytes: 10 * MB, maxItemBytes: 5 * MB });
    budget.acquire('same', 'critical', MB);
    expect(budget.acquire('same', 'critical', MB)).toMatchObject({ admitted: false, reason: 'duplicate', lease: null });
    expect(budget.snapshot().rejected).toBe(1);
  });

  it('allows a released key to be reacquired', () => {
    const budget = new RuntimeResourceBudget({ maxBytes: 10 * MB, maxItemBytes: 5 * MB });
    const first = budget.acquire('same', 'critical', MB);
    first.lease?.release();
    expect(budget.acquire('same', 'critical', MB).admitted).toBe(true);
  });

  it('rejects an item larger than the per-item budget', () => {
    const budget = new RuntimeResourceBudget({ maxBytes: 10 * MB, maxItemBytes: 2 * MB });
    expect(budget.acquire('huge', 'critical', 3 * MB)).toMatchObject({ admitted: false, reason: 'item-too-large' });
  });

  it('enforces the global byte budget', () => {
    const budget = new RuntimeResourceBudget({ maxBytes: 4 * MB, maxItemBytes: 4 * MB, criticalReservedBytes: 0, interactiveReservedBytes: 0 });
    expect(budget.acquire('a', 'critical', 3 * MB).admitted).toBe(true);
    expect(budget.acquire('b', 'critical', 2 * MB)).toMatchObject({ admitted: false, reason: 'global-capacity' });
  });

  it('enforces the global item budget', () => {
    const budget = new RuntimeResourceBudget({ maxBytes: 10 * MB, maxItems: 2, maxItemBytes: 5 * MB, criticalReservedBytes: 0, interactiveReservedBytes: 0 });
    budget.acquire('a', 'critical', 1);
    budget.acquire('b', 'critical', 1);
    expect(budget.acquire('c', 'critical', 1)).toMatchObject({ admitted: false, reason: 'global-capacity' });
  });

  it('preserves critical reserved capacity from interactive work', () => {
    const budget = new RuntimeResourceBudget({ maxBytes: 10 * MB, maxItemBytes: 10 * MB, criticalReservedBytes: 3 * MB, interactiveReservedBytes: 0 });
    expect(budget.acquire('interactive-a', 'interactive', 8 * MB)).toMatchObject({ admitted: false, reason: 'lane-capacity' });
    expect(budget.acquire('interactive-b', 'interactive', 7 * MB).admitted).toBe(true);
    expect(budget.acquire('critical-a', 'critical', 3 * MB).admitted).toBe(true);
  });

  it('preserves critical and interactive reserves from background work', () => {
    const budget = new RuntimeResourceBudget({ maxBytes: 10 * MB, maxItemBytes: 10 * MB, criticalReservedBytes: 2 * MB, interactiveReservedBytes: 3 * MB });
    expect(budget.acquire('background-a', 'background', 6 * MB)).toMatchObject({ admitted: false, reason: 'lane-capacity' });
    expect(budget.acquire('background-b', 'background', 5 * MB).admitted).toBe(true);
    expect(budget.acquire('interactive-a', 'interactive', 3 * MB).admitted).toBe(true);
    expect(budget.acquire('critical-a', 'critical', 2 * MB).admitted).toBe(true);
  });

  it('does not reserve lower-priority capacity from critical work', () => {
    const budget = new RuntimeResourceBudget({ maxBytes: 10 * MB, maxItemBytes: 10 * MB, criticalReservedBytes: 2 * MB, interactiveReservedBytes: 3 * MB });
    expect(budget.acquire('critical-a', 'critical', 10 * MB).admitted).toBe(true);
    expect(budget.snapshot().remainingBytes).toBe(0);
  });

  it('reports admission rejection and release history in sequence', () => {
    const budget = new RuntimeResourceBudget({ maxBytes: 4 * MB, maxItemBytes: 2 * MB, historySize: 4, criticalReservedBytes: 0, interactiveReservedBytes: 0 });
    const admitted = budget.acquire('a', 'critical', MB);
    budget.acquire('a', 'critical', MB);
    admitted.lease?.release();
    expect(budget.snapshot().history.map((event) => [event.sequence, event.type])).toEqual([[1, 'admit'], [2, 'reject'], [3, 'release']]);
  });

  it('bounds event history without affecting counters', () => {
    const budget = new RuntimeResourceBudget({ maxBytes: 10 * MB, maxItemBytes: 5 * MB, historySize: 2 });
    for (let index = 0; index < 4; index += 1) {
      const lease = budget.acquire(`key-${index}`, 'critical', 1).lease;
      lease?.release();
    }
    expect(budget.snapshot().history).toHaveLength(2);
    expect(budget.snapshot()).toMatchObject({ admitted: 4, released: 4 });
  });

  it('returns defensive frozen event copies', () => {
    const budget = new RuntimeResourceBudget({ maxBytes: 10 * MB, maxItemBytes: 5 * MB });
    budget.acquire('a', 'critical', 1);
    const event = budget.snapshot().history[0];
    expect(event).toBeDefined();
    expect(Object.isFrozen(event)).toBe(true);
  });

  it('reset invalidates existing lease ownership without double release', () => {
    const budget = new RuntimeResourceBudget({ maxBytes: 10 * MB, maxItemBytes: 5 * MB });
    const lease = budget.acquire('a', 'critical', MB).lease;
    budget.reset();
    lease?.release();
    expect(budget.snapshot()).toMatchObject({ items: 0, admitted: 0, rejected: 0, released: 0, history: [] });
  });

  it('reset allows old keys to be acquired under a fresh ownership epoch', () => {
    const budget = new RuntimeResourceBudget({ maxBytes: 10 * MB, maxItemBytes: 5 * MB });
    budget.acquire('a', 'critical', MB);
    budget.reset();
    expect(budget.acquire('a', 'critical', MB).admitted).toBe(true);
  });

  it.each(['', '   '] as const)('rejects invalid key %j', (key) => {
    const budget = new RuntimeResourceBudget();
    expect(() => budget.acquire(key, 'critical', 1)).toThrow(/non-empty string/);
  });

  it('rejects unsupported lanes at runtime', () => {
    const budget = new RuntimeResourceBudget();
    expect(() => budget.acquire('a', 'other' as ResourceLane, 1)).toThrow(/unsupported lane/);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid byte estimate %s', (bytes) => {
    const budget = new RuntimeResourceBudget();
    expect(() => budget.acquire('a', 'critical', bytes)).toThrow(/positive safe integer/);
  });

  it('rejects a per-item maximum larger than global capacity', () => {
    expect(() => new RuntimeResourceBudget({ maxBytes: 10, maxItemBytes: 11 })).toThrow(/cannot exceed/);
  });

  it('rejects reservations larger than global capacity', () => {
    expect(() => new RuntimeResourceBudget({ maxBytes: 10, maxItemBytes: 10, criticalReservedBytes: 6, interactiveReservedBytes: 5 })).toThrow(/reserved bytes/);
  });

  it('rejects invalid global and history bounds', () => {
    expect(() => new RuntimeResourceBudget({ maxBytes: 0 })).toThrow(/positive safe integer/);
    expect(() => new RuntimeResourceBudget({ maxItems: 0 })).toThrow(/positive safe integer/);
    expect(() => new RuntimeResourceBudget({ historySize: 0 })).toThrow(/positive safe integer/);
  });

  it('tracks remaining bytes after release', () => {
    const budget = new RuntimeResourceBudget({ maxBytes: 10 * MB, maxItemBytes: 5 * MB });
    const lease = budget.acquire('a', 'critical', 4 * MB).lease;
    expect(budget.snapshot().remainingBytes).toBe(6 * MB);
    lease?.release();
    expect(budget.snapshot().remainingBytes).toBe(10 * MB);
  });
});
