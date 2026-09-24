import { describe, expect, it, vi } from 'vitest';

import {
  captureArcgisUnifiedViewState,
  createArcgisTransitionTarget,
  createArcgisViewTransitionExecutor,
  seedOrchestrationFromArcgisView,
  transitionArcgisView,
  type ArcgisTransitionViewLike,
} from './arcgisViewTransitionAdapter';
import { ModernGisViewOrchestrationRuntime } from './modernGisViewOrchestrationRuntime';
import type { GisRenderBudget } from './runtimeContracts';
import type { UnifiedViewState } from './viewStateTransitionCoordinator';

const budget = (): GisRenderBudget => ({
  tier: 'balanced',
  maxVisibleFeatures: 50_000,
  maxPointSymbols: 20_000,
  maxLabels: 5_000,
  maxSceneNodes: 20_000,
  maxResidentBytes: 256 * 1024 * 1024,
  maxConcurrentRequests: 6,
  maxConcurrentLayerLoads: 3,
  sceneQuality: 0.7,
  labelDensity: 0.7,
  enableShadows: true,
  enableExtrusion: true,
  allowPrefetch: true,
  geometryDetail: 0.7,
  framePressure: 'none',
  memoryPressure: 'low',
});

const state2d = (x = 32.85): UnifiedViewState => ({
  mode: '2d',
  center: {
    x,
    y: 39.93,
    spatialReference: { wkid: 4326 },
  },
  scale: 25_000,
  rotation: 15,
});

const state3d = (x = 32.85): UnifiedViewState => ({
  mode: '3d',
  camera: {
    position: {
      x,
      y: 39.93,
      z: 1200,
      spatialReference: { wkid: 4326 },
    },
    heading: 20,
    tilt: 65,
  },
  scale: 18_000,
});

describe('arcgisViewTransitionAdapter capture', () => {
  it('captures a MapView state with center, scale and rotation', () => {
    const view: ArcgisTransitionViewLike = {
      center: { x: 32.85, y: 39.93, spatialReference: { wkid: 4326 } },
      scale: 25_000,
      rotation: 17,
    };

    expect(captureArcgisUnifiedViewState(view, '2d')).toEqual({
      mode: '2d',
      center: {
        x: 32.85,
        y: 39.93,
        spatialReference: { wkid: 4326 },
      },
      scale: 25_000,
      rotation: 17,
    });
  });

  it('falls back to longitude and latitude when x/y are absent', () => {
    const view: ArcgisTransitionViewLike = {
      center: { longitude: 32.8, latitude: 39.9 },
      spatialReference: { latestWkid: 4326 },
      scale: 5_000,
      rotation: 0,
    };

    expect(captureArcgisUnifiedViewState(view, '2d')).toMatchObject({
      center: {
        x: 32.8,
        y: 39.9,
        spatialReference: { latestWkid: 4326 },
      },
    });
  });

  it('captures a SceneView camera including elevation', () => {
    const view: ArcgisTransitionViewLike = {
      camera: {
        position: {
          x: 32.85,
          y: 39.93,
          z: 1600,
          spatialReference: { wkid: 4326 },
        },
        heading: 35,
        tilt: 70,
      },
      scale: 16_000,
    };

    expect(captureArcgisUnifiedViewState(view, '3d')).toEqual({
      mode: '3d',
      camera: {
        position: {
          x: 32.85,
          y: 39.93,
          z: 1600,
          spatialReference: { wkid: 4326 },
        },
        heading: 35,
        tilt: 70,
      },
      scale: 16_000,
    });
  });

  it('rejects destroyed views and missing spatial references', () => {
    expect(() => captureArcgisUnifiedViewState({ destroyed: true }, '2d')).toThrow(/not available/i);
    expect(() => captureArcgisUnifiedViewState({
      center: { x: 1, y: 2 },
      scale: 1000,
      rotation: 0,
    }, '2d')).toThrow(/WKID/i);
  });

  it('rejects missing SceneView cameras', () => {
    expect(() => captureArcgisUnifiedViewState({
      scale: 1000,
      spatialReference: { wkid: 4326 },
    }, '3d')).toThrow(/camera/i);
  });
});

describe('createArcgisTransitionTarget', () => {
  it('creates a deterministic 2D goTo target', () => {
    expect(createArcgisTransitionTarget(state2d())).toEqual({
      center: {
        x: 32.85,
        y: 39.93,
        spatialReference: { wkid: 4326 },
      },
      scale: 25_000,
      rotation: 15,
    });
  });

  it('creates a deterministic 3D goTo target', () => {
    expect(createArcgisTransitionTarget(state3d())).toEqual({
      position: {
        x: 32.85,
        y: 39.93,
        z: 1200,
        spatialReference: { wkid: 4326 },
      },
      heading: 20,
      tilt: 65,
      scale: 18_000,
    });
  });
});

describe('createArcgisViewTransitionExecutor', () => {
  it('resolves the target view by mode and passes bounded animation options to goTo', async () => {
    const goTo = vi.fn(async () => undefined);
    const twoD: ArcgisTransitionViewLike = {
      center: { x: 1, y: 2, spatialReference: { wkid: 4326 } },
      scale: 1000,
      rotation: 0,
      goTo,
    };
    const resolveView = vi.fn((mode: '2d' | '3d') => mode === '2d' ? twoD : null);
    const executor = createArcgisViewTransitionExecutor({
      resolveView,
      goToOptions: { easing: 'linear' },
    });
    const controller = new AbortController();

    const result = await executor({
      signal: controller.signal,
      sequence: 1,
      intent: 'user',
      durationMs: 350,
      target: state2d(),
    });

    expect(resolveView).toHaveBeenCalledWith('2d');
    expect(goTo).toHaveBeenCalledWith(
      createArcgisTransitionTarget(state2d()),
      expect.objectContaining({
        duration: 350,
        animate: true,
        easing: 'linear',
        signal: controller.signal,
      }),
    );
    expect(result.mode).toBe('2d');
  });

  it('turns zero-duration reduced-motion contexts into non-animated goTo calls', async () => {
    const goTo = vi.fn(async () => undefined);
    const executor = createArcgisViewTransitionExecutor({
      resolveView: () => ({
        center: { x: 1, y: 2, spatialReference: { wkid: 4326 } },
        scale: 1000,
        rotation: 0,
        goTo,
      }),
    });

    await executor({
      signal: new AbortController().signal,
      sequence: 1,
      intent: 'user',
      durationMs: 0,
      target: state2d(),
    });

    expect(goTo).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      duration: 0,
      animate: false,
    }));
  });

  it('captures the actual ArcGIS state after goTo when the view mirrors changes', async () => {
    const scene: ArcgisTransitionViewLike = {
      camera: {
        position: { x: 1, y: 2, z: 3, spatialReference: { wkid: 4326 } },
        heading: 0,
        tilt: 45,
      },
      scale: 1000,
    };
    scene.goTo = vi.fn(async () => {
      scene.camera = {
        position: { x: 99, y: 40, z: 2000, spatialReference: { wkid: 4326 } },
        heading: 90,
        tilt: 75,
      };
      scene.scale = 2222;
    });
    const executor = createArcgisViewTransitionExecutor({ resolveView: () => scene });

    const result = await executor({
      signal: new AbortController().signal,
      sequence: 1,
      intent: 'navigation',
      durationMs: 100,
      target: state3d(),
    });

    expect(result).toMatchObject({
      mode: '3d',
      camera: { position: { x: 99 }, heading: 90, tilt: 75 },
      scale: 2222,
    });
  });

  it('uses the validated transition target when a thin adapter cannot expose readable state', async () => {
    const executor = createArcgisViewTransitionExecutor({
      resolveView: () => ({ goTo: async () => undefined }),
    });

    await expect(executor({
      signal: new AbortController().signal,
      sequence: 1,
      intent: 'programmatic',
      durationMs: 10,
      target: state3d(),
    })).resolves.toEqual(state3d());
  });

  it('runs before and after hooks around goTo', async () => {
    const order: string[] = [];
    const view: ArcgisTransitionViewLike = {
      center: { x: 1, y: 2, spatialReference: { wkid: 4326 } },
      scale: 1000,
      rotation: 0,
      goTo: async () => { order.push('goTo'); },
    };
    const executor = createArcgisViewTransitionExecutor({
      resolveView: () => view,
      onBeforeGoTo: async () => { order.push('before'); },
      onAfterGoTo: async () => { order.push('after'); },
    });

    await executor({
      signal: new AbortController().signal,
      sequence: 1,
      intent: 'programmatic',
      durationMs: 1,
      target: state2d(),
    });

    expect(order).toEqual(['before', 'goTo', 'after']);
  });

  it('rejects before goTo when the transition signal is already aborted', async () => {
    const goTo = vi.fn(async () => undefined);
    const controller = new AbortController();
    controller.abort();
    const executor = createArcgisViewTransitionExecutor({
      resolveView: () => ({ goTo }),
    });

    await expect(executor({
      signal: controller.signal,
      sequence: 1,
      intent: 'programmatic',
      durationMs: 10,
      target: state2d(),
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(goTo).not.toHaveBeenCalled();
  });

  it('normalizes ArcGIS AbortError failures into a transition AbortError', async () => {
    const goTo = vi.fn(async () => {
      const error = new Error('interrupted');
      error.name = 'AbortError';
      throw error;
    });
    const executor = createArcgisViewTransitionExecutor({
      resolveView: () => ({ goTo }),
    });

    await expect(executor({
      signal: new AbortController().signal,
      sequence: 1,
      intent: 'user',
      durationMs: 10,
      target: state2d(),
    })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('fails closed when the requested target view is unavailable', async () => {
    const executor = createArcgisViewTransitionExecutor({ resolveView: () => null });

    await expect(executor({
      signal: new AbortController().signal,
      sequence: 1,
      intent: 'programmatic',
      durationMs: 10,
      target: state3d(),
    })).rejects.toThrow(/3d view is not available/i);
  });
});

describe('orchestration integration helpers', () => {
  it('seeds transition history from an ArcGIS MapView state', () => {
    const runtime = new ModernGisViewOrchestrationRuntime({ budget: budget() });
    const seeded = seedOrchestrationFromArcgisView(runtime, {
      center: { x: 32.8, y: 39.9, spatialReference: { wkid: 4326 } },
      scale: 1000,
      rotation: 5,
    }, '2d');

    expect(seeded).toMatchObject({ mode: '2d', center: { x: 32.8 }, rotation: 5 });
    expect(runtime.snapshot().transitions.historySize).toBe(1);
  });

  it('executes a full 2D to 3D transition through the orchestration runtime', async () => {
    const runtime = new ModernGisViewOrchestrationRuntime({ budget: budget() });
    runtime.seedViewTransition(state2d());
    const scene: ArcgisTransitionViewLike = {
      camera: {
        position: { x: 32.85, y: 39.93, z: 1200, spatialReference: { wkid: 4326 } },
        heading: 20,
        tilt: 65,
      },
      scale: 18_000,
      goTo: vi.fn(async () => undefined),
    };

    const result = await transitionArcgisView(runtime, {
      target: state3d(),
      intent: 'user',
      durationMs: 400,
    }, {
      resolveView: (mode) => mode === '3d' ? scene : null,
    });

    expect(result).toMatchObject({ stale: false, state: { mode: '3d' } });
    expect(scene.goTo).toHaveBeenCalledTimes(1);
    expect(runtime.snapshot().transitions.historySize).toBe(2);
  });
});
