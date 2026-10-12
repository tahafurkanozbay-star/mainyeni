import type { QueryExecutionControl, UnknownRecord } from '../../../Business/contracts';

export const GENERAL_SEARCH_LIFECYCLE_VERSION_V11 = 'general-search-lifecycle-v11' as const;

export type GeneralSearchLaneV11 = 'search' | 'detail';

export type GeneralSearchLifecycleStatusV11 =
  | 'idle'
  | 'scheduled'
  | 'running'
  | 'success'
  | 'failure'
  | 'cancelled'
  | 'disposed';

export type GeneralSearchLifecycleOutcomeV11 =
  | 'success'
  | 'failure'
  | 'cancelled'
  | 'stale'
  | 'rejected';

export type GeneralSearchAdmissionCodeV11 =
  | 'QUERY_REQUIRED'
  | 'QUERY_TOO_LARGE'
  | 'QUERY_TOO_DEEP'
  | 'QUERY_TOO_MANY_FIELDS'
  | 'QUERY_UNSUPPORTED_VALUE'
  | 'DETAIL_ID_REQUIRED'
  | 'SERVICE_RESULT_INVALID'
  | 'SERVICE_RESULT_FAILURE'
  | 'SERVICE_RESULT_TOO_LARGE'
  | 'RUNTIME_DISPOSED';

export type GeneralSearchRetryReasonV11 =
  | 'timeout'
  | 'network'
  | 'retryable-contract'
  | 'unknown-retryable';

export interface GeneralSearchLifecyclePolicyV11 {
  readonly searchDebounceMs?: number;
  readonly maxDebounceMs?: number;
  readonly searchTimeoutMs?: number;
  readonly detailTimeoutMs?: number;
  readonly maxTimeoutMs?: number;
  readonly searchCacheTtlMs?: number;
  readonly detailCacheTtlMs?: number;
  readonly maxCacheTtlMs?: number;
  readonly maxSearchRecords?: number;
  readonly maxDetailRecords?: number;
  readonly maxQueryFields?: number;
  readonly maxQueryDepth?: number;
  readonly maxQueryStringLength?: number;
  readonly maxQueryArrayLength?: number;
  readonly maxQuerySerializedLength?: number;
  readonly maxMessageLength?: number;
  readonly maxHistory?: number;
  readonly maxRetries?: number;
  readonly retryBaseDelayMs?: number;
  readonly retryMaxDelayMs?: number;
  readonly retryJitterRatio?: number;
  readonly cacheSearch?: boolean;
  readonly cacheDetail?: boolean;
  readonly deduplicateSearch?: boolean;
  readonly deduplicateDetail?: boolean;
}

export interface GeneralSearchNormalizedLifecyclePolicyV11 {
  readonly searchDebounceMs: number;
  readonly maxDebounceMs: number;
  readonly searchTimeoutMs: number;
  readonly detailTimeoutMs: number;
  readonly maxTimeoutMs: number;
  readonly searchCacheTtlMs: number;
  readonly detailCacheTtlMs: number;
  readonly maxCacheTtlMs: number;
  readonly maxSearchRecords: number;
  readonly maxDetailRecords: number;
  readonly maxQueryFields: number;
  readonly maxQueryDepth: number;
  readonly maxQueryStringLength: number;
  readonly maxQueryArrayLength: number;
  readonly maxQuerySerializedLength: number;
  readonly maxMessageLength: number;
  readonly maxHistory: number;
  readonly maxRetries: number;
  readonly retryBaseDelayMs: number;
  readonly retryMaxDelayMs: number;
  readonly retryJitterRatio: number;
  readonly cacheSearch: boolean;
  readonly cacheDetail: boolean;
  readonly deduplicateSearch: boolean;
  readonly deduplicateDetail: boolean;
}

export interface GeneralSearchTransportV11 {
  readonly Query: (
    query?: Readonly<Record<string, unknown>>,
    returnGeometry?: boolean,
    options?: QueryExecutionControl,
  ) => Promise<unknown>;
}

export interface GeneralSearchQueryAdmissionV11 {
  readonly accepted: boolean;
  readonly code: GeneralSearchAdmissionCodeV11 | null;
  readonly query: Readonly<Record<string, unknown>> | null;
  readonly fingerprint: string;
  readonly fieldCount: number;
  readonly maximumDepth: number;
  readonly serializedLength: number;
}

export interface GeneralSearchServiceResultV11 {
  readonly type: number | string | null;
  readonly success: boolean;
  readonly data: readonly unknown[];
  readonly message: string;
  readonly inputCount: number;
  readonly outputCount: number;
  readonly truncated: boolean;
}

export interface GeneralSearchExecutionOptionsV11 {
  readonly signal?: AbortSignal | null;
  readonly timeoutMs?: number;
  readonly cacheTtlMs?: number;
  readonly bypassCache?: boolean;
  readonly bypassDeduplication?: boolean;
  readonly bypassRetry?: boolean;
  readonly now?: number;
}

export interface GeneralSearchScheduleOptionsV11 extends GeneralSearchExecutionOptionsV11 {
  readonly debounceMs?: number;
  readonly bypassDebounce?: boolean;
}

export interface GeneralSearchExecutionEnvelopeV11 {
  readonly version: typeof GENERAL_SEARCH_LIFECYCLE_VERSION_V11;
  readonly lane: GeneralSearchLaneV11;
  readonly requestId: number;
  readonly requestKey: string;
  readonly fingerprint: string;
  readonly query: Readonly<Record<string, unknown>>;
  readonly returnGeometry: boolean;
  readonly result: GeneralSearchServiceResultV11;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly elapsedMs: number;
  readonly attemptCount: number;
  readonly stale: boolean;
  readonly cacheEnabled: boolean;
  readonly deduplicateEnabled: boolean;
}

export interface GeneralSearchFailureEnvelopeV11 {
  readonly version: typeof GENERAL_SEARCH_LIFECYCLE_VERSION_V11;
  readonly lane: GeneralSearchLaneV11;
  readonly requestId: number;
  readonly requestKey: string;
  readonly fingerprint: string;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly elapsedMs: number;
  readonly attemptCount: number;
  readonly stale: boolean;
  readonly errorName: string;
  readonly errorCode: string;
  readonly retryable: boolean;
}

export interface GeneralSearchLaneStateV11 {
  readonly lane: GeneralSearchLaneV11;
  readonly status: GeneralSearchLifecycleStatusV11;
  readonly requestId: number;
  readonly requestKey: string | null;
  readonly fingerprint: string | null;
  readonly scheduledAt: number | null;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  readonly attemptCount: number;
  readonly resultCount: number;
  readonly errorName: string | null;
  readonly errorCode: string | null;
}

export interface GeneralSearchHistoryEntryV11 {
  readonly lane: GeneralSearchLaneV11;
  readonly requestId: number;
  readonly requestKey: string;
  readonly fingerprint: string;
  readonly outcome: GeneralSearchLifecycleOutcomeV11;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly elapsedMs: number;
  readonly attemptCount: number;
  readonly resultCount: number;
  readonly stale: boolean;
  readonly errorName: string | null;
  readonly errorCode: string | null;
}

export interface GeneralSearchLifecycleSnapshotV11 {
  readonly version: typeof GENERAL_SEARCH_LIFECYCLE_VERSION_V11;
  readonly disposed: boolean;
  readonly search: GeneralSearchLaneStateV11;
  readonly detail: GeneralSearchLaneStateV11;
  readonly historyEntries: number;
  readonly scheduled: number;
  readonly started: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly stale: number;
  readonly rejected: number;
  readonly retries: number;
  readonly admittedSearchRecords: number;
  readonly admittedDetailRecords: number;
  readonly truncatedResponses: number;
  readonly fingerprint: string;
}

export interface GeneralSearchMutableCountersV11 {
  scheduled: number;
  started: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  stale: number;
  coalesced: number;
  rejected: number;
  retries: number;
  admittedSearchRecords: number;
  admittedDetailRecords: number;
  truncatedResponses: number;
}

export interface GeneralSearchRuntimeClockV11 {
  readonly now: () => number;
  readonly setTimeout: (
    callback: () => void,
    delay: number,
  ) => ReturnType<typeof globalThis.setTimeout>;
  readonly clearTimeout: (timer: ReturnType<typeof globalThis.setTimeout>) => void;
}

export interface GeneralSearchLifecycleDependenciesV11 {
  readonly transport: GeneralSearchTransportV11;
  readonly clock?: GeneralSearchRuntimeClockV11;
  readonly random?: () => number;
}

export interface GeneralSearchNormalizedErrorV11 {
  readonly name: string;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly retryReason: GeneralSearchRetryReasonV11 | null;
}

export interface GeneralSearchRetryDecisionV11 {
  readonly retry: boolean;
  readonly reason: GeneralSearchRetryReasonV11 | null;
  readonly delayMs: number;
}

export interface GeneralSearchLifecycleAuditInputV11 {
  readonly policy: GeneralSearchNormalizedLifecyclePolicyV11;
  readonly snapshot: GeneralSearchLifecycleSnapshotV11;
  readonly history: readonly GeneralSearchHistoryEntryV11[];
}

export interface GeneralSearchLifecycleAuditFindingV11 {
  readonly code: string;
  readonly severity: 'info' | 'warning' | 'error';
  readonly message: string;
}

export interface GeneralSearchLifecycleAuditReportV11 {
  readonly healthy: boolean;
  readonly findings: readonly GeneralSearchLifecycleAuditFindingV11[];
  readonly fingerprint: string;
}

export interface GeneralSearchDetailRequestV11 extends UnknownRecord {
  readonly ObjectId: string | number;
}
