import { describe, expect, it } from 'vitest';
import { RuntimeQuarantineRegistry } from './runtimeQuarantineRegistry';

describe('RuntimeQuarantineRegistry', () => {
  it('blocks active quarantine and permits bounded probation attempts', () => {
    const registry = new RuntimeQuarantineRegistry({ quarantineMs: 100, probationMs: 100, maxProbationAttempts: 2 });
    registry.quarantine('search', 'interactive', 'failure-budget', 10);
    expect(registry.mayAttempt('search', 50)).toBe(false);
    expect(registry.mayAttempt('search', 110)).toBe(true);
    expect(registry.mayAttempt('search', 120)).toBe(true);
    expect(registry.mayAttempt('search', 130)).toBe(false);
    expect(registry.snapshot().entries[0]?.probationAttempts).toBe(2);
  });

  it('releases an entry after the probation window expires', () => {
    const registry = new RuntimeQuarantineRegistry({ quarantineMs: 10, probationMs: 20 });
    registry.quarantine('tiles', 'background', 'overload', 0);
    expect(registry.mayAttempt('tiles', 31)).toBe(true);
    expect(registry.has('tiles')).toBe(false);
    expect(registry.snapshot().history.at(-1)?.type).toBe('release');
  });

  it('releases probation immediately after a healthy result', () => {
    const registry = new RuntimeQuarantineRegistry({ quarantineMs: 10, probationMs: 100 });
    registry.quarantine('identify', 'critical', 'failure-budget', 1);
    expect(registry.mayAttempt('identify', 11)).toBe(true);
    expect(registry.reportHealthy('identify', 12)).toBe(true);
    expect(registry.mayAttempt('identify', 13)).toBe(true);
  });

  it('refreshes quarantine without growing registry ownership', () => {
    const registry = new RuntimeQuarantineRegistry({ maxEntries: 1, quarantineMs: 50 });
    registry.quarantine('search', 'interactive', 'overload', 1);
    registry.quarantine('search', 'interactive', 'failure-budget', 2);
    expect(registry.snapshot()).toMatchObject({ size: 1, entries: [{ reason: 'failure-budget', eligibleAt: 52 }] });
  });

  it('evicts deterministically at configured capacity', () => {
    const registry = new RuntimeQuarantineRegistry({ maxEntries: 2 });
    registry.quarantine('a', 'background', 'overload', 1);
    registry.quarantine('b', 'interactive', 'failure-budget', 2);
    registry.quarantine('c', 'critical', 'operator', 3);
    expect(registry.has('a')).toBe(false);
    expect(registry.has('b')).toBe(true);
    expect(registry.has('c')).toBe(true);
    expect(registry.snapshot().history.some((event) => event.type === 'evict' && event.key === 'a')).toBe(true);
  });

  it('bounds immutable history', () => {
    const registry = new RuntimeQuarantineRegistry({ historyLimit: 2 });
    registry.quarantine('a', 'background', 'overload', 1);
    registry.quarantine('b', 'background', 'overload', 2);
    registry.release('a', 3);
    const snapshot = registry.snapshot();
    expect(snapshot.history).toHaveLength(2);
    expect(snapshot.history.map((event) => event.sequence)).toEqual([2, 3]);
    expect(Object.isFrozen(snapshot.history)).toBe(true);
    expect(Object.isFrozen(snapshot.history[0])).toBe(true);
  });

  it('clears only the requested lane', () => {
    const registry = new RuntimeQuarantineRegistry();
    registry.quarantine('critical-work', 'critical', 'operator', 1);
    registry.quarantine('background-work', 'background', 'overload', 2);
    expect(registry.clear('background').entries.map((entry) => entry.key)).toEqual(['critical-work']);
  });

  it('clears all state and restarts the caller clock', () => {
    const registry = new RuntimeQuarantineRegistry();
    registry.quarantine('work', 'critical', 'operator', 100);
    const cleared = registry.clear();
    expect(cleared.size).toBe(0);
    expect(cleared.history).toEqual([]);
    expect(() => registry.quarantine('new-work', 'critical', 'operator', 1)).not.toThrow();
  });

  it('rejects non-monotonic caller time', () => {
    const registry = new RuntimeQuarantineRegistry();
    registry.quarantine('work', 'interactive', 'overload', 100);
    expect(() => registry.mayAttempt('work', 99)).toThrow(/monotonic/);
    expect(() => registry.release('work', 98)).toThrow(/monotonic/);
  });

  it('rejects hostile keys and unsupported enum values', () => {
    const registry = new RuntimeQuarantineRegistry({ maxKeyLength: 4 });
    expect(() => registry.quarantine('', 'critical', 'operator', 0)).toThrow(/empty/);
    expect(() => registry.quarantine('12345', 'critical', 'operator', 0)).toThrow(/at most/);
    expect(() => registry.quarantine('ok', 'invalid' as never, 'operator', 0)).toThrow(/lane/);
    expect(() => registry.quarantine('ok', 'critical', 'invalid' as never, 0)).toThrow(/reason/);
  });

  it('rejects invalid policy values', () => {
    expect(() => new RuntimeQuarantineRegistry({ maxEntries: 0 })).toThrow(/maxEntries/);
    expect(() => new RuntimeQuarantineRegistry({ quarantineMs: Number.POSITIVE_INFINITY })).toThrow(/quarantineMs/);
    expect(() => new RuntimeQuarantineRegistry({ probationMs: -1 })).toThrow(/probationMs/);
    expect(() => new RuntimeQuarantineRegistry({ maxProbationAttempts: 1.5 })).toThrow(/maxProbationAttempts/);
  });

  it('keeps policy and snapshots immutable', () => {
    const registry = new RuntimeQuarantineRegistry({ maxEntries: 3 });
    registry.quarantine('work', 'critical', 'operator', 1);
    expect(Object.isFrozen(registry.policy())).toBe(true);
    const snapshot = registry.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.entries)).toBe(true);
    expect(Object.isFrozen(snapshot.entries[0])).toBe(true);
  });
});
