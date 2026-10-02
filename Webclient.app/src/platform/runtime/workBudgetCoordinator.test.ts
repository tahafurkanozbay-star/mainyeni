import { describe, expect, it } from 'vitest';
import {
  WorkBudgetCancelledError,
  WorkBudgetRejectedError,
  createWorkBudgetCoordinator,
} from './workBudgetCoordinator';

const policy = () => ({
  maxActive: 2,
  maxQueued: 8,
  maxUnits: 8,
  maxBytes: 1024,
  maxQueueAgeMs: 100,
  maxLeaseAgeMs: 200,
  maxScopes: 4,
  maxKeys: 16,
});

describe('createWorkBudgetCoordinator', () => {
  it('admits work within global cardinality, unit, and byte budgets', async () => {
    const coordinator = createWorkBudgetCoordinator(policy());
    const first = await coordinator.acquire({ key: 'a', units: 2, bytes: 100 });
    const second = await coordinator.acquire({ key: 'b', units: 3, bytes: 200 });
    expect(coordinator.snapshot()).toMatchObject({ active: 2, activeUnits: 5, activeBytes: 300, admitted: 2 });
    first.release();
    second.release();
    expect(coordinator.snapshot()).toMatchObject({ active: 0, completed: 2 });
  });

  it('queues work when active cardinality is saturated and pumps on release', async () => {
    const coordinator = createWorkBudgetCoordinator({ ...policy(), maxActive: 1 });
    const first = await coordinator.acquire({ key: 'first' });
    const pending = coordinator.acquire({ key: 'second' });
    expect(coordinator.snapshot()).toMatchObject({ active: 1, queued: 1 });
    first.release();
    const second = await pending;
    expect(second.key).toBe('second');
    expect(coordinator.snapshot()).toMatchObject({ active: 1, queued: 0, admitted: 2 });
    second.release();
  });

  it('orders queued work by priority while preserving FIFO inside a priority', async () => {
    const coordinator = createWorkBudgetCoordinator({ ...policy(), maxActive: 1 });
    const blocker = await coordinator.acquire({ key: 'blocker' });
    const background = coordinator.acquire({ key: 'background', priority: 'background' });
    const high = coordinator.acquire({ key: 'high', priority: 'high' });
    const critical = coordinator.acquire({ key: 'critical', priority: 'critical' });
    blocker.release();
    const criticalLease = await critical;
    expect(criticalLease.key).toBe('critical');
    criticalLease.release();
    const highLease = await high;
    expect(highLease.key).toBe('high');
    highLease.release();
    const backgroundLease = await background;
    backgroundLease.release();
  });

  it('allows a lower-cost candidate to bypass work that cannot currently fit', async () => {
    const coordinator = createWorkBudgetCoordinator({ ...policy(), maxActive: 3, maxUnits: 4 });
    const blocker = await coordinator.acquire({ key: 'blocker', units: 3 });
    const heavy = coordinator.acquire({ key: 'heavy', priority: 'high', units: 3 });
    const light = await coordinator.acquire({ key: 'light', priority: 'normal', units: 1 });
    expect(light.key).toBe('light');
    expect(coordinator.snapshot().queued).toBe(1);
    light.release();
    blocker.release();
    const heavyLease = await heavy;
    heavyLease.release();
  });

  it('enforces per-scope active cardinality', async () => {
    const coordinator = createWorkBudgetCoordinator({ ...policy(), maxActive: 4, scopeMaxActive: { map: 1 } });
    const first = await coordinator.acquire({ key: 'a', scope: 'map' });
    const pending = coordinator.acquire({ key: 'b', scope: 'map' });
    const other = await coordinator.acquire({ key: 'c', scope: 'search' });
    expect(coordinator.snapshot()).toMatchObject({ active: 2, queued: 1 });
    first.release();
    const second = await pending;
    second.release();
    other.release();
  });

  it('enforces per-scope unit budget independently of global budget', async () => {
    const coordinator = createWorkBudgetCoordinator({ ...policy(), maxActive: 4, scopeMaxUnits: { map: 3 } });
    const first = await coordinator.acquire({ key: 'a', scope: 'map', units: 2 });
    const pending = coordinator.acquire({ key: 'b', scope: 'map', units: 2 });
    const search = await coordinator.acquire({ key: 'c', scope: 'search', units: 2 });
    expect(coordinator.snapshot().scopes.map).toMatchObject({ active: 1, queued: 1, units: 2 });
    first.release();
    (await pending).release();
    search.release();
  });

  it('enforces per-scope byte budget independently of global budget', async () => {
    const coordinator = createWorkBudgetCoordinator({ ...policy(), maxActive: 4, scopeMaxBytes: { map: 300 } });
    const first = await coordinator.acquire({ key: 'a', scope: 'map', bytes: 200 });
    const pending = coordinator.acquire({ key: 'b', scope: 'map', bytes: 200 });
    expect(coordinator.snapshot().queued).toBe(1);
    first.release();
    (await pending).release();
  });

  it('rejects blank keys fail closed', async () => {
    const coordinator = createWorkBudgetCoordinator(policy());
    await expect(coordinator.acquire({ key: '   ' })).rejects.toBeInstanceOf(WorkBudgetRejectedError);
  });

  it('normalizes identifiers to bounded strings', async () => {
    const coordinator = createWorkBudgetCoordinator(policy());
    const lease = await coordinator.acquire({ key: `  ${'x'.repeat(200)}  `, scope: ` ${'s'.repeat(200)} ` });
    expect(lease.key).toHaveLength(128);
    expect(lease.scope).toHaveLength(128);
    lease.release();
  });

  it('clamps request units and bytes to global maxima', async () => {
    const coordinator = createWorkBudgetCoordinator(policy());
    const lease = await coordinator.acquire({ key: 'huge', units: 1000, bytes: 999999 });
    expect(lease.units).toBe(8);
    expect(lease.bytes).toBe(1024);
    lease.release();
  });

  it('normalizes invalid request costs to one', async () => {
    const coordinator = createWorkBudgetCoordinator(policy());
    const lease = await coordinator.acquire({ key: 'invalid', units: Number.NaN, bytes: -4 });
    expect(lease.units).toBe(1);
    expect(lease.bytes).toBe(1);
    lease.release();
  });

  it('rejects immediately aborted requests without retaining queue state', async () => {
    const coordinator = createWorkBudgetCoordinator(policy());
    const controller = new AbortController();
    controller.abort();
    await expect(coordinator.acquire({ key: 'aborted', signal: controller.signal })).rejects.toBeInstanceOf(WorkBudgetCancelledError);
    expect(coordinator.snapshot()).toMatchObject({ active: 0, queued: 0, cancelled: 1 });
  });

  it('propagates explicit abort reasons for already aborted requests', async () => {
    const coordinator = createWorkBudgetCoordinator(policy());
    const controller = new AbortController();
    const reason = new Error('caller stopped');
    controller.abort(reason);
    await expect(coordinator.acquire({ key: 'aborted', signal: controller.signal })).rejects.toBe(reason);
  });

  it('cancels queued work through AbortSignal and removes listener-backed state', async () => {
    const coordinator = createWorkBudgetCoordinator({ ...policy(), maxActive: 1 });
    const blocker = await coordinator.acquire({ key: 'blocker' });
    const controller = new AbortController();
    const pending = coordinator.acquire({ key: 'pending', signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(WorkBudgetCancelledError);
    expect(coordinator.snapshot()).toMatchObject({ queued: 0, cancelled: 1 });
    blocker.release();
  });

  it('supports predicate-based queued cancellation', async () => {
    const coordinator = createWorkBudgetCoordinator({ ...policy(), maxActive: 1 });
    const blocker = await coordinator.acquire({ key: 'blocker' });
    const first = coordinator.acquire({ key: 'first', scope: 'map' });
    const second = coordinator.acquire({ key: 'second', scope: 'search' });
    expect(coordinator.cancelQueued((request) => request.scope === 'map')).toBe(1);
    await expect(first).rejects.toBeInstanceOf(WorkBudgetCancelledError);
    blocker.release();
    (await second).release();
  });

  it('rejects new work when the queue is full', async () => {
    const coordinator = createWorkBudgetCoordinator({ ...policy(), maxActive: 1, maxQueued: 1 });
    const blocker = await coordinator.acquire({ key: 'blocker' });
    const pending = coordinator.acquire({ key: 'pending' });
    await expect(coordinator.acquire({ key: 'overflow' })).rejects.toBeInstanceOf(WorkBudgetRejectedError);
    expect(coordinator.snapshot().rejected).toBe(1);
    blocker.release();
    (await pending).release();
  });

  it('expires queued work by queue age', async () => {
    let clock = 0;
    const coordinator = createWorkBudgetCoordinator({ ...policy(), maxActive: 1 }, () => clock);
    const blocker = await coordinator.acquire({ key: 'blocker' });
    const pending = coordinator.acquire({ key: 'pending' });
    clock = 101;
    coordinator.sweep();
    await expect(pending).rejects.toBeInstanceOf(WorkBudgetRejectedError);
    expect(coordinator.snapshot().expiredQueued).toBe(1);
    blocker.release();
  });

  it('expires queued work by explicit deadline', async () => {
    let clock = 10;
    const coordinator = createWorkBudgetCoordinator({ ...policy(), maxActive: 1 }, () => clock);
    const blocker = await coordinator.acquire({ key: 'blocker' });
    const pending = coordinator.acquire({ key: 'pending', deadlineMs: 20 });
    clock = 21;
    coordinator.sweep();
    await expect(pending).rejects.toBeInstanceOf(WorkBudgetRejectedError);
    blocker.release();
  });

  it('expires stale active leases and admits queued work', async () => {
    let clock = 0;
    const coordinator = createWorkBudgetCoordinator({ ...policy(), maxActive: 1, maxQueueAgeMs: 1_000 }, () => clock);
    await coordinator.acquire({ key: 'stale' });
    const pending = coordinator.acquire({ key: 'next' });
    clock = 201;
    coordinator.sweep();
    const next = await pending;
    expect(coordinator.snapshot()).toMatchObject({ active: 1, expiredLeases: 1, admitted: 2 });
    next.release();
  });

  it('renews an active lease using the current clock', async () => {
    let clock = 0;
    const coordinator = createWorkBudgetCoordinator({ ...policy(), maxActive: 1 }, () => clock);
    const lease = await coordinator.acquire({ key: 'renewable' });
    clock = 150;
    expect(lease.renew()).toBe(true);
    clock = 250;
    coordinator.sweep();
    expect(coordinator.snapshot().active).toBe(1);
    lease.release();
  });

  it('does not renew released leases', async () => {
    const coordinator = createWorkBudgetCoordinator(policy());
    const lease = await coordinator.acquire({ key: 'released' });
    lease.release();
    expect(lease.renew()).toBe(false);
  });

  it('release is idempotent and completion is counted once', async () => {
    const coordinator = createWorkBudgetCoordinator(policy());
    const lease = await coordinator.acquire({ key: 'once' });
    lease.release();
    lease.release();
    expect(coordinator.snapshot().completed).toBe(1);
  });

  it('releases all active work for a normalized scope', async () => {
    const coordinator = createWorkBudgetCoordinator({ ...policy(), maxActive: 4 });
    await coordinator.acquire({ key: 'a', scope: ' map ' });
    await coordinator.acquire({ key: 'b', scope: 'map' });
    const other = await coordinator.acquire({ key: 'c', scope: 'search' });
    expect(coordinator.releaseScope(' map ')).toBe(2);
    expect(coordinator.snapshot()).toMatchObject({ active: 1, completed: 2 });
    other.release();
  });

  it('bounds distinct scope cardinality', async () => {
    const coordinator = createWorkBudgetCoordinator({ ...policy(), maxScopes: 2, maxActive: 4 });
    const a = await coordinator.acquire({ key: 'a', scope: 'one' });
    const b = await coordinator.acquire({ key: 'b', scope: 'two' });
    await expect(coordinator.acquire({ key: 'c', scope: 'three' })).rejects.toBeInstanceOf(WorkBudgetRejectedError);
    a.release();
    b.release();
  });

  it('bounds distinct key cardinality', async () => {
    const coordinator = createWorkBudgetCoordinator({ ...policy(), maxKeys: 2, maxActive: 4 });
    const a = await coordinator.acquire({ key: 'a' });
    const b = await coordinator.acquire({ key: 'b' });
    await expect(coordinator.acquire({ key: 'c' })).rejects.toBeInstanceOf(WorkBudgetRejectedError);
    a.release();
    b.release();
  });

  it('allows reuse of an admitted identity after release', async () => {
    const coordinator = createWorkBudgetCoordinator({ ...policy(), maxKeys: 1 });
    const first = await coordinator.acquire({ key: 'same' });
    first.release();
    const second = await coordinator.acquire({ key: 'same' });
    second.release();
  });

  it('produces detached scope snapshots', async () => {
    const coordinator = createWorkBudgetCoordinator(policy());
    const lease = await coordinator.acquire({ key: 'a', scope: 'map', units: 2, bytes: 40 });
    const snapshot = coordinator.snapshot();
    expect(snapshot.scopes.map).toEqual({ active: 1, queued: 0, units: 2, bytes: 40 });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.scopes)).toBe(true);
    expect(Object.isFrozen(snapshot.scopes.map)).toBe(true);
    lease.release();
    expect(snapshot.scopes.map.active).toBe(1);
  });

  it('does not expose request signals in snapshots', async () => {
    const coordinator = createWorkBudgetCoordinator(policy());
    const controller = new AbortController();
    const lease = await coordinator.acquire({ key: 'a', signal: controller.signal });
    expect(JSON.stringify(coordinator.snapshot())).not.toContain('signal');
    lease.release();
  });

  it('disposes queued and active state terminally', async () => {
    const coordinator = createWorkBudgetCoordinator({ ...policy(), maxActive: 1 });
    const active = await coordinator.acquire({ key: 'active' });
    const pending = coordinator.acquire({ key: 'pending' });
    coordinator.dispose();
    await expect(pending).rejects.toBeInstanceOf(WorkBudgetCancelledError);
    expect(coordinator.snapshot()).toMatchObject({ active: 0, queued: 0 });
    expect(active.renew()).toBe(false);
    await expect(coordinator.acquire({ key: 'after' })).rejects.toBeInstanceOf(WorkBudgetRejectedError);
  });

  it('dispose is idempotent', () => {
    const coordinator = createWorkBudgetCoordinator(policy());
    coordinator.dispose();
    coordinator.dispose();
    expect(coordinator.snapshot()).toMatchObject({ active: 0, queued: 0 });
  });

  it('uses safe defaults when policy values are invalid', async () => {
    const coordinator = createWorkBudgetCoordinator({
      maxActive: Number.NaN,
      maxQueued: -1,
      maxUnits: 0,
      maxBytes: Number.POSITIVE_INFINITY,
      maxQueueAgeMs: 0,
      maxLeaseAgeMs: -1,
      maxScopes: 0,
      maxKeys: 0,
    });
    const lease = await coordinator.acquire({ key: 'safe-defaults' });
    expect(lease.units).toBe(1);
    expect(coordinator.snapshot().active).toBe(1);
    lease.release();
  });
});