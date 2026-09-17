import { describe, expect, it, vi } from 'vitest';
import { createSceneContentOrchestrator } from './sceneContentOrchestrator';

describe('scene content budget regression', () => {
  it('keeps over-budget content blocked and invisible without invoking the layer factory', async () => {
    const add = vi.fn();
    const remove = vi.fn();
    const factory = vi.fn(async () => ({ loaded: true, visible: true }));
    const runtime = createSceneContentOrchestrator({ map: { add, remove } }, factory, {
      limits: {
        maxCpuBytes: 1,
        maxGpuBytes: 1,
        maxDrawCalls: 1,
        maxFeatures: 1,
        maxResources: 1,
        maxResourcesPerLayer: 1,
      },
    });

    runtime.register({
      id: 'oversized-building',
      title: 'Oversized building',
      kind: 'building',
      loadPolicy: 'eager',
      priority: 'visible',
      estimate: {
        cpuBytes: 2,
        gpuBytes: 2,
        drawCalls: 2,
        features: 2,
      },
    });

    runtime.setActive(true);
    await runtime.reconcile('budget-regression');
    await runtime.reconcile('budget-regression-repeat');

    const record = runtime.getSnapshot().records.find((candidate) => candidate.id === 'oversized-building');
    expect(record).toMatchObject({
      status: 'blocked',
      admitted: false,
      effectiveVisible: false,
      layerAttached: false,
    });
    expect(factory).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();

    runtime.dispose();
  });
});
