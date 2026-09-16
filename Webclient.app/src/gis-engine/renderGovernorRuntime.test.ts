import { createRenderGovernor } from './renderGovernorRuntime';

const layer = (overrides = {}) => ({
  id: 'places',
  resourceKind: 'feature-layer',
  geometryType: 'point',
  visible: true,
  importance: 60,
  ...overrides,
});

describe('renderGovernorRuntime', () => {
  test('starts balanced on a typical device', () => {
    const governor = createRenderGovernor({ device: { memoryGb: 4, logicalCores: 4, networkClass: 'normal' } });
    expect(governor.getTier()).toBe('balanced');
  });
  test('starts economy on constrained devices', () => {
    const governor = createRenderGovernor({ device: { memoryGb: 2, logicalCores: 2, saveData: true, networkClass: 'constrained' } });
    expect(governor.getTier()).toBe('economy');
    expect(governor.getBudget().allowPrefetch).toBe(false);
  });
  test('starts quality on capable devices', () => {
    const governor = createRenderGovernor({ device: { memoryGb: 8, logicalCores: 8, networkClass: 'fast' } });
    expect(governor.getTier()).toBe('quality');
  });
  test('starts ultra only on high-end devices', () => {
    const governor = createRenderGovernor({ device: { memoryGb: 16, logicalCores: 12, networkClass: 'fast' } });
    expect(governor.getTier()).toBe('ultra');
  });
  test('drops quality under sustained frame pressure', () => {
    let now = 0;
    const governor = createRenderGovernor({ now: () => now, initialTier: 'quality', settings: { minSamples: 4, transitionCooldownMs: 1 } });
    governor.updateView({ kind: '2d', stationary: true });
    [60, 62, 58, 65].forEach((sample) => { now += 10; governor.recordFrame(sample); });
    expect(governor.getTier()).toBe('balanced');
  });
  test('does not oscillate through multiple tiers during cooldown', () => {
    let now = 0;
    const governor = createRenderGovernor({ now: () => now, initialTier: 'quality', settings: { minSamples: 2, transitionCooldownMs: 5000 } });
    governor.recordFrame(80);
    now += 1;
    governor.recordFrame(90);
    expect(governor.getTier()).toBe('balanced');
    now += 10;
    governor.recordFrame(100);
    expect(governor.getTier()).toBe('balanced');
  });
  test('can recover one tier after a stable cooldown', () => {
    let now = 0;
    const governor = createRenderGovernor({
      now: () => now,
      initialTier: 'economy',
      device: { memoryGb: 8, logicalCores: 8, networkClass: 'fast' },
      settings: { minSamples: 4, recoveryCooldownMs: 10 },
    });
    governor.updateView({ kind: '2d', stationary: true });
    [12, 13, 11, 12].forEach((sample) => { now += 5; governor.recordFrame(sample); });
    expect(governor.getTier()).toBe('balanced');
  });
  test('classifies critical resident memory pressure', () => {
    const governor = createRenderGovernor({ initialTier: 'balanced' });
    const maximum = governor.getBudget().maxResidentBytes;
    governor.setResidentBytes(maximum * 2);
    expect(governor.getBudget().memoryPressure).toBe('critical');
  });
  test('2D point pressure enables clustering', () => {
    const governor = createRenderGovernor({ initialTier: 'balanced' });
    governor.updateView({ kind: '2d', scale: 5000, stationary: true });
    const budget = governor.getBudget();
    const plan = governor.planLayer({ layer: layer(), pointCount: budget.maxPointSymbols * 2, featureCount: budget.maxVisibleFeatures, allowCluster: true });
    expect(plan.cluster).toBe(true);
    expect(plan.viewKind).toBe('2d');
  });
  test('editing disables clustering and raises priority', () => {
    const governor = createRenderGovernor({ initialTier: 'balanced' });
    const plan = governor.planLayer({ layer: layer(), pointCount: 999999, editing: true, allowCluster: true });
    expect(plan.cluster).toBe(false);
    expect(plan.priority).toBe(0);
  });
  test('selected layers have higher priority than normal layers', () => {
    const governor = createRenderGovernor({ initialTier: 'balanced' });
    const normal = governor.planLayer({ layer: layer() });
    const selected = governor.planLayer({ layer: layer(), selected: true });
    expect(selected.priority).toBeLessThan(normal.priority);
  });
  test('respects ArcGIS minScale visibility semantics', () => {
    const governor = createRenderGovernor({ initialTier: 'balanced' });
    governor.updateView({ kind: '2d', scale: 50000, stationary: true });
    const plan = governor.planLayer({ layer: layer({ minScale: 10000 }) });
    expect(plan.visible).toBe(false);
    expect(plan.reason).toBe('outside-scale-range');
  });
  test('respects ArcGIS maxScale visibility semantics', () => {
    const governor = createRenderGovernor({ initialTier: 'balanced' });
    governor.updateView({ kind: '2d', scale: 500, stationary: true });
    const plan = governor.planLayer({ layer: layer({ maxScale: 1000 }) });
    expect(plan.visible).toBe(false);
  });
  test('3D quality plan allows extrusion when pressure is low', () => {
    const governor = createRenderGovernor({ initialTier: 'quality' });
    governor.updateView({ kind: '3d', stationary: true, interacting: false });
    const plan = governor.planLayer({ layer: layer({ geometryType: 'polygon' }), allowExtrusion: true });
    expect(plan.viewKind).toBe('3d');
    expect(plan.extrusion).toBe(true);
    expect(plan.maxSceneNodes).toBeGreaterThan(0);
  });
  test('interaction disables expensive 3D shadows and extrusion', () => {
    const governor = createRenderGovernor({ initialTier: 'ultra' });
    governor.updateView({ kind: '3d', stationary: false, interacting: true });
    const plan = governor.planLayer({ layer: layer({ geometryType: 'polygon' }), allowExtrusion: true, allowShadows: true });
    expect(plan.extrusion).toBe(false);
    expect(plan.shadows).toBe(false);
  });
  test('never fabricates a generalization tolerance', () => {
    const governor = createRenderGovernor({ initialTier: 'economy' });
    const plan = governor.planLayer({ layer: layer(), featureCount: 100000 });
    expect(plan.generalization.recommended).toBe(true);
    expect(plan.generalization.tolerance).toBeNull();
    expect(plan.generalization.reason).toMatch(/coordinate units/i);
  });
  test('hidden layers are deferred deterministically', () => {
    const governor = createRenderGovernor({ initialTier: 'balanced' });
    const plan = governor.planLayer({ layer: layer({ visible: false }) });
    expect(plan.visible).toBe(false);
    expect(plan.defer).toBe(true);
    expect(plan.reason).toBe('layer-hidden');
  });
  test('prefetch is disabled while the view is moving', () => {
    const governor = createRenderGovernor({ initialTier: 'quality' });
    governor.updateView({ kind: '3d', stationary: false, interacting: true });
    expect(governor.getBudget().allowPrefetch).toBe(false);
  });
  test('manual tier changes emit subscriptions', () => {
    const governor = createRenderGovernor({ initialTier: 'balanced' });
    const listener = jest.fn();
    governor.subscribe(listener);
    governor.setTier('quality', 'test');
    expect(listener).toHaveBeenCalled();
    expect(governor.getTier()).toBe('quality');
  });
  test('invalid frame samples are dropped instead of poisoning percentiles', () => {
    const governor = createRenderGovernor({ initialTier: 'balanced' });
    governor.recordFrame(-1);
    governor.recordFrame(Number.POSITIVE_INFINITY);
    const snapshot = governor.getSnapshot();
    expect(snapshot.sampleCount).toBe(0);
    expect(snapshot.droppedSamples).toBe(2);
  });
  test('resetFrameSamples clears pressure history', () => {
    const governor = createRenderGovernor({ initialTier: 'balanced' });
    governor.recordFrame(30);
    governor.recordFrame(40);
    governor.resetFrameSamples();
    expect(governor.getSnapshot().sampleCount).toBe(0);
  });
  test('destroy leaves an inert immutable snapshot surface', () => {
    const governor = createRenderGovernor({ initialTier: 'balanced' });
    governor.destroy();
    expect(governor.isDestroyed()).toBe(true);
    expect(() => governor.planLayer({ layer: layer() })).toThrow(/destroyed/i);
  });
});
