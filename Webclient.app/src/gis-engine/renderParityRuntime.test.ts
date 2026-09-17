import { describe, expect, it } from 'vitest';
import {
  createRenderParityRuntime,
  reconcileRenderLayerState,
  RenderParityRuntime,
} from './renderParityRuntime';

describe('renderParityRuntime', () => {
  it('creates deterministic operations from desired state', () => {
    const result = reconcileRenderLayerState(null, {
      id: 'parks',
      visible: true,
      opacity: 0.75,
      order: 3,
      scale: { minScale: 50_000, maxScale: 100 },
      renderer: { key: 'park-fill', iconKey: 'park', symbolKind: 'fill' },
      filter: 'ACTIVE = 1',
      popupEnabled: false,
      selectedIds: [3, 2, 3],
    }, {
      viewMode: '2d',
      scale: 10_000,
    });

    expect(result.state).toMatchObject({
      id: 'parks',
      opacity: 0.75,
      order: 3,
      rendererKey: 'park-fill',
      iconKey: 'park',
      filter: 'ACTIVE = 1',
      popupEnabled: false,
      selectedIds: [3, 2],
      effectiveVisible: true,
    });
    expect(result.operations.map((item) => item.kind)).toEqual(expect.arrayContaining([
      'set-opacity',
      'set-scale-range',
      'set-renderer',
      'set-filter',
      'set-popup',
      'set-selection',
      'set-order',
    ]));
  });

  it('never derives a new icon mapping and preserves the supplied shared icon key', () => {
    const result = reconcileRenderLayerState(null, {
      id: 'poi',
      renderer: { key: 'poi-renderer', iconKey: 'shared-icon-authority-key' },
    }, { viewMode: '2d' });

    expect(result.state.iconKey).toBe('shared-icon-authority-key');
    const rendererOperation = result.operations.find((item) => item.kind === 'set-renderer');
    expect(rendererOperation?.payload.iconKey).toBe('shared-icon-authority-key');
  });

  it('applies identical renderer identity in 2D and 3D while limiting elevation to 3D', () => {
    const desired = {
      id: 'buildings',
      renderer: { key: 'building-renderer', iconKey: 'building' },
      elevationMode: 'relative-to-ground',
    };
    const twoD = reconcileRenderLayerState(null, desired, { viewMode: '2d' });
    const threeD = reconcileRenderLayerState(null, desired, { viewMode: '3d', allow3dElevation: true });

    expect(twoD.state.rendererKey).toBe(threeD.state.rendererKey);
    expect(twoD.state.iconKey).toBe(threeD.state.iconKey);
    expect(twoD.state.elevationMode).toBeNull();
    expect(threeD.state.elevationMode).toBe('relative-to-ground');
  });

  it('hides layers outside their scale range without losing desired visibility', () => {
    const result = reconcileRenderLayerState(null, {
      id: 'detail',
      visible: true,
      scale: { minScale: 5_000, maxScale: 500 },
    }, { viewMode: '2d', scale: 20_000 });

    expect(result.state.visible).toBe(true);
    expect(result.state.effectiveVisible).toBe(false);
    expect(result.state.visibilityReason).toBe('scale');
  });

  it('keeps blocked layers hidden even when desired visibility is true', () => {
    const runtime = createRenderParityRuntime();
    runtime.reconcile({ id: 'terrain', visible: true }, { viewMode: '3d' });
    const blocked = runtime.setBlocked('terrain', true, { viewMode: '3d' });
    const desiredAgain = runtime.reconcile({
      id: 'terrain',
      revision: blocked.state.revision + 1,
      visible: true,
    }, { viewMode: '3d' });

    expect(desiredAgain.state.visible).toBe(true);
    expect(desiredAgain.state.effectiveVisible).toBe(false);
    expect(desiredAgain.state.visibilityReason).toBe('blocked');
  });

  it('uses a render-budget visibility reason independently from desired state', () => {
    const result = reconcileRenderLayerState(null, {
      id: 'dense-labels',
      visible: true,
    }, {
      viewMode: '2d',
      renderBudgetExceeded: true,
    });

    expect(result.state.effectiveVisible).toBe(false);
    expect(result.state.visibilityReason).toBe('budget');
  });

  it('bounds and de-duplicates selections', () => {
    const result = reconcileRenderLayerState(null, {
      id: 'selection',
      selectedIds: [1, 1, 2, 3, 4, 5],
    }, {
      viewMode: '2d',
      maxSelections: 3,
    });

    expect(result.state.selectedIds).toEqual([1, 2, 3]);
  });

  it('suppresses stale revisions and counts them', () => {
    const runtime = createRenderParityRuntime();
    const first = runtime.reconcile({ id: 'roads', revision: 5, opacity: 0.5 }, { viewMode: '2d' });
    const stale = runtime.reconcile({ id: 'roads', revision: 4, opacity: 1 }, { viewMode: '2d' });

    expect(stale.changed).toBe(false);
    expect(stale.state.opacity).toBe(first.state.opacity);
    expect(stale.operations).toHaveLength(1);
    expect(stale.operations[0]?.payload.stale).toBe(true);
    expect(runtime.snapshot().staleUpdates).toBe(1);
  });

  it('returns noop for a semantically identical state', () => {
    const runtime = createRenderParityRuntime();
    const first = runtime.reconcile({ id: 'water', opacity: 0.8 }, { viewMode: '2d' });
    const second = runtime.reconcile({
      id: 'water',
      revision: first.state.revision + 1,
      opacity: 0.8,
    }, { viewMode: '2d' });

    expect(second.changed).toBe(false);
    expect(second.operations.map((item) => item.kind)).toEqual(['noop']);
  });

  it('disposes a layer into an irreversible hidden state until removed', () => {
    const runtime = new RenderParityRuntime();
    runtime.reconcile({ id: 'temporary', selectedIds: [1, 2] }, { viewMode: '2d' });
    const disposed = runtime.disposeLayer('temporary');

    expect(disposed).toMatchObject({
      disposed: true,
      blocked: true,
      effectiveVisible: false,
      visibilityReason: 'disposed',
      selectedIds: [],
    });

    const attempted = runtime.reconcile({
      id: 'temporary',
      revision: (disposed?.revision ?? 0) + 1,
      visible: true,
      blocked: false,
    }, { viewMode: '2d' });
    expect(attempted.state.effectiveVisible).toBe(false);
    expect(attempted.state.disposed).toBe(true);

    expect(runtime.removeLayer('temporary')).toBe(true);
    expect(runtime.getState('temporary')).toBeNull();
  });

  it('sorts exported states by order then id for deterministic layer application', () => {
    const runtime = createRenderParityRuntime();
    runtime.reconcile({ id: 'z', order: 2 }, { viewMode: '2d' });
    runtime.reconcile({ id: 'b', order: 1 }, { viewMode: '2d' });
    runtime.reconcile({ id: 'a', order: 1 }, { viewMode: '2d' });

    expect(runtime.getStates().map((state) => state.id)).toEqual(['a', 'b', 'z']);
  });

  it('keeps parity fingerprints stable for equivalent normalized state', () => {
    const first = reconcileRenderLayerState(null, {
      id: 'stable',
      opacity: 5,
      selectedIds: [1, 1, 2],
    }, { viewMode: '2d' });
    const second = reconcileRenderLayerState(null, {
      id: 'stable',
      opacity: 1,
      selectedIds: [1, 2],
    }, { viewMode: '2d' });

    expect(first.parityFingerprint).toBe(second.parityFingerprint);
  });

  it('tracks runtime metrics and resets cleanly', () => {
    const runtime = createRenderParityRuntime();
    runtime.reconcile({ id: 'one', opacity: 0.5 }, { viewMode: '2d' });
    runtime.reconcile({ id: 'two', visible: false }, { viewMode: '3d' });
    runtime.disposeLayer('two');

    expect(runtime.snapshot()).toMatchObject({ layers: 2, reconciliations: 2, disposedLayers: 1 });
    runtime.reset();
    expect(runtime.snapshot()).toEqual({
      layers: 0,
      reconciliations: 0,
      operations: 0,
      staleUpdates: 0,
      blockedLayers: 0,
      disposedLayers: 0,
    });
  });
});
