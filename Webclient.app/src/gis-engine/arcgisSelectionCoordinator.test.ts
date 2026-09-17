import { describe, expect, it, vi } from 'vitest';
import { adaptArcGisLayerMetadata } from './arcgisMetadataAdapter';
import {
  createArcGisSelectionCoordinator,
  ArcGisSelectionCoordinatorError,
} from './arcgisSelectionCoordinator';
import type { ArcGisQueryTransport, ArcGisQueryTransportResponse } from './arcgisQueryExecutor';

const contract = adaptArcGisLayerMetadata({
  id: 0,
  name: 'Parcels',
  type: 'Feature Layer',
  geometryType: 'esriGeometryPolygon',
  objectIdField: 'OBJECTID',
  maxRecordCount: 1000,
  capabilities: 'Query',
  advancedQueryCapabilities: {
    supportsPagination: true,
    supportsOrderBy: true,
  },
  spatialReference: { wkid: 3857 },
  fields: [
    { name: 'OBJECTID', alias: 'OBJECTID', type: 'esriFieldTypeOID', nullable: false, editable: false },
    { name: 'NAME', alias: 'Name', type: 'esriFieldTypeString', nullable: true, editable: true },
  ],
}, 'https://example.test/arcgis/rest/services/Parcels/FeatureServer/0');

const response = (features: readonly unknown[], exceededTransferLimit = false): ArcGisQueryTransportResponse => ({
  ok: true,
  status: 200,
  json: async () => ({ features, exceededTransferLimit }),
});

const feature = (id: number, name = `Feature ${id}`) => ({
  attributes: { OBJECTID: id, NAME: name },
  geometry: { x: id, y: id },
});

describe('arcgisSelectionCoordinator', () => {
  it('replaces selection and preserves object id zero', async () => {
    const transport: ArcGisQueryTransport = vi.fn(async () => response([feature(0), feature(2)]));
    const coordinator = createArcGisSelectionCoordinator({ transport });
    const selected = await coordinator.select({ layerId: 'parcels', contract });
    expect(selected.status).toBe('ready');
    expect(selected.identities).toEqual([0, 2]);
    expect(selected.features).toHaveLength(2);
    expect(coordinator.snapshot('parcels')).toBe(selected);
  });

  it('adds and removes identities deterministically', async () => {
    const batches = [[feature(1), feature(2)], [feature(2), feature(3)], [feature(2)]];
    let call = 0;
    const transport: ArcGisQueryTransport = vi.fn(async () => response(batches[call++] ?? []));
    const coordinator = createArcGisSelectionCoordinator({ transport });
    await coordinator.select({ layerId: 'parcels', contract, mode: 'replace' });
    const added = await coordinator.select({ layerId: 'parcels', contract, mode: 'add' });
    expect(added.identities).toEqual([1, 2, 3]);
    const removed = await coordinator.select({ layerId: 'parcels', contract, mode: 'remove' });
    expect(removed.identities).toEqual([1, 3]);
  });

  it('cancels an older same-layer request when newer user intent arrives', async () => {
    let resolveFirst: ((value: ArcGisQueryTransportResponse) => void) | undefined;
    const first = new Promise<ArcGisQueryTransportResponse>((resolve) => { resolveFirst = resolve; });
    let call = 0;
    const transport: ArcGisQueryTransport = vi.fn(async (request) => {
      call += 1;
      if (call === 1) {
        await first;
        if (request.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        return response([feature(1)]);
      }
      return response([feature(9)]);
    });
    const coordinator = createArcGisSelectionCoordinator({ transport });
    const stale = coordinator.select({ layerId: 'parcels', contract });
    const fresh = coordinator.select({ layerId: 'parcels', contract });
    resolveFirst?.(response([feature(1)]));
    const staleResult = await stale;
    expect(staleResult.revision).toBe(2);
    await expect(fresh).resolves.toMatchObject({ status: 'ready', revision: 2, identities: [9] });
    expect(coordinator.snapshot('parcels')).toMatchObject({ status: 'ready', revision: 2, identities: [9] });
  });

  it('does not cancel requests owned by another layer', async () => {
    const signals: AbortSignal[] = [];
    const transport: ArcGisQueryTransport = vi.fn(async (request) => {
      signals.push(request.signal);
      return response([feature(signals.length)]);
    });
    const coordinator = createArcGisSelectionCoordinator({ transport });
    await Promise.all([
      coordinator.select({ layerId: 'parcels-a', contract }),
      coordinator.select({ layerId: 'parcels-b', contract }),
    ]);
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
  });

  it('propagates caller cancellation and restores previous stable selection', async () => {
    let call = 0;
    const transport: ArcGisQueryTransport = vi.fn(async (request) => {
      call += 1;
      if (call === 1) return response([feature(4)]);
      await new Promise<void>((resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      });
      return response([]);
    });
    const coordinator = createArcGisSelectionCoordinator({ transport });
    await coordinator.select({ layerId: 'parcels', contract });
    const controller = new AbortController();
    const pending = coordinator.select({ layerId: 'parcels', contract }, { signal: controller.signal });
    controller.abort('navigation changed');
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(coordinator.snapshot('parcels')).toMatchObject({ status: 'idle', identities: [4] });
  });

  it('rejects transfer-limited selection rather than silently presenting partial evidence', async () => {
    const transport: ArcGisQueryTransport = vi.fn(async () => response([feature(1)], true));
    const coordinator = createArcGisSelectionCoordinator({ transport });
    await expect(coordinator.select({ layerId: 'parcels', contract })).rejects.toMatchObject({
      code: 'TRANSFER_LIMIT_EXCEEDED',
    });
    expect(coordinator.snapshot('parcels').status).toBe('error');
  });

  it('enforces bounded selection memory', async () => {
    const transport: ArcGisQueryTransport = vi.fn(async () => response([feature(1), feature(2), feature(3)]));
    const coordinator = createArcGisSelectionCoordinator({ transport, defaultMaxSelectionSize: 2 });
    await expect(coordinator.select({ layerId: 'parcels', contract })).rejects.toMatchObject({
      code: 'SELECTION_BUDGET_EXCEEDED',
    });
  });

  it('clear invalidates pending revision and returns an empty stable snapshot', async () => {
    let release: (() => void) | undefined;
    const transport: ArcGisQueryTransport = vi.fn(async (request) => {
      await new Promise<void>((resolve) => { release = resolve; });
      if (request.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      return response([feature(8)]);
    });
    const coordinator = createArcGisSelectionCoordinator({ transport });
    const pending = coordinator.select({ layerId: 'parcels', contract });
    const cleared = coordinator.clear('parcels');
    release?.();
    await expect(pending).resolves.toBe(cleared);
    expect(cleared).toMatchObject({ status: 'idle', identities: [] });
  });

  it('cancel returns whether an active request was actually cancelled', async () => {
    let release: (() => void) | undefined;
    const transport: ArcGisQueryTransport = vi.fn(async (request) => {
      await new Promise<void>((resolve) => { release = resolve; });
      if (request.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      return response([]);
    });
    const coordinator = createArcGisSelectionCoordinator({ transport });
    const pending = coordinator.select({ layerId: 'parcels', contract });
    expect(coordinator.cancel('parcels')).toBe(true);
    expect(coordinator.cancel('parcels')).toBe(false);
    release?.();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('disposes all pending work and rejects future mutation', async () => {
    const transport: ArcGisQueryTransport = vi.fn(async (request) => {
      await new Promise<void>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      });
      return response([]);
    });
    const coordinator = createArcGisSelectionCoordinator({ transport });
    const pending = coordinator.select({ layerId: 'parcels', contract });
    coordinator.dispose();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await expect(coordinator.select({ layerId: 'parcels', contract })).rejects.toBeInstanceOf(ArcGisSelectionCoordinatorError);
  });

  it('rejects invalid layer identifiers before transport', async () => {
    const transport: ArcGisQueryTransport = vi.fn(async () => response([]));
    const coordinator = createArcGisSelectionCoordinator({ transport });
    await expect(coordinator.select({ layerId: '   ', contract })).rejects.toMatchObject({ code: 'INVALID_LAYER_ID' });
    expect(transport).not.toHaveBeenCalled();
  });
});
