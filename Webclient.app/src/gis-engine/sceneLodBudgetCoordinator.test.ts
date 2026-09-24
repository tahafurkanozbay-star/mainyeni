import { describe, expect, it } from 'vitest';
import { SceneLodBudgetCoordinator, type SceneLodResource } from './sceneLodBudgetCoordinator';

const resource = (overrides: Partial<SceneLodResource> = {}): SceneLodResource => ({
  id: 'buildings',
  kind: 'scene',
  visible: true,
  priority: 10,
  levels: [
    { id: 'high', minScale: 0, maxScale: 0, estimatedGpuBytes: 80, estimatedCpuBytes: 40, estimatedDrawCalls: 8, estimatedFeatures: 800, quality: 3 },
    { id: 'medium', minScale: 0, maxScale: 0, estimatedGpuBytes: 50, estimatedCpuBytes: 25, estimatedDrawCalls: 5, estimatedFeatures: 500, quality: 2 },
    { id: 'low', minScale: 0, maxScale: 0, estimatedGpuBytes: 20, estimatedCpuBytes: 10, estimatedDrawCalls: 2, estimatedFeatures: 200, quality: 1 },
  ],
  ...overrides,
});

const coordinator = () => new SceneLodBudgetCoordinator(10_000, {
  maxGpuBytes: 100,
  maxCpuBytes: 100,
  maxDrawCalls: 10,
  maxFeatures: 1_000,
});

describe('SceneLodBudgetCoordinator', () => {
  it('admits the highest quality level that fits', () => {
    const snapshot = coordinator().upsert(resource());
    expect(snapshot.decisions[0]).toMatchObject({ resourceId: 'buildings', admitted: true, levelId: 'high', reason: 'admitted' });
    expect(snapshot.usage.gpuBytes).toBe(80);
  });

  it('degrades lower-priority resources instead of exceeding budgets', () => {
    const runtime = coordinator();
    runtime.upsert(resource({ id: 'primary', priority: 100 }));
    const snapshot = runtime.upsert(resource({ id: 'secondary', priority: 1 }));
    expect(snapshot.decisions.find(item => item.resourceId === 'primary')?.levelId).toBe('high');
    expect(snapshot.decisions.find(item => item.resourceId === 'secondary')?.levelId).toBe('low');
    expect(snapshot.usage.gpuBytes).toBe(100);
    expect(snapshot.usage.drawCalls).toBe(10);
  });

  it('reports scale rejection when no level is eligible', () => {
    const runtime = coordinator();
    const snapshot = runtime.upsert(resource({ levels: [{ id: 'city', minScale: 5_000, maxScale: 1_000, estimatedGpuBytes: 1, estimatedCpuBytes: 1, estimatedDrawCalls: 1, estimatedFeatures: 1, quality: 1 }] }));
    expect(snapshot.decisions[0]).toMatchObject({ admitted: false, reason: 'scale' });
  });

  it('re-evaluates scale deterministically', () => {
    const runtime = coordinator();
    runtime.upsert(resource({ levels: [{ id: 'district', minScale: 20_000, maxScale: 5_000, estimatedGpuBytes: 1, estimatedCpuBytes: 1, estimatedDrawCalls: 1, estimatedFeatures: 1, quality: 1 }] }));
    expect(runtime.setScale(6_000).decisions[0]?.admitted).toBe(true);
    expect(runtime.setScale(4_000).decisions[0]?.reason).toBe('scale');
  });

  it('excludes hidden resources from usage', () => {
    const snapshot = coordinator().upsert(resource({ visible: false }));
    expect(snapshot.decisions[0]?.reason).toBe('hidden');
    expect(snapshot.usage).toEqual({ gpuBytes: 0, cpuBytes: 0, drawCalls: 0, features: 0 });
  });

  it('uses priority before insertion order', () => {
    const runtime = coordinator();
    runtime.upsert(resource({ id: 'low-priority', priority: 1 }));
    const snapshot = runtime.upsert(resource({ id: 'high-priority', priority: 100 }));
    expect(snapshot.decisions.find(item => item.resourceId === 'high-priority')?.levelId).toBe('high');
  });

  it('classifies pressure using the maximum budget ratio', () => {
    const runtime = new SceneLodBudgetCoordinator(10_000, { maxGpuBytes: 100, maxCpuBytes: 1_000, maxDrawCalls: 100, maxFeatures: 10_000 });
    expect(runtime.upsert(resource()).pressure).toBe('elevated');
  });

  it('enforces bounded resource metadata', () => {
    const runtime = new SceneLodBudgetCoordinator(10_000, { maxGpuBytes: 100, maxCpuBytes: 100, maxDrawCalls: 10, maxFeatures: 1_000, maxResources: 1 });
    runtime.upsert(resource({ id: 'one' }));
    expect(() => runtime.upsert(resource({ id: 'two' }))).toThrow('capacity exhausted');
  });

  it('updates an existing resource without consuming capacity', () => {
    const runtime = new SceneLodBudgetCoordinator(10_000, { maxGpuBytes: 100, maxCpuBytes: 100, maxDrawCalls: 10, maxFeatures: 1_000, maxResources: 1 });
    runtime.upsert(resource({ id: 'one', visible: false }));
    expect(runtime.upsert(resource({ id: 'one', visible: true })).decisions[0]?.admitted).toBe(true);
  });

  it('removes resources and advances revision only when state changes', () => {
    const runtime = coordinator();
    runtime.upsert(resource());
    const before = runtime.snapshot().revision;
    expect(runtime.remove('missing')).toBe(false);
    expect(runtime.snapshot().revision).toBe(before);
    expect(runtime.remove('buildings')).toBe(true);
    expect(runtime.snapshot().decisions).toHaveLength(0);
  });

  it('rejects duplicate LOD ids', () => {
    const duplicate = resource({ levels: [
      { id: 'same', minScale: 0, maxScale: 0, estimatedGpuBytes: 1, estimatedCpuBytes: 1, estimatedDrawCalls: 1, estimatedFeatures: 1, quality: 2 },
      { id: 'same', minScale: 0, maxScale: 0, estimatedGpuBytes: 1, estimatedCpuBytes: 1, estimatedDrawCalls: 1, estimatedFeatures: 1, quality: 1 },
    ] });
    expect(() => coordinator().upsert(duplicate)).toThrow('duplicate LOD level id');
  });

  it('rejects inverted ArcGIS scale ranges', () => {
    expect(() => coordinator().upsert(resource({ levels: [{ id: 'bad', minScale: 1_000, maxScale: 5_000, estimatedGpuBytes: 1, estimatedCpuBytes: 1, estimatedDrawCalls: 1, estimatedFeatures: 1, quality: 1 }] }))).toThrow('minScale');
  });

  it('rejects invalid budgets and pressure thresholds', () => {
    expect(() => new SceneLodBudgetCoordinator(1, { maxGpuBytes: 0, maxCpuBytes: 1, maxDrawCalls: 1, maxFeatures: 1 })).toThrow('maxGpuBytes');
    expect(() => new SceneLodBudgetCoordinator(1, { maxGpuBytes: 1, maxCpuBytes: 1, maxDrawCalls: 1, maxFeatures: 1, elevatedRatio: 0.9, criticalRatio: 0.8 })).toThrow('elevatedRatio');
  });
});
