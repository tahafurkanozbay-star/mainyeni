import { describe, expect, it } from 'vitest';
import { createSceneResourceBudget, normalizeSceneBudgetLimits, type SceneResourceRequest } from './sceneResourceBudget';

const resource = (id: string, overrides: Partial<SceneResourceRequest> = {}): SceneResourceRequest => ({ id, layerId: 'buildings', kind: 'mesh', priority: 'visible', estimatedCpuBytes: 100, estimatedGpuBytes: 200, estimatedDrawCalls: 2, estimatedFeatures: 10, distance: 100, screenCoverage: 0.2, ...overrides });

describe('sceneResourceBudget', () => {
  it('uses larger default GPU budget for 3d without unbounded values', () => {
    const two = normalizeSceneBudgetLimits('2d'); const three = normalizeSceneBudgetLimits('3d');
    expect(three.maxGpuBytes).toBeGreaterThan(two.maxGpuBytes); expect(three.maxGpuBytes).toBeLessThanOrEqual(2 * 1024 * 1024 * 1024);
  });
  it('tracks CPU GPU draw-call feature and resource ownership', () => {
    const budget = createSceneResourceBudget('3d', { maxCpuBytes: 1000, maxGpuBytes: 1000, maxDrawCalls: 10, maxFeatures: 100, maxResources: 5 });
    expect(budget.admit(resource('a')).admitted).toBe(true);
    expect(budget.snapshot().usage).toEqual({ cpuBytes: 100, gpuBytes: 200, drawCalls: 2, features: 10, resources: 1 });
    expect(budget.release('a')).toBe(true); expect(budget.snapshot().usage.resources).toBe(0);
  });
  it('rejects duplicate ownership so memory accounting cannot double count', () => {
    const budget = createSceneResourceBudget('2d'); expect(budget.admit(resource('a')).admitted).toBe(true); expect(budget.admit(resource('a')).reason).toBe('duplicate'); expect(budget.snapshot().usage.resources).toBe(1);
  });
  it('rejects invalid estimates fail closed', () => {
    const budget = createSceneResourceBudget('3d'); expect(budget.admit(resource('bad', { estimatedGpuBytes: -1 })).reason).toBe('invalid'); expect(budget.snapshot().resources).toHaveLength(0);
  });
  it('enforces per-layer resource bounds', () => {
    const budget = createSceneResourceBudget('2d', { maxResourcesPerLayer: 1 }); expect(budget.admit(resource('a')).admitted).toBe(true); expect(budget.admit(resource('b')).reason).toBe('layer-limit');
  });
  it('evicts lower priority prefetch work for interactive resources', () => {
    const budget = createSceneResourceBudget('3d', { maxGpuBytes: 300, maxCpuBytes: 1000, maxDrawCalls: 100, maxFeatures: 1000, maxResources: 10 });
    expect(budget.admit(resource('prefetch', { priority: 'prefetch', estimatedGpuBytes: 250 })).admitted).toBe(true);
    const admission = budget.admit(resource('pick', { priority: 'interactive', estimatedGpuBytes: 200 }));
    expect(admission.admitted).toBe(true); expect(admission.evicted).toEqual(['prefetch']); expect(budget.snapshot().resources.map((entry) => entry.id)).toEqual(['pick']);
  });
  it('does not evict equal or higher priority work', () => {
    const budget = createSceneResourceBudget('3d', { maxGpuBytes: 300, maxCpuBytes: 1000, maxDrawCalls: 100, maxFeatures: 1000, maxResources: 10 });
    budget.admit(resource('interactive', { priority: 'interactive', estimatedGpuBytes: 250 }));
    const admission = budget.admit(resource('visible', { priority: 'visible', estimatedGpuBytes: 200 })); expect(admission.admitted).toBe(false); expect(admission.evicted).toEqual([]); expect(budget.snapshot().resources[0]?.id).toBe('interactive');
  });
  it('releases complete layer ownership deterministically', () => {
    const budget = createSceneResourceBudget('2d'); budget.admit(resource('a')); budget.admit(resource('b')); budget.admit(resource('c', { layerId: 'roads' }));
    expect(budget.releaseLayer('buildings')).toBe(2); expect(budget.snapshot().resources.map((entry) => entry.id)).toEqual(['c']);
  });
  it('evicts noncritical resources when budgets shrink', () => {
    const budget = createSceneResourceBudget('3d', { maxGpuBytes: 1000 }); budget.admit(resource('far', { priority: 'prefetch', estimatedGpuBytes: 400, distance: 1000 })); budget.admit(resource('near', { priority: 'visible', estimatedGpuBytes: 400, distance: 10 }));
    expect(budget.updateLimits({ maxGpuBytes: 450 })).toEqual(['far']); expect(budget.snapshot().resources.map((entry) => entry.id)).toEqual(['near']);
  });
  it('preserves critical resources even if a later device budget is lower', () => {
    const budget = createSceneResourceBudget('3d', { maxGpuBytes: 1000 }); budget.admit(resource('selection', { priority: 'critical', kind: 'highlight', estimatedGpuBytes: 600 }));
    expect(budget.updateLimits({ maxGpuBytes: 300 })).toEqual([]); expect(budget.snapshot().resources[0]?.id).toBe('selection');
  });
  it('clear releases all accounting', () => {
    const budget = createSceneResourceBudget('2d'); budget.admit(resource('a')); budget.clear(); expect(budget.snapshot().usage).toEqual({ cpuBytes: 0, gpuBytes: 0, drawCalls: 0, features: 0, resources: 0 }); expect(budget.snapshot().resources).toEqual([]);
  });
});
