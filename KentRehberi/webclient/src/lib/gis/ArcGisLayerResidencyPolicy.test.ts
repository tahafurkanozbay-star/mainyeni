import { describe, expect, it } from 'vitest';
import { ArcGisLayerResidencyPolicy, type ArcGisResidencyDescriptor } from './ArcGisLayerResidencyPolicy';

const budget = { maxLayers: 4, maxResidentLayers: 2, maxResidentBytes: 1000, maxWarmingLayers: 2, warmLeaseMs: 100 };
const layer = (layerId: string, overrides: Partial<ArcGisResidencyDescriptor> = {}): ArcGisResidencyDescriptor => ({ layerId, revision: 1, tier: 'interactive', estimatedBytes: 100, visible: true, interactive: true, ...overrides });

describe('ArcGisLayerResidencyPolicy', () => {
  it('registers immutable cold entries', () => {
    const policy = new ArcGisLayerResidencyPolicy(budget);
    const entry = policy.register(layer('a'));
    expect(entry.state).toBe('cold');
    expect(Object.isFrozen(entry)).toBe(true);
  });

  it('rejects stale revisions and revision collisions', () => {
    const policy = new ArcGisLayerResidencyPolicy(budget);
    policy.register(layer('a', { revision: 2 }));
    expect(() => policy.register(layer('a', { revision: 1 }))).toThrow(/stale/);
    expect(() => policy.register(layer('a', { revision: 2, estimatedBytes: 101 }))).toThrow(/collision/);
  });

  it('permits idempotent registration for an identical revision', () => {
    const policy = new ArcGisLayerResidencyPolicy(budget);
    const first = policy.register(layer('a'));
    expect(policy.register(layer('a'))).toBe(first);
  });

  it('enforces cardinality budget', () => {
    const policy = new ArcGisLayerResidencyPolicy({ ...budget, maxLayers: 2, maxResidentLayers: 2, maxWarmingLayers: 2 });
    policy.register(layer('a')); policy.register(layer('b'));
    expect(() => policy.register(layer('c'))).toThrow(/cardinality/);
  });

  it('enforces per-layer byte budget', () => {
    const policy = new ArcGisLayerResidencyPolicy(budget);
    expect(() => policy.register(layer('a', { estimatedBytes: 1001 }))).toThrow(/byte budget/);
  });

  it('enforces warming concurrency', () => {
    const policy = new ArcGisLayerResidencyPolicy({ ...budget, maxWarmingLayers: 1 });
    policy.register(layer('a')); policy.register(layer('b'));
    policy.beginWarm('a', 1, 10);
    expect(() => policy.beginWarm('b', 1, 10)).toThrow(/warming concurrency/);
  });

  it('expires warm leases deterministically', () => {
    const policy = new ArcGisLayerResidencyPolicy(budget);
    policy.register(layer('a')); policy.beginWarm('a', 1, 10);
    expect(policy.reapExpired(110)).toHaveLength(0);
    expect(policy.reapExpired(111)[0]?.state).toBe('cold');
  });

  it('rejects completing an expired warm lease', () => {
    const policy = new ArcGisLayerResidencyPolicy(budget);
    policy.register(layer('a')); policy.beginWarm('a', 1, 10);
    expect(() => policy.completeWarm('a', 1, 111)).toThrow(/expired/);
  });

  it('enforces resident layer cardinality', () => {
    const policy = new ArcGisLayerResidencyPolicy({ ...budget, maxResidentLayers: 1 });
    policy.register(layer('a')); policy.register(layer('b'));
    policy.beginWarm('a', 1, 1); policy.completeWarm('a', 1, 2);
    policy.beginWarm('b', 1, 1);
    expect(() => policy.completeWarm('b', 1, 2)).toThrow(/resident layer budget/);
  });

  it('enforces aggregate resident bytes', () => {
    const policy = new ArcGisLayerResidencyPolicy({ ...budget, maxResidentBytes: 150 });
    policy.register(layer('a', { estimatedBytes: 100 })); policy.register(layer('b', { estimatedBytes: 100 }));
    policy.beginWarm('a', 1, 1); policy.completeWarm('a', 1, 2); policy.beginWarm('b', 1, 1);
    expect(() => policy.completeWarm('b', 1, 2)).toThrow(/resident byte budget/);
  });

  it('supports explicit warm cancellation', () => {
    const policy = new ArcGisLayerResidencyPolicy(budget);
    policy.register(layer('a')); policy.beginWarm('a', 1, 1);
    expect(policy.abortWarm('a', 1).state).toBe('cold');
  });

  it('prevents implicit eviction of pinned layers', () => {
    const policy = new ArcGisLayerResidencyPolicy(budget);
    policy.register(layer('a', { tier: 'pinned' })); policy.beginWarm('a', 1, 1); policy.completeWarm('a', 1, 2);
    expect(() => policy.beginEvict('a', 1)).toThrow(/pinned/);
  });

  it('evicts resident non-pinned layers through an explicit transition', () => {
    const policy = new ArcGisLayerResidencyPolicy(budget);
    policy.register(layer('a')); policy.beginWarm('a', 1, 1); policy.completeWarm('a', 1, 2);
    expect(policy.beginEvict('a', 1).state).toBe('evicting');
    expect(policy.completeEvict('a', 1).state).toBe('cold');
  });

  it('orders plans by tier then visibility and interactivity', () => {
    const policy = new ArcGisLayerResidencyPolicy(budget);
    policy.register(layer('background', { tier: 'background' }));
    policy.register(layer('pinned', { tier: 'pinned', visible: false, interactive: false }));
    policy.register(layer('interactive', { tier: 'interactive' }));
    expect(policy.plan(1).resident.map((entry) => entry.layerId)).toEqual(['pinned', 'interactive']);
  });

  it('defers entries beyond resident cardinality', () => {
    const policy = new ArcGisLayerResidencyPolicy({ ...budget, maxResidentLayers: 1 });
    policy.register(layer('a')); policy.register(layer('b'));
    const plan = policy.plan(1);
    expect(plan.resident).toHaveLength(1); expect(plan.deferred).toHaveLength(1);
  });

  it('defers entries beyond byte budget without partial accounting', () => {
    const policy = new ArcGisLayerResidencyPolicy({ ...budget, maxResidentBytes: 150 });
    policy.register(layer('a', { estimatedBytes: 100 })); policy.register(layer('b', { estimatedBytes: 100 }));
    const plan = policy.plan(1);
    expect(plan.residentBytes).toBe(100); expect(plan.deferred).toHaveLength(1);
  });

  it('filters plan candidates by revision', () => {
    const policy = new ArcGisLayerResidencyPolicy(budget);
    policy.register(layer('a', { revision: 1 })); policy.register(layer('b', { revision: 2 }));
    expect(policy.plan(2).resident.map((entry) => entry.layerId)).toEqual(['b']);
  });

  it('produces stable fingerprints for unchanged state', () => {
    const policy = new ArcGisLayerResidencyPolicy(budget);
    policy.register(layer('a'));
    expect(policy.plan(1).fingerprint).toBe(policy.plan(1).fingerprint);
  });

  it('changes fingerprint after a lifecycle transition', () => {
    const policy = new ArcGisLayerResidencyPolicy(budget);
    policy.register(layer('a')); const before = policy.plan(1).fingerprint;
    policy.beginWarm('a', 1, 1);
    expect(policy.plan(1).fingerprint).not.toBe(before);
  });

  it('rejects replacement while transitional', () => {
    const policy = new ArcGisLayerResidencyPolicy(budget);
    policy.register(layer('a')); policy.beginWarm('a', 1, 1);
    expect(() => policy.register(layer('a', { revision: 2 }))).toThrow(/transitional/);
  });

  it('fails closed after disposal', () => {
    const policy = new ArcGisLayerResidencyPolicy(budget);
    policy.register(layer('a')); policy.dispose(); policy.dispose();
    expect(() => policy.snapshot()).toThrow(/disposed/);
    expect(() => policy.plan(1)).toThrow(/disposed/);
  });

  it('validates budget relationships', () => {
    expect(() => new ArcGisLayerResidencyPolicy({ ...budget, maxLayers: 1, maxResidentLayers: 2 })).toThrow(/cannot exceed/);
    expect(() => new ArcGisLayerResidencyPolicy({ ...budget, maxLayers: 1, maxWarmingLayers: 2 })).toThrow(/cannot exceed/);
  });
});
