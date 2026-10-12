import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  BusinessAbortError,
  BusinessTimeoutError,
  type QueryExecutionControl,
} from '../../../Business/contracts';
import type { GeneralSearchTransportV11 } from './GenelAramaLifecycleContractsV11';
import {
  GeneralSearchAdmissionErrorV11,
  admitGeneralSearchQueryV11,
} from './GenelAramaLifecyclePolicyV11';
import { createGeneralSearchLifecycleRuntimeV11 } from './GenelAramaLifecycleRuntimeV11';

const success = (data: readonly unknown[] = []): unknown => ({
  type: 10,
  data,
  message: 'ok',
});

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('GeneralSearchLifecycleV11 adversarial production contracts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-12T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects prototype mutation keys at any query depth', () => {
    const root = Object.create(null) as Record<string, unknown>;
    root.__proto__ = { polluted: true };

    const nested = Object.create(null) as Record<string, unknown>;
    nested.constructor = { polluted: true };

    const first = admitGeneralSearchQueryV11(root);
    const second = admitGeneralSearchQueryV11({ safe: nested });

    expect(first.accepted).toBe(false);
    expect(first.code).toBe('QUERY_UNSUPPORTED_VALUE');
    expect(second.accepted).toBe(false);
    expect(second.code).toBe('QUERY_UNSUPPORTED_VALUE');
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('rejects cyclic query graphs by depth budget without recursing indefinitely', () => {
    const cyclic: Record<string, unknown> = { name: 'park' };
    cyclic.self = cyclic;

    const result = admitGeneralSearchQueryV11(cyclic, {
      maxQueryDepth: 4,
    });

    expect(result.accepted).toBe(false);
    expect(result.code).toBe('QUERY_TOO_DEEP');
  });

  it('rejects a broad query object before the transport observes it', async () => {
    const transport = {
      Query: vi.fn(async () => success([])),
    } satisfies GeneralSearchTransportV11;
    const runtime = createGeneralSearchLifecycleRuntimeV11({ transport }, {
      maxQueryFields: 8,
    });

    const broad = Object.fromEntries(
      Array.from({ length: 9 }, (_value, index) => [`field-${index}`, index]),
    );

    await expect(runtime.executeSearch(broad))
      .rejects.toBeInstanceOf(GeneralSearchAdmissionErrorV11);
    expect(transport.Query).not.toHaveBeenCalled();
    expect(runtime.snapshot().rejected).toBe(1);
  });

  it('rejects an oversized nested string before the transport observes it', async () => {
    const transport = {
      Query: vi.fn(async () => success([])),
    } satisfies GeneralSearchTransportV11;
    const runtime = createGeneralSearchLifecycleRuntimeV11({ transport }, {
      maxQueryStringLength: 64,
    });

    await expect(runtime.executeSearch({
      filter: {
        text: 'x'.repeat(65),
      },
    })).rejects.toBeInstanceOf(GeneralSearchAdmissionErrorV11);
    expect(transport.Query).not.toHaveBeenCalled();
  });

  it('keeps the transport request key free of raw query text', async () => {
    const requestKeys: string[] = [];
    const transport: GeneralSearchTransportV11 = {
      Query: async (_query = {}, _geometry = false, control) => {
        requestKeys.push(control?.requestKey ?? '');
        return success([]);
      },
    };
    const runtime = createGeneralSearchLifecycleRuntimeV11({ transport }, { maxRetries: 0 });

    await runtime.executeSearch({ searchText: 'kişisel özel sorgu değeri' });

    expect(requestKeys).toHaveLength(1);
    expect(requestKeys[0]).toMatch(/^general-search-v11:search:/);
    expect(requestKeys[0]).not.toContain('kişisel');
    expect(requestKeys[0]).not.toContain('özel');
  });

  it('preserves normalized query key order independent of caller object order', async () => {
    const queries: Readonly<Record<string, unknown>>[] = [];
    const transport: GeneralSearchTransportV11 = {
      Query: async query => {
        queries.push(query ?? {});
        return success([]);
      },
    };
    const runtime = createGeneralSearchLifecycleRuntimeV11({ transport }, { maxRetries: 0 });

    await runtime.executeSearch({ z: 1, a: 2, m: 3 });
    await runtime.executeSearch({ m: 3, z: 1, a: 2 });

    expect(Object.keys(queries[0] ?? {})).toEqual(['a', 'm', 'z']);
    expect(Object.keys(queries[1] ?? {})).toEqual(['a', 'm', 'z']);
    expect(runtime.history()[0]?.fingerprint).toBe(runtime.history()[1]?.fingerprint);
  });

  it('truncates a very large service collection to the configured search budget', async () => {
    const records = Array.from({ length: 50_050 }, (_value, index) => ({ id: index }));
    const transport: GeneralSearchTransportV11 = {
      Query: async () => success(records),
    };
    const runtime = createGeneralSearchLifecycleRuntimeV11({ transport }, {
      maxSearchRecords: 50_000,
      maxRetries: 0,
    });

    const result = await runtime.executeSearch({ searchText: 'all' });

    expect(result.result.inputCount).toBe(50_050);
    expect(result.result.outputCount).toBe(50_000);
    expect(result.result.truncated).toBe(true);
    expect(result.result.data[0]).toEqual({ id: 0 });
    expect(result.result.data[49_999]).toEqual({ id: 49_999 });
    expect(runtime.snapshot().truncatedResponses).toBe(1);
  });

  it('keeps detail responses on their independent small cardinality budget', async () => {
    const records = Array.from({ length: 100 }, (_value, index) => ({ id: index }));
    const transport: GeneralSearchTransportV11 = {
      Query: async () => success(records),
    };
    const runtime = createGeneralSearchLifecycleRuntimeV11({ transport }, {
      maxDetailRecords: 4,
      maxRetries: 0,
    });

    const result = await runtime.executeDetail(7);

    expect(result.result.inputCount).toBe(100);
    expect(result.result.outputCount).toBe(4);
    expect(runtime.snapshot().admittedDetailRecords).toBe(4);
  });

  it('survives sustained successful query churn with bounded retained history', async () => {
    const transport: GeneralSearchTransportV11 = {
      Query: async query => success([{ echo: query?.searchText }]),
    };
    const runtime = createGeneralSearchLifecycleRuntimeV11({ transport }, {
      maxHistory: 24,
      maxRetries: 0,
    });

    for (let index = 0; index < 200; index += 1) {
      await runtime.executeSearch({ searchText: `query-${index}` });
    }

    expect(runtime.snapshot().started).toBe(200);
    expect(runtime.snapshot().succeeded).toBe(200);
    expect(runtime.history()).toHaveLength(24);
    expect(runtime.history()[0]?.requestId).toBe(177);
    expect(runtime.history().at(-1)?.requestId).toBe(200);
    expect(runtime.audit().healthy).toBe(true);
  });

  it('survives sustained detail churn with no search-lane counter corruption', async () => {
    const transport: GeneralSearchTransportV11 = {
      Query: async query => success([{ id: query?.ObjectId }]),
    };
    const runtime = createGeneralSearchLifecycleRuntimeV11({ transport }, {
      maxHistory: 16,
      maxRetries: 0,
    });

    for (let index = 0; index < 100; index += 1) {
      await runtime.executeDetail(index);
    }

    expect(runtime.snapshot().succeeded).toBe(100);
    expect(runtime.snapshot().admittedDetailRecords).toBe(100);
    expect(runtime.searchState().requestId).toBe(0);
    expect(runtime.searchState().status).toBe('idle');
    expect(runtime.detailState().requestId).toBe(100);
    expect(runtime.history()).toHaveLength(16);
  });

  it('bounds scheduled-search churn and only executes the latest request', async () => {
    const transport = {
      Query: vi.fn(async query => success([{ query: query?.searchText }])),
    } satisfies GeneralSearchTransportV11;
    const runtime = createGeneralSearchLifecycleRuntimeV11({ transport }, {
      searchDebounceMs: 200,
      maxHistory: 8,
      maxRetries: 0,
    });

    const promises: Promise<unknown>[] = [];
    for (let index = 0; index < 50; index += 1) {
      promises.push(runtime.scheduleSearch({ searchText: `q-${index}` }));
    }

    await vi.advanceTimersByTimeAsync(200);
    const settled = await Promise.allSettled(promises);

    expect(transport.Query).toHaveBeenCalledTimes(1);
    expect(settled.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter(item => item.status === 'rejected')).toHaveLength(49);
    expect(runtime.snapshot().scheduled).toBe(50);
    expect(runtime.snapshot().cancelled).toBe(49);
    expect(runtime.snapshot().succeeded).toBe(1);
    expect(runtime.audit().healthy).toBe(true);
  });

  it('does not retry admission failures returned by the service', async () => {
    const transport = {
      Query: vi.fn(async () => ({
        type: 20,
        data: [],
        message: 'geçersiz sorgu',
      })),
    } satisfies GeneralSearchTransportV11;
    const runtime = createGeneralSearchLifecycleRuntimeV11({ transport }, {
      maxRetries: 5,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 1,
    });

    await expect(runtime.executeSearch({ searchText: 'park' }))
      .rejects.toThrow('geçersiz sorgu');

    await vi.runAllTimersAsync();
    expect(transport.Query).toHaveBeenCalledTimes(1);
    expect(runtime.snapshot().retries).toBe(0);
  });

  it('stops retrying after bounded repeated timeouts', async () => {
    const transport = {
      Query: vi.fn(async () => {
        throw new BusinessTimeoutError(500);
      }),
    } satisfies GeneralSearchTransportV11;
    const runtime = createGeneralSearchLifecycleRuntimeV11({ transport }, {
      maxRetries: 2,
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 10,
      retryJitterRatio: 0,
    });

    const promise = runtime.executeSearch({ searchText: 'park' });
    await flush();
    await vi.advanceTimersByTimeAsync(10);
    await flush();
    await vi.advanceTimersByTimeAsync(10);

    await expect(promise).rejects.toBeInstanceOf(BusinessTimeoutError);
    expect(transport.Query).toHaveBeenCalledTimes(3);
    expect(runtime.snapshot().retries).toBe(2);
    expect(runtime.snapshot().failed).toBe(1);
  });

  it('cancels a retrying request immediately when superseded', async () => {
    let calls = 0;
    const firstStarted = vi.fn();
    const transport: GeneralSearchTransportV11 = {
      Query: async query => {
        calls += 1;
        if (query?.searchText === 'first') {
          firstStarted();
          throw new BusinessTimeoutError(500);
        }
        return success([{ id: 2 }]);
      },
    };
    const runtime = createGeneralSearchLifecycleRuntimeV11({ transport }, {
      maxRetries: 4,
      retryBaseDelayMs: 1_000,
      retryMaxDelayMs: 1_000,
      retryJitterRatio: 0,
    });

    const first = runtime.executeSearch({ searchText: 'first' });
    await flush();
    expect(firstStarted).toHaveBeenCalledTimes(1);

    const second = runtime.executeSearch({ searchText: 'second' });
    expect((await second).result.outputCount).toBe(1);
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });

    await vi.runAllTimersAsync();
    expect(calls).toBe(2);
    expect(runtime.searchState().status).toBe('success');
  });

  it('keeps per-call timeout overrides bounded by policy maximum', async () => {
    const controls: QueryExecutionControl[] = [];
    const transport: GeneralSearchTransportV11 = {
      Query: async (_query = {}, _geometry = false, control) => {
        if (control) controls.push(control);
        return success([]);
      },
    };
    const runtime = createGeneralSearchLifecycleRuntimeV11({ transport }, {
      maxTimeoutMs: 2_000,
      searchTimeoutMs: 1_000,
      maxRetries: 0,
    });

    await runtime.executeSearch(
      { searchText: 'park' },
      { timeoutMs: 50_000 },
    );

    expect(controls[0]?.timeoutMs).toBe(2_000);
  });

  it('keeps per-call cache TTL overrides bounded by policy maximum', async () => {
    const controls: QueryExecutionControl[] = [];
    const transport: GeneralSearchTransportV11 = {
      Query: async (_query = {}, _geometry = false, control) => {
        if (control) controls.push(control);
        return success([]);
      },
    };
    const runtime = createGeneralSearchLifecycleRuntimeV11({ transport }, {
      maxCacheTtlMs: 5_000,
      searchCacheTtlMs: 1_000,
      maxRetries: 0,
    });

    await runtime.executeSearch(
      { searchText: 'park' },
      { cacheTtlMs: 99_000 },
    );

    expect(controls[0]?.cacheTtlMs).toBe(5_000);
  });

  it('does not coalesce identical searches when one bypasses cache', async () => {
    const promises: Array<Promise<unknown>> = [];
    const transport = {
      Query: vi.fn(() => {
        const promise = new Promise<unknown>(resolve => {
          promises.push(Promise.resolve().then(() => resolve(success([]))));
        });
        return promise;
      }),
    } satisfies GeneralSearchTransportV11;
    const runtime = createGeneralSearchLifecycleRuntimeV11({ transport }, { maxRetries: 0 });

    const first = runtime.executeSearch({ searchText: 'park' });
    const second = runtime.executeSearch(
      { searchText: 'park' },
      { bypassCache: true },
    );

    await Promise.allSettled([first, second]);
    expect(transport.Query).toHaveBeenCalledTimes(2);
    expect(runtime.snapshot().coalesced).toBe(0);
    expect(promises.length).toBe(2);
  });

  it('coalesces ordinary identical calls and retains only one terminal history entry', async () => {
    let resolveTransport!: (value: unknown) => void;
    const transportPromise = new Promise<unknown>(resolve => {
      resolveTransport = resolve;
    });
    const transport = {
      Query: vi.fn(() => transportPromise),
    } satisfies GeneralSearchTransportV11;
    const runtime = createGeneralSearchLifecycleRuntimeV11({ transport }, { maxRetries: 0 });

    const calls = Array.from({ length: 20 }, () =>
      runtime.executeSearch({ searchText: 'same' }));

    expect(transport.Query).toHaveBeenCalledTimes(1);
    expect(runtime.snapshot().coalesced).toBe(19);
    resolveTransport(success([{ id: 1 }]));

    const results = await Promise.all(calls);
    expect(new Set(results.map(result => result.requestId)).size).toBe(1);
    expect(runtime.history()).toHaveLength(1);
    expect(runtime.snapshot().succeeded).toBe(1);
  });

  it('does not leak raw server result bodies into lifecycle history', async () => {
    const transport: GeneralSearchTransportV11 = {
      Query: async () => success([{
        id: 1,
        password: 'should-not-be-retained',
        token: 'private-token',
      }]),
    };
    const runtime = createGeneralSearchLifecycleRuntimeV11({ transport }, { maxRetries: 0 });

    await runtime.executeSearch({ searchText: 'park' });

    const serialized = JSON.stringify(runtime.history());
    expect(serialized).not.toContain('should-not-be-retained');
    expect(serialized).not.toContain('private-token');
    expect(serialized).toContain('"resultCount":1');
  });

  it('does not leak raw query bodies into lifecycle history', async () => {
    const transport: GeneralSearchTransportV11 = {
      Query: async () => success([]),
    };
    const runtime = createGeneralSearchLifecycleRuntimeV11({ transport }, { maxRetries: 0 });

    await runtime.executeSearch({
      searchText: 'sensitive-search',
      nested: { userValue: 'private-value' },
    });

    const serialized = JSON.stringify(runtime.history());
    expect(serialized).not.toContain('sensitive-search');
    expect(serialized).not.toContain('private-value');
  });

  it('keeps audit healthy after mixed success, rejection and cancellation evidence', async () => {
    const transport: GeneralSearchTransportV11 = {
      Query: async query => success([{ id: query?.ObjectId ?? 1 }]),
    };
    const runtime = createGeneralSearchLifecycleRuntimeV11({ transport }, {
      maxHistory: 32,
      maxRetries: 0,
    });

    await runtime.executeSearch({ searchText: 'park' });
    await runtime.executeDetail(7);
    await expect(runtime.executeDetail(-1)).rejects.toBeInstanceOf(GeneralSearchAdmissionErrorV11);

    const scheduled = runtime.scheduleSearch({ searchText: 'later' });
    runtime.cancelSearch();
    await expect(scheduled).rejects.toMatchObject({ name: 'AbortError' });

    const audit = runtime.audit();
    expect(audit.healthy).toBe(true);
    expect(runtime.snapshot().rejected).toBe(1);
    expect(runtime.snapshot().cancelled).toBe(1);
  });

  it('keeps search and detail failures isolated under concurrent pressure', async () => {
    let detailResolve!: (value: unknown) => void;
    const detailPromise = new Promise<unknown>(resolve => {
      detailResolve = resolve;
    });
    const transport: GeneralSearchTransportV11 = {
      Query: async (_query = {}, geometry = false) => {
        if (geometry) return detailPromise;
        throw new Error('search failed');
      },
    };
    const runtime = createGeneralSearchLifecycleRuntimeV11({ transport }, { maxRetries: 0 });

    const detail = runtime.executeDetail(1);
    await expect(runtime.executeSearch({ searchText: 'park' })).rejects.toThrow('search failed');

    expect(runtime.searchState().status).toBe('failure');
    expect(runtime.detailState().status).toBe('running');

    detailResolve(success([{ id: 1 }]));
    await detail;
    expect(runtime.detailState().status).toBe('success');
    expect(runtime.snapshot().failed).toBe(1);
    expect(runtime.snapshot().succeeded).toBe(1);
  });

  it('keeps search and detail cancellations isolated under concurrent pressure', async () => {
    let searchReject!: (reason: unknown) => void;
    let detailResolve!: (value: unknown) => void;
    const searchPromise = new Promise<unknown>((_resolve, reject) => {
      searchReject = reject;
    });
    const detailPromise = new Promise<unknown>(resolve => {
      detailResolve = resolve;
    });
    const transport: GeneralSearchTransportV11 = {
      Query: (_query = {}, geometry = false) => geometry ? detailPromise : searchPromise,
    };
    const runtime = createGeneralSearchLifecycleRuntimeV11({ transport }, { maxRetries: 0 });

    const search = runtime.executeSearch({ searchText: 'park' });
    const detail = runtime.executeDetail(1);

    runtime.cancelSearch();
    searchReject(new BusinessAbortError());
    await expect(search).rejects.toMatchObject({ name: 'AbortError' });

    expect(runtime.detailState().status).toBe('running');
    detailResolve(success([{ id: 1 }]));
    await detail;
    expect(runtime.detailState().status).toBe('success');
  });

  it('keeps snapshot fingerprint stable when state is unchanged', async () => {
    const transport: GeneralSearchTransportV11 = {
      Query: async () => success([]),
    };
    const runtime = createGeneralSearchLifecycleRuntimeV11({ transport }, { maxRetries: 0 });

    await runtime.executeSearch({ searchText: 'park' });
    expect(runtime.snapshot().fingerprint).toBe(runtime.snapshot().fingerprint);
  });

  it('changes snapshot fingerprint after lifecycle evidence changes', async () => {
    const transport: GeneralSearchTransportV11 = {
      Query: async () => success([]),
    };
    const runtime = createGeneralSearchLifecycleRuntimeV11({ transport }, { maxRetries: 0 });

    const before = runtime.snapshot().fingerprint;
    await runtime.executeSearch({ searchText: 'park' });
    const after = runtime.snapshot().fingerprint;

    expect(after).not.toBe(before);
  });
});
