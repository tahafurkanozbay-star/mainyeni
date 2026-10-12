import { describe, expect, it, vi } from 'vitest';
import type {
  FastAccessQuery,
  QueryExecutionControl,
} from '../../../Business/contracts';
import {
  isGeneralSearchTransportCancellationV11,
} from './GenelAramaTransportContractsV11';
import {
  GeneralSearchTransportRuntimeV11,
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

interface CapturedCall {
  readonly query: FastAccessQuery;
  readonly returnGeometry: boolean;
  readonly options: QueryExecutionControl;
}

const sourceWith = (
  handler: (
    query: FastAccessQuery,
    returnGeometry: boolean,
    options: QueryExecutionControl,
    index: number,
  ) => Promise<unknown> | unknown,
) => {
  const calls: CapturedCall[] = [];
  const Query = vi.fn(async (
    query: FastAccessQuery = {},
    returnGeometry = false,
    options: QueryExecutionControl = {},
  ) => {
    const index = calls.length;
    calls.push({ query, returnGeometry, options });
    return handler(query, returnGeometry, options, index);
  });
  return { source: Object.freeze({ Query }), Query, calls };
};

const success = (data: readonly unknown[]): unknown => ({
  type: 10,
  data,
  message: '',
});

describe('Genel Arama transport v11 adversarial lifecycle', () => {
  it('keeps a stable cache identity across sequential identical searches without dedupe coupling', async () => {
    const fake = sourceWith((_query, _returnGeometry, _options, index) => success([{ id: index }]));
    const runtime = new GeneralSearchTransportRuntimeV11(fake.source);

    await runtime.startSearch({ query: { name: 'aynı' } }).promise;
    await runtime.startSearch({ query: { name: 'aynı' } }).promise;

    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]?.options.requestKey).toBe(fake.calls[1]?.options.requestKey);
    expect(fake.calls[0]?.options.deduplicate).toBe(false);
    expect(fake.calls[1]?.options.deduplicate).toBe(false);
  });

  it('changes request-key suffix without changing semantic request fingerprint', () => {
    const left = createGeneralSearchTransportIdentityV11(
      'search',
      { name: 'ankara' },
      false,
      'window-a',
    );
    const right = createGeneralSearchTransportIdentityV11(
      'search',
      { name: 'ankara' },
      false,
      'window-b',
    );

    expect(left.requestFingerprint).toBe(right.requestFingerprint);
    expect(left.requestKey).not.toBe(right.requestKey);
  });

  it('rejects a pre-aborted external signal without delivering a source result', async () => {
    const fake = sourceWith(() => success([{ id: 1 }]));
    const runtime = new GeneralSearchTransportRuntimeV11(fake.source);
    const controller = new AbortController();
    controller.abort(new DOMException('external abort', 'AbortError'));

    const task = runtime.startSearch({
      query: { name: 'abort-before-start' },
      execution: { signal: controller.signal },
    });

    await expect(task.promise).rejects.toSatisfy(isGeneralSearchTransportCancellationV11);
    expect(fake.Query).not.toHaveBeenCalled();
    expect(runtime.snapshot().cancelled).toBe(1);
  });

  it('does not allow a late superseded success to overwrite newer scalar diagnostics', async () => {
    const oldRequest = deferred<unknown>();
    const newRequest = deferred<unknown>();
    const fake = sourceWith((_query, _geometry, _options, index) => (
      index === 0 ? oldRequest.promise : newRequest.promise
    ));
    const runtime = new GeneralSearchTransportRuntimeV11(fake.source);

    const oldTask = runtime.startSearch({ query: { name: 'old' } });
    const newTask = runtime.startSearch({ query: { name: 'new' } });

    newRequest.resolve(success([{ id: 'new' }]));
    await newTask.promise;

    oldRequest.resolve(success([{ id: 'old' }]));
    await expect(oldTask.promise).rejects.toMatchObject({
      code: 'GENERAL_SEARCH_SUPERSEDED',
    });

    const diagnostics = runtime.snapshot().diagnostics;
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.map(item => item.outcome).sort()).toEqual([
      'success',
      'superseded',
    ]);
    expect(diagnostics.find(item => item.outcome === 'success')?.requestFingerprint)
      .toBe(newTask.requestFingerprint);
  });

  it('isolates hostile reporter behavior across many successful operations', async () => {
    const fake = sourceWith((_query, _geometry, _options, index) => success([{ id: index }]));
    let reporterCalls = 0;
    const runtime = new GeneralSearchTransportRuntimeV11(fake.source, {
      reporter: () => {
        reporterCalls += 1;
        if (reporterCalls % 2 === 0) throw new Error('reporter-hostile');
      },
      policy: { maximumDiagnostics: 10 },
    });

    for (let index = 0; index < 25; index += 1) {
      const result = await runtime.startSearch({
        query: { name: `q-${index}` },
      }).promise;
      expect(result.acceptedRecordCount).toBe(1);
    }

    const snapshot = runtime.snapshot();
    expect(snapshot.completed).toBe(25);
    expect(snapshot.reporterFailures).toBe(12);
    expect(snapshot.diagnostics).toHaveLength(10);
    expect(snapshot.diagnostics[0]?.sequence).toBe(16);
    expect(snapshot.diagnostics[9]?.sequence).toBe(25);
  });

  it('makes repeated cancelAll calls idempotent for already-aborted tasks', async () => {
    const search = deferred<unknown>();
    const detail = deferred<unknown>();
    const fake = sourceWith((_query, geometry) => geometry ? detail.promise : search.promise);
    const runtime = new GeneralSearchTransportRuntimeV11(fake.source);

    const searchTask = runtime.startSearch({ query: { name: 'x' } });
    const detailTask = runtime.startDetail({ objectId: 1 });

    expect(runtime.cancelAll()).toBe(2);
    expect(runtime.cancelAll()).toBe(2);

    search.resolve(success([{ id: 'search' }]));
    detail.resolve(success([{ id: 'detail' }]));

    await expect(searchTask.promise).rejects.toSatisfy(isGeneralSearchTransportCancellationV11);
    await expect(detailTask.promise).rejects.toSatisfy(isGeneralSearchTransportCancellationV11);

    const snapshot = runtime.snapshot();
    expect(snapshot.cancelled).toBe(2);
    expect(snapshot.activeSearchRequestId).toBeNull();
    expect(snapshot.activeDetailRequestId).toBeNull();
  });

  it('keeps search active while a detail request is cancelled and replaced', async () => {
    const search = deferred<unknown>();
    const detailA = deferred<unknown>();
    const detailB = deferred<unknown>();
    let detailIndex = 0;
    const fake = sourceWith((_query, geometry) => {
      if (!geometry) return search.promise;
      detailIndex += 1;
      return detailIndex === 1 ? detailA.promise : detailB.promise;
    });
    const runtime = new GeneralSearchTransportRuntimeV11(fake.source);

    const searchTask = runtime.startSearch({ query: { name: 'stable-search' } });
    const firstDetail = runtime.startDetail({ objectId: 1 });
    const secondDetail = runtime.startDetail({ objectId: 2 });

    expect(searchTask.isCurrent()).toBe(true);
    expect(firstDetail.isCurrent()).toBe(false);
    expect(secondDetail.isCurrent()).toBe(true);

    search.resolve(success([{ id: 's' }]));
    detailA.resolve(success([{ id: 1 }]));
    detailB.resolve(success([{ id: 2 }]));

    await expect(searchTask.promise).resolves.toMatchObject({ acceptedRecordCount: 1 });
    await expect(firstDetail.promise).rejects.toMatchObject({ code: 'GENERAL_SEARCH_SUPERSEDED' });
    await expect(secondDetail.promise).resolves.toMatchObject({ acceptedRecordCount: 1 });
  });
});

describe('Genel Arama transport v11 adversarial response boundaries', () => {
  it('accepts exactly maximumSearchRecords records', async () => {
    const rows = Array.from({ length: 100 }, (_value, index) => ({ id: index }));
    const fake = sourceWith(() => success(rows));
    const runtime = new GeneralSearchTransportRuntimeV11(fake.source, {
      policy: { maximumSearchRecords: 100 },
    });

    await expect(runtime.startSearch({ query: { name: 'x' } }).promise).resolves.toMatchObject({
      inputRecordCount: 100,
      acceptedRecordCount: 100,
    });
  });

  it('blocks one record above maximumSearchRecords', async () => {
    const rows = Array.from({ length: 101 }, (_value, index) => ({ id: index }));
    const fake = sourceWith(() => success(rows));
    const runtime = new GeneralSearchTransportRuntimeV11(fake.source, {
      policy: { maximumSearchRecords: 100 },
    });

    await expect(runtime.startSearch({ query: { name: 'x' } }).promise).rejects.toMatchObject({
      code: 'GENERAL_SEARCH_RESPONSE_LIMIT',
    });
  });

  it('accepts exactly the malformed-record allowance and reports the surviving records', async () => {
    const fake = sourceWith(() => success([
      null,
      'bad',
      { id: 1 },
    ]));
    const runtime = new GeneralSearchTransportRuntimeV11(fake.source, {
      policy: {
        maximumSearchRecords: 10,
        maximumMalformedRecords: 2,
      },
    });

    const envelope = await runtime.startSearch({ query: { name: 'x' } }).promise;
    expect(envelope).toMatchObject({
      inputRecordCount: 3,
      acceptedRecordCount: 1,
      malformedRecordCount: 2,
    });
  });

  it('blocks one malformed record above the configured allowance', async () => {
    const fake = sourceWith(() => success([
      null,
      'bad',
      99,
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
  });

  it('accepts a 65,536-character shallow field at the integrity boundary', async () => {
    const fake = sourceWith(() => success([
      { id: 1, description: 'x'.repeat(65_536) },
    ]));
    const runtime = new GeneralSearchTransportRuntimeV11(fake.source, {
      policy: { maximumSearchRecords: 10 },
    });

    await expect(runtime.startSearch({ query: { name: 'x' } }).promise).resolves.toMatchObject({
      acceptedRecordCount: 1,
    });
  });

  it('blocks a 65,537-character shallow field before it reaches the UI normalizer', async () => {
    const fake = sourceWith(() => success([
      { id: 1, description: 'x'.repeat(65_537) },
    ]));
    const runtime = new GeneralSearchTransportRuntimeV11(fake.source, {
      policy: { maximumSearchRecords: 10 },
    });

    await expect(runtime.startSearch({ query: { name: 'x' } }).promise).rejects.toMatchObject({
      code: 'GENERAL_SEARCH_RESPONSE_INVALID',
    });
  });

  it('does not recursively reject a large nested service object when its top-level surface is bounded', async () => {
    const fake = sourceWith(() => success([
      {
        id: 1,
        attr: {
          intentionallyNested: 'x'.repeat(100_000),
          deeplyNestedArray: new Array(20_000).fill('nested'),
        },
      },
    ]));
    const runtime = new GeneralSearchTransportRuntimeV11(fake.source);

    await expect(runtime.startSearch({ query: { name: 'x' } }).promise).resolves.toMatchObject({
      acceptedRecordCount: 1,
    });
  });

  it('accepts legacy Type/Data casing through the full runtime', async () => {
    const fake = sourceWith(() => ({
      Type: 10,
      Data: [{ id: 7 }],
      Message: 'legacy-ok',
    }));
    const runtime = new GeneralSearchTransportRuntimeV11(fake.source);

    await expect(runtime.startSearch({ query: { name: 'legacy' } }).promise).resolves.toMatchObject({
      acceptedRecordCount: 1,
      message: 'legacy-ok',
    });
  });

  it('bounds hostile service failure text before surfacing the retryable error', async () => {
    const fake = sourceWith(() => ({
      type: 20,
      message: 'x'.repeat(10_000),
    }));
    const runtime = new GeneralSearchTransportRuntimeV11(fake.source, {
      policy: { maximumMessageLength: 128 },
    });

    try {
      await runtime.startSearch({ query: { name: 'x' } }).promise;
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'GENERAL_SEARCH_SERVICE_ERROR',
        retryable: true,
      });
      expect((error as Error).message.length).toBeLessThanOrEqual(128);
    }
  });

  it('normalizes numeric and string detail identifiers without exposing geometry on list searches', async () => {
    const fake = sourceWith((query, returnGeometry) => success([
      {
        id: query.ObjectId ?? null,
        geometryRequested: returnGeometry,
      },
    ]));
    const runtime = new GeneralSearchTransportRuntimeV11(fake.source);

    const numeric = await runtime.startDetail({ objectId: 42 }).promise;
    const textual = await runtime.startDetail({ objectId: '0042' }).promise;
    const search = await runtime.startSearch({ query: { name: 'x' } }).promise;

    expect(numeric.records[0]).toMatchObject({ id: 42, geometryRequested: true });
    expect(textual.records[0]).toMatchObject({ id: '0042', geometryRequested: true });
    expect(search.records[0]).toMatchObject({ geometryRequested: false });
  });
});
