import { describe, expect, it, vi } from 'vitest';
import { createArcGisQueryPipeline } from './arcgisQueryPipeline';
import type { ArcGisMetadataContract } from './arcgisMetadataAdapter';

const contract = (overrides: Partial<ArcGisMetadataContract> = {}): ArcGisMetadataContract => ({
  resourceUrl: 'https://example.invalid/arcgis/rest/services/Kent/FeatureServer/0',
  name: 'Kent',
  type: 'Feature Layer',
  displayField: 'NAME',
  objectIdField: 'OBJECTID',
  globalIdField: null,
  geometryField: null,
  geometryType: 'point',
  spatialReference: { wkid: 4326 },
  maxRecordCount: 2,
  capabilities: new Set(['query', 'pagination', 'order-by']),
  fields: [],
  fieldMap: new Map(),
  scales: { minScale: 0, maxScale: 0 },
  time: { enabled: false, startField: null, endField: null, trackIdField: null, defaultInterval: null, defaultIntervalUnits: null },
  editing: { create: false, update: false, delete: false, sync: false, attachments: false, supportsApplyEditsWithGlobalIds: false },
  renderer: { type: null, field: null, field2: null, field3: null, normalizationField: null, visualVariableCount: 0, labelingRuleCount: 0, transparency: null },
  hasZ: false,
  hasM: false,
  issues: [],
  queryReady: true,
  identityReady: true,
  ...overrides,
});

const spec = Object.freeze({ where: 'STATUS = 1', outFields: ['OBJECTID', 'NAME'], returnGeometry: false });
const ok = (features: unknown[], exceededTransferLimit = false) => ({
  ok: true,
  status: 200,
  json: async () => ({ features, exceededTransferLimit }),
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

describe('createArcGisQueryPipeline', () => {
  it('executes a verified single ArcGIS query through injected transport', async () => {
    const transport = vi.fn(async () => ok([{ attributes: { OBJECTID: 0, NAME: 'Zero' } }]));
    const pipeline = createArcGisQueryPipeline({ transport });

    const result = await pipeline.executeSingle(contract(), spec);

    expect(result.mode).toBe('single');
    expect(result.result.features[0]?.attributes.OBJECTID).toBe(0);
    expect(result.key).toMatch(/^single:arcgis-query:/);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('deduplicates equal concurrent single queries', async () => {
    const gate = deferred<ReturnType<typeof ok>>();
    const transport = vi.fn(async () => gate.promise);
    const pipeline = createArcGisQueryPipeline({ transport });
    const metadata = contract();

    const first = pipeline.executeSingle(metadata, spec);
    const second = pipeline.executeSingle(metadata, spec);
    expect(transport).toHaveBeenCalledTimes(1);

    gate.resolve(ok([{ attributes: { OBJECTID: 1, NAME: 'A' } }]));
    const [left, right] = await Promise.all([first, second]);
    expect(left.key).toBe(right.key);
    expect(left.result.features).toEqual(right.result.features);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('isolates subscriber cancellation while shared work still has listeners', async () => {
    const gate = deferred<ReturnType<typeof ok>>();
    const transport = vi.fn(async () => gate.promise);
    const pipeline = createArcGisQueryPipeline({ transport });
    const metadata = contract();
    const controller = new AbortController();

    const cancelled = pipeline.executeSingle(metadata, spec, { signal: controller.signal });
    const survivor = pipeline.executeSingle(metadata, spec);
    controller.abort('component-unmounted');
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });

    gate.resolve(ok([{ attributes: { OBJECTID: 2, NAME: 'B' } }]));
    await expect(survivor).resolves.toMatchObject({ mode: 'single' });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('aborts underlying work when the last subscriber cancels', async () => {
    const observedSignals: AbortSignal[] = [];
    const transport = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      observedSignals.push(signal);
      return new Promise<ReturnType<typeof ok>>((resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
        void resolve;
      });
    });
    const pipeline = createArcGisQueryPipeline({ transport });
    const controller = new AbortController();
    const result = pipeline.executeSingle(contract(), spec, { signal: controller.signal });

    controller.abort('superseded');
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(observedSignals[0]?.aborted).toBe(true);
  });

  it('serves completed results from the bounded TTL cache', async () => {
    const transport = vi.fn(async () => ok([{ attributes: { OBJECTID: 3 } }]));
    const pipeline = createArcGisQueryPipeline({ transport, defaultCacheTtlMs: 10_000 });
    const metadata = contract();

    await pipeline.executeSingle(metadata, spec);
    await pipeline.executeSingle(metadata, spec);

    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('invalidates all remembered cache keys for one verified resource', async () => {
    const transport = vi.fn(async () => ok([{ attributes: { OBJECTID: 4 } }]));
    const pipeline = createArcGisQueryPipeline({ transport, defaultCacheTtlMs: 10_000 });
    const metadata = contract();
    await pipeline.executeSingle(metadata, spec);

    expect(pipeline.invalidateResource(metadata.resourceUrl)).toBe(1);
    await pipeline.executeSingle(metadata, spec);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('reads a bounded multi-page feature window with stable identity', async () => {
    const transport = vi.fn(async ({ body }: { body: URLSearchParams }) => {
      const offset = Number(body.get('resultOffset') ?? 0);
      return offset === 0
        ? ok([{ attributes: { OBJECTID: 0 } }, { attributes: { OBJECTID: 1 } }], true)
        : ok([{ attributes: { OBJECTID: 2 } }], false);
    });
    const pipeline = createArcGisQueryPipeline({ transport, defaultPageSize: 2 });

    const result = await pipeline.executeWindow(contract(), spec, { pageSize: 2, maxFeatures: 10, maxPages: 5 });

    expect(result.mode).toBe('window');
    expect(result.result.complete).toBe(true);
    expect(result.result.features.map((feature) => feature.attributes.OBJECTID)).toEqual([0, 1, 2]);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('ignores a caller-provided starting window and owns pagination from offset zero', async () => {
    const offsets: number[] = [];
    const transport = vi.fn(async ({ body }: { body: URLSearchParams }) => {
      offsets.push(Number(body.get('resultOffset') ?? 0));
      return ok([{ attributes: { OBJECTID: 1 } }], false);
    });
    const pipeline = createArcGisQueryPipeline({ transport });

    await pipeline.executeWindow(contract(), { ...spec, window: { resultOffset: 999, resultRecordCount: 1 } });

    expect(offsets).toEqual([0]);
  });

  it('rejects window execution when pagination is not verified', async () => {
    const pipeline = createArcGisQueryPipeline({ transport: vi.fn() });
    const metadata = contract({ capabilities: new Set(['query', 'order-by']) });

    await expect(pipeline.executeWindow(metadata, spec)).rejects.toMatchObject({ code: 'PAGINATION_UNSUPPORTED' });
  });

  it('rejects window execution without stable identity', async () => {
    const pipeline = createArcGisQueryPipeline({ transport: vi.fn() });
    const metadata = contract({ identityReady: false, objectIdField: null, globalIdField: null });

    await expect(pipeline.executeWindow(metadata, spec)).rejects.toMatchObject({ code: 'STABLE_IDENTITY_REQUIRED' });
  });

  it('creates deterministic window keys from query and memory budgets', () => {
    const pipeline = createArcGisQueryPipeline({ transport: vi.fn() });
    const metadata = contract();

    const first = pipeline.keyForWindow(metadata, spec, { pageSize: 2, maxFeatures: 50, maxPages: 3 });
    const same = pipeline.keyForWindow(metadata, spec, { pageSize: 2, maxFeatures: 50, maxPages: 3 });
    const different = pipeline.keyForWindow(metadata, spec, { pageSize: 1, maxFeatures: 50, maxPages: 3 });

    expect(first).toBe(same);
    expect(first).not.toBe(different);
  });

  it('keeps single and window request namespaces separate', () => {
    const pipeline = createArcGisQueryPipeline({ transport: vi.fn() });
    const metadata = contract();

    expect(pipeline.keyForSingle(metadata, spec)).toMatch(/^single:/);
    expect(pipeline.keyForWindow(metadata, spec)).toMatch(/^window:/);
    expect(pipeline.keyForSingle(metadata, spec)).not.toBe(pipeline.keyForWindow(metadata, spec));
  });

  it('enforces bounded batch cardinality before transport work', async () => {
    const transport = vi.fn(async () => ok([]));
    const pipeline = createArcGisQueryPipeline({ transport });
    const metadata = contract();
    const items = [
      { contract: metadata, spec },
      { contract: metadata, spec: { ...spec, where: 'STATUS = 2' } },
    ];

    await expect(pipeline.executeBatch(items, 1)).rejects.toMatchObject({ code: 'BATCH_BUDGET_EXCEEDED' });
    expect(transport).not.toHaveBeenCalled();
  });

  it('preserves batch result order despite independent request completion', async () => {
    const transport = vi.fn(async ({ body }: { body: URLSearchParams }) => {
      const where = body.get('where');
      return ok([{ attributes: { OBJECTID: where === 'A=1' ? 1 : 2 } }]);
    });
    const pipeline = createArcGisQueryPipeline({ transport, concurrency: 2 });
    const metadata = contract();

    const results = await pipeline.executeBatch([
      { contract: metadata, spec: { ...spec, where: 'A=1' } },
      { contract: metadata, spec: { ...spec, where: 'A=2' } },
    ]);

    expect(results.map((item) => item.index)).toEqual([0, 1]);
    expect(results[0]?.result.result.features[0]?.attributes.OBJECTID).toBe(1);
    expect(results[1]?.result.result.features[0]?.attributes.OBJECTID).toBe(2);
  });

  it('surfaces interactive priority in request snapshots while work is active', async () => {
    const gate = deferred<ReturnType<typeof ok>>();
    const transport = vi.fn(async () => gate.promise);
    const pipeline = createArcGisQueryPipeline({ transport, concurrency: 1 });
    const pending = pipeline.executeSingle(contract(), spec, { requestPriority: 'interactive' });

    expect(pipeline.snapshots()[0]).toMatchObject({ priority: 'interactive', state: 'running', subscribers: 1 });
    gate.resolve(ok([]));
    await pending;
  });

  it('fails closed for non-layer ArcGIS service roots', async () => {
    const pipeline = createArcGisQueryPipeline({ transport: vi.fn() });
    const metadata = contract({ resourceUrl: 'https://example.invalid/arcgis/rest/services/Kent/FeatureServer' });

    await expect(pipeline.executeSingle(metadata, spec)).rejects.toMatchObject({ code: 'INVALID_RESOURCE_URL' });
  });

  it('rejects work after deterministic disposal', async () => {
    const pipeline = createArcGisQueryPipeline({ transport: vi.fn() });
    pipeline.dispose();

    await expect(pipeline.executeSingle(contract(), spec)).rejects.toMatchObject({ code: 'DISPOSED' });
  });
});
