import { describe, expect, it } from 'vitest';
import { ArcGisLayerResidencyCoordinator, type ArcGisLayerResidencyRequest } from './ArcGisLayerResidencyCoordinator';

const policy = { maxResidentLayers: 3, maxResidentBytes: 300, maxGpuBytes: 180, maxPinnedLayers: 1, staleAfterMs: 100 } as const;
const layer = (layerId: string, residencyClass: ArcGisLayerResidencyRequest['residencyClass'] = 'visible', overrides: Partial<ArcGisLayerResidencyRequest> = {}): ArcGisLayerResidencyRequest => ({ layerId, viewMode: '2d', residencyClass, estimatedBytes: 80, estimatedGpuBytes: 40, ...overrides });

describe('ArcGisLayerResidencyCoordinator', () => {
  it('accounts admitted residency and returns immutable snapshots', () => {
    const runtime = new ArcGisLayerResidencyCoordinator(policy);
    const admission = runtime.admit(layer('roads'), 10);
    expect(admission.resident).toMatchObject({ layerId: 'roads', generation: 1, admittedAt: 10, lastTouchedAt: 10 });
    expect(Object.isFrozen(admission.resident)).toBe(true);
    expect(runtime.budgetSnapshot()).toEqual({ residentLayers: 1, residentBytes: 80, gpuBytes: 40, pinnedLayers: 0 });
  });

  it('evicts lower priority residency deterministically under layer pressure', () => {
    const runtime = new ArcGisLayerResidencyCoordinator({ ...policy, maxResidentLayers: 2 });
    runtime.admit(layer('prefetch-a', 'prefetch'), 1);
    runtime.admit(layer('visible-a', 'visible'), 2);
    const result = runtime.admit(layer('critical-a', 'critical'), 3);
    expect(result.evicted.map((entry) => entry.layerId)).toEqual(['prefetch-a']);
    expect(runtime.list().map((entry) => entry.layerId)).toEqual(['critical-a', 'visible-a']);
  });

  it('evicts lower priority residency under byte pressure', () => {
    const runtime = new ArcGisLayerResidencyCoordinator({ ...policy, maxResidentBytes: 170 });
    runtime.admit(layer('prefetch-a', 'prefetch'), 1);
    runtime.admit(layer('visible-a', 'visible'), 2);
    const result = runtime.admit(layer('critical-a', 'critical', { estimatedBytes: 90 }), 3);
    expect(result.evicted.map((entry) => entry.layerId)).toEqual(['prefetch-a']);
    expect(runtime.budgetSnapshot().residentBytes).toBe(170);
  });

  it('evicts lower priority residency under GPU pressure', () => {
    const runtime = new ArcGisLayerResidencyCoordinator({ ...policy, maxGpuBytes: 90 });
    runtime.admit(layer('prefetch-a', 'prefetch'), 1);
    runtime.admit(layer('visible-a', 'visible'), 2);
    const result = runtime.admit(layer('critical-a', 'critical', { estimatedGpuBytes: 50 }), 3);
    expect(result.evicted.map((entry) => entry.layerId)).toEqual(['prefetch-a']);
    expect(runtime.budgetSnapshot().gpuBytes).toBe(90);
  });

  it('never evicts equal priority residency to force admission', () => {
    const runtime = new ArcGisLayerResidencyCoordinator({ ...policy, maxResidentLayers: 1 });
    runtime.admit(layer('visible-a'), 1);
    expect(() => runtime.admit(layer('visible-b'), 2)).toThrow(/cannot satisfy/);
    expect(runtime.list().map((entry) => entry.layerId)).toEqual(['visible-a']);
  });

  it('never evicts pinned residency', () => {
    const runtime = new ArcGisLayerResidencyCoordinator({ ...policy, maxResidentLayers: 1 });
    runtime.admit(layer('pinned-prefetch', 'prefetch', { pinned: true }), 1);
    expect(() => runtime.admit(layer('critical-a', 'critical'), 2)).toThrow(/cannot satisfy/);
    expect(runtime.get('pinned-prefetch')?.pinned).toBe(true);
  });

  it('enforces pinned layer capacity', () => {
    const runtime = new ArcGisLayerResidencyCoordinator(policy);
    runtime.admit(layer('pinned-a', 'visible', { pinned: true }), 1);
    expect(() => runtime.admit(layer('pinned-b', 'critical', { pinned: true }), 2)).toThrow(/pinned layer budget exhausted/);
  });

  it('allows deterministic promotion without generation churn', () => {
    const runtime = new ArcGisLayerResidencyCoordinator(policy);
    const first = runtime.admit(layer('roads', 'prefetch'), 1).resident;
    const promoted = runtime.admit(layer('roads', 'critical', { estimatedBytes: 90, estimatedGpuBytes: 50 }), 2).resident;
    expect(promoted.generation).toBe(first.generation);
    expect(promoted.residencyClass).toBe('critical');
    expect(promoted.lastTouchedAt).toBe(2);
    expect(runtime.budgetSnapshot()).toEqual({ residentLayers: 1, residentBytes: 90, gpuBytes: 50, pinnedLayers: 0 });
  });

  it('rejects implicit priority demotion', () => {
    const runtime = new ArcGisLayerResidencyCoordinator(policy);
    runtime.admit(layer('roads', 'critical'), 1);
    expect(() => runtime.admit(layer('roads', 'prefetch'), 2)).toThrow(/demotion requires release/);
  });

  it('rejects changing a resident layer between 2d and 3d', () => {
    const runtime = new ArcGisLayerResidencyCoordinator(policy);
    runtime.admit(layer('roads', 'visible', { viewMode: '2d' }), 1);
    expect(() => runtime.admit(layer('roads', 'visible', { viewMode: '3d' }), 2)).toThrow(/already belongs to 2d/);
  });

  it('touches a resident and rejects backwards clocks', () => {
    const runtime = new ArcGisLayerResidencyCoordinator(policy);
    runtime.admit(layer('roads'), 10);
    expect(runtime.touch('roads', 20)?.lastTouchedAt).toBe(20);
    expect(() => runtime.touch('roads', 19)).toThrow(/cannot move backwards/);
  });

  it('returns null when touching or releasing an unknown layer', () => {
    const runtime = new ArcGisLayerResidencyCoordinator(policy);
    expect(runtime.touch('missing', 1)).toBeNull();
    expect(runtime.release('missing')).toBeNull();
  });

  it('releases accounting atomically', () => {
    const runtime = new ArcGisLayerResidencyCoordinator(policy);
    runtime.admit(layer('roads', 'visible', { pinned: true }), 1);
    expect(runtime.release('roads')?.layerId).toBe('roads');
    expect(runtime.budgetSnapshot()).toEqual({ residentLayers: 0, residentBytes: 0, gpuBytes: 0, pinnedLayers: 0 });
  });

  it('prunes stale non-critical unpinned residency in deterministic order', () => {
    const runtime = new ArcGisLayerResidencyCoordinator(policy);
    runtime.admit(layer('b', 'visible'), 1);
    runtime.admit(layer('a', 'prefetch'), 1);
    const removed = runtime.pruneStale(101);
    expect(removed.map((entry) => entry.layerId)).toEqual(['a', 'b']);
    expect(runtime.list()).toEqual([]);
  });

  it('does not prune critical residency', () => {
    const runtime = new ArcGisLayerResidencyCoordinator(policy);
    runtime.admit(layer('critical', 'critical'), 1);
    expect(runtime.pruneStale(1000)).toEqual([]);
  });

  it('does not prune pinned residency', () => {
    const runtime = new ArcGisLayerResidencyCoordinator(policy);
    runtime.admit(layer('pinned', 'prefetch', { pinned: true }), 1);
    expect(runtime.pruneStale(1000)).toEqual([]);
  });

  it('filters snapshots by view mode', () => {
    const runtime = new ArcGisLayerResidencyCoordinator(policy);
    runtime.admit(layer('map', 'visible', { viewMode: '2d' }), 1);
    runtime.admit(layer('scene', 'visible', { viewMode: '3d' }), 2);
    expect(runtime.list('2d').map((entry) => entry.layerId)).toEqual(['map']);
    expect(runtime.list('3d').map((entry) => entry.layerId)).toEqual(['scene']);
  });

  it('sorts snapshots by stable layer identity', () => {
    const runtime = new ArcGisLayerResidencyCoordinator(policy);
    runtime.admit(layer('zoning'), 1);
    runtime.admit(layer('addresses'), 2);
    expect(runtime.list().map((entry) => entry.layerId)).toEqual(['addresses', 'zoning']);
  });

  it.each([
    [{ ...policy, maxResidentLayers: 0 }, /maxResidentLayers/],
    [{ ...policy, maxResidentBytes: 0 }, /maxResidentBytes/],
    [{ ...policy, maxGpuBytes: 0 }, /maxGpuBytes/],
    [{ ...policy, maxPinnedLayers: 0 }, /maxPinnedLayers/],
    [{ ...policy, staleAfterMs: 0 }, /staleAfterMs/],
    [{ ...policy, maxPinnedLayers: 4 }, /cannot exceed/],
  ])('rejects malformed policy %#', (badPolicy, expected) => {
    expect(() => new ArcGisLayerResidencyCoordinator(badPolicy)).toThrow(expected);
  });

  it.each([
    [layer(' '), /layerId/],
    [layer('x', 'visible', { estimatedBytes: 0 }), /estimatedBytes/],
    [layer('x', 'visible', { estimatedGpuBytes: -1 }), /estimatedGpuBytes/],
    [layer('x', 'visible', { estimatedBytes: 10, estimatedGpuBytes: 11 }), /cannot exceed/],
    [layer('x', 'visible', { estimatedBytes: Number.MAX_SAFE_INTEGER + 1 }), /estimatedBytes/],
  ])('rejects malformed request %#', (request, expected) => {
    const runtime = new ArcGisLayerResidencyCoordinator(policy);
    expect(() => runtime.admit(request, 1)).toThrow(expected);
  });

  it('rejects a single layer larger than resident budget', () => {
    const runtime = new ArcGisLayerResidencyCoordinator(policy);
    expect(() => runtime.admit(layer('huge', 'critical', { estimatedBytes: 301 }), 1)).toThrow(/resident byte budget/);
  });

  it('rejects a single layer larger than GPU budget', () => {
    const runtime = new ArcGisLayerResidencyCoordinator(policy);
    expect(() => runtime.admit(layer('huge', 'critical', { estimatedBytes: 200, estimatedGpuBytes: 181 }), 1)).toThrow(/GPU byte budget/);
  });

  it('fails closed after disposal', () => {
    const runtime = new ArcGisLayerResidencyCoordinator(policy);
    runtime.admit(layer('roads'), 1);
    runtime.dispose();
    runtime.dispose();
    expect(() => runtime.list()).toThrow(/disposed/);
    expect(() => runtime.admit(layer('new'), 2)).toThrow(/disposed/);
  });
});
