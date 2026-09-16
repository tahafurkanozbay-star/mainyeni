import {
  createLayerLifecycleCoordinator,
  type LayerViewHandle,
} from './layerLifecycleCoordinator';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('layerLifecycleCoordinator', () => {
  it('creates one handle per layer/mode and reuses it deterministically', async () => {
    const created: string[] = [];
    const coordinator = createLayerLifecycleCoordinator({
      factory: {
        createLayerView: async ({ layerId, mode }) => {
          created.push(`${layerId}:${mode}`);
          return { layerId, mode };
        },
      },
    });
    coordinator.register({ layerId: 'poi', visible: true });
    const first = await coordinator.ensure('poi', '2d');
    const second = await coordinator.ensure('poi', '2d');
    expect(first).toBe(second);
    expect(created).toEqual(['poi:2d']);
    expect(coordinator.snapshot('poi')?.handles.mode2d).toBe(true);
    await coordinator.destroy();
  });

  it('applies shared visibility, opacity and selection to both 2D and 3D handles', async () => {
    const state = new Map<string, { visible?: boolean; opacity?: number; selection?: readonly (string | number)[] }>();
    const coordinator = createLayerLifecycleCoordinator({
      factory: {
        createLayerView: async ({ layerId, mode }): Promise<LayerViewHandle> => {
          const key = `${layerId}:${mode}`;
          state.set(key, {});
          return {
            layerId,
            mode,
            setVisible: (visible) => { state.get(key)!.visible = visible; },
            setOpacity: (opacity) => { state.get(key)!.opacity = opacity; },
            setSelection: (selection) => { state.get(key)!.selection = [...selection]; },
            clearSelection: () => { state.get(key)!.selection = []; },
          };
        },
      },
    });
    coordinator.register({ layerId: 'poi', visible: true, opacity: 0.75 });
    await coordinator.ensure('poi', '2d');
    await coordinator.ensure('poi', '3d');
    await coordinator.setOpacity('poi', 0.4);
    await coordinator.setSelection('poi', [0, 1, 1, '2']);
    await coordinator.setVisible('poi', false);
    expect(state.get('poi:2d')).toMatchObject({ visible: false, opacity: 0.4, selection: [0, 1, '2'] });
    expect(state.get('poi:3d')).toMatchObject({ visible: false, opacity: 0.4, selection: [0, 1, '2'] });
    await coordinator.destroy();
  });

  it('rejects mismatched handles returned by an SDK adapter', async () => {
    const coordinator = createLayerLifecycleCoordinator({
      factory: {
        createLayerView: async ({ mode }) => ({ layerId: 'wrong', mode }),
      },
    });
    coordinator.register({ layerId: 'poi' });
    await expect(coordinator.ensure('poi', '2d')).rejects.toMatchObject({ code: 'MISMATCHED_LAYER_VIEW' });
    expect(coordinator.snapshot('poi')?.state).toBe('error');
    await coordinator.destroy();
  });

  it('discards stale asynchronous creation after unregister', async () => {
    let resolveHandle: ((handle: LayerViewHandle) => void) | null = null;
    let destroyed = 0;
    const coordinator = createLayerLifecycleCoordinator({
      factory: {
        createLayerView: ({ layerId, mode }) => new Promise<LayerViewHandle>((resolve) => {
          resolveHandle = resolve;
        }).then((handle) => ({
          ...handle,
          layerId,
          mode,
          destroy: () => { destroyed += 1; },
        })),
      },
    });
    coordinator.register({ layerId: 'poi' });
    const pending = coordinator.ensure('poi', '2d');
    const unregister = coordinator.unregister('poi');
    await flush();
    resolveHandle?.({ layerId: 'poi', mode: '2d' });
    await expect(pending).rejects.toBeDefined();
    await unregister;
    expect(destroyed).toBeGreaterThanOrEqual(1);
    expect(coordinator.snapshot('poi')).toBeNull();
    await coordinator.destroy();
  });

  it('suspends inactive mode handles when retained and destroys them when not retained', async () => {
    const suspended: string[] = [];
    const destroyed: string[] = [];
    const coordinator = createLayerLifecycleCoordinator({
      factory: {
        createLayerView: async ({ layerId, mode }) => ({
          layerId,
          mode,
          suspend: () => { suspended.push(`${layerId}:${mode}`); },
          destroy: () => { destroyed.push(`${layerId}:${mode}`); },
        }),
      },
    });
    coordinator.register({ layerId: 'retained', retainWhenHidden: true });
    coordinator.register({ layerId: 'ephemeral', retainWhenHidden: false });
    await coordinator.ensure('retained', '2d');
    await coordinator.ensure('ephemeral', '2d');
    await coordinator.activateMode('3d', ['retained', 'ephemeral']);
    expect(suspended).toContain('retained:2d');
    expect(destroyed).toContain('ephemeral:2d');
    expect(coordinator.snapshot('retained')?.handles.mode3d).toBe(true);
    expect(coordinator.snapshot('ephemeral')?.handles.mode3d).toBe(true);
    await coordinator.destroy();
  });

  it('enforces per-layer 2D/3D mode restrictions', async () => {
    const coordinator = createLayerLifecycleCoordinator({
      factory: { createLayerView: async ({ layerId, mode }) => ({ layerId, mode }) },
    });
    coordinator.register({ layerId: 'scene', allow2d: false, allow3d: true });
    await expect(coordinator.ensure('scene', '2d')).rejects.toMatchObject({ code: 'VIEW_MODE_NOT_ALLOWED' });
    await expect(coordinator.ensure('scene', '3d')).resolves.toMatchObject({ layerId: 'scene', mode: '3d' });
    await coordinator.destroy();
  });

  it('cleans all pending work, handles and subscriptions on destroy', async () => {
    const destroyed: string[] = [];
    const events: string[] = [];
    const coordinator = createLayerLifecycleCoordinator({
      factory: {
        createLayerView: async ({ layerId, mode }) => ({
          layerId,
          mode,
          destroy: () => { destroyed.push(`${layerId}:${mode}`); },
        }),
      },
    });
    coordinator.register({ layerId: 'a' });
    coordinator.register({ layerId: 'b' });
    coordinator.subscribe((event) => events.push(event.type));
    await coordinator.ensure('a', '2d');
    await coordinator.ensure('b', '3d');
    await coordinator.destroy();
    expect(destroyed.sort()).toEqual(['a:2d', 'b:3d']);
    expect(coordinator.snapshots()).toEqual([]);
    expect(() => coordinator.register({ layerId: 'c' })).toThrow('destroyed');
    expect(events.length).toBeGreaterThan(0);
  });
});
