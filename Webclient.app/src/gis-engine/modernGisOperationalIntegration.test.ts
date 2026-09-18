import { describe, expect, it } from 'vitest';

import { createModernGisKernel } from './modernGisKernel';

describe('modern GIS operational runtime integration', () => {
  it('exposes temporal, edit, map-state and export runtimes from the main kernel', () => {
    const kernel = createModernGisKernel({
      now: () => 1000,
    });

    expect(kernel.temporal).toBeDefined();
    expect(kernel.edits).toBeDefined();
    expect(kernel.mapState).toBeDefined();
    expect(kernel.exports).toBeDefined();
  });

  it('uses the shared kernel clock for temporal state', () => {
    let clock = 1000;
    const kernel = createModernGisKernel({
      now: () => clock,
    });

    kernel.temporal.setRange({ start: 0, end: 10_000 });
    kernel.temporal.configurePlayback({
      stepMs: 100,
      intervalMs: 100,
    });
    kernel.temporal.play();

    clock = 1100;
    const snapshot = kernel.temporal.tick();

    expect(snapshot.cursor).toBe(100);
    expect(snapshot.playback.lastTickAt).toBe(1100);
  });

  it('uses the shared kernel clock for edit transaction timestamps', () => {
    let clock = 100;
    const kernel = createModernGisKernel({
      now: () => clock,
    });

    const transaction = kernel.edits.beginTransaction({
      transactionId: 'shared-clock',
    });

    expect(transaction.createdAt).toBe(100);

    clock = 200;
    kernel.edits.stageAdd(transaction.transactionId, {
      layerId: 'assets',
      attributes: {
        status: 'new',
      },
    });

    expect(kernel.edits.getTransaction(transaction.transactionId).updatedAt).toBe(200);
  });

  it('captures map state from the shared kernel clock', () => {
    const kernel = createModernGisKernel({
      now: () => 1234,
    });

    const state = kernel.mapState.capture({
      view: {
        mode: '2d',
        center: [32.85, 39.93],
        spatialReferenceWkid: 4326,
      },
      layers: [],
    });

    expect(state.capturedAt).toBe(1234);
  });

  it('creates bounded export plans without a service endpoint', () => {
    const kernel = createModernGisKernel();

    const plan = kernel.exports.plan({
      mode: '2d',
      format: 'png',
      pageSize: 'custom',
      widthPx: 1280,
      heightPx: 720,
      layers: [
        {
          layerId: 'roads',
          visible: true,
        },
      ],
    });

    expect(plan.strategy).toBe('map-screenshot');
    expect(plan.widthPx).toBe(1280);
    expect(plan.heightPx).toBe(720);
    expect(JSON.stringify(plan)).not.toMatch(/https?:\/\//i);
  });

  it('supports one operational workflow across time, editing, persistence and export planning', async () => {
    const kernel = createModernGisKernel({
      now: () => 5000,
    });

    kernel.temporal.setRange({
      start: 0,
      end: 86_400_000,
    });
    kernel.temporal.registerLayer({
      layerId: 'maintenance',
      minimum: 0,
      maximum: 86_400_000,
      defaultWindowMs: 3_600_000,
    });
    kernel.temporal.setCursor(43_200_000);

    const transaction = kernel.edits.beginTransaction({
      transactionId: 'maintenance-edit',
      baseRevision: 'rev-7',
    });
    kernel.edits.stageUpdate(transaction.transactionId, {
      layerId: 'maintenance',
      featureId: 17,
      attributes: {
        status: 'resolved',
      },
      baseRevision: 'feature-rev-3',
    });

    const editResult = await kernel.edits.commit(
      transaction.transactionId,
      async ({ operations, baseRevision }) => ({
        revision: baseRevision === 'rev-7' ? 'rev-8' : 'unexpected',
        operationResults: operations.map((operation) => ({
          operationId: operation.operationId,
          success: true,
          featureId: operation.featureId,
        })),
      }),
    );

    const temporalPlan = kernel.temporal.getLayerPlan('maintenance');
    const state = kernel.mapState.capture({
      view: {
        mode: '2d',
        center: [32.85, 39.93],
        spatialReferenceWkid: 4326,
        scale: 25_000,
      },
      layers: [
        {
          layerId: 'maintenance',
          visible: true,
          opacity: 1,
          order: 0,
        },
      ],
      temporal: {
        cursor: temporalPlan.cursor,
        start: temporalPlan.range.start,
        end: temporalPlan.range.end,
        stepMs: temporalPlan.stepMs,
        windowMs: temporalPlan.windowMs,
      },
      metadata: {
        editRevision: editResult.revision,
      },
    });
    const exportPlan = kernel.exports.plan({
      mode: state.view.mode,
      format: 'pdf',
      title: 'Bakım Durumu',
      layers: state.layers,
      includeLegend: true,
    });

    expect(editResult.revision).toBe('rev-8');
    expect(state.temporal?.cursor).toBe(43_200_000);
    expect(exportPlan.format).toBe('pdf');
    expect(exportPlan.includeLegend).toBe(true);
  });

  it('destroys temporal and edit runtimes with the parent kernel', async () => {
    const kernel = createModernGisKernel();

    kernel.temporal.registerLayer({
      layerId: 'time-layer',
      minimum: 0,
      maximum: 100,
    });
    kernel.edits.beginTransaction({
      transactionId: 'edit',
    });

    await kernel.destroy();

    expect(kernel.isDestroyed()).toBe(true);
    expect(kernel.temporal.getSnapshot().destroyed).toBe(true);
    expect(kernel.edits.getSnapshot().destroyed).toBe(true);
    expect(() => kernel.temporal.registerLayer({
      layerId: 'late',
      minimum: 0,
      maximum: 1,
    })).toThrow(/destroyed/i);
    expect(() => kernel.edits.beginTransaction()).toThrow(/destroyed/i);
  });

  it('keeps operational state isolated across independent kernel instances', () => {
    const first = createModernGisKernel();
    const second = createModernGisKernel();

    first.temporal.registerLayer({
      layerId: 'first-only',
      minimum: 0,
      maximum: 100,
    });
    first.edits.beginTransaction({
      transactionId: 'first-edit',
    });

    expect(first.temporal.getSnapshot().registeredLayerCount).toBe(1);
    expect(second.temporal.getSnapshot().registeredLayerCount).toBe(0);
    expect(first.edits.getSnapshot().transactionCount).toBe(1);
    expect(second.edits.getSnapshot().transactionCount).toBe(0);
  });
});
