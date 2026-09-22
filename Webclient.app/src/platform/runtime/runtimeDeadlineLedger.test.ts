import { describe, expect, it } from 'vitest';
import { RuntimeDeadlineLedger } from './runtimeDeadlineLedger';

describe('RuntimeDeadlineLedger', () => {
  it('creates an immutable caller-clocked lease', () => {
    const ledger = new RuntimeDeadlineLedger();
    const lease = ledger.create({ key: 'request:a', lane: 'critical', nowMs: 100, timeoutMs: 50 });
    expect(lease).not.toBeNull();
    expect(lease).toMatchObject({ key: 'request:a', lane: 'critical', createdAtMs: 100, deadlineMs: 150, timeoutMs: 50 });
    expect(Object.isFrozen(lease)).toBe(true);
    expect(lease?.remainingMs(120)).toBe(30);
    expect(lease?.expired(149)).toBe(false);
    expect(lease?.expired(150)).toBe(true);
  });

  it('propagates the tighter parent deadline', () => {
    const ledger = new RuntimeDeadlineLedger();
    const lease = ledger.create({ key: 'child', lane: 'interactive', nowMs: 1_000, timeoutMs: 500, parentDeadlineMs: 1_200 });
    expect(lease).toMatchObject({ deadlineMs: 1_200, timeoutMs: 200 });
  });

  it('rejects an already exhausted parent deadline', () => {
    const ledger = new RuntimeDeadlineLedger();
    expect(ledger.create({ key: 'child', lane: 'interactive', nowMs: 1_000, timeoutMs: 500, parentDeadlineMs: 1_000 })).toBeNull();
    expect(ledger.snapshot()).toMatchObject({ active: 0, created: 0, rejected: 1 });
  });

  it('caps hostile timeout configuration and requests', () => {
    const ledger = new RuntimeDeadlineLedger({ maxTimeoutMs: 9_000_000 });
    const lease = ledger.create({ key: 'bounded', lane: 'background', nowMs: 0, timeoutMs: 99_000_000 });
    expect(lease?.timeoutMs).toBe(300_000);
    expect(lease?.deadlineMs).toBe(300_000);
  });

  it('rejects zero timeout without allocating', () => {
    const ledger = new RuntimeDeadlineLedger();
    expect(ledger.create({ key: 'zero', lane: 'critical', nowMs: 0, timeoutMs: 0 })).toBeNull();
    expect(ledger.snapshot()).toMatchObject({ active: 0, rejected: 1 });
  });

  it('rejects duplicate ownership keys', () => {
    const ledger = new RuntimeDeadlineLedger();
    expect(ledger.create({ key: 'same', lane: 'critical', nowMs: 0, timeoutMs: 100 })).not.toBeNull();
    expect(ledger.create({ key: 'same', lane: 'background', nowMs: 0, timeoutMs: 100 })).toBeNull();
    expect(ledger.snapshot()).toMatchObject({ active: 1, created: 1, rejected: 1 });
  });

  it('enforces bounded active capacity', () => {
    const ledger = new RuntimeDeadlineLedger({ maxEntries: 2 });
    expect(ledger.create({ key: 'a', lane: 'critical', nowMs: 0, timeoutMs: 100 })).not.toBeNull();
    expect(ledger.create({ key: 'b', lane: 'interactive', nowMs: 0, timeoutMs: 100 })).not.toBeNull();
    expect(ledger.create({ key: 'c', lane: 'background', nowMs: 0, timeoutMs: 100 })).toBeNull();
    expect(ledger.snapshot()).toMatchObject({ active: 2, rejected: 1 });
  });

  it('sweeps expired entries before capacity rejection', () => {
    const ledger = new RuntimeDeadlineLedger({ maxEntries: 1 });
    expect(ledger.create({ key: 'old', lane: 'background', nowMs: 0, timeoutMs: 10 })).not.toBeNull();
    expect(ledger.create({ key: 'new', lane: 'critical', nowMs: 10, timeoutMs: 10 })).not.toBeNull();
    expect(ledger.snapshot()).toMatchObject({ active: 1, created: 2, expired: 1, rejected: 0 });
  });

  it('completes a lease exactly once', () => {
    const ledger = new RuntimeDeadlineLedger();
    const lease = ledger.create({ key: 'once', lane: 'critical', nowMs: 10, timeoutMs: 100 });
    expect(lease?.complete(20)).toBe(true);
    expect(lease?.complete(21)).toBe(false);
    expect(ledger.snapshot()).toMatchObject({ active: 0, completed: 1, expired: 0 });
  });

  it('classifies late completion as expiry', () => {
    const ledger = new RuntimeDeadlineLedger();
    const lease = ledger.create({ key: 'late', lane: 'critical', nowMs: 10, timeoutMs: 10 });
    expect(lease?.complete(20)).toBe(true);
    expect(ledger.snapshot()).toMatchObject({ active: 0, completed: 0, expired: 1 });
    expect(ledger.snapshot().history.at(-1)?.outcome).toBe('expired');
  });

  it('releases ownership without treating it as success', () => {
    const ledger = new RuntimeDeadlineLedger();
    ledger.create({ key: 'cancelled', lane: 'interactive', nowMs: 10, timeoutMs: 100 });
    expect(ledger.release('cancelled', 20)).toBe(true);
    expect(ledger.release('cancelled', 21)).toBe(false);
    expect(ledger.snapshot()).toMatchObject({ active: 0, released: 1, completed: 0 });
  });

  it('classifies release at the deadline as expiry', () => {
    const ledger = new RuntimeDeadlineLedger();
    ledger.create({ key: 'late-release', lane: 'background', nowMs: 0, timeoutMs: 5 });
    expect(ledger.release('late-release', 5)).toBe(true);
    expect(ledger.snapshot()).toMatchObject({ expired: 1, released: 0 });
  });

  it('get lazily expires an overdue entry', () => {
    const ledger = new RuntimeDeadlineLedger();
    ledger.create({ key: 'lookup', lane: 'critical', nowMs: 0, timeoutMs: 5 });
    expect(ledger.get('lookup', 5)).toBeNull();
    expect(ledger.snapshot()).toMatchObject({ active: 0, expired: 1 });
  });

  it('sweeps every expired entry deterministically', () => {
    const ledger = new RuntimeDeadlineLedger();
    ledger.create({ key: 'a', lane: 'critical', nowMs: 0, timeoutMs: 5 });
    ledger.create({ key: 'b', lane: 'interactive', nowMs: 0, timeoutMs: 10 });
    ledger.create({ key: 'c', lane: 'background', nowMs: 0, timeoutMs: 15 });
    expect(ledger.sweep(10)).toBe(2);
    expect(ledger.snapshot()).toMatchObject({ active: 1, expired: 2 });
    expect(ledger.snapshot().byLane).toEqual({ critical: 0, interactive: 0, background: 1 });
  });

  it('requires a monotonic caller clock', () => {
    const ledger = new RuntimeDeadlineLedger();
    ledger.create({ key: 'clock', lane: 'critical', nowMs: 100, timeoutMs: 10 });
    expect(() => ledger.sweep(99)).toThrow(RangeError);
    expect(() => ledger.get('clock', 50)).toThrow(RangeError);
  });

  it('rejects malformed numeric inputs', () => {
    const ledger = new RuntimeDeadlineLedger();
    expect(() => ledger.create({ key: 'nan', lane: 'critical', nowMs: Number.NaN, timeoutMs: 10 })).toThrow(RangeError);
    expect(() => new RuntimeDeadlineLedger({ maxEntries: 0 })).toThrow(RangeError);
    expect(() => new RuntimeDeadlineLedger({ maxEntries: 1.5 })).toThrow(RangeError);
    expect(() => new RuntimeDeadlineLedger({ maxTimeoutMs: 0 })).toThrow(RangeError);
    expect(() => new RuntimeDeadlineLedger({ maxHistory: 0 })).toThrow(RangeError);
  });

  it('rejects empty keys', () => {
    const ledger = new RuntimeDeadlineLedger();
    expect(() => ledger.create({ key: '   ', lane: 'critical', nowMs: 0, timeoutMs: 10 })).toThrow(TypeError);
  });

  it('bounds history while preserving aggregate counters', () => {
    const ledger = new RuntimeDeadlineLedger({ maxHistory: 2 });
    for (let index = 0; index < 4; index += 1) {
      const lease = ledger.create({ key: `item:${index}`, lane: 'critical', nowMs: index * 2, timeoutMs: 100 });
      expect(lease?.complete(index * 2 + 1)).toBe(true);
    }
    const snapshot = ledger.snapshot();
    expect(snapshot).toMatchObject({ active: 0, created: 4, completed: 4 });
    expect(snapshot.history).toHaveLength(2);
    expect(snapshot.history.map(item => item.key)).toEqual(['item:2', 'item:3']);
  });

  it('returns deeply immutable diagnostics', () => {
    const ledger = new RuntimeDeadlineLedger();
    const lease = ledger.create({ key: 'immutable', lane: 'critical', nowMs: 0, timeoutMs: 10 });
    lease?.complete(1);
    const snapshot = ledger.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.byLane)).toBe(true);
    expect(Object.isFrozen(snapshot.history)).toBe(true);
    expect(Object.isFrozen(snapshot.history[0])).toBe(true);
  });

  it('does not own timers or asynchronous work', () => {
    const ledger = new RuntimeDeadlineLedger();
    const lease = ledger.create({ key: 'sync', lane: 'background', nowMs: 0, timeoutMs: 100 });
    expect(lease?.remainingMs(10)).toBe(90);
    expect(ledger.snapshot().active).toBe(1);
    expect(ledger.sweep(99)).toBe(0);
    expect(ledger.sweep(100)).toBe(1);
  });
});
