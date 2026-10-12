import { describe, expect, it } from 'vitest';
import {
  BusinessContractError,
  BusinessTimeoutError,
} from '../../../Business/contracts';
import {
  GENERAL_SEARCH_LIFECYCLE_VERSION_V11,
  type GeneralSearchHistoryEntryV11,
  type GeneralSearchLifecycleSnapshotV11,
} from './GenelAramaLifecycleContractsV11';
import {
  GeneralSearchAdmissionErrorV11,
  admitGeneralSearchQueryV11,
  admitGeneralSearchServiceResultV11,
  auditGeneralSearchLifecycleV11,
  normalizeGeneralSearchErrorV11,
  normalizeGeneralSearchLifecyclePolicyV11,
  retryDecisionForGeneralSearchV11,
} from './GenelAramaLifecyclePolicyV11';

const success = (data: readonly unknown[] = []): unknown => ({
  type: 10,
  data,
  message: 'ok',
});

const failure = (message = 'hata'): unknown => ({
  type: 20,
  data: [],
  message,
});

const baseSnapshot = (): GeneralSearchLifecycleSnapshotV11 => Object.freeze({
  version: GENERAL_SEARCH_LIFECYCLE_VERSION_V11,
  disposed: false,
  search: Object.freeze({
    lane: 'search',
    status: 'idle',
    requestId: 0,
    requestKey: null,
    fingerprint: null,
    scheduledAt: null,
    startedAt: null,
    completedAt: null,
    attemptCount: 0,
    resultCount: 0,
    errorName: null,
    errorCode: null,
  }),
  detail: Object.freeze({
    lane: 'detail',
    status: 'idle',
    requestId: 0,
    requestKey: null,
    fingerprint: null,
    scheduledAt: null,
    startedAt: null,
    completedAt: null,
    attemptCount: 0,
    resultCount: 0,
    errorName: null,
    errorCode: null,
  }),
  historyEntries: 0,
  scheduled: 0,
  started: 0,
  succeeded: 0,
  failed: 0,
  cancelled: 0,
  stale: 0,
  rejected: 0,
  retries: 0,
  admittedSearchRecords: 0,
  admittedDetailRecords: 0,
  truncatedResponses: 0,
  fingerprint: 'snapshot',
});

const historyEntry = (
  outcome: GeneralSearchHistoryEntryV11['outcome'],
  overrides: Partial<GeneralSearchHistoryEntryV11> = {},
): GeneralSearchHistoryEntryV11 => Object.freeze({
  lane: 'search',
  requestId: 1,
  requestKey: 'general-search-v11:search:test',
  fingerprint: 'test',
  outcome,
  startedAt: 10,
  completedAt: 20,
  elapsedMs: 10,
  attemptCount: 1,
  resultCount: outcome === 'success' ? 1 : 0,
  stale: outcome === 'stale',
  errorName: outcome === 'failure' ? 'Error' : null,
  errorCode: outcome === 'failure' ? 'ERROR' : null,
  ...overrides,
});

describe('GenelAramaLifecyclePolicyV11', () => {
  it('normalizes a bounded production policy', () => {
    const policy = normalizeGeneralSearchLifecyclePolicyV11({
      searchDebounceMs: 250,
      maxDebounceMs: 500,
      searchTimeoutMs: 5_000,
      detailTimeoutMs: 4_000,
      maxTimeoutMs: 6_000,
      searchCacheTtlMs: 3_000,
      detailCacheTtlMs: 4_000,
      maxCacheTtlMs: 5_000,
      maxSearchRecords: 10_000,
      maxDetailRecords: 3,
      maxQueryFields: 12,
      maxQueryDepth: 4,
      maxQueryStringLength: 512,
      maxQueryArrayLength: 32,
      maxQuerySerializedLength: 4_096,
      maxMessageLength: 256,
      maxHistory: 20,
      maxRetries: 1,
      retryBaseDelayMs: 50,
      retryMaxDelayMs: 100,
      retryJitterRatio: 0.1,
      cacheSearch: false,
      cacheDetail: true,
      deduplicateSearch: true,
      deduplicateDetail: false,
    });

    expect(policy.searchDebounceMs).toBe(250);
    expect(policy.maxDebounceMs).toBe(500);
    expect(policy.searchTimeoutMs).toBe(5_000);
    expect(policy.detailTimeoutMs).toBe(4_000);
    expect(policy.maxTimeoutMs).toBe(6_000);
    expect(policy.searchCacheTtlMs).toBe(3_000);
    expect(policy.detailCacheTtlMs).toBe(4_000);
    expect(policy.maxCacheTtlMs).toBe(5_000);
    expect(policy.maxSearchRecords).toBe(10_000);
    expect(policy.maxDetailRecords).toBe(3);
    expect(policy.maxQueryFields).toBe(12);
    expect(policy.maxQueryDepth).toBe(4);
    expect(policy.maxQueryStringLength).toBe(512);
    expect(policy.maxQueryArrayLength).toBe(32);
    expect(policy.maxQuerySerializedLength).toBe(4_096);
    expect(policy.maxMessageLength).toBe(256);
    expect(policy.maxHistory).toBe(20);
    expect(policy.maxRetries).toBe(1);
    expect(policy.retryBaseDelayMs).toBe(50);
    expect(policy.retryMaxDelayMs).toBe(100);
    expect(policy.retryJitterRatio).toBe(0.1);
    expect(policy.cacheSearch).toBe(false);
    expect(policy.cacheDetail).toBe(true);
    expect(policy.deduplicateSearch).toBe(true);
    expect(policy.deduplicateDetail).toBe(false);
    expect(Object.isFrozen(policy)).toBe(true);
  });

  it('clamps child timing budgets to parent budgets', () => {
    const policy = normalizeGeneralSearchLifecyclePolicyV11({
      maxDebounceMs: 100,
      searchDebounceMs: 500,
      maxTimeoutMs: 1_000,
      searchTimeoutMs: 50_000,
      detailTimeoutMs: 50_000,
      maxCacheTtlMs: 1_000,
      searchCacheTtlMs: 50_000,
      detailCacheTtlMs: 50_000,
      retryMaxDelayMs: 75,
      retryBaseDelayMs: 500,
    });

    expect(policy.searchDebounceMs).toBe(100);
    expect(policy.searchTimeoutMs).toBe(1_000);
    expect(policy.detailTimeoutMs).toBe(1_000);
    expect(policy.searchCacheTtlMs).toBe(1_000);
    expect(policy.detailCacheTtlMs).toBe(1_000);
    expect(policy.retryBaseDelayMs).toBe(75);
  });

  it('accepts a plain deterministic query and creates a stable fingerprint', () => {
    const first = admitGeneralSearchQueryV11({
      searchText: '  Atatürk Parkı  ',
      page: 1,
      filters: ['park', 'yeşil'],
      exact: true,
      nested: { district: 'Çankaya' },
    });
    const second = admitGeneralSearchQueryV11({
      exact: true,
      nested: { district: 'Çankaya' },
      filters: ['park', 'yeşil'],
      page: 1,
      searchText: '  Atatürk Parkı  ',
    });

    expect(first.accepted).toBe(true);
    expect(first.code).toBeNull();
    expect(first.query).toEqual({
      exact: true,
      filters: ['park', 'yeşil'],
      nested: { district: 'Çankaya' },
      page: 1,
      searchText: 'Atatürk Parkı',
    });
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.fieldCount).toBe(6);
    expect(first.maximumDepth).toBeGreaterThanOrEqual(2);
  });

  it('rejects null and non-object query roots', () => {
    for (const value of [null, undefined, 'query', 42, true, []]) {
      const result = admitGeneralSearchQueryV11(value);
      expect(result.accepted).toBe(false);
      expect(result.code).toBe('QUERY_REQUIRED');
      expect(result.query).toBeNull();
    }
  });

  it('rejects class instances and executable values', () => {
    class Unsafe {
      value = 'x';
    }

    const classResult = admitGeneralSearchQueryV11({ nested: new Unsafe() });
    const functionResult = admitGeneralSearchQueryV11({ callback: () => undefined });
    const symbolResult = admitGeneralSearchQueryV11({ token: Symbol('x') });

    expect(classResult.accepted).toBe(false);
    expect(classResult.code).toBe('QUERY_UNSUPPORTED_VALUE');
    expect(functionResult.accepted).toBe(false);
    expect(functionResult.code).toBe('QUERY_UNSUPPORTED_VALUE');
    expect(symbolResult.accepted).toBe(false);
    expect(symbolResult.code).toBe('QUERY_UNSUPPORTED_VALUE');
  });

  it('rejects non-finite numeric query values', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const result = admitGeneralSearchQueryV11({ value });
      expect(result.accepted).toBe(false);
      expect(result.code).toBe('QUERY_UNSUPPORTED_VALUE');
    }
  });

  it('omits undefined values without changing sibling fields', () => {
    const result = admitGeneralSearchQueryV11({
      searchText: 'park',
      omitted: undefined,
      nested: {
        district: 'Çankaya',
        ignored: undefined,
      },
    });

    expect(result.accepted).toBe(true);
    expect(result.query).toEqual({
      nested: { district: 'Çankaya' },
      searchText: 'park',
    });
  });

  it('enforces maximum query field count across nested objects', () => {
    const result = admitGeneralSearchQueryV11({
      one: 1,
      nested: {
        two: 2,
        three: 3,
      },
    }, {
      maxQueryFields: 2,
    });

    expect(result.accepted).toBe(false);
    expect(result.code).toBe('QUERY_TOO_MANY_FIELDS');
  });

  it('enforces maximum object depth', () => {
    const result = admitGeneralSearchQueryV11({
      a: { b: { c: { d: 'too-deep' } } },
    }, {
      maxQueryDepth: 3,
    });

    expect(result.accepted).toBe(false);
    expect(result.code).toBe('QUERY_TOO_DEEP');
  });

  it('enforces maximum string length', () => {
    const result = admitGeneralSearchQueryV11({
      searchText: 'x'.repeat(129),
    }, {
      maxQueryStringLength: 128,
    });

    expect(result.accepted).toBe(false);
    expect(result.code).toBe('QUERY_TOO_LARGE');
  });

  it('enforces maximum array length', () => {
    const result = admitGeneralSearchQueryV11({
      ids: Array.from({ length: 5 }, (_value, index) => index),
    }, {
      maxQueryArrayLength: 4,
    });

    expect(result.accepted).toBe(false);
    expect(result.code).toBe('QUERY_TOO_LARGE');
  });

  it('enforces serialized query length after normalization', () => {
    const result = admitGeneralSearchQueryV11({
      first: 'a'.repeat(150),
      second: 'b'.repeat(150),
    }, {
      maxQueryStringLength: 1_000,
      maxQuerySerializedLength: 256,
    });

    expect(result.accepted).toBe(false);
    expect(result.code).toBe('QUERY_TOO_LARGE');
    expect(result.serializedLength).toBeGreaterThan(256);
  });

  it('accepts modern success service result casing', () => {
    const result = admitGeneralSearchServiceResultV11(
      success([{ id: 1 }, { id: 2 }]),
      10,
    );

    expect(result.success).toBe(true);
    expect(result.type).toBe(10);
    expect(result.data).toEqual([{ id: 1 }, { id: 2 }]);
    expect(result.inputCount).toBe(2);
    expect(result.outputCount).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it('accepts legacy success service result casing', () => {
    const result = admitGeneralSearchServiceResultV11({
      Type: '10',
      Data: [{ id: 1 }],
      Message: 'başarılı',
    }, 10);

    expect(result.success).toBe(true);
    expect(result.type).toBe('10');
    expect(result.message).toBe('başarılı');
    expect(result.data).toEqual([{ id: 1 }]);
  });

  it('treats missing success data as an empty collection', () => {
    const result = admitGeneralSearchServiceResultV11({
      type: 10,
      message: 'empty',
    }, 10);

    expect(result.data).toEqual([]);
    expect(result.inputCount).toBe(0);
    expect(result.outputCount).toBe(0);
  });

  it('rejects malformed service roots', () => {
    for (const value of [null, [], 'bad', 42]) {
      expect(() => admitGeneralSearchServiceResultV11(value, 10))
        .toThrowError(GeneralSearchAdmissionErrorV11);
    }
  });

  it('rejects unsuccessful service results with sanitized message', () => {
    expect(() => admitGeneralSearchServiceResultV11(
      failure('Sunucu arama isteğini reddetti.'),
      10,
    )).toThrowError('Sunucu arama isteğini reddetti.');
  });

  it('rejects non-array data on a successful response', () => {
    expect(() => admitGeneralSearchServiceResultV11({
      type: 10,
      data: { id: 1 },
    }, 10)).toThrowError('sonuç koleksiyonu geçersiz');
  });

  it('truncates oversized successful result collections deterministically', () => {
    const input = Array.from({ length: 10 }, (_value, index) => ({ id: index }));
    const result = admitGeneralSearchServiceResultV11(success(input), 4);

    expect(result.inputCount).toBe(10);
    expect(result.outputCount).toBe(4);
    expect(result.truncated).toBe(true);
    expect(result.data).toEqual(input.slice(0, 4));
    expect(Object.isFrozen(result.data)).toBe(true);
  });

  it('bounds service messages without reflecting arbitrary payload size', () => {
    const result = admitGeneralSearchServiceResultV11({
      type: 10,
      data: [],
      message: 'x'.repeat(200),
    }, 10, 64);

    expect(result.message).toHaveLength(64);
  });

  it('classifies timeout errors as retryable', () => {
    const normalized = normalizeGeneralSearchErrorV11(new BusinessTimeoutError(1_000));

    expect(normalized.retryable).toBe(true);
    expect(normalized.retryReason).toBe('timeout');
    expect(normalized.code).toBe('TIMEOUT');
  });

  it('classifies retryable business contract errors', () => {
    const normalized = normalizeGeneralSearchErrorV11(
      new BusinessContractError('TEMPORARY', 'temporary', true),
    );

    expect(normalized.retryable).toBe(true);
    expect(normalized.retryReason).toBe('retryable-contract');
    expect(normalized.code).toBe('TEMPORARY');
  });

  it('does not retry non-retryable business failures', () => {
    const normalized = normalizeGeneralSearchErrorV11(
      new BusinessContractError('INVALID', 'invalid', false),
    );

    expect(normalized.retryable).toBe(false);
    expect(normalized.retryReason).toBeNull();
  });

  it('classifies common browser network errors without exposing stack data', () => {
    const error = new TypeError('Failed to fetch');
    error.name = 'NetworkError';
    const normalized = normalizeGeneralSearchErrorV11(error);

    expect(normalized.retryable).toBe(true);
    expect(normalized.retryReason).toBe('network');
    expect(normalized.message).toBe('Failed to fetch');
  });

  it('creates deterministic bounded retry delays', () => {
    const policy = normalizeGeneralSearchLifecyclePolicyV11({
      maxRetries: 3,
      retryBaseDelayMs: 100,
      retryMaxDelayMs: 500,
      retryJitterRatio: 0.2,
    });
    const error = new BusinessTimeoutError(1_000);

    const first = retryDecisionForGeneralSearchV11(error, 1, 'same', policy);
    const again = retryDecisionForGeneralSearchV11(error, 1, 'same', policy);
    const second = retryDecisionForGeneralSearchV11(error, 2, 'same', policy);

    expect(first.retry).toBe(true);
    expect(first.reason).toBe('timeout');
    expect(first.delayMs).toBe(again.delayMs);
    expect(first.delayMs).toBeGreaterThanOrEqual(80);
    expect(first.delayMs).toBeLessThanOrEqual(120);
    expect(second.delayMs).toBeGreaterThanOrEqual(160);
    expect(second.delayMs).toBeLessThanOrEqual(240);
  });

  it('stops retrying after the configured retry budget', () => {
    const policy = normalizeGeneralSearchLifecyclePolicyV11({
      maxRetries: 1,
      retryBaseDelayMs: 0,
      retryMaxDelayMs: 0,
    });
    const error = new BusinessTimeoutError(1_000);

    expect(retryDecisionForGeneralSearchV11(error, 1, 'x', policy).retry).toBe(true);
    expect(retryDecisionForGeneralSearchV11(error, 2, 'x', policy).retry).toBe(false);
  });

  it('honors retry bypass even for retryable failures', () => {
    const policy = normalizeGeneralSearchLifecyclePolicyV11({ maxRetries: 4 });
    const error = new BusinessTimeoutError(1_000);

    const decision = retryDecisionForGeneralSearchV11(error, 1, 'x', policy, true);
    expect(decision.retry).toBe(false);
    expect(decision.delayMs).toBe(0);
  });

  it('keeps unknown ordinary errors non-retryable', () => {
    const policy = normalizeGeneralSearchLifecyclePolicyV11({ maxRetries: 4 });
    const decision = retryDecisionForGeneralSearchV11(new Error('bad data'), 1, 'x', policy);

    expect(decision.retry).toBe(false);
    expect(decision.reason).toBeNull();
  });

  it('reports a healthy idle lifecycle audit', () => {
    const policy = normalizeGeneralSearchLifecyclePolicyV11();
    const report = auditGeneralSearchLifecycleV11({
      policy,
      snapshot: baseSnapshot(),
      history: [],
    });

    expect(report.healthy).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.fingerprint).toBeTruthy();
  });

  it('flags history that exceeds the configured bound', () => {
    const policy = normalizeGeneralSearchLifecyclePolicyV11({ maxHistory: 2 });
    const history = [
      historyEntry('success', { requestId: 1 }),
      historyEntry('success', { requestId: 2 }),
      historyEntry('success', { requestId: 3 }),
    ];
    const report = auditGeneralSearchLifecycleV11({
      policy,
      snapshot: Object.freeze({ ...baseSnapshot(), historyEntries: 3 }),
      history,
    });

    expect(report.healthy).toBe(false);
    expect(report.findings.some(item => item.code === 'history-over-budget')).toBe(true);
  });

  it('flags running lanes without a start timestamp', () => {
    const policy = normalizeGeneralSearchLifecyclePolicyV11();
    const report = auditGeneralSearchLifecycleV11({
      policy,
      snapshot: Object.freeze({
        ...baseSnapshot(),
        search: Object.freeze({
          ...baseSnapshot().search,
          status: 'running',
          requestId: 1,
        }),
      }),
      history: [],
    });

    expect(report.healthy).toBe(false);
    expect(report.findings.some(item => item.code === 'search-running-without-start')).toBe(true);
  });

  it('allows scheduled cancellations in terminal accounting', () => {
    const policy = normalizeGeneralSearchLifecyclePolicyV11();
    const report = auditGeneralSearchLifecycleV11({
      policy,
      snapshot: Object.freeze({
        ...baseSnapshot(),
        scheduled: 2,
        started: 1,
        succeeded: 1,
        cancelled: 2,
      }),
      history: [],
    });

    expect(report.findings.some(item => item.code === 'terminal-count-exceeds-started')).toBe(false);
  });

  it('flags impossible terminal accounting', () => {
    const policy = normalizeGeneralSearchLifecyclePolicyV11();
    const report = auditGeneralSearchLifecycleV11({
      policy,
      snapshot: Object.freeze({
        ...baseSnapshot(),
        started: 1,
        succeeded: 2,
      }),
      history: [],
    });

    expect(report.healthy).toBe(false);
    expect(report.findings.some(item => item.code === 'terminal-count-exceeds-started')).toBe(true);
  });

  it('surfaces response truncation as a warning rather than an error', () => {
    const policy = normalizeGeneralSearchLifecyclePolicyV11();
    const report = auditGeneralSearchLifecycleV11({
      policy,
      snapshot: Object.freeze({
        ...baseSnapshot(),
        started: 1,
        succeeded: 1,
        truncatedResponses: 1,
      }),
      history: [historyEntry('success')],
    });

    expect(report.healthy).toBe(true);
    expect(report.findings).toContainEqual(expect.objectContaining({
      code: 'response-truncation-observed',
      severity: 'warning',
    }));
  });

  it('flags stale history that is not represented in snapshot counters', () => {
    const policy = normalizeGeneralSearchLifecyclePolicyV11();
    const report = auditGeneralSearchLifecycleV11({
      policy,
      snapshot: Object.freeze({
        ...baseSnapshot(),
        started: 1,
      }),
      history: [historyEntry('stale')],
    });

    expect(report.healthy).toBe(false);
    expect(report.findings.some(item => item.code === 'stale-counter-under-reports-history')).toBe(true);
  });

  it('produces the same audit fingerprint for the same evidence', () => {
    const policy = normalizeGeneralSearchLifecyclePolicyV11();
    const input = {
      policy,
      snapshot: Object.freeze({
        ...baseSnapshot(),
        started: 1,
        succeeded: 1,
        admittedSearchRecords: 1,
      }),
      history: [historyEntry('success')],
    };

    expect(auditGeneralSearchLifecycleV11(input).fingerprint)
      .toBe(auditGeneralSearchLifecycleV11(input).fingerprint);
  });

  it('changes audit fingerprint when retained evidence changes', () => {
    const policy = normalizeGeneralSearchLifecyclePolicyV11();
    const first = auditGeneralSearchLifecycleV11({
      policy,
      snapshot: baseSnapshot(),
      history: [],
    });
    const second = auditGeneralSearchLifecycleV11({
      policy,
      snapshot: Object.freeze({ ...baseSnapshot(), rejected: 1 }),
      history: [],
    });

    expect(first.fingerprint).not.toBe(second.fingerprint);
  });
});
