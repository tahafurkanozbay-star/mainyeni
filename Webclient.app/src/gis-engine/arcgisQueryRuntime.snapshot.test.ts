import { describe, expect, it, vi } from 'vitest';
import {
  createArcGisQueryRuntime,
  type ArcGisQueryResponse,
} from './arcgisQueryRuntime';
import type { ArcGisMetadataContract, ArcGisFieldContract } from './arcgisMetadataAdapter';

const field = (name: string, type: ArcGisFieldContract['type']): ArcGisFieldContract => ({
  name,
  alias: name,
  type,
  nullable: name !== 'OBJECTID',
  editable: name !== 'OBJECTID',
  length: type === 'string' ? 256 : null,
  defaultValue: null,
  domain: null,
});

const metadata = (pagination = false): ArcGisMetadataContract => ({
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
  capabilities: new Set([
    'query',
    ...(pagination ? ['pagination' as const, 'order-by' as const] : []),
  ]),
  fields: [field('OBJECTID', 'oid'), field('NAME', 'string')],
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
});

const limits = { maxFeatures: 2, maxPages: 1, preferredPageSize: 2, maxPageSize: 2 };
const request = { where: '1=1', outFields: ['OBJECTID', 'NAME'], returnGeometry: false } as const;
const feature = (OBJECTID: number, NAME = 'Park') => ({ attributes: { OBJECTID, NAME } });
const response = (features: unknown[], exceededTransferLimit = false): ArcGisQueryResponse => ({
  features: features as ArcGisQueryResponse['features'],
  exceededTransferLimit,
});

describe('ArcGIS query runtime immutable response boundary', () => {
  it('caches only complete responses and immediately refreshes a truncated query', async () => {
    let calls = 0;
    const transport = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? response([feature(1)], true) : response([feature(1)]);
    });
    const runtime = createArcGisQueryRuntime(transport, { queryLimits: limits });
    const first = await runtime.execute(metadata(), request);
    expect(first.diagnostics).toMatchObject({ complete: false, truncated: true, cacheEligible: false });
    const second = await runtime.execute(metadata(), request);
    expect(second.diagnostics).toMatchObject({ complete: true, truncated: false, cacheEligible: true });
    const cached = await runtime.execute(metadata(), request);
    expect(cached.features).toEqual(second.features);
    expect(calls).toBe(2);
    expect(runtime.snapshot().cacheHits).toBe(1);
    runtime.destroy();
  });

  it('does not cache a response that exactly fills the feature budget', async () => {
    const transport = vi.fn(async () => response([feature(1), feature(2)]));
    const runtime = createArcGisQueryRuntime(transport, { queryLimits: limits });
    const first = await runtime.execute(metadata(), request);
    const second = await runtime.execute(metadata(), request);
    expect(first.diagnostics).toMatchObject({ complete: false, truncated: true, cacheEligible: false });
    expect(second.diagnostics.truncated).toBe(true);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(runtime.snapshot().cacheEntries).toBe(0);
    runtime.destroy();
  });

  it('keeps complete results cached when the transport returns fewer than the limit', async () => {
    const transport = vi.fn(async () => response([feature(1)]));
    const runtime = createArcGisQueryRuntime(transport, { queryLimits: limits });
    const first = await runtime.execute(metadata(), request);
    const second = await runtime.execute(metadata(), request);
    expect(first.diagnostics.cacheEligible).toBe(true);
    expect(second.features).toEqual(first.features);
    expect(transport).toHaveBeenCalledTimes(1);
    runtime.destroy();
  });

  it('returns frozen snapshots isolated from transport-owned mutations', async () => {
    const source = {
      attributes: { OBJECTID: 1, NAME: 'before', nested: { owner: 'ABB' } },
      geometry: { x: 32.8, y: 39.9, spatialReference: { wkid: 4326 } },
    };
    const runtime = createArcGisQueryRuntime(async () => response([source]), { queryLimits: limits });
    const result = await runtime.execute(metadata(), { ...request, returnGeometry: true, validateGeometry: false });
    source.attributes.NAME = 'after';
    source.attributes.nested.owner = 'changed';
    source.geometry.x = 999;
    const retained = result.features[0];
    expect(retained?.attributes?.NAME).toBe('before');
    expect((retained?.attributes?.nested as { owner: string }).owner).toBe('ABB');
    expect((retained?.geometry as { x: number }).x).toBe(32.8);
    expect(Object.isFrozen(retained)).toBe(true);
    expect(Object.isFrozen(retained?.attributes)).toBe(true);
    expect(Object.isFrozen(retained?.attributes?.nested)).toBe(true);
    expect(Object.isFrozen(retained?.geometry)).toBe(true);
    runtime.destroy();
  });

  it('rejects a getter on the response envelope without executing it', async () => {
    let calls = 0;
    const payload = {};
    Object.defineProperty(payload, 'features', {
      enumerable: true,
      get() { calls += 1; throw new Error('private response detail'); },
    });
    const runtime = createArcGisQueryRuntime(async () => payload as ArcGisQueryResponse, { queryLimits: limits });
    await expect(runtime.execute(metadata(), request)).rejects.toMatchObject({
      name: 'ArcGisQueryRuntimeError',
      code: 'INVALID_QUERY_RESPONSE',
    });
    expect(calls).toBe(0);
    runtime.destroy();
  });

  it('rejects nested feature getters without exposing their exception text', async () => {
    let calls = 0;
    const attributes: Record<string, unknown> = { OBJECTID: 1 };
    Object.defineProperty(attributes, 'NAME', {
      enumerable: true,
      get() { calls += 1; throw new Error('secret field content'); },
    });
    const runtime = createArcGisQueryRuntime(async () => response([{ attributes }]), { queryLimits: limits });
    let thrown: unknown;
    try {
      await runtime.execute(metadata(), request);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ name: 'ArcGisQueryRuntimeError', code: 'ACCESSOR_PROPERTY' });
    expect((thrown as Error).message).not.toContain('secret field content');
    expect(calls).toBe(0);
    runtime.destroy();
  });

  it('rejects malformed transfer-limit flags instead of treating them as complete', async () => {
    const runtime = createArcGisQueryRuntime(async () => ({
      features: [feature(1)],
      exceededTransferLimit: 'false',
    } as unknown as ArcGisQueryResponse), { queryLimits: limits });
    await expect(runtime.execute(metadata(), request)).rejects.toMatchObject({
      name: 'ArcGisQueryRuntimeError',
      code: 'INVALID_QUERY_RESPONSE',
    });
    runtime.destroy();
  });

  it('converts hostile proxy traps to a constant response error', async () => {
    const payload = new Proxy({ features: [feature(1)] }, {
      getOwnPropertyDescriptor() { throw new Error('secret proxy trap'); },
    });
    const runtime = createArcGisQueryRuntime(async () => payload as ArcGisQueryResponse, { queryLimits: limits });
    let thrown: unknown;
    try {
      await runtime.execute(metadata(), request);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ name: 'ArcGisQueryRuntimeError', code: 'INVALID_QUERY_RESPONSE' });
    expect((thrown as Error).message).not.toContain('secret proxy trap');
    runtime.destroy();
  });

  it('applies aggregate snapshot byte budgets across paginated service responses', async () => {
    const transport = vi.fn(async (plan: { body: URLSearchParams }) => {
      const offset = Number(plan.body.get('resultOffset') ?? 0);
      return response(offset === 0 ? [feature(1), feature(2)] : [feature(3)]);
    });
    const runtime = createArcGisQueryRuntime(transport, {
      queryLimits: { maxFeatures: 4, maxPages: 2, preferredPageSize: 2, maxPageSize: 2 },
      featureSnapshotBudget: { maxBytesPerFeature: 128, maxBytesPerQuery: 260 },
    });
    await expect(runtime.execute(metadata(true), request)).rejects.toMatchObject({
      name: 'ArcGisQueryRuntimeError',
      code: 'QUERY_BYTE_BUDGET',
      pageIndex: 1,
    });
    expect(transport).toHaveBeenCalledTimes(2);
    expect(runtime.snapshot().cacheEntries).toBe(0);
    runtime.destroy();
  });

  it('does not cache exports even when their bounded response is complete', async () => {
    const transport = vi.fn(async () => response([feature(1)]));
    const runtime = createArcGisQueryRuntime(transport, { queryLimits: limits });
    await runtime.execute(metadata(), { ...request, purpose: 'export' });
    await runtime.execute(metadata(), { ...request, purpose: 'export' });
    expect(transport).toHaveBeenCalledTimes(2);
    runtime.destroy();
  });

  it('does not cache when the caller explicitly disables cache', async () => {
    const transport = vi.fn(async () => response([feature(1)]));
    const runtime = createArcGisQueryRuntime(transport, { queryLimits: limits });
    await runtime.execute(metadata(), { ...request, cache: false });
    await runtime.execute(metadata(), { ...request, cache: false });
    expect(transport).toHaveBeenCalledTimes(2);
    runtime.destroy();
  });

  it('keeps sanitized replacement features frozen when geometry is dropped', async () => {
    const runtime = createArcGisQueryRuntime(async () => response([{
      attributes: { OBJECTID: 1, NAME: 'Park' },
      geometry: { unsupported: 'opaque' },
    }]), { queryLimits: limits });
    const result = await runtime.execute(metadata(), { ...request, returnGeometry: true });
    expect(result.features[0]?.geometry).toBeNull();
    expect(Object.isFrozen(result.features[0])).toBe(true);
    expect(Object.isFrozen(result.features[0]?.attributes)).toBe(true);
    runtime.destroy();
  });

  it('removes the retry abort listener after the backoff timer resolves', async () => {
    const added: EventListener[] = [];
    const removed: EventListener[] = [];
    let attempts = 0;
    const transport = vi.fn(async (_plan: unknown, context: { signal: AbortSignal }) => {
      if (attempts++ === 0) {
        const signal = context.signal;
        const originalAdd = signal.addEventListener.bind(signal);
        const originalRemove = signal.removeEventListener.bind(signal);
        Object.defineProperty(signal, 'addEventListener', {
          configurable: true,
          value: (type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) => {
            if (type === 'abort' && typeof listener === 'function') added.push(listener);
            originalAdd(type, listener as EventListener, options);
          },
        });
        Object.defineProperty(signal, 'removeEventListener', {
          configurable: true,
          value: (type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) => {
            if (type === 'abort' && typeof listener === 'function') removed.push(listener);
            originalRemove(type, listener as EventListener, options);
          },
        });
        throw Object.assign(new Error('temporary upstream response'), { status: 503 });
      }
      return response([feature(1)]);
    });
    const runtime = createArcGisQueryRuntime(transport, {
      queryLimits: limits, maxRetries: 1, retryBaseDelayMs: 1, retryMaxDelayMs: 1,
    });
    await expect(runtime.execute(metadata(), request)).resolves.toMatchObject({
      diagnostics: { retries: 1, complete: true, cacheEligible: true },
    });
    expect(added.length).toBeGreaterThan(0);
    expect(added.every((listener) => removed.includes(listener))).toBe(true);
    runtime.destroy();
  });

  it('removes retry listeners and cancels the backoff promptly when the caller aborts', async () => {
    const added: EventListener[] = [];
    const removed: EventListener[] = [];
    const controller = new AbortController();
    let transportSignal: AbortSignal | undefined;
    const transport = vi.fn(async (_plan: unknown, context: { signal: AbortSignal }) => {
      transportSignal = context.signal;
      const originalAdd = context.signal.addEventListener.bind(context.signal);
      const originalRemove = context.signal.removeEventListener.bind(context.signal);
      Object.defineProperty(context.signal, 'addEventListener', {
        configurable: true,
        value: (type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) => {
          if (type === 'abort' && typeof listener === 'function') added.push(listener);
          originalAdd(type, listener as EventListener, options);
        },
      });
      Object.defineProperty(context.signal, 'removeEventListener', {
        configurable: true,
        value: (type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) => {
          if (type === 'abort' && typeof listener === 'function') removed.push(listener);
          originalRemove(type, listener as EventListener, options);
        },
      });
      throw Object.assign(new Error('temporary upstream response'), { status: 503 });
    });
    const runtime = createArcGisQueryRuntime(transport, {
      queryLimits: limits, maxRetries: 1, retryBaseDelayMs: 5000, retryMaxDelayMs: 5000,
    });
    const pending = runtime.execute(metadata(), { ...request, signal: controller.signal });
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(transportSignal?.aborted).toBe(true);
    expect(added.length).toBeGreaterThan(0);
    expect(added.every((listener) => removed.includes(listener))).toBe(true);
    runtime.destroy();
  });

  it.each([
    ['missing', { attributes: { NAME: 'Park' } }],
    ['undefined', { attributes: { OBJECTID: undefined, NAME: 'Park' } }],
    ['fractional', { attributes: { OBJECTID: 1.5, NAME: 'Park' } }],
    ['negative', { attributes: { OBJECTID: -1, NAME: 'Park' } }],
    ['blank string', { attributes: { OBJECTID: '   ', NAME: 'Park' } }],
    ['control-bearing string', { attributes: { OBJECTID: 'bad\nid', NAME: 'Park' } }],
    ['oversized string', { attributes: { OBJECTID: 'x'.repeat(257), NAME: 'Park' } }],
  ])('rejects unstable paged identity: %s', async (_label, item) => {
    const runtime = createArcGisQueryRuntime(async () => response([item]), {
      queryLimits: { maxFeatures: 4, maxPages: 2, preferredPageSize: 2, maxPageSize: 2 },
    });
    await expect(runtime.execute(metadata(true), request)).rejects.toMatchObject({
      name: 'ArcGisQueryRuntimeError',
      code: 'INVALID_FEATURE_IDENTITY',
    });
    runtime.destroy();
  });

  it('normalizes bounded string identities for stable pagination without rewriting attributes', async () => {
    const runtime = createArcGisQueryRuntime(async () => response([
      { attributes: { OBJECTID: '  guid-like-id  ', NAME: 'Park' } },
    ]), {
      queryLimits: { maxFeatures: 4, maxPages: 2, preferredPageSize: 2, maxPageSize: 2 },
    });
    const result = await runtime.execute(metadata(true), request);
    expect(result.features[0]?.attributes?.OBJECTID).toBe('  guid-like-id  ');
    expect(result.diagnostics.complete).toBe(true);
    runtime.destroy();
  });

  it('redacts credentials from ArcGIS service and transport error diagnostics', async () => {
    const serviceRuntime = createArcGisQueryRuntime(async () => ({
      error: {
        code: 498,
        message: 'Invalid token access_token=service-secret&retry=false',
        details: ['Bearer eyJabcdefghijk.abcdefghijk.abcdefghijk'],
      },
      features: [],
    } as unknown as ArcGisQueryResponse), { queryLimits: limits });
    let serviceError: unknown;
    try {
      await serviceRuntime.execute(metadata(), request);
    } catch (error) {
      serviceError = error;
    }
    expect(serviceError).toMatchObject({ name: 'ArcGisQueryRuntimeError', code: 'ARCGIS_SERVICE_ERROR' });
    expect((serviceError as Error).message).not.toContain('service-secret');
    expect((serviceError as Error).message).not.toContain('abcdefghijk');
    serviceRuntime.destroy();

    const transportRuntime = createArcGisQueryRuntime(async () => {
      throw new Error('request failed https://example.invalid/query?token=transport-secret');
    }, { queryLimits: limits, maxRetries: 1 });
    let transportError: unknown;
    try {
      await transportRuntime.execute(metadata(), request);
    } catch (error) {
      transportError = error;
    }
    expect(transportError).toMatchObject({ name: 'ArcGisQueryRuntimeError', code: 'TRANSPORT_ERROR' });
    expect((transportError as Error).message).not.toContain('transport-secret');
    expect((transportError as { cause?: unknown }).cause).toBeUndefined();
    transportRuntime.destroy();
  });

  it('does not cache geometry that was dropped by lenient validation', async () => {
    let calls = 0;
    const transport = vi.fn(async () => {
      calls += 1;
      return response([{
        attributes: { OBJECTID: 1, NAME: 'Park' },
        geometry: calls === 1 ? { unsupported: 'opaque' } : {
          x: 32.8, y: 39.9, spatialReference: { wkid: 4326 },
        },
      }]);
    });
    const runtime = createArcGisQueryRuntime(transport, { queryLimits: limits });
    const degraded = await runtime.execute(metadata(), { ...request, returnGeometry: true });
    expect(degraded.diagnostics).toMatchObject({
      invalidGeometryCount: 1, droppedInvalidGeometryCount: 1, cacheEligible: false,
    });
    expect(degraded.features[0]?.geometry).toBeNull();
    const repaired = await runtime.execute(metadata(), { ...request, returnGeometry: true });
    expect(repaired.diagnostics).toMatchObject({
      invalidGeometryCount: 0, droppedInvalidGeometryCount: 0, cacheEligible: true,
    });
    expect(repaired.features[0]?.geometry).toMatchObject({ x: 32.8, y: 39.9 });
    await runtime.execute(metadata(), { ...request, returnGeometry: true });
    expect(calls).toBe(2);
    runtime.destroy();
  });

  it('does not execute accessor-backed ArcGIS error details arrays', async () => {
    let calls = 0;
    const details: string[] = [];
    Object.defineProperty(details, '0', {
      enumerable: true,
      configurable: true,
      get() { calls += 1; throw new Error('secret detail getter'); },
    });
    details.length = 1;
    const runtime = createArcGisQueryRuntime(async () => ({
      error: { code: 400, message: 'Invalid query', details },
      features: [],
    } as unknown as ArcGisQueryResponse), { queryLimits: limits });
    let thrown: unknown;
    try {
      await runtime.execute(metadata(), request);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ name: 'ArcGisQueryRuntimeError', code: 'ARCGIS_SERVICE_ERROR' });
    expect((thrown as Error).message).toContain('Invalid query');
    expect((thrown as Error).message).not.toContain('secret detail getter');
    expect(calls).toBe(0);
    runtime.destroy();
  });

  it('normalizes hostile thrown proxy values without leaking trap messages', async () => {
    const hostile = new Proxy({}, {
      getPrototypeOf() { throw new Error('secret prototype trap'); },
      get() { throw new Error('secret property trap'); },
    });
    const runtime = createArcGisQueryRuntime(async () => { throw hostile; }, { queryLimits: limits, maxRetries: 1 });
    let thrown: unknown;
    try {
      await runtime.execute(metadata(), request);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ name: 'ArcGisQueryRuntimeError', code: 'TRANSPORT_ERROR' });
    expect((thrown as Error).message).toBe('ArcGIS transport failed.');
    expect((thrown as Error).message).not.toContain('secret');
    expect((thrown as { cause?: unknown }).cause).toBeUndefined();
    runtime.destroy();
  });

  it('does not cache a paginated result whose page identities overlap', async () => {
    let queryNumber = 0;
    let calls = 0;
    const transport = vi.fn(async (_plan: unknown, context: { pageIndex: number }) => {
      calls += 1;
      if (context.pageIndex === 0) queryNumber += 1;
      if (queryNumber === 1) {
        return response(context.pageIndex === 0
          ? [feature(1), feature(2)]
          : [feature(2)]);
      }
      return response(context.pageIndex === 0
        ? [feature(1), feature(2)]
        : [feature(3)]);
    });
    const runtime = createArcGisQueryRuntime(transport, {
      queryLimits: { maxFeatures: 4, maxPages: 2, preferredPageSize: 2, maxPageSize: 2 },
    });
    const inconsistent = await runtime.execute(metadata(true), request);
    expect(inconsistent.diagnostics).toMatchObject({
      complete: true, duplicateCount: 1, cacheEligible: false,
    });
    const consistent = await runtime.execute(metadata(true), request);
    expect(consistent.diagnostics).toMatchObject({
      complete: true, duplicateCount: 0, cacheEligible: true,
    });
    await runtime.execute(metadata(true), request);
    expect(calls).toBe(4);
    expect(runtime.snapshot().cacheHits).toBe(1);
    runtime.destroy();
  });

  it('does not cache strict geometry validation failures', async () => {
    let calls = 0;
    const transport = vi.fn(async () => {
      calls += 1;
      return response([{
        attributes: { OBJECTID: 1, NAME: 'Park' },
        geometry: calls === 1 ? { unsupported: 'opaque' } : {
          x: 32.8, y: 39.9, spatialReference: { wkid: 4326 },
        },
      }]);
    });
    const runtime = createArcGisQueryRuntime(transport, { queryLimits: limits });
    await expect(runtime.execute(metadata(), {
      ...request, returnGeometry: true, strictGeometry: true,
    })).rejects.toMatchObject({ code: 'INVALID_FEATURE_GEOMETRY' });
    const recovered = await runtime.execute(metadata(), { ...request, returnGeometry: true });
    expect(recovered.diagnostics.cacheEligible).toBe(true);
    await runtime.execute(metadata(), { ...request, returnGeometry: true });
    expect(calls).toBe(2);
    runtime.destroy();
  });

  it('does not cache a response that exceeds the snapshot string budget', async () => {
    let calls = 0;
    const transport = vi.fn(async () => response([feature(1, calls++ === 0 ? 'x'.repeat(9) : 'Park')]));
    const runtime = createArcGisQueryRuntime(transport, {
      queryLimits: limits,
      featureSnapshotBudget: { maxStringLength: 8 },
    });
    await expect(runtime.execute(metadata(), request)).rejects.toMatchObject({
      name: 'ArcGisQueryRuntimeError', code: 'STRING_BUDGET',
    });
    await expect(runtime.execute(metadata(), request)).resolves.toMatchObject({
      diagnostics: { complete: true, cacheEligible: true },
    });
    await runtime.execute(metadata(), request);
    expect(transport).toHaveBeenCalledTimes(2);
    runtime.destroy();
  });

  it('rejects inherited response fields without invoking inherited getters', async () => {
    let calls = 0;
    const payload = Object.create({
      get features() { calls += 1; throw new Error('inherited response getter'); },
    }) as ArcGisQueryResponse;
    Object.defineProperty(payload, 'exceededTransferLimit', { value: false, enumerable: true });
    const runtime = createArcGisQueryRuntime(async () => payload, { queryLimits: limits });
    await expect(runtime.execute(metadata(), request)).rejects.toMatchObject({
      name: 'ArcGisQueryRuntimeError', code: 'INVALID_QUERY_RESPONSE',
    });
    expect(calls).toBe(0);
    runtime.destroy();
  });

  it('rejects non-finite coordinates even when display geometry validation is disabled', async () => {
    const runtime = createArcGisQueryRuntime(async () => response([{
      attributes: { OBJECTID: 1, NAME: 'Park' },
      geometry: { x: Number.NaN, y: 39.9 },
    }]), { queryLimits: limits });
    await expect(runtime.execute(metadata(), {
      ...request, returnGeometry: true, validateGeometry: false,
    })).rejects.toMatchObject({
      name: 'ArcGisQueryRuntimeError', code: 'NON_FINITE_NUMBER',
    });
    expect(runtime.snapshot().cacheEntries).toBe(0);
    runtime.destroy();
  });

  it('fails closed on accessor-backed object IDs before pagination can deduplicate them', async () => {
    let calls = 0;
    const attributes: Record<string, unknown> = { NAME: 'Park' };
    Object.defineProperty(attributes, 'OBJECTID', {
      enumerable: true,
      get() { calls += 1; throw new Error('object ID getter'); },
    });
    const runtime = createArcGisQueryRuntime(async () => response([{ attributes }]), {
      queryLimits: { maxFeatures: 4, maxPages: 2, preferredPageSize: 2, maxPageSize: 2 },
    });
    await expect(runtime.execute(metadata(true), request)).rejects.toMatchObject({
      name: 'ArcGisQueryRuntimeError', code: 'ACCESSOR_PROPERTY',
    });
    expect(calls).toBe(0);
    runtime.destroy();
  });
});
