import { describe, expect, it, vi } from 'vitest';

import { createModernGisOrchestratedKernel } from './modernGisOrchestratedKernel';
import type { SceneLodResource } from './sceneLodBudgetCoordinator';
import type { UnifiedViewState } from './viewStateTransitionCoordinator';

const sceneResource = (id: string): SceneLodResource => ({
  id,
  kind: 'scene',
  visible: true,
  priority: 10,
  levels: [
    {
      id: 'high',
      minScale: 100_000,
      maxScale: 0,
      estimatedGpuBytes: 8 * 1024 * 1024,
      estimatedCpuBytes: 4 * 1024 * 1024,
      estimatedDrawCalls: 40,
      estimatedFeatures: 2_000,
      quality: 1,
    },
  ],
});

const state2d = (): UnifiedViewState => ({
  mode: '2d',
  center: {
    x: 32.85,
    y: 39.93,
    spatialReference: { wkid: 4326 },
  },
  scale: 25_000,
  rotation: 0,
});

const state3d = (): UnifiedViewState => ({
  mode: '3d',
  camera: {
    position: {
      x: 32.85,
      y: 39.93,
      z: 1200,
      spatialReference: { wkid: 4326 },
    },
    heading: 0,
    tilt: 65,
  },
  scale: 20_000,
});

describe('createModernGisOrchestratedKernel', () => {
  it('exposes the bounded view orchestration extension without removing base kernel APIs', () => {
    const kernel = createModernGisOrchestratedKernel();

    expect(kernel.viewOrchestration).toBeDefined();
    expect(kernel.temporal).toBeDefined();
    expect(kernel.edits).toBeDefined();
    expect(kernel.mapState).toBeDefined();
    expect(kernel.exports).toBeDefined();
    expect(kernel.queryControlPlane).toBeDefined();
    expect(typeof kernel.registerService).toBe('function');
    expect(typeof kernel.executeQuery).toBe('function');
  });

  it('uses the same injected clock for base kernel and orchestration events', () => {
    const events: Array<{ timestamp: number }> = [];
    let clock = 500;
    const kernel = createModernGisOrchestratedKernel({
      now: () => clock,
      viewOrchestrationOptions: {
        onEvent: (event) => events.push(event),
      },
    });

    clock = 750;
    kernel.updateView({ kind: '3d', scale: 12_000 });

    expect(events.at(-1)?.timestamp).toBe(750);
    expect(kernel.viewOrchestration.snapshot().currentView).toMatchObject({
      kind: '3d',
      scale: 12_000,
    });
  });

  it('forwards kernel view updates into Scene LOD scale planning', () => {
    const kernel = createModernGisOrchestratedKernel();
    kernel.viewOrchestration.registerSceneLodResource(sceneResource('buildings'));

    kernel.updateView({ kind: '3d', scale: 4_500 });

    expect(kernel.viewOrchestration.planSceneLod().scale).toBe(4_500);
  });

  it('keeps Scene LOD resources available when the quality tier changes', () => {
    const kernel = createModernGisOrchestratedKernel();
    kernel.viewOrchestration.registerSceneLodResource(sceneResource('buildings'));
    const before = kernel.getViewOrchestrationSnapshot();

    kernel.setQualityTier('economy', 'battery');
    const after = kernel.getViewOrchestrationSnapshot();

    expect(before.sceneLod.decisions.map((entry) => entry.resourceId)).toEqual(['buildings']);
    expect(after.sceneLod.decisions.map((entry) => entry.resourceId)).toEqual(['buildings']);
    expect(after.metrics.budgetUpdates).toBeGreaterThanOrEqual(1);
  });

  it('does not rebuild the orchestration budget when a kernel operation leaves the budget unchanged', () => {
    const kernel = createModernGisOrchestratedKernel();
    const before = kernel.getViewOrchestrationSnapshot().metrics.budgetUpdates;

    kernel.updateView({ kind: '2d', scale: 10_000 });
    kernel.updateView({ kind: '2d', scale: 9_000 });

    const after = kernel.getViewOrchestrationSnapshot().metrics.budgetUpdates;
    expect(after).toBeGreaterThanOrEqual(before);
    expect(after).toBeLessThanOrEqual(before + 2);
  });

  it('provides Scene section planning from the production kernel surface', () => {
    const kernel = createModernGisOrchestratedKernel();
    kernel.viewOrchestration.upsertSceneSection({
      id: 'building-cut',
      layerIds: ['buildings'],
      planes: [{
        id: 'east-west',
        origin: { x: 32.85, y: 39.93, z: 900 },
        normal: { x: 1, y: 0, z: 0 },
      }],
    });

    const admitted = kernel.viewOrchestration.planSceneSections({ layerIds: ['buildings'] });
    const filtered = kernel.viewOrchestration.planSceneSections({ layerIds: ['roads'] });

    expect(admitted.admittedPlanes).toBe(1);
    expect(filtered.admittedPlanes).toBe(0);
    expect(filtered.decisions[0]).toMatchObject({ reason: 'layer-filter' });
  });

  it('owns layer-view resource lifecycle through the production kernel extension', async () => {
    const kernel = createModernGisOrchestratedKernel();
    const dispose = vi.fn();
    kernel.viewOrchestration.registerLayerView({
      key: { layerId: 'roads', mode: '2d' },
      priority: 'normal',
      load: async () => ({ dispose }),
    });

    await kernel.viewOrchestration.ensureLayerView({ layerId: 'roads', mode: '2d' });
    await kernel.viewOrchestration.removeLayerView({ layerId: 'roads', mode: '2d' });

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(kernel.getViewOrchestrationSnapshot().layerViews.entries).toHaveLength(0);
  });

  it('executes 2D to 3D transitions from the production kernel extension', async () => {
    const kernel = createModernGisOrchestratedKernel();
    kernel.viewOrchestration.seedViewTransition(state2d());

    const result = await kernel.viewOrchestration.transitionView(
      { target: state3d(), intent: 'user' },
      async ({ target }) => target,
    );

    expect(result).toMatchObject({ stale: false, state: { mode: '3d' } });
    expect(kernel.getViewOrchestrationSnapshot().transitions.historySize).toBe(2);
  });

  it('combines base-kernel and view-orchestration diagnostics', () => {
    const kernel = createModernGisOrchestratedKernel();
    kernel.updateView({ kind: '3d', scale: 5_000 });

    const diagnostics = kernel.getDiagnostics();

    expect(diagnostics).toMatchObject({
      kernel: expect.any(Object),
      scheduler: expect.anything(),
      lifecycle: expect.anything(),
      render: expect.any(Object),
      queryControlPlane: expect.any(Object),
      viewOrchestration: expect.objectContaining({
        mode: '3d',
        scale: 5_000,
      }),
    });
    expect(Object.isFrozen(diagnostics)).toBe(true);
  });

  it('keeps base-kernel service and query registration behavior intact', async () => {
    const kernel = createModernGisOrchestratedKernel();
    kernel.registerService({
      serviceId: 'parcels',
      url: 'https://example.test/arcgis/rest/services/parcels/FeatureServer/0',
      allowUnknownUrl: true,
      metadata: {
        type: 'Feature Layer',
        capabilities: 'Query',
        maxRecordCount: 1000,
        objectIdField: 'OBJECTID',
        fields: [{ name: 'OBJECTID', type: 'esriFieldTypeOID' }],
      },
    });

    const result = await kernel.executeQuery({
      serviceId: 'parcels',
      execute: async (request) => ({ request, features: [] }),
    });

    expect(result.value).toMatchObject({ features: [] });
    expect(result.fromScheduler).toBe(true);
  });

  it('propagates frame-driven render budget changes without exposing a second render authority', () => {
    const kernel = createModernGisOrchestratedKernel();
    const before = kernel.getSnapshot().renderBudget;

    for (let index = 0; index < 20; index += 1) kernel.recordFrame(80);

    const after = kernel.getSnapshot().renderBudget;
    expect(kernel.viewOrchestration.snapshot().budget.sceneLod.maxGpuBytes).toBe(
      Math.floor(after.maxResidentBytes * 0.45),
    );
    expect(kernel.getSnapshot().renderBudget).toBe(after);
    expect(before.tier).toBeDefined();
  });

  it('disposes orchestration resources before completing parent-kernel destruction', async () => {
    const kernel = createModernGisOrchestratedKernel();
    const dispose = vi.fn();
    kernel.viewOrchestration.registerLayerView({
      key: { layerId: 'owned', mode: '3d' },
      priority: 'high',
      load: async () => ({ dispose }),
    });
    await kernel.viewOrchestration.ensureLayerView({ layerId: 'owned', mode: '3d' });

    await kernel.destroy();
    await kernel.destroy();

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(kernel.isDestroyed()).toBe(true);
    expect(kernel.getViewOrchestrationSnapshot().disposed).toBe(true);
    expect(() => kernel.updateView({ kind: '2d', scale: 1_000 })).toThrow(/destroyed/i);
  });

  it('keeps orchestration state isolated between kernel instances', () => {
    const first = createModernGisOrchestratedKernel();
    const second = createModernGisOrchestratedKernel();
    first.viewOrchestration.registerSceneLodResource(sceneResource('first-only'));
    first.viewOrchestration.upsertSceneSection({
      id: 'first-section',
      planes: [{
        id: 'plane',
        origin: { x: 0, y: 0, z: 0 },
        normal: { x: 1, y: 0, z: 0 },
      }],
    });

    expect(first.getViewOrchestrationSnapshot().sceneLod.decisions).toHaveLength(1);
    expect(second.getViewOrchestrationSnapshot().sceneLod.decisions).toHaveLength(0);
    expect(first.getViewOrchestrationSnapshot().sceneSections.sections).toBe(1);
    expect(second.getViewOrchestrationSnapshot().sceneSections.sections).toBe(0);
  });
});
