import { describe, expect, it } from 'vitest';
import { createDeadlineRegistry, normalizeDeadlinePolicy } from './deadlineRegistry';

describe('deadlineRegistry', () => {
  it('creates bounded deadline tokens', () => {
    const registry = createDeadlineRegistry({ defaultTimeoutMs: 100 }, () => 10);
    expect(registry.begin('query')).toEqual({
      id: 1,
      label: 'query',
      startedAt: 10,
      deadlineAt: 110,
      timeoutMs: 100,
    });
  });

  it('reports remaining time and expiration', () => {
    const registry = createDeadlineRegistry({ defaultTimeoutMs: 10 });
    const token = registry.begin('query', undefined, 0)!;
    expect(registry.remaining(token.id, 5)).toBe(5);
    expect(registry.expired(token.id, 9)).toBe(false);
    expect(registry.expired(token.id, 10)).toBe(true);
  });

  it('clamps timeout overrides to configured bounds', () => {
    const registry = createDeadlineRegistry({
      minimumTimeoutMs: 10,
      maximumTimeoutMs: 100,
      defaultTimeoutMs: 50,
    });
    expect(registry.begin('short', 1, 0)?.timeoutMs).toBe(10);
    expect(registry.begin('long', 1_000, 0)?.timeoutMs).toBe(100);
  });

  it('rejects empty labels and capacity overflow', () => {
    const registry = createDeadlineRegistry({ maxTracked: 1 });
    expect(registry.begin('   ')).toBeNull();
    expect(registry.begin('first')).not.toBeNull();
    expect(registry.begin('second')).toBeNull();
    expect(registry.snapshot()).toMatchObject({ rejected: 2 });
  });

  it('completes active deadlines once', () => {
    const registry = createDeadlineRegistry();
    const token = registry.begin('query', 100, 0)!;
    expect(registry.complete(token.id, 30)).toMatchObject({
      completed: true,
      completedAt: 30,
      expired: false,
    });
    registry.complete(token.id, 40);
    expect(registry.snapshot().completed).toBe(1);
  });

  it('sweeps expired deadlines exactly once', () => {
    const registry = createDeadlineRegistry({ defaultTimeoutMs: 10 });
    registry.begin('a', undefined, 0);
    registry.begin('b', undefined, 5);
    expect(registry.sweep(11)).toHaveLength(1);
    expect(registry.sweep(20)).toHaveLength(1);
    expect(registry.snapshot().expired).toBe(2);
  });

  it('does not classify completed work as expired', () => {
    const registry = createDeadlineRegistry({ defaultTimeoutMs: 10 });
    const token = registry.begin('a', undefined, 0)!;
    registry.complete(token.id, 5);
    expect(registry.expired(token.id, 20)).toBe(false);
    expect(registry.sweep(20)).toHaveLength(0);
  });

  it('clears completed tokens while retaining active ones', () => {
    const registry = createDeadlineRegistry();
    const done = registry.begin('done', 100, 0)!;
    registry.begin('active', 100, 0);
    registry.complete(done.id, 1);
    registry.clearCompleted();
    expect(registry.snapshot().deadlines).toHaveLength(1);
    expect(registry.snapshot().active).toBe(1);
  });

  it('normalizes inverted timeout bounds', () => {
    const policy = normalizeDeadlinePolicy({
      minimumTimeoutMs: 100,
      maximumTimeoutMs: 10,
      defaultTimeoutMs: 1,
    });
    expect(policy.maximumTimeoutMs).toBeGreaterThanOrEqual(policy.minimumTimeoutMs);
    expect(policy.defaultTimeoutMs).toBeGreaterThanOrEqual(policy.minimumTimeoutMs);
  });

  it('rejects unknown token operations', () => {
    const registry = createDeadlineRegistry();
    expect(() => registry.remaining(999)).toThrow('Unknown');
    expect(() => registry.complete(999)).toThrow('Unknown');
  });

  it('rejects operations after disposal', () => {
    const registry = createDeadlineRegistry();
    registry.dispose();
    expect(() => registry.snapshot()).toThrow('disposed');
    expect(() => registry.begin('a')).toThrow('disposed');
  });
});
