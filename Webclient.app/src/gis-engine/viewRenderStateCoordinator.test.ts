import { describe, expect, it } from 'vitest';
import { ViewRenderStateCoordinator, type RenderViewState } from './viewRenderStateCoordinator';

const view2d = (scale = 10_000): RenderViewState => ({
  mode: '2d',
  scale,
  center: [32.85, 39.93],
  rotation: 0,
  quality: 'balanced',
});

const layer = (layerId: string, overrides: Partial<Parameters<ViewRenderStateCoordinator['upsertLayer']>[0]> = {}) => ({
  layerId,
  visible: true,
  opacity: 1,
  minScale: 0,
  maxScale: 0,
  priority: 1,
  estimatedDrawCalls: 10,
  estimatedGpuBytes: 100,
  ...overrides,
});

describe('ViewRenderStateCoordinator', () => {
  it('admits visible layers within budgets', () => {
    const runtime = new ViewRenderStateCoordinator(view2d(), { maxDrawCalls: 100, maxGpuBytes: 1_000 });
    runtime.upsertLayer(layer('roads'));
    runtime.upsertLayer(layer('buildings', { estimatedDrawCalls: 20, estimatedGpuBytes: 200 }));
    const snapshot = runtime.snapshot();
    expect(snapshot.layers.every((entry) => entry.effectiveVisible)).toBe(true);
    expect(snapshot.admittedDrawCalls).toBe(30);
    expect(snapshot.admittedGpuBytes).toBe(300);
  });

  it('uses priority before insertion order under draw pressure', () => {
    const runtime = new ViewRenderStateCoordinator(view2d(), { maxDrawCalls: 10, maxGpuBytes: 1_000 });
    runtime.upsertLayer(layer('low', { priority: 1, estimatedDrawCalls: 10 }));
    runtime.upsertLayer(layer('critical', { priority: 100, estimatedDrawCalls: 10 }));
    const snapshot = runtime.snapshot();
    expect(snapshot.layers.find((entry) => entry.layerId === 'critical')?.reason).toBe('visible');
    expect(snapshot.layers.find((entry) => entry.layerId === 'low')?.reason).toBe('draw-budget');
  });

  it('enforces gpu pressure independently from draw calls', () => {
    const runtime = new ViewRenderStateCoordinator(view2d(), { maxDrawCalls: 100, maxGpuBytes: 100 });
    runtime.upsertLayer(layer('heavy', { estimatedGpuBytes: 101 }));
    expect(runtime.snapshot().layers[0]?.reason).toBe('gpu-budget');
  });

  it('preserves requested visibility while reporting effective scale visibility', () => {
    const runtime = new ViewRenderStateCoordinator(view2d(50_000));
    runtime.upsertLayer(layer('parcel', { minScale: 20_000 }));
    const decision = runtime.snapshot().layers[0];
    expect(decision?.requestedVisible).toBe(true);
    expect(decision?.effectiveVisible).toBe(false);
    expect(decision?.reason).toBe('scale');
    runtime.setView(view2d(10_000));
    expect(runtime.snapshot().layers[0]?.effectiveVisible).toBe(true);
  });

  it('treats zero opacity as effectively hidden', () => {
    const runtime = new ViewRenderStateCoordinator(view2d());
    runtime.upsertLayer(layer('transparent', { opacity: 0 }));
    expect(runtime.snapshot().layers[0]?.reason).toBe('hidden');
  });

  it('clamps opacity into the ArcGIS-compatible unit interval', () => {
    const runtime = new ViewRenderStateCoordinator(view2d());
    runtime.upsertLayer(layer('high', { opacity: 5 }));
    expect(runtime.snapshot().layers[0]?.opacity).toBe(1);
    runtime.upsertLayer(layer('high', { opacity: -2 }));
    expect(runtime.snapshot().layers[0]?.opacity).toBe(0);
  });

  it('requires a camera for 3d state and normalizes camera angles', () => {
    expect(() => new ViewRenderStateCoordinator({ ...view2d(), mode: '3d' })).toThrow('3d render state requires camera');
    const runtime = new ViewRenderStateCoordinator({
      ...view2d(),
      mode: '3d',
      rotation: -10,
      camera: { longitude: 32.85, latitude: 39.93, altitude: 500, heading: 370, tilt: 45 },
    });
    expect(runtime.snapshot().view.rotation).toBe(350);
    expect(runtime.snapshot().view.camera?.heading).toBe(10);
  });

  it('rejects invalid camera latitude and inverted extents', () => {
    expect(() => new ViewRenderStateCoordinator({
      ...view2d(), mode: '3d', camera: { longitude: 0, latitude: 91, altitude: 1, heading: 0, tilt: 0 },
    })).toThrow('camera.latitude');
    expect(() => new ViewRenderStateCoordinator({
      ...view2d(), extent: { xmin: 5, ymin: 0, xmax: 4, ymax: 1, spatialReferenceWkid: 4326 },
    })).toThrow('extent bounds are inverted');
  });

  it('bounds metadata growth', () => {
    const runtime = new ViewRenderStateCoordinator(view2d(), { maxLayers: 1 });
    runtime.upsertLayer(layer('one'));
    expect(() => runtime.upsertLayer(layer('two'))).toThrow('render layer capacity exhausted');
  });

  it('updates an existing layer without consuming capacity', () => {
    const runtime = new ViewRenderStateCoordinator(view2d(), { maxLayers: 1 });
    runtime.upsertLayer(layer('one'));
    runtime.upsertLayer(layer('one', { visible: false }));
    expect(runtime.snapshot().layers).toHaveLength(1);
    expect(runtime.snapshot().layers[0]?.reason).toBe('hidden');
  });

  it('reports elevated and critical pressure from admitted resources', () => {
    const elevated = new ViewRenderStateCoordinator(view2d(), { maxDrawCalls: 100, maxGpuBytes: 1_000, elevatedPressureRatio: 0.5, criticalPressureRatio: 0.9 });
    elevated.upsertLayer(layer('a', { estimatedDrawCalls: 60 }));
    expect(elevated.snapshot().pressure).toBe('elevated');
    const critical = new ViewRenderStateCoordinator(view2d(), { maxDrawCalls: 100, maxGpuBytes: 1_000, elevatedPressureRatio: 0.5, criticalPressureRatio: 0.9 });
    critical.upsertLayer(layer('a', { estimatedDrawCalls: 90 }));
    expect(critical.snapshot().pressure).toBe('critical');
  });

  it('removes and clears layers deterministically', () => {
    const runtime = new ViewRenderStateCoordinator(view2d());
    runtime.upsertLayer(layer('a'));
    runtime.upsertLayer(layer('b'));
    expect(runtime.removeLayer('a')).toBe(true);
    expect(runtime.removeLayer('missing')).toBe(false);
    expect(runtime.snapshot().layers.map((entry) => entry.layerId)).toEqual(['b']);
    runtime.clear();
    expect(runtime.snapshot().layers).toEqual([]);
  });

  it('rejects malformed scales and pressure thresholds', () => {
    expect(() => new ViewRenderStateCoordinator({ ...view2d(), scale: 0 })).toThrow('scale must be positive');
    expect(() => new ViewRenderStateCoordinator(view2d(), { elevatedPressureRatio: 0.9, criticalPressureRatio: 0.8 })).toThrow('elevatedPressureRatio');
  });
});
