import type {
  FastAccessQuery,
  QueryExecutionControl,
  UnknownRecord,
} from '../../../Business/contracts';

export const GENERAL_SEARCH_TRANSPORT_VERSION_V11 = '2026-10-12.v11' as const;

export type GeneralSearchTransportOperationV11 = 'search' | 'detail';

export type GeneralSearchTransportOutcomeV11 =
  | 'success'
  | 'service-error'
  | 'invalid-response'
  | 'response-limit'
  | 'cancelled'
  | 'superseded'
  | 'failure';

export type GeneralSearchTransportErrorCodeV11 =
  | 'GENERAL_SEARCH_SERVICE_ERROR'
  | 'GENERAL_SEARCH_RESPONSE_INVALID'
  | 'GENERAL_SEARCH_RESPONSE_LIMIT'
  | 'GENERAL_SEARCH_ABORTED'
  | 'GENERAL_SEARCH_SUPERSEDED'
  | 'GENERAL_SEARCH_RUNTIME_DISPOSED';

export interface GeneralSearchTransportPolicyV11 {
  readonly successType?: number;
  readonly maximumSearchRecords?: number;
  readonly maximumDetailRecords?: number;
  readonly maximumMessageLength?: number;
  readonly searchTimeoutMs?: number;
  readonly detailTimeoutMs?: number;
  readonly searchCacheTtlMs?: number;
  readonly detailCacheTtlMs?: number;
  readonly maximumDiagnostics?: number;
  readonly maximumMalformedRecords?: number;
  readonly cacheSearches?: boolean;
  readonly cacheDetails?: boolean;
}

export interface GeneralSearchTransportExecutionOptionsV11 {
  readonly signal?: AbortSignal | null;
  readonly timeoutMs?: number;
  readonly cache?: boolean;
  readonly cacheTtlMs?: number;
  readonly requestKeySuffix?: string | null;
}

export interface GeneralSearchTransportSourceV11 {
  readonly Query: (
    query?: FastAccessQuery,
    returnGeometry?: boolean,
    options?: QueryExecutionControl,
  ) => Promise<unknown>;
}

export interface GeneralSearchServiceResultV11 {
  readonly type: number | null;
  readonly data: readonly UnknownRecord[];
  readonly message: string;
  readonly errorMessage: string;
  readonly inputRecordCount: number;
  readonly acceptedRecordCount: number;
  readonly malformedRecordCount: number;
  readonly truncated: boolean;
}

export interface GeneralSearchTransportEnvelopeV11 {
  readonly version: typeof GENERAL_SEARCH_TRANSPORT_VERSION_V11;
  readonly operation: GeneralSearchTransportOperationV11;
  readonly requestId: number;
  readonly requestFingerprint: string;
  readonly records: readonly UnknownRecord[];
  readonly message: string;
  readonly inputRecordCount: number;
  readonly acceptedRecordCount: number;
  readonly malformedRecordCount: number;
  readonly elapsedMs: number;
  readonly stale: boolean;
}

export interface GeneralSearchTransportTaskV11 {
  readonly operation: GeneralSearchTransportOperationV11;
  readonly requestId: number;
  readonly requestFingerprint: string;
  readonly promise: Promise<GeneralSearchTransportEnvelopeV11>;
  readonly cancel: (reason?: string) => void;
  readonly isCurrent: () => boolean;
}

export interface GeneralSearchTransportDiagnosticV11 {
  readonly sequence: number;
  readonly operation: GeneralSearchTransportOperationV11;
  readonly requestId: number;
  readonly requestFingerprint: string;
  readonly outcome: GeneralSearchTransportOutcomeV11;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly elapsedMs: number;
  readonly inputRecordCount: number;
  readonly acceptedRecordCount: number;
  readonly malformedRecordCount: number;
  readonly code: string;
}

export interface GeneralSearchTransportSnapshotV11 {
  readonly version: typeof GENERAL_SEARCH_TRANSPORT_VERSION_V11;
  readonly disposed: boolean;
  readonly activeSearchRequestId: number | null;
  readonly activeDetailRequestId: number | null;
  readonly started: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly superseded: number;
  readonly blocked: number;
  readonly malformedRecords: number;
  readonly reporterFailures: number;
  readonly diagnostics: readonly GeneralSearchTransportDiagnosticV11[];
}

export interface GeneralSearchTransportAuditPolicyV11 {
  readonly maximumDiagnostics?: number;
  readonly maximumElapsedMs?: number;
  readonly maximumMalformedRecordsPerRequest?: number;
  readonly maximumFailureRatio?: number;
}

export type GeneralSearchTransportAuditSeverityV11 = 'info' | 'warning' | 'error';

export interface GeneralSearchTransportAuditIssueV11 {
  readonly code:
    | 'diagnostic-budget-exceeded'
    | 'diagnostic-sequence-invalid'
    | 'active-request-after-dispose'
    | 'negative-counter'
    | 'counter-invariant'
    | 'elapsed-budget-exceeded'
    | 'malformed-budget-exceeded'
    | 'failure-ratio-exceeded'
    | 'fingerprint-missing';
  readonly severity: GeneralSearchTransportAuditSeverityV11;
  readonly detail: string;
  readonly diagnosticSequence: number | null;
}

export interface GeneralSearchTransportAuditReportV11 {
  readonly healthy: boolean;
  readonly errors: number;
  readonly warnings: number;
  readonly issues: readonly GeneralSearchTransportAuditIssueV11[];
  readonly fingerprint: string;
}

export interface GeneralSearchTransportReporterV11 {
  (
    diagnostic: GeneralSearchTransportDiagnosticV11,
  ): void;
}

export interface GeneralSearchTransportRuntimeOptionsV11 {
  readonly policy?: GeneralSearchTransportPolicyV11;
  readonly clock?: () => number;
  readonly reporter?: GeneralSearchTransportReporterV11 | null;
}

export interface GeneralSearchSearchTaskInputV11 {
  readonly query: FastAccessQuery;
  readonly execution?: GeneralSearchTransportExecutionOptionsV11;
}

export interface GeneralSearchDetailTaskInputV11 {
  readonly objectId: string | number;
  readonly execution?: GeneralSearchTransportExecutionOptionsV11;
}

export interface GeneralSearchTransportIdentityV11 {
  readonly operation: GeneralSearchTransportOperationV11;
  readonly requestFingerprint: string;
  readonly requestKey: string;
}

export interface GeneralSearchTransportControlPlanV11 {
  readonly identity: GeneralSearchTransportIdentityV11;
  readonly control: QueryExecutionControl;
  readonly returnGeometry: boolean;
}

export class GeneralSearchTransportErrorV11 extends Error {
  readonly code: GeneralSearchTransportErrorCodeV11;
  readonly retryable: boolean;
  readonly operation: GeneralSearchTransportOperationV11;
  readonly requestId: number;
  readonly requestFingerprint: string;

  constructor(
    code: GeneralSearchTransportErrorCodeV11,
    message: string,
    operation: GeneralSearchTransportOperationV11,
    requestId: number,
    requestFingerprint: string,
    retryable = false,
  ) {
    super(message);
    this.name = code === 'GENERAL_SEARCH_ABORTED' || code === 'GENERAL_SEARCH_SUPERSEDED'
      ? 'AbortError'
      : 'GeneralSearchTransportErrorV11';
    this.code = code;
    this.retryable = retryable;
    this.operation = operation;
    this.requestId = requestId;
    this.requestFingerprint = requestFingerprint;
  }
}

export const isGeneralSearchTransportErrorV11 = (
  value: unknown,
): value is GeneralSearchTransportErrorV11 => value instanceof GeneralSearchTransportErrorV11;

export const isGeneralSearchTransportCancellationV11 = (value: unknown): boolean => {
  if (value instanceof GeneralSearchTransportErrorV11) {
    return value.code === 'GENERAL_SEARCH_ABORTED'
      || value.code === 'GENERAL_SEARCH_SUPERSEDED';
  }
  if (value instanceof DOMException) return value.name === 'AbortError';
  if (value instanceof Error) return value.name === 'AbortError';
  return false;
};
