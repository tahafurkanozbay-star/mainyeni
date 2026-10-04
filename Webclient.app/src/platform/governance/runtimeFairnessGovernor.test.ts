import { describe, expect, it } from 'vitest';
import { RuntimeFairnessGovernor } from './runtimeFairnessGovernor';

const policy = {
  maxScopes: 3,
  maxQueuedGlobal: 6,
  maxQueuedPerScope: 3,
  maxCostPerRequest: 8,
  maxDeficitPerScope: 16,
  criticalQuantum: 8,
  interactiveQuantum: 4,
  backgroundQuantum: 2,
  requestTtlMs: 100,
  idleScopeTtlMs: 200,
  maxClockSkewMs: 5,
} as const;

function clock(initial = 1000) {
  let value = initial;
  return { now: () => value, set: (next: number) => { value = next; }, advance: (delta: number) => { value += delta; } };
}

describe('RuntimeFairnessGovernor', () => {
  it('queues detached scalar tickets and exposes aggregate diagnostics', () => {
    const c = clock(); const governor = new RuntimeFairnessGovernor(policy, c.now);
    const ticket = governor.enqueue({ scope: 'search', priority: 'interactive', cost: 3 });
    expect(ticket).toEqual(expect.objectContaining({ scope: 'search', priority: 'interactive', cost: 3 }));
    expect(Object.isFrozen(ticket)).toBe(true);
    expect(governor.snapshot()).toEqual(expect.objectContaining({ queued: 1, scopes: 1, interactive: 1, totalCost: 3, enqueued: 1 }));
  });

  it('rejects malformed scope, priority and cost', () => {
    const governor = new RuntimeFairnessGovernor(policy);
    expect(() => governor.enqueue({ scope: '', priority: 'critical', cost: 1 })).toThrow();
    expect(() => governor.enqueue({ scope: 'a/b', priority: 'critical', cost: 1 })).toThrow();
    expect(() => governor.enqueue({ scope: 'a', priority: 'unknown' as 'critical', cost: 1 })).toThrow();
    expect(() => governor.enqueue({ scope: 'a', priority: 'critical', cost: 0 })).toThrow();
    expect(() => governor.enqueue({ scope: 'a', priority: 'critical', cost: 9 })).toThrow();
  });

  it('enforces global and per-scope queue bounds', () => {
    const governor = new RuntimeFairnessGovernor({ ...policy, maxQueuedGlobal: 2, maxQueuedPerScope: 1 });
    expect(governor.enqueue({ scope: 'a', priority: 'critical', cost: 1 })).not.toBeNull();
    expect(governor.enqueue({ scope: 'a', priority: 'critical', cost: 1 })).toBeNull();
    expect(governor.enqueue({ scope: 'b', priority: 'critical', cost: 1 })).not.toBeNull();
    expect(governor.enqueue({ scope: 'c', priority: 'critical', cost: 1 })).toBeNull();
  });

  it('promotes affordable work deterministically across lexical scopes', () => {
    const governor = new RuntimeFairnessGovernor(policy);
    governor.enqueue({ scope: 'zeta', priority: 'critical', cost: 8 });
    governor.enqueue({ scope: 'alpha', priority: 'critical', cost: 8 });
    expect(governor.promote()?.scope).toBe('alpha');
    expect(governor.promote()?.scope).toBe('zeta');
  });

  it('uses weighted deficit so critical work becomes affordable sooner', () => {
    const governor = new RuntimeFairnessGovernor(policy);
    governor.enqueue({ scope: 'background', priority: 'background', cost: 4 });
    governor.enqueue({ scope: 'critical', priority: 'critical', cost: 8 });
    expect(governor.promote()?.scope).toBe('critical');
    expect(governor.promote()?.scope).toBe('background');
  });

  it('preserves FIFO inside a scope', () => {
    const governor = new RuntimeFairnessGovernor(policy);
    const first = governor.enqueue({ scope: 'same', priority: 'critical', cost: 1 })!;
    const second = governor.enqueue({ scope: 'same', priority: 'critical', cost: 1 })!;
    expect(governor.promote()?.id).toBe(first.id);
    expect(governor.promote()?.id).toBe(second.id);
  });

  it('expires stale queued work and releases queue capacity', () => {
    const c = clock(); const governor = new RuntimeFairnessGovernor({ ...policy, maxQueuedGlobal: 1, maxQueuedPerScope: 1 }, c.now);
    const ticket = governor.enqueue({ scope: 'a', priority: 'critical', cost: 1 })!;
    c.advance(100);
    expect(governor.sweep()).toBe(1);
    expect(governor.isQueued(ticket)).toBe(false);
    expect(governor.enqueue({ scope: 'b', priority: 'critical', cost: 1 })).not.toBeNull();
    expect(governor.snapshot().expired).toBe(1);
  });

  it('rejects forged tickets without mutating real work', () => {
    const governor = new RuntimeFairnessGovernor(policy);
    const ticket = governor.enqueue({ scope: 'a', priority: 'critical', cost: 2 })!;
    expect(governor.cancel({ ...ticket, cost: 1 })).toBe(false);
    expect(governor.isQueued(ticket)).toBe(true);
  });

  it('cancels valid work exactly once', () => {
    const governor = new RuntimeFairnessGovernor(policy);
    const ticket = governor.enqueue({ scope: 'a', priority: 'critical', cost: 1 })!;
    expect(governor.cancel(ticket)).toBe(true);
    expect(governor.cancel(ticket)).toBe(false);
  });

  it('invalidates stale handles after scope reset', () => {
    const governor = new RuntimeFairnessGovernor(policy);
    const ticket = governor.enqueue({ scope: 'a', priority: 'critical', cost: 1 })!;
    expect(governor.resetScope('a')).toBe(1);
    expect(governor.cancel(ticket)).toBe(false);
  });

  it('evicts oldest idle scope when scope cardinality is exhausted', () => {
    const c = clock(); const governor = new RuntimeFairnessGovernor({ ...policy, maxScopes: 2 }, c.now);
    const a = governor.enqueue({ scope: 'a', priority: 'critical', cost: 1 })!; governor.cancel(a);
    c.advance(1);
    const b = governor.enqueue({ scope: 'b', priority: 'critical', cost: 1 })!; governor.cancel(b);
    c.advance(1);
    expect(governor.enqueue({ scope: 'c', priority: 'critical', cost: 1 })).not.toBeNull();
    expect(governor.snapshot().scopes).toBe(2);
  });

  it('does not evict active scopes to admit new scope', () => {
    const governor = new RuntimeFairnessGovernor({ ...policy, maxScopes: 1 });
    governor.enqueue({ scope: 'a', priority: 'critical', cost: 1 });
    expect(governor.enqueue({ scope: 'b', priority: 'critical', cost: 1 })).toBeNull();
  });

  it('removes idle scopes after TTL', () => {
    const c = clock(); const governor = new RuntimeFairnessGovernor(policy, c.now);
    const ticket = governor.enqueue({ scope: 'a', priority: 'critical', cost: 1 })!; governor.cancel(ticket);
    c.advance(200);
    governor.sweep();
    expect(governor.snapshot().scopes).toBe(0);
  });

  it('tolerates bounded clock rollback monotonically', () => {
    const c = clock(); const governor = new RuntimeFairnessGovernor(policy, c.now);
    governor.enqueue({ scope: 'a', priority: 'critical', cost: 1 });
    c.advance(4); governor.snapshot(); c.set(1002);
    expect(() => governor.snapshot()).not.toThrow();
  });

  it('fails closed on excessive clock rollback', () => {
    const c = clock(); const governor = new RuntimeFairnessGovernor(policy, c.now);
    governor.snapshot(); c.advance(10); governor.snapshot(); c.set(1000);
    expect(() => governor.snapshot()).toThrow();
  });

  it('fails closed when clock is non-finite or negative', () => {
    expect(() => new RuntimeFairnessGovernor(policy, () => Number.NaN).snapshot()).toThrow();
    expect(() => new RuntimeFairnessGovernor(policy, () => -1).snapshot()).toThrow();
  });

  it('validates policy relationships', () => {
    expect(() => new RuntimeFairnessGovernor({ ...policy, maxQueuedGlobal: 1 })).toThrow();
    expect(() => new RuntimeFairnessGovernor({ ...policy, maxDeficitPerScope: 4 })).toThrow();
  });

  it('bounds deficit accumulation at policy maximum', () => {
    const governor = new RuntimeFairnessGovernor({ ...policy, maxCostPerRequest: 16 });
    governor.enqueue({ scope: 'a', priority: 'background', cost: 16 });
    for (let index = 0; index < 20; index += 1) governor.promote();
    expect(governor.snapshot().queued).toBe(0);
  });

  it('keeps snapshots payload-free and immutable', () => {
    const governor = new RuntimeFairnessGovernor(policy);
    governor.enqueue({ scope: 'private-scope', priority: 'critical', cost: 1 });
    const snapshot = governor.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('private-scope');
  });

  it('disposes terminally and invalidates tickets', () => {
    const governor = new RuntimeFairnessGovernor(policy);
    const ticket = governor.enqueue({ scope: 'a', priority: 'critical', cost: 1 })!;
    governor.dispose();
    expect(governor.cancel(ticket)).toBe(false);
    expect(() => governor.enqueue({ scope: 'b', priority: 'critical', cost: 1 })).toThrow();
  });
});
