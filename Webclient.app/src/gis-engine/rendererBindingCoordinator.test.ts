import { describe, expect, it, vi } from 'vitest';
import type { ArcGisLayerDescriptor } from './arcgisLayerAdapter';
import {
  createRendererBindingCoordinator,
  RendererBindingCoordinatorError,
  type RendererLayerHandle,
} from './rendererBindingCoordinator';

const descriptor = (id: string, overrides: Partial<ArcGisLayerDescriptor> = {}): ArcGisLayerDescriptor => Object.freeze({
  id,
  kind: 'feature',
  resourceUrl: `https://example.test/arcgis/rest/services/${id}/FeatureServer/0`,
  title: id,
  mode: '2d',
  visible: true,
  opacity: 1,
  minScale: 100000,
  maxScale: 1000,
  popupEnabled: true,
  labelsEnabled: false,
  queryable: true,
  selectable: true,
  objectIdField: 'OBJECTID',
  geometryType: 'polygon',
  spatialReference: { wkid: 3857 },
  ...overrides,
});

const handleFor = (value: ArcGisLayerDescriptor, apply = vi.fn(), destroy = vi.fn()): RendererLayerHandle => ({
  id: value.id,
  mode: value.mode,
  resourceUrl: value.resourceUrl,
  apply,
  destroy,
});

describe('rendererBindingCoordinator', () => {
  it('binds a verified renderer-neutral descriptor and exposes ready state', async () => {
    const factory = vi.fn(async ({ descriptor: value }) => handleFor(value));
    const coordinator = createRendererBindingCoordinator({ factory });
    const ready = await coordinator.bind(descriptor('parcels'));
    expect(ready).toMatchObject({ id: 'parcels', status: 'ready', revision: 1, mode: '2d' });
    expect(coordinator.snapshot('parcels')).toBe(ready);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('patches renderer state without recreating a stable resource identity', async () => {
    const apply = vi.fn();
    const destroy = vi.fn();
    const factory = vi.fn(async ({ descriptor: value }) => handleFor(value, apply, destroy));
    const coordinator = createRendererBindingCoordinator({ factory });
    const first = descriptor('roads');
    await coordinator.bind(first);
    const updated = await coordinator.bind(descriptor('roads', { visible: false, opacity: 0.4, minScale: 50000, maxScale: 500 }));
    expect(updated).toMatchObject({ status: 'ready', revision: 2, visible: false, opacity: 0.4 });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith({ visible: false, opacity: 0.4, minScale: 50000, maxScale: 500 });
    expect(destroy).not.toHaveBeenCalled();
  });

  it('does not call apply when a stable descriptor has no renderer-state changes', async () => {
    const apply = vi.fn();
    const factory = vi.fn(async ({ descriptor: value }) => handleFor(value, apply));
    const coordinator = createRendererBindingCoordinator({ factory });
    const value = descriptor('buildings');
    await coordinator.bind(value);
    const second = await coordinator.bind(value);
    expect(second.revision).toBe(2);
    expect(apply).not.toHaveBeenCalled();
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('recreates the renderer handle when mode changes', async () => {
    const destroyed: string[] = [];
    const factory = vi.fn(async ({ descriptor: value }) => handleFor(value, vi.fn(), () => { destroyed.push(`${value.id}:${value.mode}`); }));
    const coordinator = createRendererBindingCoordinator({ factory });
    await coordinator.bind(descriptor('terrain'));
    const scene = await coordinator.bind(descriptor('terrain', { mode: '3d' }));
    expect(scene.mode).toBe('3d');
    expect(factory).toHaveBeenCalledTimes(2);
    expect(destroyed).toEqual(['terrain:2d']);
  });

  it('recreates the renderer handle when verified resource identity changes', async () => {
    const destroy = vi.fn();
    const factory = vi.fn(async ({ descriptor: value }) => handleFor(value, vi.fn(), destroy));
    const coordinator = createRendererBindingCoordinator({ factory });
    await coordinator.bind(descriptor('zoning'));
    const changed = descriptor('zoning', { resourceUrl: 'https://example.test/arcgis/rest/services/ZoningV2/FeatureServer/0' });
    await coordinator.bind(changed);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('destroys a stale handle that resolves after a newer binding wins', async () => {
    let releaseFirst: ((handle: RendererLayerHandle) => void) | undefined;
    const staleDestroy = vi.fn();
    const first = new Promise<RendererLayerHandle>((resolve) => { releaseFirst = resolve; });
    let calls = 0;
    const factory = vi.fn(async ({ descriptor: value }) => {
      calls += 1;
      if (calls === 1) return first;
      return handleFor(value);
    });
    const coordinator = createRendererBindingCoordinator({ factory });
    const oldDescriptor = descriptor('parcels');
    const stale = coordinator.bind(oldDescriptor);
    const freshDescriptor = descriptor('parcels', { mode: '3d' });
    const fresh = coordinator.bind(freshDescriptor);
    releaseFirst?.(handleFor(oldDescriptor, vi.fn(), staleDestroy));
    await stale;
    await expect(fresh).resolves.toMatchObject({ status: 'ready', mode: '3d', revision: 2 });
    expect(staleDestroy).toHaveBeenCalledTimes(1);
    expect(coordinator.snapshot('parcels')).toMatchObject({ status: 'ready', mode: '3d', revision: 2 });
  });

  it('rejects a renderer handle whose identity does not match the descriptor', async () => {
    const destroy = vi.fn();
    const factory = vi.fn(async ({ descriptor: value }) => ({ ...handleFor(value, vi.fn(), destroy), resourceUrl: `${value.resourceUrl}/wrong` }));
    const coordinator = createRendererBindingCoordinator({ factory });
    await expect(coordinator.bind(descriptor('parcels'))).rejects.toMatchObject({ code: 'HANDLE_IDENTITY_MISMATCH' });
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(coordinator.snapshot('parcels')).toMatchObject({ status: 'error' });
  });

  it('records bounded renderer errors without losing the previous handle during patch failure', async () => {
    const apply = vi.fn(async () => { throw new Error('renderer rejected patch'); });
    const destroy = vi.fn();
    const factory = vi.fn(async ({ descriptor: value }) => handleFor(value, apply, destroy));
    const coordinator = createRendererBindingCoordinator({ factory });
    await coordinator.bind(descriptor('roads'));
    await expect(coordinator.bind(descriptor('roads', { opacity: 0.2 }))).rejects.toThrow('renderer rejected patch');
    expect(coordinator.snapshot('roads')).toMatchObject({ status: 'error', revision: 2, error: 'renderer rejected patch' });
    expect(destroy).not.toHaveBeenCalled();
  });

  it('rejects duplicate ids before mutating a batch', async () => {
    const factory = vi.fn(async ({ descriptor: value }) => handleFor(value));
    const coordinator = createRendererBindingCoordinator({ factory });
    await expect(coordinator.bindAll([descriptor('a'), descriptor('a')])).rejects.toMatchObject({ code: 'DUPLICATE_LAYER_ID' });
    expect(factory).not.toHaveBeenCalled();
    expect(coordinator.snapshots()).toHaveLength(0);
  });

  it('enforces a bounded renderer ownership budget', async () => {
    const factory = vi.fn(async ({ descriptor: value }) => handleFor(value));
    const coordinator = createRendererBindingCoordinator({ factory, maximumBindings: 1 });
    await coordinator.bind(descriptor('a'));
    await expect(coordinator.bind(descriptor('b'))).rejects.toMatchObject({ code: 'BINDING_BUDGET_EXCEEDED' });
    expect(coordinator.snapshots()).toHaveLength(1);
  });

  it('reconcile releases absent layers and retains desired layers', async () => {
    const destroys = new Map<string, ReturnType<typeof vi.fn>>();
    const factory = vi.fn(async ({ descriptor: value }) => {
      const destroy = vi.fn();
      destroys.set(`${value.id}:${value.mode}`, destroy);
      return handleFor(value, vi.fn(), destroy);
    });
    const coordinator = createRendererBindingCoordinator({ factory });
    await coordinator.bindAll([descriptor('a'), descriptor('b')]);
    const result = await coordinator.reconcile([descriptor('b'), descriptor('c')]);
    expect(result.map((item) => item.id)).toEqual(['b', 'c']);
    expect(coordinator.snapshot('a')).toBeNull();
    expect(destroys.get('a:2d')).toHaveBeenCalledTimes(1);
  });

  it('release aborts pending ownership and destroys a late handle', async () => {
    let releaseFactory: ((handle: RendererLayerHandle) => void) | undefined;
    const destroy = vi.fn();
    const pendingHandle = new Promise<RendererLayerHandle>((resolve) => { releaseFactory = resolve; });
    const factory = vi.fn(async () => pendingHandle);
    const coordinator = createRendererBindingCoordinator({ factory });
    const value = descriptor('pending');
    const pending = coordinator.bind(value);
    expect(await coordinator.release('pending')).toBe(true);
    expect(await coordinator.release('pending')).toBe(false);
    releaseFactory?.(handleFor(value, vi.fn(), destroy));
    await pending;
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(coordinator.snapshot('pending')).toBeNull();
  });

  it('releaseMode only removes bindings owned by the requested renderer mode', async () => {
    const destroy = vi.fn();
    const factory = vi.fn(async ({ descriptor: value }) => handleFor(value, vi.fn(), destroy));
    const coordinator = createRendererBindingCoordinator({ factory });
    await coordinator.bindAll([descriptor('map'), descriptor('scene', { mode: '3d' })]);
    expect(await coordinator.releaseMode('3d')).toBe(1);
    expect(coordinator.snapshot('scene')).toBeNull();
    expect(coordinator.snapshot('map')).toMatchObject({ status: 'ready', mode: '2d' });
  });

  it('dispose releases all handles and makes future mutation fail closed', async () => {
    const destroy = vi.fn();
    const factory = vi.fn(async ({ descriptor: value }) => handleFor(value, vi.fn(), destroy));
    const coordinator = createRendererBindingCoordinator({ factory });
    await coordinator.bindAll([descriptor('a'), descriptor('b')]);
    await coordinator.dispose();
    await coordinator.dispose();
    expect(destroy).toHaveBeenCalledTimes(2);
    expect(coordinator.snapshots()).toHaveLength(0);
    await expect(coordinator.bind(descriptor('c'))).rejects.toBeInstanceOf(RendererBindingCoordinatorError);
  });

  it('validates binding budgets and factory contracts at construction', () => {
    expect(() => createRendererBindingCoordinator({ factory: null as never })).toThrowError(/factory/i);
    expect(() => createRendererBindingCoordinator({ factory: async ({ descriptor: value }) => handleFor(value), maximumBindings: 0 })).toThrowError(/budget/i);
    expect(() => createRendererBindingCoordinator({ factory: async ({ descriptor: value }) => handleFor(value), maximumBindings: 5000 })).toThrowError(/budget/i);
  });
});
