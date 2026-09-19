export type GuardrailDecision = 'allow' | 'deny' | 'normalize';
export type GuardrailSeverity = 'info' | 'warning' | 'error' | 'critical';

export interface GuardrailReason {
  readonly code: string;
  readonly severity: GuardrailSeverity;
  readonly message: string;
  readonly path?: string;
}

export interface GuardrailVerdict<T> {
  readonly decision: GuardrailDecision;
  readonly value: T | null;
  readonly reasons: readonly GuardrailReason[];
}

export interface TextBoundaryLimits {
  readonly maxCodeUnits: number;
  readonly maxUtf8Bytes: number;
  readonly rejectControlCharacters: boolean;
  readonly rejectBidiControls: boolean;
  readonly stripInvisibleFormatting: boolean;
  readonly trim: boolean;
  readonly normalizeUnicode: boolean;
}

export interface TextBoundaryResult {
  readonly accepted: boolean;
  readonly value: string;
  readonly originalLength: number;
  readonly utf8Bytes: number;
  readonly changed: boolean;
  readonly reasons: readonly GuardrailReason[];
}

export interface UrlBoundaryPolicy {
  readonly baseUrl?: string;
  readonly allowedProtocols: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly allowedHosts: readonly string[];
  readonly blockedHosts: readonly string[];
  readonly allowedPorts: readonly string[];
  readonly allowRelative: boolean;
  readonly allowFragments: boolean;
  readonly allowLocalNetworkTargets: boolean;
  readonly requireHttpsForExternal: boolean;
  readonly maxUrlLength: number;
  readonly maxPathLength: number;
  readonly maxPathSegments: number;
  readonly maxQueryLength: number;
  readonly maxQueryParameters: number;
  readonly maxFragmentLength: number;
}

export interface UrlBoundaryResult {
  readonly input: string;
  readonly normalizedUrl: string | null;
  readonly origin: string | null;
  readonly protocol: string | null;
  readonly hostname: string | null;
  readonly port: string | null;
  readonly relative: boolean;
  readonly sameOrigin: boolean;
  readonly localNetworkTarget: boolean;
  readonly decision: GuardrailDecision;
  readonly reasons: readonly GuardrailReason[];
}

export interface PayloadBudget {
  readonly maxDepth: number;
  readonly maxObjectKeys: number;
  readonly maxArrayItems: number;
  readonly maxStringLength: number;
  readonly maxUtf8Bytes: number;
  readonly maxTotalNodes: number;
}

export interface PayloadShapeStats {
  readonly depth: number;
  readonly objectKeys: number;
  readonly arrayItems: number;
  readonly strings: number;
  readonly utf8Bytes: number;
  readonly nodes: number;
}

export interface PayloadBoundaryResult<T = unknown> {
  readonly accepted: boolean;
  readonly value: T | null;
  readonly stats: PayloadShapeStats;
  readonly reasons: readonly GuardrailReason[];
}

export type SafeHttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';

export interface RequestBoundaryPolicy {
  readonly url: UrlBoundaryPolicy;
  readonly allowedMethods: readonly SafeHttpMethod[];
  readonly maxHeaders: number;
  readonly maxHeaderBytes: number;
  readonly maxHeaderNameLength: number;
  readonly maxHeaderValueLength: number;
  readonly maxBodyBytes: number;
  readonly allowedContentTypes: readonly string[];
  readonly allowBodyOnGetOrHead: boolean;
  readonly externalReferrerPolicy: 'no-referrer' | 'strict-origin' | 'same-origin';
}

export interface RequestBoundaryInput {
  readonly url: string;
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly referrerPolicy?: ReferrerPolicy;
}

export interface NormalizedRequestDescriptor {
  readonly url: string;
  readonly method: SafeHttpMethod;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly referrerPolicy: ReferrerPolicy;
  readonly external: boolean;
  readonly estimatedBodyBytes: number;
  readonly estimatedHeaderBytes: number;
}

export interface ResponseBoundaryPolicy {
  readonly maxBodyBytes: number;
  readonly maxHeaders: number;
  readonly maxHeaderBytes: number;
  readonly allowedContentTypes: readonly string[];
  readonly rejectOpaqueResponses: boolean;
  readonly allowRedirectedResponses: boolean;
  readonly acceptedStatusRanges: readonly Readonly<{ min: number; max: number; }>[];
}

export interface ResponseBoundaryInput {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly bodyBytes?: number;
  readonly responseType?: ResponseType;
  readonly redirected?: boolean;
  readonly url?: string;
}

export interface NormalizedResponseDescriptor {
  readonly status: number;
  readonly contentType: string;
  readonly bodyBytes: number;
  readonly headerBytes: number;
  readonly redirected: boolean;
  readonly responseType: ResponseType;
}

export interface WorkBudgetPolicy {
  readonly maxConcurrent: number;
  readonly maxQueued: number;
  readonly maxPerKey: number;
  readonly maxWaitMs: number;
  readonly maxRunMs: number;
  readonly maxCompletedHistory: number;
}

export type WorkTicketState = 'queued' | 'running' | 'completed' | 'cancelled' | 'rejected';

export interface WorkTicketSnapshot {
  readonly id: number;
  readonly key: string;
  readonly priority: number;
  readonly state: WorkTicketState;
  readonly queuedAt: number;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  readonly queueWaitMs: number | null;
  readonly runMs: number | null;
  readonly reason: string | null;
}

export interface WorkBudgetSnapshot {
  readonly running: number;
  readonly queued: number;
  readonly rejected: number;
  readonly cancelled: number;
  readonly completed: number;
  readonly tickets: readonly WorkTicketSnapshot[];
}

export interface GuardrailEventInput {
  readonly code: string;
  readonly severity: GuardrailSeverity;
  readonly decision: GuardrailDecision;
  readonly source: string;
  readonly detail?: Readonly<Record<string, unknown>>;
  readonly at?: number;
  readonly fingerprint?: string;
}

export interface GuardrailEvent {
  readonly id: number;
  readonly at: number;
  readonly code: string;
  readonly severity: GuardrailSeverity;
  readonly decision: GuardrailDecision;
  readonly source: string;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly fingerprint: string;
  readonly duplicateCount: number;
}

export interface GuardrailCounters {
  readonly allowed: number;
  readonly normalized: number;
  readonly denied: number;
  readonly info: number;
  readonly warning: number;
  readonly error: number;
  readonly critical: number;
  readonly droppedEvents: number;
  readonly duplicateEvents: number;
}

export interface GuardrailJournalOptions {
  readonly capacity: number;
  readonly maxDetailKeys: number;
  readonly maxDetailStringLength: number;
  readonly dedupeWindowMs: number;
}

export interface GuardrailJournalSnapshot {
  readonly capacity: number;
  readonly retained: number;
  readonly firstEventAt: number | null;
  readonly lastEventAt: number | null;
  readonly counters: GuardrailCounters;
  readonly events: readonly GuardrailEvent[];
}

export interface GuardrailReadinessPolicy {
  readonly maxDeniedEvents: number;
  readonly maxWarningEvents: number;
  readonly maxErrorEvents: number;
  readonly maxCriticalEvents: number;
  readonly maxDroppedEvents: number;
  readonly maxDuplicateEvents: number;
  readonly minimumScore: number;
}

export type GuardrailReadinessState = 'ready' | 'degraded' | 'blocked';

export interface GuardrailReadinessReport {
  readonly state: GuardrailReadinessState;
  readonly score: number;
  readonly reasons: readonly GuardrailReason[];
  readonly evaluatedAt: number;
  readonly counters: GuardrailCounters;
}

export interface LifecycleGuardPolicy {
  readonly maxTrackedResources: number;
  readonly maxOwnersPerResource: number;
  readonly staleAfterMs: number;
  readonly maxHistory: number;
}

export interface LifecycleResourceSnapshot {
  readonly id: string;
  readonly kind: string;
  readonly ownerCount: number;
  readonly acquiredAt: number;
  readonly lastTouchedAt: number;
  readonly releasedAt: number | null;
  readonly state: 'active' | 'released' | 'stale';
}

export interface LifecycleGuardSnapshot {
  readonly active: number;
  readonly released: number;
  readonly stale: number;
  readonly rejected: number;
  readonly resources: readonly LifecycleResourceSnapshot[];
}
