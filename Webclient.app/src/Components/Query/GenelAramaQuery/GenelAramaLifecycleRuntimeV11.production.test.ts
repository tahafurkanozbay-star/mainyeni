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
} from './GenelAramaLifecyclePolicyV11';
import {
  createGeneralSearchLifecycleRuntimeV11,
  type GeneralSearchLifecycleRuntimeV11,
} from './GenelAramaLifecycleRuntimeV11';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const success = (data: readonly unknown[] = [], message = 'ok'): unknown => ({
  type: 10,
  data,
  message,
});

const failure = (message = 'failure'): unknown => ({
  type: 20,
  data: [],
  message,
});

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('GeneralSearchLifecycleRuntimeV11', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-12T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes governed FastAccess controls to search transport', async () => {
    const calls: Array<{
      query: Readonly<Record<string, unknown>>;
      geometry: boolean;
      control: QueryExecutionControl | undefined;
    }> = [];
    const transport: GeneralSearchTransportV11 = {
      Query: async (query = {}, geometry = false, control) => {
        calls.push({ query, geometry, control });
        return success([{ id: 1 }]);
      },
    };
    const runtime = createGeneralSearchLifecycleRuntimeV11({ transport }, {
      searchTimeoutMs: 3_000,
      searchCacheTtlMs: 5_000,
      maxRetries: 0,
    });

    const envelope = await runtime.executeSearch({ searchText: '  park  ' });

    expect(envelope.result.outputCount).toBe(1);
    expect(envelope.query).toEqual({ searchText: 'park' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.geometry).toBe(false);
    expect(calls[0]?.control?.timeoutMs).toBe(3_000);
    expect(calls[0]?.control?.cacheTtlMs).toBe(5_000);
    expect(calls[0]?.control?.cache).toBe(true);
    expect(calls[0]?.control?.deduplicate).toBe(true);
    expect(calls[0]?.control?.requestKey).toMatch(/^general-search-v11:search:/);
    expect(calls[0]?.control?.signal).toBeInstanceOf(AbortSignal);
    expect(runtime.searchState().status).toBe('success');
    expect(runtime.snapshot().succeeded).toBe(1);
  });

  it('uses detail geometry mode and independent detail budgets', async () => {
    const calls: Array<{
      query: Readonly<Record<string, unknown>>;
      geometry: boolean;
      control: QueryExecutionControl | undefined;
    }> = [];
    const transport: GeneralSearchTransportV11 = {
      Query: async (query = {}, geometry = false, control) => {
        calls.push({ query, geometry, control });
        return success([{ id: 7, geometry: { x: 1, y: 2 } }]);
      },
    };
    const runtime = createGeneralSearchLifecycleRuntimeV11({ transport }, {
      detailTimeoutMs: 2_500,
      detailCacheTtlMs: 45_000,
      maxRetries: 0,
    });

    const envelope = await runtime.executeDetail(7);

    expect(envelope.lane).toBe('detail');
    expect(envelope.returnGeometry).toBe(true);
    expect(calls[0]?.query).toEqual({ ObjectId: 7 });
    expect(calls[0]?.geometry).toBe(true);
    expect(calls[0]?.control?.timeoutMs).toBe(2_500);
    expect(calls[0]?.control?.cacheTtlMs).toBe(45_000);
    expect(calls[0]?.control?.requestKey).toMatch(/^general-search-v11:detail:/);
    expect(runtime.detailState().status).toBe('success');
  });

  it('keeps search and detail lanes independent', async () => {
    const searchDeferred = deferred<unknown>();
    const detailDeferred = deferred<unknown>();
    const transport: GeneralSearchTransportV11 = {
      Query: (query = {}, geometry = false) => (
        geometry ? detailDeferred.promise : searchDeferred.promise
      ),
    };
    const runtime = createGeneralSearchLifecycleRuntimeV11({ transport }, { maxRetries: 0 });

    const searchPromise = runtime.executeSearch({ searchText: 'park' });
    const detailPromise = runtime.executeDetail(9);

    expect(runtime.searchState().status).toBe('running');
    expect(runtime.detailState().status).toBe('running');

    detailDeferred.resolve(success([{ id: 9 }]));
    expect((await detailPromise).result.outputCount).toBe(1);
    expect(runtime.searchState().status).toBe('running');

    searchDeferred.resolve(success([{ id: 1 }, { id: 2 }]));
    expect((await searchPromise).result.outputCount).toBe(2);
    expect(runtime.searchState().status).toBe('success');
    expect(runtime.detailState().status).toBe('success');
  });

  it('coalesces identical in-flight searches without aborting the shared transport', async () => {
    const pending = deferred<unknown>();
    const controls: QueryExecutionControl[] = [];
    const transport: GeneralSearchTransportV11 = {
      Query: (_query = {}, _geometry = false, control) => {
        if (control) controls.push(control);
        return pending.promise;
      },
    };
    const runtime = createGeneralSearchLifecycleRuntimeV11({ transport }, { maxRetries: 0 });

    const first = runtime.executeSearch({ searchText: 'park', page: 1 });
    const second = runtime.executeSearch({ page: 1, searchText: 'park' });

    expect(first).toBe(second);
    expect(controls).toHaveLength(1);
    expect(controls[0]?.signal?.aborted).toBe(false);
    expect(runtime.snapshot().coalesced).toBe(1);

    pending.resolve(success([{ id: 1 }]));
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.requestId).toBe(secondResult.requestId);
    expect(runtime.snapshot().succeeded).toBe(1);
  });

  it('does not coalesce identical queries with different execution controls', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    let calls = 0;
    const transport: GeneralSearchTransportV11 = {
      Query: () => {
        calls += 1;
        return calls === 1 ? first.promise : second.promise;
      },
    };
    const runtime = createGeneralSearchLifecycleRuntimeV11({ transport }, { maxRetries: 0 });

    const firstPromise = runtime.executeSearch(
      { searchText: 'park' },
      { timeoutMs: 1_000 },
    );
    const secondPromise = runtime.executeSearch(
      { searchText: 'park' },
      { timeoutMs: 2_000 },
    );

    expect(firstPromise).not.toBe(secondPromise);
    expect(calls).toBe(2);
    second.resolve(success([{ id: 2 }]));
    await secondPromise;
    first.reject(new BusinessAbortError());
    await expect(firstPromise).rejects.toMatchObject({ name: 'AbortError' });
    expect(runtime.snapshot().coalesced).toBe(0);
  });

  it('does not lifecycle-coalesce subscriber-specific external abort signals', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    let calls = 0;
    const transport: GeneralSearchTransportV11 = {
      Query: () => {
        calls += 1;
        return calls === 1 ? first.promise : second.promise;
      },
    };
    const runtime = createGeneralSearchLifecycleRuntimeV11({ transport }, { maxRetries: 0 });
    const one = new AbortController();
    const two = new AbortController();

    const firstPromise = runtime.executeSearch(
      { searchText: 'park' },
      { signal: one.signal },
    );
    const secondPromise = runtime.executeSearch(
      { searchText: 'park' },
      { signal: two.signal },
    );

    expect(calls).toBe(2);
    second.resolve(success([{ id: 2 }]));
    await secondPromise;
    first.reject(new BusinessAbortError());
    await expect(firstPromise).rejects.toMatchObject({ name: 'AbortError' });
    expect(runtime.snapshot().coalesced).toBe(0);
  });

  it('aborts a previous search when a newer search starts', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const controls: QueryExecutionControl[] = [];
    let call = 0;
    const transport: GeneralSearchTransportV11 = {
      Query: (_query = {}, _geometry = false, control) => {
        if (control) controls.push(control);
        call += 1;
        return call === 1 ? first.promise : second.promise;
      },
    };
    const runtime = createGeneralSearchLifecycleRuntimeV11({ transport }, { maxRetries: 0 });

    const firstPromise = runtime.executeSearch({ searchText: 'ilk' });
    const secondPromise = runtime.executeSearch({ searchText: 'ikinci' });

    expect(controls[0]?.signal?.aborted).toBe(true);
    second.resolve(success([{ id: 2 }]));
    expect((await secondPromise).result.data).toEqual([{ id: 2 }]);

    first.reject(new BusinessAbortError());
    await expect(firstPromise).rejects.toMatchObject({ name: 'AbortError' });
    expect(runtime.snapshot().cancelled).toBe(1);
    expect(runtime.searchState().status).toBe('success');
  });

  it('marks an old result stale when a transport ignores abort', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    let call = 0;
    const transport: GeneralSearchTransportV11 = {
      Query: () => {
        call += 1;
        return call === 1 ? first.promise : second.promise;
      },
    };
    const runtime = createGeneralSearchLifecycleRuntimeV11({ transport }, { maxRetries: 0 });

    const firstPromise = runtime.executeSearch({ searchText: 'ilk' });
    const secondPromise = runtime.executeSearch({ searchText: 'ikinci' });

    second.resolve(success([{ id: 2 }]));
    await secondPromise;

    first.resolve(success([{ id: 1 }]));
    const stale = await firstPromise;

    expect(stale.stale).toBe(true);
    expect(runtime.snapshot().stale).toBe(1);
    expect(runtime.searchState().resultCount).toBe(1);
    expect(runtime.history().some(entry => entry.outcome === 'stale')).toBe(true);
  });

  it('propagates external abort signal to the transport', async () => {
    const pending = deferred<unknown>();
    let observedSignal: AbortSignal | undefined;
    const transport: GeneralSearchTransportV11 = {
      Query: (_query = {}, _geometry = false, control) => {
        observedSignal = control?.signal;
        return pending.promise;
      },
    };
    const runtime = createGeneralSearchLifecycleRuntimeV11({ transport }, { maxRetries: 0 });
    const external = new AbortController();

    const promise = runtime.executeSearch(
      { searchText: 'park' },
      { signal: external.signal },
    );
    external.abort();

    expect(observedSignal?.aborted).toBe(true);
    pending.reject(new BusinessAbortError());
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(runtime.snapshot().cancelled).toBe(1);
  });

  it('retries a timeout once and then succeeds', async () => {
    let calls = 0;
    const transport: GeneralSearchTransportV11 = {
      Query: async () => {
        calls += 1;
        if (calls === 1) throw new BusinessTimeoutError(1_000);
        return success([{ id: 1 }]);
      },
    };
    const runtime = createGeneralSearchLifecycleRuntimeV11({ transport }, {
      maxRetries: 1,
      retryBaseDelayMs: 100,
      retryMaxDelayMs: 100,
      retryJitterRatio: 0,
    });

    const promise = runtime.executeSearch({ searchText: 'park' });
    await flush();
    expect(calls).toBe(1);

    await vi.advanceTimersByTimeAsync(100);
    const result = await promise;

    expect(calls).toBe(2);
    expect(result.attemptCount).toBe(2);
    expect(runtime.snapshot().retries).toBe(1);
    expect(runtime.snapshot().succeeded).toBe(1);
  });

  it('does not retry non-retryable service admission failure', async () => {
    let calls = 0;
    const transport: GeneralSearchTransportV11 = {
      Query: async () => {
        calls += 1;
        return failure('yetki yok');
      },
    };
    const runtime = createGeneralSearchLifecycleRuntimeV11({ transport }, {
      maxRetries: 3,
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 10,
    });

    await expect(runtime.executeSearch({ searchText: 'park' }))
      .rejects.toThrow('yetki yok');
    expect(calls).toBe(1);
    expect(runtime.snapshot().retries).toBe(0);
    expect(runtime.snapshot().failed).toBe(1);
  });

  it('honors retry bypass on a timeout', async () => {
    let calls = 0;
    const transport: GeneralSearchTransportV11 = {
      Query: async () => {
        calls += 1;
        throw new BusinessTimeoutError(1_000);
      },
    };
    const runtime = createGeneralSearchLifecycleRuntimeV11({ transport }, {
      maxRetries: 3,
    });

    await expect(runtime.executeSearch(
      { searchText: 'park' },
      { bypassRetry: true },
    )).rejects.toBeInstanceOf(BusinessTimeoutError);
    expect(calls).toBe(1);
    expect(runtime.snapshot().retries).toBe(0);
  });

  it('aborts during retry backoff and does not issue another transport call', async () => {
    let calls = 0;
    const transport: GeneralSearchTransportV11 = {
      Query: async () => {
        calls += 1;
        throw new BusinessTimeoutError(1_000);
      },
    };
    const runtime = createGeneralSearchLifecycleRuntimeV11({ transport }, {
      maxRetries: 3,
      retryBaseDelayMs: 1_000,
      retryMaxDelayMs: 1_000,
      retryJitterRatio: 0,
    });

    const promise = runtime.executeSearch({ searchText: 'park' });
    await flush();
    runtime.cancelSearch();

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    await vi.runAllTimersAsync();
    expect(calls).toBe(1);
  });

  it('schedules search after debounce', async () => {
    const transport = {
      Query: vi.fn(async () => success([{ id: 1 }])),
    } satisfies GeneralSearchTransportV11;
    const runtime = createGeneralSearchLifecycleRuntimeV11({ transport }, {
      searchDebounceMs: 200,
      maxRetries: 0,
    });

    const promise = runtime.scheduleSearch({ searchText: 'park' });

    expect(runtime.searchState().status).toBe('scheduled');
    expect(transport.Query).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(199);
    expect(transport.Query).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect((await promise).result.outputCount).toBe(1);
    expect(transport.Query).toHaveBeenCalledTimes(1);
    expect(runtime.snapshot().scheduled).toBe(1);
  });

  it('cancels a scheduled search when a newer schedule replaces it', async () => {
    const transport = {
      Query: vi.fn(async () => success([{ id: 2 }])),
    } satisfies GeneralSearchTransportV11;
    const runtime = createGeneralSearchLifecycleRuntimeV11({ transport }, {
      searchDebounceMs: 100,
      maxRetries: 0,
    });

    const first = runtime.scheduleSearch({ searchText: 'ilk' });
    const second = runtime.scheduleSearch({ searchText: 'ikinci' });

    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(100);
    expect((await second).result.data).toEqual([{ id: 2 }]);
    expect(transport.Query).toHaveBeenCalledTimes(1);
    expect(runtime.snapshot().cancelled).toBe(1);
  });

  it('supports per-call debounce override within policy maximum', async () => {
    const transport = {
      Query: vi.fn(async () => success([])),
    } satisfies GeneralSearchTransportV11;
    const runtime = createGeneralSearchLifecycleRuntimeV11({ transport }, {
      searchDebounceMs: 100,
      maxDebounceMs: 500,
      maxRetries: 0,
    });

    const promise = runtime.scheduleSearch(
      { searchText: 'park' },
      { debounceMs: 300 },
    );

    await vi.advanceTimersByTimeAsync(299);
    expect(transport.Query).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await promise;
    expect(transport.Query).toHaveBeenCalledTimes(1);
  });

  it('can bypass debounce without scheduling a timer', async () => {
    const transport = {
      Query: vi.fn(async () => success([])),
    } satisfies GeneralSearchTransportV11;
    const runtime = createGeneralSearchLifecycleRuntimeV11({ transport }, {
      searchDebounceMs: 500,
      maxRetries: 0,
    });

    await runtime.scheduleSearch(
      { searchText: 'park' },
      { bypassDebounce: true },
    );

    expect(transport.Query).toHaveBeenCalledTimes(1);
    expect(runtime.snapshot().scheduled).toBe(0);
  });

  it('rejects an empty search query before transport execution', async () => {
    const transport = {
      Query: vi.fn(async () => success([])),
    } satisfies GeneralSearchTransportV11;
    const runtime = createGeneralSearchLifecycleRuntimeV11({ transport });

    await expect(runtime.executeSearch({}))
      .rejects.toBeInstanceOf(GeneralSearchAdmissionErrorV11);
    expect(transport.Query).not.toHaveBeenCalled();
    expect(runtime.snapshot().rejected).toBe(1);
  });

  it('rejects malformed detail identifiers before transport execution', async () => {
    const transport = {
      Query: vi.fn(async () => success([])),
    } satisfies GeneralSearchTransportV11;
    const runtime = createGeneralSearchLifecycleRuntimeV11({ transport });

    for (const id of [null, undefined, -1, 1.5, '', ' '.repeat(4), 'x'.repeat(161)]) {
      await expect(runtime.executeDetail(id))
        .rejects.toBeInstanceOf(GeneralSearchAdmissionErrorV11);
    }
    expect(transport.Query).not.toHaveBeenCalled();
    expect(runtime.snapshot().rejected).toBe(7);
  });

  it('bounds search response cardinality and records truncation', async () => {
    const input = Array.from({ length: 12 }, (_value, index) => ({ id: index }));
    const transport: GeneralSearchTransportV11 = {
      Query: async () => success(input),
    };
    const runtime = createGeneralSearchLifecycleRuntimeV11({ transport }, {
      maxSearchRecords: 5,
      maxRetries: 0,
    });

    const envelope = await runtime.executeSearch({ searchText: 'park' });

    expect(envelope.result.inputCount).toBe(12);
    expect(envelope.result.outputCount).toBe(5);
    expect(envelope.result.truncated).toBe(true);
    expect(runtime.snapshot().truncatedResponses).toBe(1);
    expect(runtime.snapshot().admittedSearchRecords).toBe(5);
  });

  it('bounds detail response cardinality independently', async () => {
    const input = Array.from({ length: 5 }, (_value, index) => ({ id: index }));
    const transport: GeneralSearchTransportV11 = {
      Query: async () => success(input),
    };
    const runtime = createGeneralSearchLifecycleRuntimeV11({ transport }, {
      maxDetailRecords: 2,
      maxRetries: 0,
    });

    const envelope = await runtime.executeDetail(1);

    expect(envelope.result.outputCount).toBe(2);
    expect(runtime.snapshot().admittedDetailRecords).toBe(2);
    expect(runtime.snapshot().truncatedResponses).toBe(1);
  });

  it('honors cache and dedup bypass flags in transport controls', async () => {
    const controls: QueryExecutionControl[] = [];
    const transport: GeneralSearchTransportV11 = {
      Query: async (_query = {}, _geometry = false, control) => {
        if (control) controls.push(control);
        return success([]);
      },
    };
    const runtime = createGeneralSearchLifecycleRuntimeV11({ transport }, { maxRetries: 0 });

    await runtime.executeSearch(
      { searchText: 'park' },
      { bypassCache: true, bypassDeduplication: true },
    );

    expect(controls[0]?.cache).toBe(false);
    expect(controls[0]?.deduplicate).toBe(false);
    expect(controls[0]?.requestKey).toBeTruthy();
  });

  it('keeps request keys stable for semantically identical query objects', async () => {
    const keys: string[] = [];
    const transport: GeneralSearchTransportV11 = {
      Query: async (_query = {}, _geometry = false, control) => {
        keys.push(control?.requestKey ?? '');
        return success([]);
      },
    };
    const runtime = createGeneralSearchLifecycleRuntimeV11({ transport }, { maxRetries: 0 });

    await runtime.executeSearch({ searchText: 'park', page: 1 });
    await runtime.executeSearch({ page: 1, searchText: 'park' });

    expect(keys[0]).toBe(keys[1]);
  });

  it('separates search and detail request-key namespaces', async () => {
    const keys: string[] = [];
    const transport: GeneralSearchTransportV11 = {
      Query: async (_query = {}, _geometry = false, control) => {
        keys.push(control?.requestKey ?? '');
        return success([]);
      },
    };
    const runtime = createGeneralSearchLifecycleRuntimeV11({ transport }, { maxRetries: 0 });

    await runtime.executeSearch({ ObjectId: 1 });
    await runtime.executeDetail(1);

    expect(keys[0]).toMatch(/^general-search-v11:search:/);
    expect(keys[1]).toMatch(/^general-search-v11:detail:/);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('preserves bounded history by dropping oldest entries', async () => {
    const transport: GeneralSearchTransportV11 = {
      Query: async query => success([{ query }]),
    };
    const runtime = createGeneralSearchLifecycleRuntimeV11({ transport }, {
      maxHistory: 3,
      maxRetries: 0,
    });

    for (const value of ['a', 'b', 'c', 'd', 'e']) {
      await runtime.executeSearch({ searchText: value });
    }

    const history = runtime.history();
    expect(history).toHaveLength(3);
    expect(history.map(entry => entry.requestId)).toEqual([3, 4, 5]);
    expect(runtime.snapshot().succeeded).toBe(5);
  });

  it('produces immutable state, history and snapshot surfaces', async () => {
    const transport: GeneralSearchTransportV11 = {
      Query: async () => success([{ id: 1 }]),
    };
    const runtime = createGeneralSearchLifecycleRuntimeV11({ transport }, { maxRetries: 0 });

    await runtime.executeSearch({ searchText: 'park' });

    expect(Object.isFrozen(runtime.searchState())).toBe(true);
    expect(Object.isFrozen(runtime.detailState())).toBe(true);
    expect(Object.isFrozen(runtime.history())).toBe(true);
    expect(Object.isFrozen(runtime.history()[0])).toBe(true);
    expect(Object.isFrozen(runtime.snapshot())).toBe(true);
  });

  it('reset cancels active work and returns both lanes to idle', async () => {
    const pending = deferred<unknown>();
    const transport: GeneralSearchTransportV11 = {
      Query: () => pending.promise,
    };
    const runtime = createGeneralSearchLifecycleRuntimeV11({ transport }, { maxRetries: 0 });

    const promise = runtime.executeSearch({ searchText: 'park' });
    runtime.reset();

    expect(runtime.searchState().status).toBe('idle');
    expect(runtime.detailState().status).toBe('idle');
    pending.reject(new BusinessAbortError());
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('cancelAll aborts both lanes without cross-lane state corruption', async () => {
    const search = deferred<unknown>();
    const detail = deferred<unknown>();
    const transport: GeneralSearchTransportV11 = {
      Query: (_query = {}, geometry = false) => geometry ? detail.promise : search.promise,
    };
    const runtime = createGeneralSearchLifecycleRuntimeV11({ transport }, { maxRetries: 0 });

    const searchPromise = runtime.executeSearch({ searchText: 'park' });
    const detailPromise = runtime.executeDetail(1);
    runtime.cancelAll();

    search.reject(new BusinessAbortError());
    detail.reject(new BusinessAbortError());

    await expect(searchPromise).rejects.toMatchObject({ name: 'AbortError' });
    await expect(detailPromise).rejects.toMatchObject({ name: 'AbortError' });
    expect(runtime.searchState().status).toBe('cancelled');
    expect(runtime.detailState().status).toBe('cancelled');
  });

  it('dispose cancels active work and rejects future operations', async () => {
    const pending = deferred<unknown>();
    const transport: GeneralSearchTransportV11 = {
      Query: () => pending.promise,
    };
    const runtime = createGeneralSearchLifecycleRuntimeV11({ transport }, { maxRetries: 0 });

    const active = runtime.executeSearch({ searchText: 'park' });
    runtime.dispose();

    pending.reject(new BusinessAbortError());
    await expect(active).rejects.toMatchObject({ name: 'AbortError' });
    expect(runtime.snapshot().disposed).toBe(true);
    expect(runtime.searchState().status).toBe('disposed');
    expect(() => runtime.executeSearch({ searchText: 'new' })).toThrow('kapatıldı');
  });

  it('returns a healthy lifecycle audit after ordinary successful operations', async () => {
    const transport: GeneralSearchTransportV11 = {
      Query: async (_query = {}, geometry = false) => success(
        geometry ? [{ id: 1 }] : [{ id: 1 }, { id: 2 }],
      ),
    };
    const runtime = createGeneralSearchLifecycleRuntimeV11({ transport }, { maxRetries: 0 });

    await runtime.executeSearch({ searchText: 'park' });
    await runtime.executeDetail(1);

    const audit = runtime.audit();
    expect(audit.healthy).toBe(true);
    expect(audit.findings).toEqual([]);
    expect(audit.fingerprint).toBeTruthy();
  });

  it('retains failure evidence without raw payloads', async () => {
    const transport: GeneralSearchTransportV11 = {
      Query: async () => {
        throw Object.assign(new Error('sensitive-token-should-not-be-history'), {
          code: 'TEMP',
        });
      },
    };
    const runtime = createGeneralSearchLifecycleRuntimeV11({ transport }, {
      maxRetries: 0,
    });

    await expect(runtime.executeSearch({ searchText: 'park' })).rejects.toThrow();
    const entry = runtime.history()[0];

    expect(entry?.outcome).toBe('failure');
    expect(entry?.errorName).toBe('Error');
    expect(entry?.errorCode).toBe('TEMP');
    expect(JSON.stringify(entry)).not.toContain('sensitive-token');
  });

  it('does not retain query values in snapshot diagnostics', async () => {
    const transport: GeneralSearchTransportV11 = {
      Query: async () => success([]),
    };
    const runtime = createGeneralSearchLifecycleRuntimeV11({ transport }, { maxRetries: 0 });

    await runtime.executeSearch({ searchText: 'private-query-value' });
    const serialized = JSON.stringify(runtime.snapshot());

    expect(serialized).not.toContain('private-query-value');
    expect(serialized).toContain('fingerprint');
  });

  it('counts repeated admitted records without retaining their bodies', async () => {
    const transport: GeneralSearchTransportV11 = {
      Query: async () => success([{ secret: 'one' }, { secret: 'two' }]),
    };
    const runtime = createGeneralSearchLifecycleRuntimeV11({ transport }, { maxRetries: 0 });

    await runtime.executeSearch({ searchText: 'park' });
    await runtime.executeSearch({ searchText: 'school' });

    expect(runtime.snapshot().admittedSearchRecords).toBe(4);
    expect(JSON.stringify(runtime.history())).not.toContain('secret');
  });
});
