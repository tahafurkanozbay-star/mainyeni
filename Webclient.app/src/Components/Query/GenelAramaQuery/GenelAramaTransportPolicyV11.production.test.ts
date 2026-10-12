import { describe, expect, it } from 'vitest';
import type {
  FastAccessQuery,
  QueryExecutionControl,
} from '../../../Business/contracts';
import {
  GeneralSearchTransportErrorV11,
  type GeneralSearchTransportExecutionOptionsV11,
  type GeneralSearchTransportPolicyV11,
} from './GenelAramaTransportContractsV11';
import {
  GeneralSearchTransportRuntimeV11,
  admitGeneralSearchServiceResultV11,
  createGeneralSearchTransportControlPlanV11,
  createGeneralSearchTransportIdentityV11,
} from './GenelAramaTransportRuntimeV11';

const success = (data: readonly unknown[]): unknown => ({
  type: 10,
  data,
  message: '',
});

const makeSource = (
  value: unknown | ((query: FastAccessQuery, geometry: boolean, control: QueryExecutionControl) => unknown),
) => ({
  Query: async (
    query: FastAccessQuery = {},
    geometry = false,
    control: QueryExecutionControl = {},
  ): Promise<unknown> => typeof value === 'function'
    ? (value as (query: FastAccessQuery, geometry: boolean, control: QueryExecutionControl) => unknown)(
      query,
      geometry,
      control,
    )
    : value,
});

describe('Genel Arama transport v11 policy boundaries', () => {
  it('clamps timeout overrides to the service-runtime hard ceiling', () => {
    const plan = createGeneralSearchTransportControlPlanV11(
      'search',
      { name: 'x' },
      false,
      { timeoutMs: 999_999 },
    );
    expect(plan.control.timeoutMs).toBe(120_000);
  });

  it('uses operation-specific default timeout values', () => {
    const policy: GeneralSearchTransportPolicyV11 = {
      searchTimeoutMs: 18_000,
      detailTimeoutMs: 7_000,
    };
    const search = createGeneralSearchTransportControlPlanV11(
      'search',
      { name: 'x' },
      false,
      policy,
    );
    const detail = createGeneralSearchTransportControlPlanV11(
      'detail',
      { ObjectId: 1 },
      true,
      policy,
    );

    expect(search.control.timeoutMs).toBe(18_000);
    expect(detail.control.timeoutMs).toBe(7_000);
  });

  it('uses operation-specific cache policies', () => {
    const policy: GeneralSearchTransportPolicyV11 = {
      searchCacheTtlMs: 3_000,
      detailCacheTtlMs: 9_000,
      cacheSearches: false,
      cacheDetails: true,
    };
    const search = createGeneralSearchTransportControlPlanV11(
      'search',
      { name: 'x' },
      false,
      policy,
    );
    const detail = createGeneralSearchTransportControlPlanV11(
      'detail',
      { ObjectId: 1 },
      true,
      policy,
    );

    expect(search.control.cache).toBe(false);
    expect(search.control.cacheTtlMs).toBe(3_000);
    expect(detail.control.cache).toBe(true);
    expect(detail.control.cacheTtlMs).toBe(9_000);
  });

  it('lets one request explicitly disable cache without changing global policy', () => {
    const execution: GeneralSearchTransportExecutionOptionsV11 = {
      cache: false,
      cacheTtlMs: 0,
    };
    const plan = createGeneralSearchTransportControlPlanV11(
      'detail',
      { ObjectId: 1 },
      true,
      { cacheDetails: true, detailCacheTtlMs: 30_000 },
      execution,
    );

    expect(plan.control.cache).toBe(false);
    expect(plan.control.cacheTtlMs).toBe(0);
  });

  it('normalizes a hostile request-key suffix into a bounded slug', () => {
    const identity = createGeneralSearchTransportIdentityV11(
      'search',
      { name: 'x' },
      false,
      '  Window / ../../ SECRET ? '.repeat(20),
    );

    const suffix = identity.requestKey.split(':').at(-1) ?? '';
    expect(suffix.length).toBeLessThanOrEqual(64);
    expect(suffix).toMatch(/^[a-z0-9_-]+$/u);
    expect(identity.requestKey).not.toContain('..');
    expect(identity.requestKey).not.toContain('SECRET');
  });

  it('fingerprints canonical query identity rather than object insertion order', () => {
    const left = createGeneralSearchTransportIdentityV11(
      'search',
      {
        name: 'Ankara',
        districtId: 6,
        nbhoodId: 12,
        showNearby: true,
      },
      false,
    );
    const rightQuery: FastAccessQuery = {
      showNearby: true,
      nbhoodId: 12,
      districtId: 6,
      name: 'Ankara',
    };
    const right = createGeneralSearchTransportIdentityV11(
      'search',
      rightQuery,
      false,
    );

    expect(left.requestFingerprint).toBe(right.requestFingerprint);
  });

  it('changes fingerprint when geometry intent changes', () => {
    const list = createGeneralSearchTransportIdentityV11(
      'search',
      { ObjectId: 10 },
      false,
    );
    const detail = createGeneralSearchTransportIdentityV11(
      'detail',
      { ObjectId: 10 },
      true,
    );

    expect(list.requestFingerprint).not.toBe(detail.requestFingerprint);
  });

  it('rounds user-location identity before fingerprinting jitter', () => {
    const left = createGeneralSearchTransportIdentityV11(
      'search',
      {
        name: 'yakın',
        userLocation: { latitude: 39.12345641, longitude: 32.12345641 },
      },
      false,
    );
    const right = createGeneralSearchTransportIdentityV11(
      'search',
      {
        name: 'yakın',
        userLocation: { latitude: 39.12345644, longitude: 32.12345644 },
      },
      false,
    );

    expect(left.requestFingerprint).toBe(right.requestFingerprint);
  });

  it('keeps meaningful coordinate changes distinct', () => {
    const left = createGeneralSearchTransportIdentityV11(
      'search',
      {
        userLocation: { latitude: 39.1, longitude: 32.1 },
      },
      false,
    );
    const right = createGeneralSearchTransportIdentityV11(
      'search',
      {
        userLocation: { latitude: 39.2, longitude: 32.1 },
      },
      false,
    );

    expect(left.requestFingerprint).not.toBe(right.requestFingerprint);
  });
});

describe('Genel Arama transport v11 admission boundaries', () => {
  it('treats non-object service roots as invalid', () => {
    expect(() => admitGeneralSearchServiceResultV11(
      'not-an-object',
      {
        operation: 'search',
        successType: 10,
        maximumRecords: 100,
        maximumMessageLength: 100,
      },
    )).toThrowError(GeneralSearchTransportErrorV11);
  });

  it('does not require data array for service-declared failures', () => {
    const result = admitGeneralSearchServiceResultV11(
      { type: 20, message: 'failed' },
      {
        operation: 'search',
        successType: 10,
        maximumRecords: 100,
        maximumMessageLength: 100,
      },
    );

    expect(result.type).toBe(20);
    expect(result.data).toEqual([]);
    expect(result.message).toBe('failed');
  });

  it('freezes accepted top-level records to prevent downstream mutation', () => {
    const result = admitGeneralSearchServiceResultV11(
      { type: 10, data: [{ id: 1, title: 'A' }] },
      {
        operation: 'search',
        successType: 10,
        maximumRecords: 100,
        maximumMessageLength: 100,
      },
    );

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.data)).toBe(true);
    expect(Object.isFrozen(result.data[0])).toBe(true);
  });

  it('counts malformed records only inside the admitted cardinality window', () => {
    const result = admitGeneralSearchServiceResultV11(
      {
        type: 10,
        data: [{ id: 1 }, null, { id: 2 }, 'outside-window'],
      },
      {
        operation: 'search',
        successType: 10,
        maximumRecords: 3,
        maximumMessageLength: 100,
      },
    );

    expect(result.inputRecordCount).toBe(4);
    expect(result.acceptedRecordCount).toBe(2);
    expect(result.malformedRecordCount).toBe(1);
    expect(result.truncated).toBe(true);
  });

  it('normalizes numeric string service type before comparing success code', () => {
    const result = admitGeneralSearchServiceResultV11(
      {
        type: '10',
        data: [{ id: 1 }],
      },
      {
        operation: 'search',
        successType: 10,
        maximumRecords: 10,
        maximumMessageLength: 100,
      },
    );

    expect(result.type).toBe(10);
    expect(result.acceptedRecordCount).toBe(1);
  });
});

describe('Genel Arama transport v11 runtime policy accounting', () => {
  it('records blocked result-limit failures separately from executor failures', async () => {
    const runtime = new GeneralSearchTransportRuntimeV11(
      makeSource(success([{ id: 1 }, { id: 2 }])),
      { policy: { maximumSearchRecords: 1 } },
    );

    await expect(runtime.startSearch({ query: { name: 'x' } }).promise)
      .rejects.toMatchObject({ code: 'GENERAL_SEARCH_RESPONSE_LIMIT' });

    expect(runtime.snapshot()).toMatchObject({
      started: 1,
      completed: 0,
      failed: 0,
      blocked: 1,
      cancelled: 0,
      superseded: 0,
    });
  });

  it('records service-declared failures as failures, not admission blocks', async () => {
    const runtime = new GeneralSearchTransportRuntimeV11(
      makeSource({ type: 20, message: 'service-down' }),
    );

    await expect(runtime.startSearch({ query: { name: 'x' } }).promise)
      .rejects.toMatchObject({ code: 'GENERAL_SEARCH_SERVICE_ERROR' });

    expect(runtime.snapshot()).toMatchObject({
      started: 1,
      failed: 1,
      blocked: 0,
    });
  });

  it('passes caller timeout and cache overrides to the source', async () => {
    let captured: QueryExecutionControl | null = null;
    const runtime = new GeneralSearchTransportRuntimeV11(makeSource(
      (_query, _geometry, control) => {
        captured = control;
        return success([{ id: 1 }]);
      },
    ));

    await runtime.startSearch({
      query: { name: 'x' },
      execution: {
        timeoutMs: 2_500,
        cache: false,
        cacheTtlMs: 1_500,
        requestKeySuffix: 'policy-test',
      },
    }).promise;

    expect(captured).toMatchObject({
      timeoutMs: 2_500,
      cache: false,
      cacheTtlMs: 1_500,
      deduplicate: false,
    });
    expect(captured?.requestKey).toContain('policy-test');
  });

  it('uses the detail policy for geometry lookups', async () => {
    let capturedGeometry = false;
    let capturedControl: QueryExecutionControl | null = null;
    const runtime = new GeneralSearchTransportRuntimeV11(
      makeSource((_query, geometry, control) => {
        capturedGeometry = geometry;
        capturedControl = control;
        return success([{ id: 42 }]);
      }),
      {
        policy: {
          detailTimeoutMs: 4_000,
          detailCacheTtlMs: 12_000,
        },
      },
    );

    await runtime.startDetail({ objectId: 42 }).promise;

    expect(capturedGeometry).toBe(true);
    expect(capturedControl).toMatchObject({
      timeoutMs: 4_000,
      cacheTtlMs: 12_000,
      deduplicate: false,
    });
  });

  it('does not increment completed when response-integrity audit blocks the payload', async () => {
    const runtime = new GeneralSearchTransportRuntimeV11(makeSource(success([
      {
        id: 1,
        giant: 'x'.repeat(65_537),
      },
    ])));

    await expect(runtime.startSearch({ query: { name: 'x' } }).promise)
      .rejects.toMatchObject({ code: 'GENERAL_SEARCH_RESPONSE_INVALID' });

    expect(runtime.snapshot()).toMatchObject({
      started: 1,
      completed: 0,
      blocked: 1,
    });
  });

  it('keeps diagnostic retention bounded while counters continue to grow', async () => {
    const runtime = new GeneralSearchTransportRuntimeV11(
      makeSource(success([{ id: 1 }])),
      { policy: { maximumDiagnostics: 2 } },
    );

    for (let index = 0; index < 6; index += 1) {
      await runtime.startSearch({
        query: { name: `bounded-${index}` },
      }).promise;
    }

    const snapshot = runtime.snapshot();
    expect(snapshot.started).toBe(6);
    expect(snapshot.completed).toBe(6);
    expect(snapshot.diagnostics).toHaveLength(2);
    expect(snapshot.diagnostics.map(item => item.sequence)).toEqual([5, 6]);
  });

  it('keeps cancellation terminal accounting at one event for repeated cancellation attempts', async () => {
    let resolve!: (value: unknown) => void;
    const pending = new Promise<unknown>(onResolve => {
      resolve = onResolve;
    });
    const runtime = new GeneralSearchTransportRuntimeV11(makeSource(pending));
    const task = runtime.startSearch({ query: { name: 'x' } });

    expect(runtime.cancelSearch()).toBe(true);
    expect(runtime.cancelSearch()).toBe(false);

    resolve(success([{ id: 1 }]));
    await expect(task.promise).rejects.toMatchObject({
      code: 'GENERAL_SEARCH_ABORTED',
    });

    expect(runtime.snapshot()).toMatchObject({
      started: 1,
      cancelled: 1,
      superseded: 0,
    });
  });

  it('keeps supersession terminal accounting at one event when replacement begins', async () => {
    let resolveFirst!: (value: unknown) => void;
    let resolveSecond!: (value: unknown) => void;
    let call = 0;
    const source = makeSource(() => {
      call += 1;
      return new Promise<unknown>(resolve => {
        if (call === 1) resolveFirst = resolve;
        else resolveSecond = resolve;
      });
    });
    const runtime = new GeneralSearchTransportRuntimeV11(source);

    const first = runtime.startSearch({ query: { name: 'first' } });
    const second = runtime.startSearch({ query: { name: 'second' } });

    resolveSecond(success([{ id: 2 }]));
    await second.promise;
    resolveFirst(success([{ id: 1 }]));
    await expect(first.promise).rejects.toMatchObject({
      code: 'GENERAL_SEARCH_SUPERSEDED',
    });

    expect(runtime.snapshot()).toMatchObject({
      started: 2,
      completed: 1,
      superseded: 1,
      cancelled: 0,
    });
  });
});
