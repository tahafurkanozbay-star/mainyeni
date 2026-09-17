import { describe, expect, it, vi } from 'vitest';
import {
  ArcGisQuerySession,
  createArcGisQuerySession,
  type ArcGisQueryExecutionContext,
  type ArcGisQueryPage,
} from './arcgisQuerySessionRuntime';
import type { ArcGisValidatedQueryPlan } from './arcgisCapabilityAdapter';

interface Feature {
  attributes: { OBJECTID: number; NAME?: string };
  geometry?: { x: number; y: number };
}

const serviceUrl = 'https://example.invalid/arcgis/rest/services/Places/FeatureServer/0';

const metadata = (overrides: Record<string, unknown> = {}) => ({
  id: 0,
  name: 'Places',
  type: 'Feature Layer',
  geometryType: 'esriGeometryPoint',
  objectIdField: 'OBJECTID',
  maxRecordCount: 2,
  capabilities: 'Query',
  spatialReference: { wkid: 4326 },
  fields: [
    { name: 'OBJECTID', type: 'esriFieldTypeOID' },
    { name: 'NAME', type: 'esriFieldTypeString' },
  ],
  advancedQueryCapabilities: {
    supportsPagination: true,
    supportsOrderBy: true,
    supportsDistinct: true,
    supportsStatistics: true,
    supportsHavingClause: true,
    supportsSqlExpression: true,
    supportsReturningQueryExtent: true,
    supportsQueryWithDistance: true,
  },
  ...overrides,
});

const feature = (id: number, name = `Place ${id}`): Feature => ({
  attributes: { OBJECTID: id, NAME: name },
  geometry: { x: id, y: id },
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const createExecutor = (pages: ArcGisQueryPage<Feature>[] = [{ features: [feature(1)] }]) => {
  let index = 0;
  return {
    execute: vi.fn(async () => pages[Math.min(index++, pages.length - 1)] ?? { features: [] }),
    count: vi.fn(async () => 7),
  };
};

describe('arcgisQuerySessionRuntime', () => {
  it('accepts only concrete ArcGIS REST MapServer or FeatureServer layer URLs', () => {
    const executor = createExecutor();
    expect(() => createArcGisQuerySession({ serviceUrl, metadata: metadata(), executor })).not.toThrow();
    expect(() => createArcGisQuerySession({
      serviceUrl: 'https://example.invalid/arcgis/rest/services/Places/FeatureServer',
      metadata: metadata(),
      executor,
    })).toThrow(/concrete MapServer\/FeatureServer layer URL/);
    expect(() => createArcGisQuerySession({
      serviceUrl: 'https://example.invalid/geoserver/wms',
      metadata: metadata(),
      executor,
    })).toThrow(/concrete MapServer\/FeatureServer layer URL/);
    expect(() => createArcGisQuerySession({
      serviceUrl: 'https://example.invalid/geoserver/wfs',
      metadata: metadata(),
      executor,
    })).toThrow(/concrete MapServer\/FeatureServer layer URL/);
  });

  it('derives capabilities from metadata and clamps page size to service maxRecordCount', async () => {
    const executor = createExecutor();
    const session = createArcGisQuerySession({ serviceUrl, metadata: metadata(), executor });

    const result = await session.queryPage({
      resultRecordCount: 99,
      outFields: ['OBJECTID', 'NAME', 'UNTRUSTED_FIELD'],
      orderByFields: ['OBJECTID DESC'],
    });

    expect(result.plan.pageSize).toBe(2);
    expect(result.plan.params.resultRecordCount).toBe(2);
    expect(result.plan.params.outFields).toBe('OBJECTID,NAME');
    expect(result.plan.params.orderByFields).toBe('OBJECTID DESC');
    expect(session.capabilities.supportsPagination).toBe(true);
    expect(session.capabilities.spatialReferenceWkid).toBe(4326);
  });

  it('deduplicates identical in-flight page requests without changing their response', async () => {
    const pending = deferred<ArcGisQueryPage<Feature>>();
    const execute = vi.fn(() => pending.promise);
    const session = createArcGisQuerySession({
      serviceUrl,
      metadata: metadata(),
      executor: { execute },
    });

    const first = session.queryPage({ where: 'OBJECTID > 0', resultRecordCount: 2 });
    const second = session.queryPage({ where: 'OBJECTID > 0', resultRecordCount: 2 });
    await Promise.resolve();

    expect(execute).toHaveBeenCalledTimes(1);
    pending.resolve({ features: [feature(1), feature(2)], exceededTransferLimit: false });
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.features).toEqual(secondResult.features);
    expect(firstResult.requestKey).toBe(secondResult.requestKey);
    expect(firstResult.deduped).toBe(false);
    expect(secondResult.deduped).toBe(true);
    expect(session.snapshot()).toMatchObject({ started: 1, completed: 1, deduped: 1, inFlight: 0 });
  });

  it('isolates subscriber cancellation while another deduplicated subscriber remains', async () => {
    const pending = deferred<ArcGisQueryPage<Feature>>();
    let transportSignal: AbortSignal | undefined;
    const execute = vi.fn((_plan: ArcGisValidatedQueryPlan, context: ArcGisQueryExecutionContext) => {
      transportSignal = context.signal;
      return pending.promise;
    });
    const session = createArcGisQuerySession({ serviceUrl, metadata: metadata(), executor: { execute } });
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = session.queryPage({ where: '1=1', signal: firstController.signal });
    const second = session.queryPage({ where: '1=1', signal: secondController.signal });
    await Promise.resolve();
    firstController.abort();

    await expect(first).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(transportSignal?.aborted).toBe(false);

    pending.resolve({ features: [feature(3)] });
    await expect(second).resolves.toMatchObject({ features: [feature(3)] });
    expect(transportSignal?.aborted).toBe(false);
  });

  it('aborts shared transport work when all subscribers cancel', async () => {
    let transportSignal: AbortSignal | undefined;
    const execute = vi.fn((_plan: ArcGisValidatedQueryPlan, context: ArcGisQueryExecutionContext) => new Promise<ArcGisQueryPage<Feature>>(
      (_resolve, reject) => {
        transportSignal = context.signal;
        context.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      },
    ));
    const session = createArcGisQuerySession({ serviceUrl, metadata: metadata(), executor: { execute } });
    const a = new AbortController();
    const b = new AbortController();

    const first = session.queryPage({ signal: a.signal });
    const second = session.queryPage({ signal: b.signal });
    await Promise.resolve();
    a.abort();
    b.abort();

    await expect(first).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(second).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(transportSignal?.aborted).toBe(true);
  });

  it('paginates with the capability-advertised offset contract and de-duplicates stable object ids', async () => {
    const offsets: number[] = [];
    const execute = vi.fn(async (plan: ArcGisValidatedQueryPlan) => {
      offsets.push(Number(plan.params.resultOffset));
      if (plan.params.resultOffset === 0) {
        return { features: [feature(1), feature(2)], exceededTransferLimit: true };
      }
      return { features: [feature(2), feature(3)], exceededTransferLimit: false };
    });
    const session = createArcGisQuerySession({ serviceUrl, metadata: metadata(), executor: { execute } });

    const result = await session.queryAll({ resultRecordCount: 2, maxRecords: 10 });

    expect(offsets).toEqual([0, 2]);
    expect(result.features.map((item) => item.attributes.OBJECTID)).toEqual([1, 2, 3]);
    expect(result.pages).toBe(2);
    expect(result.complete).toBe(true);
    expect(result.truncated).toBe(false);
  });

  it('stops at maxRecords and reports deterministic truncation', async () => {
    const execute = vi.fn(async () => ({
      features: [feature(1), feature(2)],
      exceededTransferLimit: true,
    }));
    const session = createArcGisQuerySession({ serviceUrl, metadata: metadata(), executor: { execute } });

    const result = await session.queryAll({ resultRecordCount: 2, maxRecords: 2, maxPages: 20 });

    expect(result.features).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.warnings).toContain('max-records-reached');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('stops at maxPages instead of allowing unbounded transfer-limit pagination', async () => {
    let next = 1;
    const execute = vi.fn(async () => ({
      features: [feature(next++), feature(next++)],
      exceededTransferLimit: true,
    }));
    const session = createArcGisQuerySession({ serviceUrl, metadata: metadata(), executor: { execute } });

    const result = await session.queryAll({ resultRecordCount: 2, maxRecords: 100, maxPages: 3 });

    expect(result.pages).toBe(3);
    expect(result.features).toHaveLength(6);
    expect(result.truncated).toBe(true);
    expect(result.warnings).toContain('max-pages-reached');
  });

  it('does not invent pagination when metadata does not advertise it', async () => {
    const execute = vi.fn(async () => ({
      features: [feature(1), feature(2)],
      exceededTransferLimit: true,
    }));
    const session = createArcGisQuerySession({
      serviceUrl,
      metadata: metadata({ advancedQueryCapabilities: { supportsPagination: false } }),
      executor: { execute },
    });

    const result = await session.queryAll({ resultRecordCount: 2, maxPages: 10 });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.warnings).toContain('pagination-required-but-not-supported');
    expect(result.complete).toBe(false);
  });

  it('refreshes metadata as a new revision and aborts stale in-flight work', async () => {
    let signal: AbortSignal | undefined;
    const execute = vi.fn((_plan: ArcGisValidatedQueryPlan, context: ArcGisQueryExecutionContext) => new Promise<ArcGisQueryPage<Feature>>(
      (_resolve, reject) => {
        signal = context.signal;
        context.signal.addEventListener('abort', () => reject(new Error('metadata refreshed')), { once: true });
      },
    ));
    const session = createArcGisQuerySession({ serviceUrl, metadata: metadata(), executor: { execute } });
    const pending = session.queryPage();
    await Promise.resolve();

    const capabilities = session.refreshMetadata(metadata({ maxRecordCount: 25 }));

    expect(signal?.aborted).toBe(true);
    await expect(pending).rejects.toThrow('metadata refreshed');
    expect(capabilities.maxRecordCount).toBe(25);
    expect(session.snapshot().revision).toBe(2);
  });

  it('deduplicates count requests and refuses to fabricate count support', async () => {
    const pending = deferred<number>();
    const count = vi.fn(() => pending.promise);
    const session = createArcGisQuerySession({
      serviceUrl,
      metadata: metadata(),
      executor: { execute: vi.fn(async () => ({ features: [] })), count },
    });

    const first = session.count({ where: 'OBJECTID > 0' });
    const second = session.count({ where: 'OBJECTID > 0' });
    await Promise.resolve();
    expect(count).toHaveBeenCalledTimes(1);
    pending.resolve(12.9);
    await expect(Promise.all([first, second])).resolves.toEqual([12, 12]);

    const withoutCount = new ArcGisQuerySession({
      serviceUrl,
      metadata: metadata(),
      executor: { execute: vi.fn(async () => ({ features: [] })) },
    });
    await expect(withoutCount.count()).rejects.toMatchObject({ code: 'COUNT_UNSUPPORTED' });
  });

  it('disposes deterministically, aborting active work and rejecting future requests', async () => {
    let signal: AbortSignal | undefined;
    const execute = vi.fn((_plan: ArcGisValidatedQueryPlan, context: ArcGisQueryExecutionContext) => new Promise<ArcGisQueryPage<Feature>>(
      (_resolve, reject) => {
        signal = context.signal;
        context.signal.addEventListener('abort', () => reject(new Error('disposed transport')), { once: true });
      },
    ));
    const session = createArcGisQuerySession({ serviceUrl, metadata: metadata(), executor: { execute } });
    const pending = session.queryPage();
    await Promise.resolve();

    session.dispose();

    expect(signal?.aborted).toBe(true);
    await expect(pending).rejects.toThrow('disposed transport');
    await expect(session.queryPage()).rejects.toMatchObject({ code: 'SESSION_DISPOSED' });
    expect(session.snapshot().disposed).toBe(true);
  });
});
