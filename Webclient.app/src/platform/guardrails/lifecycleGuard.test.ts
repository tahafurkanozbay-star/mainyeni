import { describe, expect, it } from 'vitest';
import { createLifecycleGuard, normalizeLifecycleGuardPolicy } from './lifecycleGuard';

describe('lifecycleGuard', () => {
  it('acquires and releases a resource for one owner', () => {
    const guard = createLifecycleGuard();
    expect(guard.acquire('layer:1', 'map').acquired).toBe(true);
    const released = guard.release('layer:1', 'map', 10);
    expect(released).toMatchObject({ state: 'released', ownerCount: 0, releasedAt: 10 });
    expect(guard.snapshot()).toMatchObject({ active: 0, released: 1 });
  });

  it('supports multiple owners without premature release', () => {
    const guard = createLifecycleGuard({ maxOwnersPerResource: 2 });
    guard.acquire('resource', 'owner-a', 'layer', 1);
    guard.acquire('resource', 'owner-b', 'layer', 2);
    const firstRelease = guard.release('resource', 'owner-a', 3);
    expect(firstRelease.state).toBe('active');
    expect(firstRelease.ownerCount).toBe(1);
    expect(guard.snapshot().active).toBe(1);
  });

  it('deduplicates repeat acquire by the same owner', () => {
    const guard = createLifecycleGuard();
    guard.acquire('resource', 'owner', 'layer', 1);
    guard.acquire('resource', 'owner', 'layer', 2);
    expect(guard.snapshot().resources[0]?.ownerCount).toBe(1);
    expect(guard.snapshot().resources[0]?.lastTouchedAt).toBe(2);
  });

  it('enforces owner capacity per resource', () => {
    const guard = createLifecycleGuard({ maxOwnersPerResource: 1 });
    guard.acquire('resource', 'a');
    const rejected = guard.acquire('resource', 'b');
    expect(rejected).toMatchObject({ acquired: false, reason: 'owner-capacity' });
    expect(guard.snapshot().rejected).toBe(1);
  });

  it('enforces tracked resource capacity', () => {
    const guard = createLifecycleGuard({ maxTrackedResources: 1 });
    guard.acquire('one', 'a');
    expect(guard.acquire('two', 'b')).toMatchObject({
      acquired: false,
      reason: 'resource-capacity',
    });
  });

  it('rejects empty identities', () => {
    const guard = createLifecycleGuard();
    expect(guard.acquire('', 'owner').acquired).toBe(false);
    expect(guard.acquire('resource', ' ').acquired).toBe(false);
  });

  it('touches only resources held by the owner', () => {
    const guard = createLifecycleGuard();
    guard.acquire('resource', 'a', 'layer', 1);
    expect(guard.touch('resource', 'a', 20).lastTouchedAt).toBe(20);
    expect(() => guard.touch('resource', 'b', 30)).toThrow('Owner');
  });

  it('releases every resource held by a specific owner', () => {
    const guard = createLifecycleGuard();
    guard.acquire('one', 'owner', 'layer', 1);
    guard.acquire('two', 'owner', 'layer', 2);
    const released = guard.releaseOwner('owner', 10);
    expect(released).toHaveLength(2);
    expect(guard.snapshot()).toMatchObject({ active: 0, released: 2 });
  });

  it('preserves shared resources after releaseOwner', () => {
    const guard = createLifecycleGuard();
    guard.acquire('shared', 'a', 'layer', 1);
    guard.acquire('shared', 'b', 'layer', 1);
    guard.releaseOwner('a', 2);
    expect(guard.snapshot().active).toBe(1);
    expect(guard.snapshot().resources[0]?.ownerCount).toBe(1);
  });

  it('marks inactive resources stale during sweep', () => {
    const guard = createLifecycleGuard({ staleAfterMs: 10 });
    guard.acquire('stale-resource', 'owner', 'layer', 0);
    const swept = guard.sweep(11);
    expect(swept).toHaveLength(1);
    expect(swept[0]?.state).toBe('stale');
    expect(guard.snapshot()).toMatchObject({ active: 0, stale: 1 });
  });

  it('does not sweep within the staleness window', () => {
    const guard = createLifecycleGuard({ staleAfterMs: 10 });
    guard.acquire('active-resource', 'owner', 'layer', 0);
    expect(guard.sweep(10)).toHaveLength(0);
    expect(guard.snapshot().active).toBe(1);
  });

  it('bounds terminal history', () => {
    const guard = createLifecycleGuard({ maxHistory: 2 });
    for (let index = 0; index < 4; index += 1) {
      const id = 'r' + index;
      guard.acquire(id, 'owner', 'layer', index * 2);
      guard.release(id, 'owner', index * 2 + 1);
    }
    expect(guard.snapshot().resources).toHaveLength(2);
    expect(guard.snapshot().released).toBe(2);
  });

  it('normalizes invalid policy values', () => {
    const policy = normalizeLifecycleGuardPolicy({
      maxTrackedResources: -1,
      maxOwnersPerResource: Number.NaN,
      staleAfterMs: 0,
    });
    expect(policy.maxTrackedResources).toBeGreaterThan(0);
    expect(policy.maxOwnersPerResource).toBeGreaterThan(0);
    expect(policy.staleAfterMs).toBeGreaterThan(0);
  });

  it('rejects operations after disposal', () => {
    const guard = createLifecycleGuard();
    guard.dispose();
    expect(() => guard.snapshot()).toThrow('disposed');
    expect(() => guard.acquire('resource', 'owner')).toThrow('disposed');
  });
});
