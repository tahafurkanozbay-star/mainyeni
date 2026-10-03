import { describe, expect, it } from 'vitest';
import { RuntimeDeadlineRegistry, type RuntimeDeadlineRegistryOptions } from './runtimeDeadlineRegistry';

const options = (override: Partial<RuntimeDeadlineRegistryOptions> = {}): RuntimeDeadlineRegistryOptions => ({
  maxEntries: 4, maxEntriesPerScope: 3, maxTtlMs: 10_000, maxClaimMs: 1_000,
  maxScopes: 3, maxKeyLength: 40, maxScopeLength: 40, ...override,
});
const clock = () => { let now = 100; return { now: () => now, set: (value: number) => { now = value; } }; };

describe('RuntimeDeadlineRegistry', () => {
  it('admits bounded deadlines without retaining caller payloads', () => {
    const time = clock(); const registry = new RuntimeDeadlineRegistry(options(), time);
    expect(registry.schedule({ scope: 'map', key: 'refresh', dueAt: 200, expiresAt: 500 })).toMatchObject({ state: 'scheduled', generation: 1 });
    expect(registry.snapshot()).toMatchObject({ scheduled: 1, claimed: 0, scopes: 1, admitted: 1 });
  });

  it('rejects invalid options', () => {
    expect(() => new RuntimeDeadlineRegistry(options({ maxEntries: 0 }))).toThrow(RangeError);
    expect(() => new RuntimeDeadlineRegistry(options({ maxEntriesPerScope: 5 }))).toThrow(RangeError);
    expect(() => new RuntimeDeadlineRegistry(options({ maxClaimMs: 0 }))).toThrow(RangeError);
    expect(() => new RuntimeDeadlineRegistry(options({ maxScopes: 0 }))).toThrow(RangeError);
  });

  it('validates identifiers and intervals fail closed', () => {
    const time = clock(); const registry = new RuntimeDeadlineRegistry(options(), time);
    expect(() => registry.schedule({ scope: '', key: 'a', dueAt: 200, expiresAt: 300 })).toThrow(RangeError);
    expect(() => registry.schedule({ scope: 'map', key: 'bad key', dueAt: 200, expiresAt: 300 })).toThrow(RangeError);
    expect(() => registry.schedule({ scope: 'map', key: 'a', dueAt: 99, expiresAt: 300 })).toThrow(RangeError);
    expect(() => registry.schedule({ scope: 'map', key: 'a', dueAt: 300, expiresAt: 200 })).toThrow(RangeError);
    expect(() => registry.schedule({ scope: 'map', key: 'a', dueAt: 200, expiresAt: 20_000 })).toThrow(RangeError);
  });

  it('claims due work by priority then due time', () => {
    const time = clock(); const registry = new RuntimeDeadlineRegistry(options(), time);
    registry.schedule({ scope: 'a', key: 'background', dueAt: 150, expiresAt: 500, priority: 'background' });
    registry.schedule({ scope: 'a', key: 'critical', dueAt: 170, expiresAt: 500, priority: 'critical' });
    registry.schedule({ scope: 'a', key: 'interactive', dueAt: 140, expiresAt: 500, priority: 'interactive' });
    time.set(200);
    expect(registry.claimDue(3, 100).map(item => item.key)).toEqual(['critical', 'interactive', 'background']);
  });

  it('does not claim future work', () => {
    const time = clock(); const registry = new RuntimeDeadlineRegistry(options(), time);
    registry.schedule({ scope: 'a', key: 'later', dueAt: 500, expiresAt: 700 });
    time.set(499); expect(registry.claimDue(4, 100)).toEqual([]);
    time.set(500); expect(registry.claimDue(4, 100)).toHaveLength(1);
  });

  it('bounds claim batch size', () => {
    const time = clock(); const registry = new RuntimeDeadlineRegistry(options(), time);
    for (let index = 0; index < 3; index += 1) registry.schedule({ scope: 'a', key: `k${index}`, dueAt: 101, expiresAt: 900 });
    time.set(200); expect(registry.claimDue(2, 100)).toHaveLength(2); expect(registry.snapshot()).toMatchObject({ claimed: 2, scheduled: 1 });
  });

  it('rejects oversized claim duration', () => {
    const registry = new RuntimeDeadlineRegistry(options(), clock());
    expect(() => registry.claimDue(1, 1001)).toThrow(RangeError);
    expect(() => registry.claimDue(0, 1)).toThrow(RangeError);
  });

  it('releases stale claims back to scheduled state', () => {
    const time = clock(); const registry = new RuntimeDeadlineRegistry(options(), time);
    registry.schedule({ scope: 'a', key: 'job', dueAt: 100, expiresAt: 900 });
    const [claim] = registry.claimDue(1, 50); expect(claim).toBeDefined();
    time.set(151); expect(registry.sweep()).toBe(1); expect(registry.get('a', 'job')).toMatchObject({ state: 'scheduled', claimedUntil: null });
  });

  it('renews a live generation without extending past expiry', () => {
    const time = clock(); const registry = new RuntimeDeadlineRegistry(options(), time);
    registry.schedule({ scope: 'a', key: 'job', dueAt: 100, expiresAt: 250 });
    const [claim] = registry.claimDue(1, 100); expect(claim).toBeDefined();
    time.set(120); const renewed = claim ? registry.renew(claim, 1000) : null;
    expect(renewed?.claimedUntil).toBe(250);
  });

  it('rejects stale generation completion after replacement', () => {
    const time = clock(); const registry = new RuntimeDeadlineRegistry(options(), time);
    registry.schedule({ scope: 'a', key: 'job', dueAt: 100, expiresAt: 500 });
    const [claim] = registry.claimDue(1, 50); expect(claim).toBeDefined();
    time.set(151); registry.sweep(); registry.cancel('a', 'job');
    registry.schedule({ scope: 'a', key: 'job', dueAt: 200, expiresAt: 600 });
    expect(claim ? registry.complete(claim) : true).toBe(false);
    expect(registry.get('a', 'job')?.generation).toBe(2);
  });

  it('completes only the matching claimed generation', () => {
    const time = clock(); const registry = new RuntimeDeadlineRegistry(options(), time);
    registry.schedule({ scope: 'a', key: 'job', dueAt: 100, expiresAt: 500 });
    const [claim] = registry.claimDue(1, 100); expect(claim).toBeDefined();
    expect(claim ? registry.complete(claim) : false).toBe(true);
    expect(registry.get('a', 'job')).toBeNull(); expect(registry.snapshot().completed).toBe(1);
  });

  it('expires work at the explicit terminal deadline', () => {
    const time = clock(); const registry = new RuntimeDeadlineRegistry(options(), time);
    registry.schedule({ scope: 'a', key: 'job', dueAt: 120, expiresAt: 200 });
    time.set(200); expect(registry.sweep()).toBe(1); expect(registry.get('a', 'job')).toBeNull(); expect(registry.snapshot().expired).toBe(1);
  });

  it('enforces per-scope cardinality', () => {
    const registry = new RuntimeDeadlineRegistry(options({ maxEntriesPerScope: 2 }), clock());
    expect(registry.schedule({ scope: 'a', key: '1', dueAt: 200, expiresAt: 300 })).not.toBeNull();
    expect(registry.schedule({ scope: 'a', key: '2', dueAt: 200, expiresAt: 300 })).not.toBeNull();
    expect(registry.schedule({ scope: 'a', key: '3', dueAt: 200, expiresAt: 300 })).toBeNull();
    expect(registry.snapshot().rejected).toBe(1);
  });

  it('enforces scope cardinality', () => {
    const registry = new RuntimeDeadlineRegistry(options({ maxScopes: 2 }), clock());
    registry.schedule({ scope: 'a', key: '1', dueAt: 200, expiresAt: 300 });
    registry.schedule({ scope: 'b', key: '1', dueAt: 200, expiresAt: 300 });
    expect(registry.schedule({ scope: 'c', key: '1', dueAt: 200, expiresAt: 300 })).toBeNull();
  });

  it('evicts oldest lower-priority unclaimed work at global capacity', () => {
    const registry = new RuntimeDeadlineRegistry(options({ maxEntries: 2, maxEntriesPerScope: 2 }), clock());
    registry.schedule({ scope: 'a', key: 'old', dueAt: 200, expiresAt: 500, priority: 'background' });
    registry.schedule({ scope: 'a', key: 'new', dueAt: 210, expiresAt: 500, priority: 'interactive' });
    expect(registry.schedule({ scope: 'b', key: 'critical', dueAt: 220, expiresAt: 500, priority: 'critical' })).not.toBeNull();
    expect(registry.get('a', 'old')).toBeNull(); expect(registry.snapshot().evicted).toBe(1);
  });

  it('does not evict equal or higher priority work', () => {
    const registry = new RuntimeDeadlineRegistry(options({ maxEntries: 1, maxEntriesPerScope: 1 }), clock());
    registry.schedule({ scope: 'a', key: 'critical', dueAt: 200, expiresAt: 500, priority: 'critical' });
    expect(registry.schedule({ scope: 'b', key: 'interactive', dueAt: 200, expiresAt: 500, priority: 'interactive' })).toBeNull();
  });

  it('never evicts claimed work', () => {
    const time = clock(); const registry = new RuntimeDeadlineRegistry(options({ maxEntries: 1, maxEntriesPerScope: 1 }), time);
    registry.schedule({ scope: 'a', key: 'job', dueAt: 100, expiresAt: 500, priority: 'background' });
    registry.claimDue(1, 100);
    expect(registry.schedule({ scope: 'b', key: 'urgent', dueAt: 200, expiresAt: 500, priority: 'critical' })).toBeNull();
  });

  it('reschedules an unclaimed identity with a new generation', () => {
    const registry = new RuntimeDeadlineRegistry(options(), clock());
    const first = registry.schedule({ scope: 'a', key: 'job', dueAt: 200, expiresAt: 500 });
    const second = registry.schedule({ scope: 'a', key: 'job', dueAt: 300, expiresAt: 600, priority: 'critical' });
    expect(first?.generation).toBe(1); expect(second).toMatchObject({ generation: 2, dueAt: 300, priority: 'critical' });
    expect(registry.snapshot().admitted).toBe(1);
  });

  it('rejects replacement while identity is claimed', () => {
    const time = clock(); const registry = new RuntimeDeadlineRegistry(options(), time);
    registry.schedule({ scope: 'a', key: 'job', dueAt: 100, expiresAt: 500 }); registry.claimDue(1, 100);
    expect(registry.schedule({ scope: 'a', key: 'job', dueAt: 200, expiresAt: 600 })).toBeNull();
  });

  it('cancels one identity and updates scope accounting', () => {
    const registry = new RuntimeDeadlineRegistry(options(), clock());
    registry.schedule({ scope: 'a', key: '1', dueAt: 200, expiresAt: 300 });
    expect(registry.cancel('a', '1')).toBe(true); expect(registry.cancel('a', '1')).toBe(false);
    expect(registry.snapshot()).toMatchObject({ scheduled: 0, scopes: 0, cancelled: 1 });
  });

  it('cancels an entire scope deterministically', () => {
    const registry = new RuntimeDeadlineRegistry(options(), clock());
    registry.schedule({ scope: 'a', key: '1', dueAt: 200, expiresAt: 300 });
    registry.schedule({ scope: 'a', key: '2', dueAt: 200, expiresAt: 300 });
    registry.schedule({ scope: 'b', key: '1', dueAt: 200, expiresAt: 300 });
    expect(registry.cancelScope('a')).toBe(2); expect(registry.snapshot()).toMatchObject({ scheduled: 1, scopes: 1, cancelled: 2 });
  });

  it('returns frozen detached records and snapshots', () => {
    const registry = new RuntimeDeadlineRegistry(options(), clock());
    const record = registry.schedule({ scope: 'a', key: '1', dueAt: 200, expiresAt: 300 });
    expect(Object.isFrozen(record)).toBe(true); expect(Object.isFrozen(registry.snapshot())).toBe(true);
  });

  it('rejects non-finite clock values', () => {
    const registry = new RuntimeDeadlineRegistry(options(), { now: () => Number.NaN });
    expect(() => registry.schedule({ scope: 'a', key: '1', dueAt: 200, expiresAt: 300 })).toThrow(RangeError);
  });

  it('disposes idempotently and rejects subsequent operations', () => {
    const registry = new RuntimeDeadlineRegistry(options(), clock());
    registry.schedule({ scope: 'a', key: '1', dueAt: 200, expiresAt: 300 }); registry.dispose(); registry.dispose();
    expect(() => registry.schedule({ scope: 'a', key: '2', dueAt: 200, expiresAt: 300 })).toThrow(/disposed/u);
  });
});
