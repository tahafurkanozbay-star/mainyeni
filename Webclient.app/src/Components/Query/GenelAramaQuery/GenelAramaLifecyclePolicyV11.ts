import {
  BusinessContractError,
  BusinessTimeoutError,
} from '../../../Business/contracts';
import {
  hashFingerprint,
  normalizeInteger,
  normalizeText,
  stableSerialize,
} from '../../../data-search/normalization';
import type {
  GeneralSearchAdmissionCodeV11,
  GeneralSearchHistoryEntryV11,
  GeneralSearchLifecycleAuditFindingV11,
  GeneralSearchLifecycleAuditInputV11,
  GeneralSearchLifecycleAuditReportV11,
  GeneralSearchLifecyclePolicyV11,
  GeneralSearchNormalizedErrorV11,
  GeneralSearchNormalizedLifecyclePolicyV11,
  GeneralSearchQueryAdmissionV11,
  GeneralSearchRetryDecisionV11,
  GeneralSearchRetryReasonV11,
  GeneralSearchServiceResultV11,
} from './GenelAramaLifecycleContractsV11';

const DEFAULT_SEARCH_DEBOUNCE_MS = 160;
const DEFAULT_MAX_DEBOUNCE_MS = 2_000;
const DEFAULT_SEARCH_TIMEOUT_MS = 15_000;
const DEFAULT_DETAIL_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_TIMEOUT_MS = 60_000;
const DEFAULT_SEARCH_CACHE_TTL_MS = 20_000;
const DEFAULT_DETAIL_CACHE_TTL_MS = 60_000;
const DEFAULT_MAX_CACHE_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_SEARCH_RECORDS = 50_000;
const DEFAULT_MAX_DETAIL_RECORDS = 8;
const DEFAULT_MAX_QUERY_FIELDS = 32;
const DEFAULT_MAX_QUERY_DEPTH = 5;
const DEFAULT_MAX_QUERY_STRING_LENGTH = 2_048;
const DEFAULT_MAX_QUERY_ARRAY_LENGTH = 128;
const DEFAULT_MAX_QUERY_SERIALIZED_LENGTH = 16_384;
const DEFAULT_MAX_MESSAGE_LENGTH = 1_000;
const DEFAULT_MAX_HISTORY = 96;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 180;
const DEFAULT_RETRY_MAX_DELAY_MS = 2_000;
const DEFAULT_RETRY_JITTER_RATIO = 0.15;

const safeBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback;

const safeRatio = (value: unknown, fallback: number): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(0.5, numeric));
};

export const normalizeGeneralSearchLifecyclePolicyV11 = (
  policy: GeneralSearchLifecyclePolicyV11 = {},
): GeneralSearchNormalizedLifecyclePolicyV11 => {
  const maxDebounceMs = normalizeInteger(policy.maxDebounceMs, {
    min: 0,
    max: 10_000,
    fallback: DEFAULT_MAX_DEBOUNCE_MS,
  });
  const maxTimeoutMs = normalizeInteger(policy.maxTimeoutMs, {
    min: 250,
    max: 120_000,
    fallback: DEFAULT_MAX_TIMEOUT_MS,
  });
  const maxCacheTtlMs = normalizeInteger(policy.maxCacheTtlMs, {
    min: 0,
    max: 60 * 60_000,
    fallback: DEFAULT_MAX_CACHE_TTL_MS,
  });
  const retryMaxDelayMs = normalizeInteger(policy.retryMaxDelayMs, {
    min: 0,
    max: 30_000,
    fallback: DEFAULT_RETRY_MAX_DELAY_MS,
  });
  return Object.freeze({
    searchDebounceMs: normalizeInteger(policy.searchDebounceMs, {
      min: 0,
      max: maxDebounceMs,
      fallback: DEFAULT_SEARCH_DEBOUNCE_MS,
    }),
    maxDebounceMs,
    searchTimeoutMs: normalizeInteger(policy.searchTimeoutMs, {
      min: 250,
      max: maxTimeoutMs,
      fallback: DEFAULT_SEARCH_TIMEOUT_MS,
    }),
    detailTimeoutMs: normalizeInteger(policy.detailTimeoutMs, {
      min: 250,
      max: maxTimeoutMs,
      fallback: DEFAULT_DETAIL_TIMEOUT_MS,
    }),
    maxTimeoutMs,
    searchCacheTtlMs: normalizeInteger(policy.searchCacheTtlMs, {
      min: 0,
      max: maxCacheTtlMs,
      fallback: DEFAULT_SEARCH_CACHE_TTL_MS,
    }),
    detailCacheTtlMs: normalizeInteger(policy.detailCacheTtlMs, {
      min: 0,
      max: maxCacheTtlMs,
      fallback: DEFAULT_DETAIL_CACHE_TTL_MS,
    }),
    maxCacheTtlMs,
    maxSearchRecords: normalizeInteger(policy.maxSearchRecords, {
      min: 1,
      max: 250_000,
      fallback: DEFAULT_MAX_SEARCH_RECORDS,
    }),
    maxDetailRecords: normalizeInteger(policy.maxDetailRecords, {
      min: 1,
      max: 1_000,
      fallback: DEFAULT_MAX_DETAIL_RECORDS,
    }),
    maxQueryFields: normalizeInteger(policy.maxQueryFields, {
      min: 1,
      max: 256,
      fallback: DEFAULT_MAX_QUERY_FIELDS,
    }),
    maxQueryDepth: normalizeInteger(policy.maxQueryDepth, {
      min: 1,
      max: 12,
      fallback: DEFAULT_MAX_QUERY_DEPTH,
    }),
    maxQueryStringLength: normalizeInteger(policy.maxQueryStringLength, {
      min: 16,
      max: 64 * 1024,
      fallback: DEFAULT_MAX_QUERY_STRING_LENGTH,
    }),
    maxQueryArrayLength: normalizeInteger(policy.maxQueryArrayLength, {
      min: 1,
      max: 10_000,
      fallback: DEFAULT_MAX_QUERY_ARRAY_LENGTH,
    }),
    maxQuerySerializedLength: normalizeInteger(policy.maxQuerySerializedLength, {
      min: 256,
      max: 1024 * 1024,
      fallback: DEFAULT_MAX_QUERY_SERIALIZED_LENGTH,
    }),
    maxMessageLength: normalizeInteger(policy.maxMessageLength, {
      min: 32,
      max: 16_384,
      fallback: DEFAULT_MAX_MESSAGE_LENGTH,
    }),
    maxHistory: normalizeInteger(policy.maxHistory, {
      min: 1,
      max: 10_000,
      fallback: DEFAULT_MAX_HISTORY,
    }),
    maxRetries: normalizeInteger(policy.maxRetries, {
      min: 0,
      max: 8,
      fallback: DEFAULT_MAX_RETRIES,
    }),
    retryBaseDelayMs: normalizeInteger(policy.retryBaseDelayMs, {
      min: 0,
      max: retryMaxDelayMs,
      fallback: Math.min(DEFAULT_RETRY_BASE_DELAY_MS, retryMaxDelayMs),
    }),
    retryMaxDelayMs,
    retryJitterRatio: safeRatio(policy.retryJitterRatio, DEFAULT_RETRY_JITTER_RATIO),
    cacheSearch: safeBoolean(policy.cacheSearch, true),
    cacheDetail: safeBoolean(policy.cacheDetail, true),
    deduplicateSearch: safeBoolean(policy.deduplicateSearch, true),
    deduplicateDetail: safeBoolean(policy.deduplicateDetail, true),
  });
};

const isPlainRecord = (value: unknown): value is Readonly<Record<string, unknown>> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

interface AdmissionContext {
  readonly policy: GeneralSearchNormalizedLifecyclePolicyV11;
  fields: number;
  maximumDepth: number;
  code: GeneralSearchAdmissionCodeV11 | null;
}

const reject = (
  context: AdmissionContext,
  code: GeneralSearchAdmissionCodeV11,
): undefined => {
  context.code = context.code ?? code;
  return undefined;
};

const normalizePrimitive = (
  value: unknown,
  context: AdmissionContext,
): string | number | boolean | null | undefined => {
  if (value === null) return null;
  if (typeof value === 'string') {
    if (value.length > context.policy.maxQueryStringLength) {
      return reject(context, 'QUERY_TOO_LARGE');
    }
    return value.trim();
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : reject(context, 'QUERY_UNSUPPORTED_VALUE');
  }
  if (typeof value === 'boolean') return value;
  if (value === undefined) return undefined;
  return reject(context, 'QUERY_UNSUPPORTED_VALUE');
};

const normalizeValue = (
  value: unknown,
  depth: number,
  context: AdmissionContext,
): unknown => {
  context.maximumDepth = Math.max(context.maximumDepth, depth);
  if (depth > context.policy.maxQueryDepth) {
    return reject(context, 'QUERY_TOO_DEEP');
  }

  if (
    value === null
    || value === undefined
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
  ) {
    return normalizePrimitive(value, context);
  }

  if (Array.isArray(value)) {
    if (value.length > context.policy.maxQueryArrayLength) {
      return reject(context, 'QUERY_TOO_LARGE');
    }
    const output: unknown[] = [];
    for (const item of value) {
      const normalized = normalizeValue(item, depth + 1, context);
      if (context.code) return undefined;
      if (normalized !== undefined) output.push(normalized);
    }
    return Object.freeze(output);
  }

  if (!isPlainRecord(value)) {
    return reject(context, 'QUERY_UNSUPPORTED_VALUE');
  }

  const output: Record<string, unknown> = {};
  const keys = Object.keys(value).sort((left, right) => left.localeCompare(right, 'en'));
  for (const key of keys) {
    context.fields += 1;
    if (context.fields > context.policy.maxQueryFields) {
      return reject(context, 'QUERY_TOO_MANY_FIELDS');
    }
    if (key.length > 128) return reject(context, 'QUERY_TOO_LARGE');
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      return reject(context, 'QUERY_UNSUPPORTED_VALUE');
    }
    const normalized = normalizeValue(value[key], depth + 1, context);
    if (context.code) return undefined;
    if (normalized !== undefined) output[key] = normalized;
  }
  return Object.freeze(output);
};

const admissionFingerprint = (
  query: Readonly<Record<string, unknown>>,
): string => hashFingerprint(stableSerialize({
  namespace: 'general-search-v11',
  query,
}));

export const admitGeneralSearchQueryV11 = (
  queryInput: unknown,
  policyInput: GeneralSearchLifecyclePolicyV11 | GeneralSearchNormalizedLifecyclePolicyV11 = {},
): GeneralSearchQueryAdmissionV11 => {
  const policy = 'maxQueryFields' in policyInput
    && typeof policyInput.maxQueryFields === 'number'
    && 'searchTimeoutMs' in policyInput
    ? policyInput as GeneralSearchNormalizedLifecyclePolicyV11
    : normalizeGeneralSearchLifecyclePolicyV11(policyInput as GeneralSearchLifecyclePolicyV11);

  const context: AdmissionContext = {
    policy,
    fields: 0,
    maximumDepth: 0,
    code: null,
  };

  if (!isPlainRecord(queryInput)) {
    return Object.freeze({
      accepted: false,
      code: 'QUERY_REQUIRED',
      query: null,
      fingerprint: '',
      fieldCount: 0,
      maximumDepth: 0,
      serializedLength: 0,
    });
  }

  const normalized = normalizeValue(queryInput, 1, context);
  if (context.code || !isPlainRecord(normalized)) {
    return Object.freeze({
      accepted: false,
      code: context.code ?? 'QUERY_UNSUPPORTED_VALUE',
      query: null,
      fingerprint: '',
      fieldCount: context.fields,
      maximumDepth: context.maximumDepth,
      serializedLength: 0,
    });
  }

  let serialized = '';
  try {
    serialized = stableSerialize(normalized);
  } catch {
    return Object.freeze({
      accepted: false,
      code: 'QUERY_UNSUPPORTED_VALUE',
      query: null,
      fingerprint: '',
      fieldCount: context.fields,
      maximumDepth: context.maximumDepth,
      serializedLength: 0,
    });
  }

  if (serialized.length > policy.maxQuerySerializedLength) {
    return Object.freeze({
      accepted: false,
      code: 'QUERY_TOO_LARGE',
      query: null,
      fingerprint: '',
      fieldCount: context.fields,
      maximumDepth: context.maximumDepth,
      serializedLength: serialized.length,
    });
  }

  return Object.freeze({
    accepted: true,
    code: null,
    query: normalized,
    fingerprint: admissionFingerprint(normalized),
    fieldCount: context.fields,
    maximumDepth: context.maximumDepth,
    serializedLength: serialized.length,
  });
};

const readField = (
  input: Readonly<Record<string, unknown>>,
  lower: string,
  upper: string,
): unknown => Object.prototype.hasOwnProperty.call(input, lower)
  ? input[lower]
  : input[upper];

const serviceType = (value: unknown): number | string | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const normalized = value.trim();
    return normalized || null;
  }
  return null;
};

const serviceSuccess = (value: number | string | null): boolean =>
  value === 10 || value === '10';

export class GeneralSearchAdmissionErrorV11 extends Error {
  readonly code: GeneralSearchAdmissionCodeV11;
  readonly retryable: boolean;

  constructor(
    code: GeneralSearchAdmissionCodeV11,
    message: string,
    retryable = false,
  ) {
    super(message);
    this.name = 'GeneralSearchAdmissionErrorV11';
    this.code = code;
    this.retryable = retryable;
  }
}

export const admitGeneralSearchServiceResultV11 = (
  value: unknown,
  maximumRecords: number,
  maximumMessageLength = DEFAULT_MAX_MESSAGE_LENGTH,
): GeneralSearchServiceResultV11 => {
  if (!isPlainRecord(value)) {
    throw new GeneralSearchAdmissionErrorV11(
      'SERVICE_RESULT_INVALID',
      'Arama servisi geçersiz bir yanıt döndürdü.',
    );
  }

  const type = serviceType(readField(value, 'type', 'Type'));
  const message = normalizeText(readField(value, 'message', 'Message'))
    .slice(0, Math.max(32, maximumMessageLength));
  const rawData = readField(value, 'data', 'Data');

  if (!serviceSuccess(type)) {
    throw new GeneralSearchAdmissionErrorV11(
      'SERVICE_RESULT_FAILURE',
      message || 'Arama servisi isteği tamamlayamadı.',
      false,
    );
  }

  if (rawData !== undefined && rawData !== null && !Array.isArray(rawData)) {
    throw new GeneralSearchAdmissionErrorV11(
      'SERVICE_RESULT_INVALID',
      'Arama servisi sonuç koleksiyonu geçersiz.',
    );
  }

  const source = Array.isArray(rawData) ? rawData : [];
  const limit = Math.max(1, Math.trunc(maximumRecords));
  const data = Object.freeze(source.slice(0, limit));

  return Object.freeze({
    type,
    success: true,
    data,
    message,
    inputCount: source.length,
    outputCount: data.length,
    truncated: source.length > data.length,
  });
};

const normalizedErrorCode = (error: unknown): string => {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = normalizeText((error as { code?: unknown }).code);
    if (code) return code.slice(0, 80);
  }
  return error instanceof Error && error.name
    ? normalizeText(error.name).slice(0, 80) || 'ERROR'
    : 'ERROR';
};

const normalizedErrorMessage = (error: unknown): string => {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  return normalizeText(raw).slice(0, 1_000) || 'Beklenmeyen arama hatası.';
};

const retryReason = (error: unknown): GeneralSearchRetryReasonV11 | null => {
  if (error instanceof BusinessTimeoutError) return 'timeout';
  if (error instanceof BusinessContractError && error.retryable) return 'retryable-contract';
  if (error && typeof error === 'object' && 'retryable' in error) {
    if ((error as { retryable?: unknown }).retryable === true) return 'unknown-retryable';
  }
  const name = error instanceof Error ? error.name.toLowerCase() : '';
  const code = normalizedErrorCode(error).toLowerCase();
  const message = normalizedErrorMessage(error).toLowerCase();
  if (
    name.includes('network')
    || code.includes('network')
    || message.includes('network')
    || message.includes('failed to fetch')
    || message.includes('connection')
    || message.includes('bağlant')
  ) {
    return 'network';
  }
  return null;
};

export const normalizeGeneralSearchErrorV11 = (
  error: unknown,
): GeneralSearchNormalizedErrorV11 => {
  const reason = retryReason(error);
  const retryable = reason !== null;
  return Object.freeze({
    name: error instanceof Error
      ? normalizeText(error.name).slice(0, 80) || 'Error'
      : 'Error',
    code: normalizedErrorCode(error),
    message: normalizedErrorMessage(error),
    retryable,
    retryReason: reason,
  });
};

const deterministicJitter = (
  fingerprint: string,
  attempt: number,
): number => {
  const seed = hashFingerprint(stableSerialize({ fingerprint, attempt }));
  const numeric = Number.parseInt(seed.slice(0, 8), 16);
  if (!Number.isFinite(numeric)) return 0.5;
  return (numeric % 10_000) / 10_000;
};

export const retryDecisionForGeneralSearchV11 = (
  error: unknown,
  attempt: number,
  fingerprint: string,
  policy: GeneralSearchNormalizedLifecyclePolicyV11,
  bypassRetry = false,
): GeneralSearchRetryDecisionV11 => {
  const normalized = normalizeGeneralSearchErrorV11(error);
  if (
    bypassRetry
    || !normalized.retryable
    || attempt > policy.maxRetries
  ) {
    return Object.freeze({ retry: false, reason: normalized.retryReason, delayMs: 0 });
  }

  const exponential = Math.min(
    policy.retryMaxDelayMs,
    policy.retryBaseDelayMs * (2 ** Math.max(0, attempt - 1)),
  );
  const jitterUnit = deterministicJitter(fingerprint, attempt);
  const jitter = exponential * policy.retryJitterRatio * ((jitterUnit * 2) - 1);
  const delayMs = Math.max(0, Math.round(exponential + jitter));
  return Object.freeze({
    retry: true,
    reason: normalized.retryReason,
    delayMs,
  });
};

const finding = (
  code: string,
  severity: GeneralSearchLifecycleAuditFindingV11['severity'],
  message: string,
): GeneralSearchLifecycleAuditFindingV11 => Object.freeze({ code, severity, message });

const historyCounts = (
  history: readonly GeneralSearchHistoryEntryV11[],
): Readonly<Record<string, number>> => {
  const counts: Record<string, number> = {};
  for (const entry of history) {
    counts[entry.outcome] = (counts[entry.outcome] ?? 0) + 1;
  }
  return Object.freeze(counts);
};

export const auditGeneralSearchLifecycleV11 = (
  input: GeneralSearchLifecycleAuditInputV11,
): GeneralSearchLifecycleAuditReportV11 => {
  const findings: GeneralSearchLifecycleAuditFindingV11[] = [];
  const { policy, snapshot, history } = input;

  if (history.length > policy.maxHistory) {
    findings.push(finding(
      'history-over-budget',
      'error',
      'Lifecycle history exceeded its configured bound.',
    ));
  }
  if (snapshot.search.status === 'running' && snapshot.search.startedAt === null) {
    findings.push(finding(
      'search-running-without-start',
      'error',
      'Search lane is running without a start timestamp.',
    ));
  }
  if (snapshot.detail.status === 'running' && snapshot.detail.startedAt === null) {
    findings.push(finding(
      'detail-running-without-start',
      'error',
      'Detail lane is running without a start timestamp.',
    ));
  }
  if (snapshot.succeeded + snapshot.failed + snapshot.cancelled + snapshot.stale > snapshot.started + snapshot.scheduled) {
    findings.push(finding(
      'terminal-count-exceeds-started',
      'error',
      'Terminal lifecycle counters exceed started operations.',
    ));
  }
  if (snapshot.truncatedResponses > 0) {
    findings.push(finding(
      'response-truncation-observed',
      'warning',
      'One or more server responses exceeded the admitted record budget and were truncated.',
    ));
  }
  if (snapshot.retries > snapshot.started * Math.max(1, policy.maxRetries)) {
    findings.push(finding(
      'retry-count-suspicious',
      'warning',
      'Observed retry count is unexpectedly high relative to started operations.',
    ));
  }

  const counts = historyCounts(history);
  const staleHistory = counts.stale ?? 0;
  if (staleHistory > snapshot.stale) {
    findings.push(finding(
      'stale-counter-under-reports-history',
      'error',
      'Stale response counter is lower than retained history evidence.',
    ));
  }

  const fingerprint = hashFingerprint(stableSerialize({
    version: 'general-search-lifecycle-audit-v11',
    policy: {
      maxHistory: policy.maxHistory,
      maxSearchRecords: policy.maxSearchRecords,
      maxDetailRecords: policy.maxDetailRecords,
      maxRetries: policy.maxRetries,
      searchTimeoutMs: policy.searchTimeoutMs,
      detailTimeoutMs: policy.detailTimeoutMs,
    },
    snapshot,
    history: history.map(entry => [
      entry.lane,
      entry.requestId,
      entry.fingerprint,
      entry.outcome,
      entry.elapsedMs,
      entry.attemptCount,
      entry.resultCount,
      entry.stale,
      entry.errorCode,
    ]),
    findings,
  }));

  return Object.freeze({
    healthy: !findings.some(item => item.severity === 'error'),
    findings: Object.freeze(findings),
    fingerprint,
  });
};
