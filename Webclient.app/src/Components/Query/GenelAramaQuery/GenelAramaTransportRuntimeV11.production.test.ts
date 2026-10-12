import { describe, expect, it, vi } from 'vitest';
import type {
  FastAccessQuery,
  QueryExecutionControl,
} from '../../../Business/contracts';
import {
  GeneralSearchTransportErrorV11,
  isGeneralSearchTransportCancellationV11,
} from './GenelAramaTransportContractsV11';
import {
  GeneralSearchTransportRuntimeV11,
  admitGeneralSearchServiceResultV11,
  createGeneralSearchTransportControlPlanV11,
  createGeneralSearchTransportIdentityV11,
} from './GenelAramaTransportRuntimeV11';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
};

interface QueryCall {
  readonly query: FastAccessQuery;
  readonly returnGeometry: boolean;
  readonly options: QueryExecutionControl;
}

const createSource = (
  implementation: (
    query: FastAccessQuery,
    returnGeometry: boolean,
    options: QueryExecutionControl,
  ) => Promise<unknown> | unknown,
) => {
  const calls: QueryCall[] = [];
  const Query = vi.fn(async (
    query: FastAccessQuery = {},
    returnGeometry = false,
    options: QueryExecutionControl = {},
  ) => {
    calls.push({ query, returnGeometry, options });
    return implementation(query, returnGeometry, options);
  });
  return {
    source: Object.freeze({ Query }),
    calls,
    Query,
  };
};

const success = (
  data: readonly unknown[],
  message = '',
): unknown => Object.freeze({
  type: 10,
  data,
  message,
});

const failure = (message: string): unknown => Object.freeze({
  type: 20,
  data: Object.freeze([]),
  message,
});

describe('Genel Arama transport v11 contracts and admission', () => {
  it('creates deterministic operation-scoped identities without exposing the raw query', () => {
    const left = createGeneralSearchTransportIdentityV11(
      'search',
      {
        name: ' Çankaya Belediyesi ',
        districtId: 6,
        showNearby: true,
        bufferDistance: 20,
        userLocation: { latitude: 39.91, longitude: 32.85 },
      },
      false,
      'window-a',
    );
    const right = createGeneralSearchTransportIdentityV11(
      'search',
      {
        name: ' Çankaya Belediyesi ',
        districtId: 6,
        showNearby: true,
        bufferDistance: 20,
        userLocation: { latitude: 39.91, longitude: 32.85 },
      },
      false,
      'window-a',
    );
    const detail = createGeneralSearchTransportIdentityV11(
      'detail',
      { ObjectId: 42 },
      true,
      'window-a',
    );

    expect(left).toEqual(right);
    expect(left.requestFingerprint).not.toContain('Çankaya');
    expect(left.requestKey).not.toContain('Çankaya');
    expect(left.requestKey).toContain('genel-arama-v11:search');
    expect(detail.requestFingerprint).not.toBe(left.requestFingerprint);
    expect(detail.requestKey).toContain('genel-arama-v11:detail');
  });

  it('normalizes transport control while keeping subscriber-owned requests out of inflight dedupe', () => {
    const controller = new AbortController();
    const plan = createGeneralSearchTransportControlPlanV11(
      'search',
      { name: 'park' },
      false,
      {
        timeoutMs: 9_000,
        cacheTtlMs: 5_000,
        cache: true,
        requestKeySuffix: 'Main Window',
      },
      { searchTimeoutMs: 15_000, searchCacheTtlMs: 20_000 },
      controller.signal,
    );

    expect(plan.returnGeometry).toBe(false);
    expect(plan.control.signal).toBe(controller.signal);
    expect(plan.control.timeoutMs).toBe(9_000);
    expect(plan.control.cacheTtlMs).toBe(5_000);
    expect(plan.control.cache).toBe(true);
    expect(plan.control.deduplicate).toBe(false);
    expect(plan.control.requestKey).toContain('main-window');
  });

  it('admits both modern and legacy service-result casing', () => {
    const modern = admitGeneralSearchServiceResultV11(
      {
        type: 10,
        data: [{ id: 1 }, { id: 2 }],
        message: 'ok',
      },
      {
        operation: 'search',
        successType: 10,
        maximumRecords: 10,
        maximumMessageLength: 100,
      },
    );
    const legacy = admitGeneralSearchServiceResultV11(
      {
        Type: '10',
        Data: [{ id: 3 }],
        Message: 'legacy',
      },
      {
        operation: 'search',
        successType: 10,
        maximumRecords: 10,
        maximumMessageLength: 100,
      },
    );

    expect(modern.type).toBe(10);
    expect(modern.data).toHaveLength(2);
    expect(modern.acceptedRecordCount).toBe(2);
    expect(legacy.type).toBe(10);
    expect(legacy.data).toHaveLength(1);
    expect(legacy.message).toBe('legacy');
  });

  it('rejects a successful response that is missing its record array', () => {
    expect(() => admitGeneralSearchServiceResultV11(
      { type: 10, data: { id: 1 } },
      {
        operation: 'search',
        successType: 10,
        maximumRecords: 10,
        maximumMessageLength: 100,
      },
    )).toThrowError(GeneralSearchTransportErrorV11);
  });

  it('marks oversize responses as truncated and drops malformed top-level records', () => {
    const admitted = admitGeneralSearchServiceResultV11(
      {
        type: 10,
        data: [{ id: 1 }, null, 'bad', { id: 2 }, { id: 3 }],
      },
      {
        operation: 'search',
        successType: 10,
        maximumRecords: 4,
        maximumMessageLength: 100,
      },
    );

    expect(admitted.inputRecordCount).toBe(5);
    expect(admitted.acceptedRecordCount).toBe(2);
    expect(admitted.malformedRecordCount).toBe(2);
    expect(admitted.truncated).toBe(true);
    expect(Object.isFrozen(admitted.data)).toBe(true);
    expect(Object.isFrozen(admitted.data[0])).toBe(true);
  });

  it('bounds service messages before they enter UI-facing errors or envelopes', () => {
    const admitted = admitGeneralSearchServiceResultV11(
      {
        type: 20,
        message: 'x'.repeat(5_000),
      },
      {
        operation: 'search',
        successType: 10,
        maximumRecords: 10,
        maximumMessageLength: 64,
      },
    );
    expect(admitted.message).toHaveLength(64);
  });
});

describe('GeneralSearchTransportRuntimeV11 search lifecycle', () => {
  it('executes a bounded search with stable cache identity and scalar diagnostics', async () => {
    let now = 1_000;
    const reporter = vi.fn();
    const fake = createSource(() => success([
      { id: 1, title: 'Park' },
      { id: 2, title: 'Müze' },
    ], 'tamam'));
    const runtime = new GeneralSearchTransportRuntimeV11(fake.source, {
      clock: () => now,
      reporter,
      policy: {
        maximumSearchRecords: 100,
        maximumDiagnostics: 16,
      },
    });

    const task = runtime.startSearch({
      query: { name: 'park' },
      execution: { requestKeySuffix: 'results' },
    });
    now = 1_250;
    const envelope = await task.promise;

    expect(task.isCurrent()).toBe(false);
    expect(envelope.operation).toBe('search');
    expect(envelope.records).toHaveLength(2);
    expect(envelope.message).toBe('tamam');
    expect(envelope.elapsedMs).toBe(250);
    expect(envelope.stale).toBe(false);

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.returnGeometry).toBe(false);
    expect(fake.calls[0]?.options.deduplicate).toBe(false);
    expect(fake.calls[0]?.options.cache).toBe(true);
    expect(fake.calls[0]?.options.signal).toBeInstanceOf(AbortSignal);
    expect(fake.calls[0]?.options.requestKey).toContain('genel-arama-v11:search');

    const snapshot = runtime.snapshot();
    expect(snapshot.started).toBe(1);
    expect(snapshot.completed).toBe(1);
    expect(snapshot.failed).toBe(0);
    expect(snapshot.diagnostics).toHaveLength(1);
    expect(snapshot.diagnostics[0]).toMatchObject({
      operation: 'search',
      outcome: 'success',
      inputRecordCount: 2,
      acceptedRecordCount: 2,
      malformedRecordCount: 0,
      code: 'OK',
    });
    expect(reporter).toHaveBeenCalledTimes(1);
  });

  it('supersedes an older search without allowing its late result to become current', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    let call = 0;
    const fake = createSource(() => {
      call += 1;
      return call === 1 ? first.promise : second.promise;
    });
    const runtime = new GeneralSearchTransportRuntimeV11(fake.source);

    const oldTask = runtime.startSearch({ query: { name: 'eski' } });
    const newTask = runtime.startSearch({ query: { name: 'yeni' } });

    expect(oldTask.isCurrent()).toBe(false);
    expect(newTask.isCurrent()).toBe(true);
    expect(fake.calls[0]?.options.signal?.aborted).toBe(true);

    second.resolve(success([{ id: 2, title: 'Yeni' }]));
    await expect(newTask.promise).resolves.toMatchObject({
      acceptedRecordCount: 1,
      stale: false,
    });

    first.resolve(success([{ id: 1, title: 'Eski' }]));
    await expect(oldTask.promise).rejects.toMatchObject({
      name: 'AbortError',
      code: 'GENERAL_SEARCH_SUPERSEDED',
    });

    const snapshot = runtime.snapshot();
    expect(snapshot.completed).toBe(1);
    expect(snapshot.superseded).toBe(1);
    expect(snapshot.activeSearchRequestId).toBeNull();
  });

  it('lets detail and search execute independently while superseding only same-operation work', async () => {
    const searchDeferred = deferred<unknown>();
    const firstDetail = deferred<unknown>();
    const secondDetail = deferred<unknown>();
    let detailCall = 0;
    const fake = createSource((query, returnGeometry) => {
      if (!returnGeometry) return searchDeferred.promise;
      detailCall += 1;
      return detailCall === 1 ? firstDetail.promise : secondDetail.promise;
    });
    const runtime = new GeneralSearchTransportRuntimeV11(fake.source);

    const searchTask = runtime.startSearch({ query: { name: 'Ankara' } });
    const detailA = runtime.startDetail({ objectId: 10 });
    const detailB = runtime.startDetail({ objectId: 11 });

    expect(searchTask.isCurrent()).toBe(true);
    expect(detailA.isCurrent()).toBe(false);
    expect(detailB.isCurrent()).toBe(true);
    expect(fake.calls[0]?.options.signal?.aborted).toBe(false);
    expect(fake.calls[1]?.options.signal?.aborted).toBe(true);
    expect(fake.calls[2]?.returnGeometry).toBe(true);

    searchDeferred.resolve(success([{ id: 'search' }]));
    secondDetail.resolve(success([{ id: 11, geometry: { x: 1, y: 2 } }]));
    firstDetail.resolve(success([{ id: 10 }]));

    await expect(searchTask.promise).resolves.toMatchObject({ acceptedRecordCount: 1 });
    await expect(detailB.promise).resolves.toMatchObject({ acceptedRecordCount: 1 });
    await expect(detailA.promise).rejects.toMatchObject({
      code: 'GENERAL_SEARCH_SUPERSEDED',
    });

    expect(runtime.snapshot()).toMatchObject({
      completed: 2,
      superseded: 1,
    });
  });

  it('propagates an external abort into the owned transport controller', async () => {
    const pending = deferred<unknown>();
    const fake = createSource(() => pending.promise);
    const runtime = new GeneralSearchTransportRuntimeV11(fake.source);
    const controller = new AbortController();

    const task = runtime.startSearch({
      query: { name: 'cancel-me' },
      execution: { signal: controller.signal },
    });
    controller.abort();

    expect(fake.calls[0]?.options.signal?.aborted).toBe(true);
    pending.resolve(success([{ id: 1 }]));

    await expect(task.promise).rejects.toSatisfy(isGeneralSearchTransportCancellationV11);
    expect(runtime.snapshot().cancelled).toBe(1);
  });

  it('supports explicit task cancellation without cancelling the independent detail channel', async () => {
    const searchPending = deferred<unknown>();
    const detailPending = deferred<unknown>();
    const fake = createSource((_query, returnGeometry) => (
      returnGeometry ? detailPending.promise : searchPending.promise
    ));
    const runtime = new GeneralSearchTransportRuntimeV11(fake.source);

    const searchTask = runtime.startSearch({ query: { name: 'park' } });
    const detailTask = runtime.startDetail({ objectId: 44 });

    searchTask.cancel('search closed');
    expect(fake.calls[0]?.options.signal?.aborted).toBe(true);
    expect(fake.calls[1]?.options.signal?.aborted).toBe(false);
    expect(detailTask.isCurrent()).toBe(true);

    searchPending.resolve(success([{ id: 1 }]));
    detailPending.resolve(success([{ id: 44 }]));

    await expect(searchTask.promise).rejects.toMatchObject({ name: 'AbortError' });
    await expect(detailTask.promise).resolves.toMatchObject({ acceptedRecordCount: 1 });
  });
});

describe('GeneralSearchTransportRuntimeV11 fail-closed response handling', () => {
  it('turns service-declared failures into a bounded retryable transport error', async () => {
    const fake = createSource(() => failure('servis geçici olarak kullanılamıyor'));
    const runtime = new GeneralSearchTransportRuntimeV11(fake.source);
    const task = runtime.startSearch({ query: { name: 'park' } });

    await expect(task.promise).rejects.toMatchObject({
      code: 'GENERAL_SEARCH_SERVICE_ERROR',
      retryable: true,
    });
    expect(runtime.snapshot()).toMatchObject({
      failed: 1,
      blocked: 0,
    });
  });

  it('blocks a search response that exceeds the configured record cardinality', async () => {
    const fake = createSource(() => success([
      { id: 1 },
      { id: 2 },
      { id: 3 },
    ]));
    const runtime = new GeneralSearchTransportRuntimeV11(fake.source, {
      policy: { maximumSearchRecords: 2 },
    });
    const task = runtime.startSearch({ query: { name: 'x' } });

    await expect(task.promise).rejects.toMatchObject({
      code: 'GENERAL_SEARCH_RESPONSE_LIMIT',
    });
    expect(runtime.snapshot().blocked).toBe(1);
  });

  it('blocks a detail response that returns more rows than the detail contract allows', async () => {
    const fake = createSource(() => success([
      { id: 1 },
      { id: 2 },
    ]));
    const runtime = new GeneralSearchTransportRuntimeV11(fake.source, {
      policy: { maximumDetailRecords: 1 },
    });

    await expect(runtime.startDetail({ objectId: 1 }).promise).rejects.toMatchObject({
      code: 'GENERAL_SEARCH_RESPONSE_LIMIT',
    });
  });

  it('blocks responses with excessive malformed top-level records', async () => {
    const fake = createSource(() => success([
      null,
      'bad',
      42,
      { id: 1 },
    ]));
    const runtime = new GeneralSearchTransportRuntimeV11(fake.source, {
      policy: {
        maximumSearchRecords: 10,
        maximumMalformedRecords: 2,
      },
    });

    await expect(runtime.startSearch({ query: { name: 'x' } }).promise).rejects.toMatchObject({
      code: 'GENERAL_SEARCH_RESPONSE_INVALID',
    });
    expect(runtime.snapshot().blocked).toBe(1);
  });

  it('rejects a malformed success envelope instead of treating it as an empty result', async () => {
    const fake = createSource(() => ({ type: 10, data: { id: 1 } }));
    const runtime = new GeneralSearchTransportRuntimeV11(fake.source);

    await expect(runtime.startSearch({ query: { name: 'x' } }).promise).rejects.toMatchObject({
      code: 'GENERAL_SEARCH_RESPONSE_INVALID',
    });
    expect(runtime.snapshot().blocked).toBe(1);
  });

  it('does not treat a transport exception as a response-admission failure', async () => {
    const fake = createSource(() => {
      throw Object.assign(new Error('network-ish failure'), { code: 'EXECUTOR_FAILURE' });
    });
    const runtime = new GeneralSearchTransportRuntimeV11(fake.source);

    await expect(runtime.startSearch({ query: { name: 'x' } }).promise).rejects.toThrow(
      'network-ish failure',
    );
    const snapshot = runtime.snapshot();
    expect(snapshot.failed).toBe(1);
    expect(snapshot.blocked).toBe(0);
    expect(snapshot.diagnostics[0]?.code).toBe('EXECUTOR_FAILURE');
  });
});

describe('GeneralSearchTransportRuntimeV11 diagnostics and disposal', () => {
  it('bounds diagnostics independently from lifetime request counters', async () => {
    const fake = createSource((query) => success([{ id: query.name }]));
    const runtime = new GeneralSearchTransportRuntimeV11(fake.source, {
      policy: { maximumDiagnostics: 3 },
    });

    for (let index = 0; index < 8; index += 1) {
      await runtime.startSearch({ query: { name: `q-${index}` } }).promise;
    }

    const snapshot = runtime.snapshot();
    expect(snapshot.started).toBe(8);
    expect(snapshot.completed).toBe(8);
    expect(snapshot.diagnostics).toHaveLength(3);
    expect(snapshot.diagnostics.map(item => item.sequence)).toEqual([6, 7, 8]);
  });

  it('isolates reporter failures from successful search delivery', async () => {
    const fake = createSource(() => success([{ id: 1 }]));
    const runtime = new GeneralSearchTransportRuntimeV11(fake.source, {
      reporter: () => {
        throw new Error('reporter failed');
      },
    });

    await expect(runtime.startSearch({ query: { name: 'x' } }).promise).resolves.toMatchObject({
      acceptedRecordCount: 1,
    });
    expect(runtime.snapshot()).toMatchObject({
      completed: 1,
      reporterFailures: 1,
    });
  });

  it('cancelAll aborts both channels without retaining active IDs', async () => {
    const searchPending = deferred<unknown>();
    const detailPending = deferred<unknown>();
    const fake = createSource((_query, returnGeometry) => (
      returnGeometry ? detailPending.promise : searchPending.promise
    ));
    const runtime = new GeneralSearchTransportRuntimeV11(fake.source);

    const searchTask = runtime.startSearch({ query: { name: 'x' } });
    const detailTask = runtime.startDetail({ objectId: 9 });

    expect(runtime.cancelAll()).toBe(2);
    searchPending.resolve(success([{ id: 1 }]));
    detailPending.resolve(success([{ id: 9 }]));

    await expect(searchTask.promise).rejects.toMatchObject({ name: 'AbortError' });
    await expect(detailTask.promise).rejects.toMatchObject({ name: 'AbortError' });

    expect(runtime.snapshot()).toMatchObject({
      activeSearchRequestId: null,
      activeDetailRequestId: null,
      cancelled: 2,
    });
  });

  it('dispose is idempotent and prevents future work', async () => {
    const pending = deferred<unknown>();
    const fake = createSource(() => pending.promise);
    const runtime = new GeneralSearchTransportRuntimeV11(fake.source);
    const task = runtime.startSearch({ query: { name: 'x' } });

    runtime.dispose();
    runtime.dispose();
    pending.resolve(success([{ id: 1 }]));

    await expect(task.promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(runtime.snapshot()).toMatchObject({
      disposed: true,
      activeSearchRequestId: null,
      activeDetailRequestId: null,
    });

    expect(() => runtime.startSearch({ query: { name: 'after-dispose' } })).toThrowError(
      GeneralSearchTransportErrorV11,
    );
  });
});
