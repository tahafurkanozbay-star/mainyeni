import type {
  FastAccessQuery,
  QueryExecutionControl,
  UnknownRecord,
} from '../../../Business/contracts';
import {
  isAbortError,
  isRecord,
} from '../../../Business/contracts';
import {
  hashFingerprint,
  normalizeInteger,
  normalizeSearchText,
  normalizeText,
  stableSerialize,
} from '../../../data-search/normalization';
import {
  auditGeneralSearchResponseIntegrityV11,
  summarizeGeneralSearchIntegrityV11,
} from './GenelAramaResponseIntegrityV11';
import {
  GENERAL_SEARCH_TRANSPORT_VERSION_V11,
  GeneralSearchTransportErrorV11,
  type GeneralSearchDetailTaskInputV11,
  type GeneralSearchSearchTaskInputV11,
  type GeneralSearchServiceResultV11,
  type GeneralSearchTransportControlPlanV11,
  type GeneralSearchTransportDiagnosticV11,
  type GeneralSearchTransportEnvelopeV11,
  type GeneralSearchTransportExecutionOptionsV11,
  type GeneralSearchTransportIdentityV11,
  type GeneralSearchTransportOperationV11,
  type GeneralSearchTransportOutcomeV11,
  type GeneralSearchTransportPolicyV11,
  type GeneralSearchTransportRuntimeOptionsV11,
  type GeneralSearchTransportSnapshotV11,
  type GeneralSearchTransportSourceV11,
  type GeneralSearchTransportTaskV11,
} from './GenelAramaTransportContractsV11';

interface NormalizedPolicyV11 {
  readonly successType: number;
  readonly maximumSearchRecords: number;
  readonly maximumDetailRecords: number;
  readonly maximumMessageLength: number;
  readonly searchTimeoutMs: number;
  readonly detailTimeoutMs: number;
  readonly searchCacheTtlMs: number;
  readonly detailCacheTtlMs: number;
  readonly maximumDiagnostics: number;
  readonly maximumMalformedRecords: number;
  readonly cacheSearches: boolean;
  readonly cacheDetails: boolean;
}

interface ActiveOperationV11 {
  readonly requestId: number;
  readonly requestFingerprint: string;
  readonly controller: AbortController;
  readonly startedAt: number;
  superseded: boolean;
}

interface MutableCountersV11 {
  started: number;
  completed: number;
  failed: number;
  cancelled: number;
  superseded: number;
  blocked: number;
  malformedRecords: number;
  reporterFailures: number;
}

interface AdmissionOptionsV11 {
  readonly operation: GeneralSearchTransportOperationV11;
  readonly successType: number;
  readonly maximumRecords: number;
  readonly maximumMessageLength: number;
}

const DEFAULT_SEARCH_RECORDS = 50_000;
const DEFAULT_DETAIL_RECORDS = 8;
const DEFAULT_MESSAGE_LENGTH = 1_024;
const DEFAULT_SEARCH_TIMEOUT_MS = 20_000;
const DEFAULT_DETAIL_TIMEOUT_MS = 15_000;
const DEFAULT_SEARCH_CACHE_TTL_MS = 15_000;
const DEFAULT_DETAIL_CACHE_TTL_MS = 30_000;
const DEFAULT_MAX_DIAGNOSTICS = 128;
const DEFAULT_MAX_MALFORMED_RECORDS = 256;

const safeNow = (clock: () => number): number => {
  const value = Number(clock());
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : Date.now();
};

const normalizePolicy = (
  input: GeneralSearchTransportPolicyV11 = {},
): NormalizedPolicyV11 => Object.freeze({
  successType: normalizeInteger(input.successType, {
    min: 1,
    max: 999,
    fallback: 10,
  }),
  maximumSearchRecords: normalizeInteger(input.maximumSearchRecords, {
    min: 1,
    max: 100_000,
    fallback: DEFAULT_SEARCH_RECORDS,
  }),
  maximumDetailRecords: normalizeInteger(input.maximumDetailRecords, {
    min: 1,
    max: 100,
    fallback: DEFAULT_DETAIL_RECORDS,
  }),
  maximumMessageLength: normalizeInteger(input.maximumMessageLength, {
    min: 64,
    max: 8_192,
    fallback: DEFAULT_MESSAGE_LENGTH,
  }),
  searchTimeoutMs: normalizeInteger(input.searchTimeoutMs, {
    min: 100,
    max: 120_000,
    fallback: DEFAULT_SEARCH_TIMEOUT_MS,
  }),
  detailTimeoutMs: normalizeInteger(input.detailTimeoutMs, {
    min: 100,
    max: 120_000,
    fallback: DEFAULT_DETAIL_TIMEOUT_MS,
  }),
  searchCacheTtlMs: normalizeInteger(input.searchCacheTtlMs, {
    min: 0,
    max: 300_000,
    fallback: DEFAULT_SEARCH_CACHE_TTL_MS,
  }),
  detailCacheTtlMs: normalizeInteger(input.detailCacheTtlMs, {
    min: 0,
    max: 300_000,
    fallback: DEFAULT_DETAIL_CACHE_TTL_MS,
  }),
  maximumDiagnostics: normalizeInteger(input.maximumDiagnostics, {
    min: 1,
    max: 2_000,
    fallback: DEFAULT_MAX_DIAGNOSTICS,
  }),
  maximumMalformedRecords: normalizeInteger(input.maximumMalformedRecords, {
    min: 0,
    max: 10_000,
    fallback: DEFAULT_MAX_MALFORMED_RECORDS,
  }),
  cacheSearches: input.cacheSearches !== false,
  cacheDetails: input.cacheDetails !== false,
});

const boundedMessage = (
  value: unknown,
  maximum: number,
): string => normalizeText(value).slice(0, maximum);

const readNumericType = (value: unknown): number | null => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : null;
};

const sourceData = (root: Readonly<Record<string, unknown>>): unknown => (
  root.data ?? root.Data
);

const sourceType = (root: Readonly<Record<string, unknown>>): unknown => (
  root.type ?? root.Type
);

const sourceMessage = (root: Readonly<Record<string, unknown>>): unknown => (
  root.message ?? root.Message
);

const sourceErrorMessage = (root: Readonly<Record<string, unknown>>): unknown => (
  root.errorMessage ?? root.ErrorMessage
);

export const admitGeneralSearchServiceResultV11 = (
  value: unknown,
  options: AdmissionOptionsV11,
): GeneralSearchServiceResultV11 => {
  if (!isRecord(value)) {
    throw new GeneralSearchTransportErrorV11(
      'GENERAL_SEARCH_RESPONSE_INVALID',
      'Genel arama servisi geçersiz bir yanıt döndürdü.',
      options.operation,
      0,
      '',
      true,
    );
  }

  const type = readNumericType(sourceType(value));
  const message = boundedMessage(sourceMessage(value), options.maximumMessageLength);
  const errorMessage = boundedMessage(sourceErrorMessage(value), options.maximumMessageLength);
  const rawData = sourceData(value);

  if (type === options.successType && !Array.isArray(rawData)) {
    throw new GeneralSearchTransportErrorV11(
      'GENERAL_SEARCH_RESPONSE_INVALID',
      'Genel arama başarılı yanıtı kayıt listesi içermiyor.',
      options.operation,
      0,
      '',
      true,
    );
  }

  const input = Array.isArray(rawData) ? rawData : [];
  const truncated = input.length > options.maximumRecords;
  const accepted: UnknownRecord[] = [];
  let malformedRecordCount = 0;
  const upper = Math.min(input.length, options.maximumRecords);

  for (let index = 0; index < upper; index += 1) {
    const candidate = input[index];
    if (!isRecord(candidate)) {
      malformedRecordCount += 1;
      continue;
    }
    accepted.push(Object.freeze({ ...candidate }));
  }

  return Object.freeze({
    type,
    data: Object.freeze(accepted),
    message,
    errorMessage,
    inputRecordCount: input.length,
    acceptedRecordCount: accepted.length,
    malformedRecordCount,
    truncated,
  });
};

const normalizeIdentifier = (value: unknown): string => normalizeText(value)
  .slice(0, 160);

const normalizeLocationIdentity = (value: unknown): Readonly<Record<string, unknown>> | null => {
  if (!isRecord(value)) return null;
  const latitude = Number(value.latitude ?? value.y);
  const longitude = Number(value.longitude ?? value.x);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return Object.freeze({
    latitude: Math.round(latitude * 1_000_000) / 1_000_000,
    longitude: Math.round(longitude * 1_000_000) / 1_000_000,
  });
};

const canonicalQueryIdentity = (
  query: FastAccessQuery,
): Readonly<Record<string, unknown>> => Object.freeze({
  objectId: normalizeIdentifier(query.ObjectId ?? query.objectId),
  name: normalizeText(query.name).slice(0, 160),
  districtId: normalizeIdentifier(query.districtId),
  neighborhoodId: normalizeIdentifier(query.nbhoodId),
  showNearby: query.showNearby === true,
  bufferDistance: Number.isFinite(Number(query.bufferDistance))
    ? Number(query.bufferDistance)
    : null,
  userLocation: normalizeLocationIdentity(query.userLocation),
});

const normalizeSuffix = (value: unknown): string => normalizeSearchText(value)
  .replace(/[^a-z0-9_-]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 64);

export const createGeneralSearchTransportIdentityV11 = (
  operation: GeneralSearchTransportOperationV11,
  query: FastAccessQuery,
  returnGeometry: boolean,
  requestKeySuffix?: string | null,
): GeneralSearchTransportIdentityV11 => {
  const requestFingerprint = hashFingerprint(stableSerialize({
    version: GENERAL_SEARCH_TRANSPORT_VERSION_V11,
    operation,
    query: canonicalQueryIdentity(query),
    returnGeometry,
  }));
  const suffix = normalizeSuffix(requestKeySuffix);
  const requestKey = [
    'genel-arama-v11',
    operation,
    requestFingerprint,
    suffix || null,
  ].filter(Boolean).join(':');
  return Object.freeze({
    operation,
    requestFingerprint,
    requestKey,
  });
};

const normalizeExecutionTimeout = (
  value: unknown,
  fallback: number,
): number => normalizeInteger(value, {
  min: 100,
  max: 120_000,
  fallback,
});

const normalizeExecutionCacheTtl = (
  value: unknown,
  fallback: number,
): number => normalizeInteger(value, {
  min: 0,
  max: 300_000,
  fallback,
});

export const createGeneralSearchTransportControlPlanV11 = (
  operation: GeneralSearchTransportOperationV11,
  query: FastAccessQuery,
  returnGeometry: boolean,
  policy: GeneralSearchTransportPolicyV11 = {},
  execution: GeneralSearchTransportExecutionOptionsV11 = {},
  signal?: AbortSignal,
): GeneralSearchTransportControlPlanV11 => {
  const normalized = normalizePolicy(policy);
  const identity = createGeneralSearchTransportIdentityV11(
    operation,
    query,
    returnGeometry,
    execution.requestKeySuffix,
  );
  const search = operation === 'search';
  const control: QueryExecutionControl = Object.freeze({
    ...(signal ? { signal } : {}),
    timeoutMs: normalizeExecutionTimeout(
      execution.timeoutMs,
      search ? normalized.searchTimeoutMs : normalized.detailTimeoutMs,
    ),
    cacheTtlMs: normalizeExecutionCacheTtl(
      execution.cacheTtlMs,
      search ? normalized.searchCacheTtlMs : normalized.detailCacheTtlMs,
    ),
    cache: execution.cache ?? (search ? normalized.cacheSearches : normalized.cacheDetails),
    // Subscriber-owned AbortSignals must not be coupled through the shared
    // service-runtime inflight promise. Cache identity remains stable while
    // transport dedupe is intentionally disabled at this window boundary.
    deduplicate: false,
    requestKey: identity.requestKey,
  });
  return Object.freeze({
    identity,
    control,
    returnGeometry,
  });
};

const linkedAbort = (
  external: AbortSignal | null | undefined,
  internal: AbortController,
): (() => void) => {
  if (!external) return () => undefined;
  const propagate = (): void => {
    if (!internal.signal.aborted) internal.abort(external.reason);
  };
  if (external.aborted) {
    propagate();
    return () => undefined;
  }
  external.addEventListener('abort', propagate, { once: true });
  return () => external.removeEventListener('abort', propagate);
};

const codeForError = (error: unknown): string => {
  if (error instanceof GeneralSearchTransportErrorV11) return error.code;
  if (isRecord(error) && typeof error.code === 'string') return error.code.slice(0, 80);
  if (error instanceof Error) return error.name.slice(0, 80) || 'Error';
  return 'ERROR';
};

const outcomeForError = (
  error: unknown,
  superseded: boolean,
): GeneralSearchTransportOutcomeV11 => {
  if (superseded) return 'superseded';
  if (error instanceof GeneralSearchTransportErrorV11) {
    if (error.code === 'GENERAL_SEARCH_SUPERSEDED') return 'superseded';
    if (error.code === 'GENERAL_SEARCH_ABORTED') return 'cancelled';
    if (error.code === 'GENERAL_SEARCH_SERVICE_ERROR') return 'service-error';
    if (error.code === 'GENERAL_SEARCH_RESPONSE_LIMIT') return 'response-limit';
    if (error.code === 'GENERAL_SEARCH_RESPONSE_INVALID') return 'invalid-response';
  }
  if (isAbortError(error)) return 'cancelled';
  return 'failure';
};

const retryableServiceMessage = (
  result: GeneralSearchServiceResultV11,
): string => result.message
  || result.errorMessage
  || 'Arama sonuçları alınamadı. Lütfen tekrar deneyin.';

const boundedPush = <T>(target: T[], value: T, maximum: number): void => {
  target.push(value);
  if (target.length > maximum) target.splice(0, target.length - maximum);
};

const nextSequence = (value: number): number => (
  value >= Number.MAX_SAFE_INTEGER ? 1 : value + 1
);

export class GeneralSearchTransportRuntimeV11 {
  readonly #source: GeneralSearchTransportSourceV11;
  readonly #policy: NormalizedPolicyV11;
  readonly #clock: () => number;
  readonly #reporter: GeneralSearchTransportRuntimeOptionsV11['reporter'];
  readonly #diagnostics: GeneralSearchTransportDiagnosticV11[] = [];
  readonly #counters: MutableCountersV11 = {
    started: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    superseded: 0,
    blocked: 0,
    malformedRecords: 0,
    reporterFailures: 0,
  };
  #activeSearch: ActiveOperationV11 | null = null;
  #activeDetail: ActiveOperationV11 | null = null;
  #requestSequence = 0;
  #diagnosticSequence = 0;
  #disposed = false;

  constructor(
    source: GeneralSearchTransportSourceV11,
    options: GeneralSearchTransportRuntimeOptionsV11 = {},
  ) {
    if (!source || typeof source.Query !== 'function') {
      throw new TypeError('General-search transport source must expose Query().');
    }
    this.#source = source;
    this.#policy = normalizePolicy(options.policy);
    this.#clock = typeof options.clock === 'function' ? options.clock : () => Date.now();
    this.#reporter = options.reporter ?? null;
  }

  #now(): number {
    return safeNow(this.#clock);
  }

  #ensureActive(): void {
    if (!this.#disposed) return;
    throw new GeneralSearchTransportErrorV11(
      'GENERAL_SEARCH_RUNTIME_DISPOSED',
      'Genel arama transport runtime kapatıldı.',
      'search',
      0,
      '',
      false,
    );
  }

  #active(operation: GeneralSearchTransportOperationV11): ActiveOperationV11 | null {
    return operation === 'search' ? this.#activeSearch : this.#activeDetail;
  }

  #setActive(
    operation: GeneralSearchTransportOperationV11,
    value: ActiveOperationV11 | null,
  ): void {
    if (operation === 'search') this.#activeSearch = value;
    else this.#activeDetail = value;
  }

  #isCurrent(
    operation: GeneralSearchTransportOperationV11,
    requestId: number,
  ): boolean {
    return !this.#disposed && this.#active(operation)?.requestId === requestId;
  }

  #cancelActive(
    operation: GeneralSearchTransportOperationV11,
    superseded: boolean,
    message: string,
  ): boolean {
    const active = this.#active(operation);
    if (!active) return false;
    active.superseded = superseded;
    if (!active.controller.signal.aborted) {
      const code = superseded ? 'GENERAL_SEARCH_SUPERSEDED' : 'GENERAL_SEARCH_ABORTED';
      active.controller.abort(new GeneralSearchTransportErrorV11(
        code,
        message,
        operation,
        active.requestId,
        active.requestFingerprint,
        false,
      ));
    }
    return true;
  }

  #remember(
    entry: Omit<GeneralSearchTransportDiagnosticV11, 'sequence'>,
  ): void {
    this.#diagnosticSequence = nextSequence(this.#diagnosticSequence);
    const diagnostic = Object.freeze({
      sequence: this.#diagnosticSequence,
      ...entry,
    });
    boundedPush(this.#diagnostics, diagnostic, this.#policy.maximumDiagnostics);
    if (!this.#reporter) return;
    try {
      this.#reporter(diagnostic);
    } catch {
      this.#counters.reporterFailures += 1;
    }
  }

  #finishCounters(outcome: GeneralSearchTransportOutcomeV11): void {
    if (outcome === 'success') {
      this.#counters.completed += 1;
      return;
    }
    if (outcome === 'cancelled') {
      this.#counters.cancelled += 1;
      return;
    }
    if (outcome === 'superseded') {
      this.#counters.superseded += 1;
      return;
    }
    if (outcome === 'invalid-response' || outcome === 'response-limit') {
      this.#counters.blocked += 1;
      return;
    }
    this.#counters.failed += 1;
  }

  #createTask(
    operation: GeneralSearchTransportOperationV11,
    query: FastAccessQuery,
    returnGeometry: boolean,
    execution: GeneralSearchTransportExecutionOptionsV11,
  ): GeneralSearchTransportTaskV11 {
    this.#ensureActive();
    this.#cancelActive(
      operation,
      true,
      operation === 'search'
        ? 'Yeni arama isteği önceki aramayı geçersiz kıldı.'
        : 'Yeni detay isteği önceki detay isteğini geçersiz kıldı.',
    );

    this.#requestSequence = nextSequence(this.#requestSequence);
    const requestId = this.#requestSequence;
    const controller = new AbortController();
    const detachExternal = linkedAbort(execution.signal, controller);
    const plan = createGeneralSearchTransportControlPlanV11(
      operation,
      query,
      returnGeometry,
      this.#policy,
      execution,
      controller.signal,
    );
    const startedAt = this.#now();
    const active: ActiveOperationV11 = {
      requestId,
      requestFingerprint: plan.identity.requestFingerprint,
      controller,
      startedAt,
      superseded: false,
    };
    this.#setActive(operation, active);
    this.#counters.started += 1;

    let recorded = false;
    const rememberOnce = (
      outcome: GeneralSearchTransportOutcomeV11,
      inputRecordCount: number,
      acceptedRecordCount: number,
      malformedRecordCount: number,
      code: string,
    ): void => {
      if (recorded) return;
      recorded = true;
      this.#finishCounters(outcome);
      this.#counters.malformedRecords += malformedRecordCount;
      const completedAt = this.#now();
      this.#remember({
        operation,
        requestId,
        requestFingerprint: plan.identity.requestFingerprint,
        outcome,
        startedAt,
        completedAt,
        elapsedMs: Math.max(0, completedAt - startedAt),
        inputRecordCount,
        acceptedRecordCount,
        malformedRecordCount,
        code,
      });
    };

    const maximumRecords = operation === 'search'
      ? this.#policy.maximumSearchRecords
      : this.#policy.maximumDetailRecords;

    const promise = Promise.resolve()
      .then(() => {
        if (controller.signal.aborted) {
          throw controller.signal.reason ?? new GeneralSearchTransportErrorV11(
            'GENERAL_SEARCH_ABORTED',
            'İşlem iptal edildi.',
            operation,
            requestId,
            plan.identity.requestFingerprint,
            false,
          );
        }
        return this.#source.Query(query, returnGeometry, plan.control);
      })
      .then((raw) => {
        if (active.superseded || !this.#isCurrent(operation, requestId)) {
          throw new GeneralSearchTransportErrorV11(
            'GENERAL_SEARCH_SUPERSEDED',
            'Daha yeni bir istek bu sonucu geçersiz kıldı.',
            operation,
            requestId,
            plan.identity.requestFingerprint,
            false,
          );
        }
        if (controller.signal.aborted) {
          throw controller.signal.reason ?? new GeneralSearchTransportErrorV11(
            'GENERAL_SEARCH_ABORTED',
            'İşlem iptal edildi.',
            operation,
            requestId,
            plan.identity.requestFingerprint,
            false,
          );
        }

        const admitted = admitGeneralSearchServiceResultV11(raw, {
          operation,
          successType: this.#policy.successType,
          maximumRecords,
          maximumMessageLength: this.#policy.maximumMessageLength,
        });

        if (admitted.truncated) {
          throw new GeneralSearchTransportErrorV11(
            'GENERAL_SEARCH_RESPONSE_LIMIT',
            operation === 'search'
              ? 'Arama yanıtı güvenli kayıt sınırını aştı.'
              : 'Detay yanıtı beklenen kayıt sınırını aştı.',
            operation,
            requestId,
            plan.identity.requestFingerprint,
            true,
          );
        }
        if (admitted.malformedRecordCount > this.#policy.maximumMalformedRecords) {
          throw new GeneralSearchTransportErrorV11(
            'GENERAL_SEARCH_RESPONSE_INVALID',
            'Arama yanıtındaki bozuk kayıt sayısı güvenli sınırı aştı.',
            operation,
            requestId,
            plan.identity.requestFingerprint,
            true,
          );
        }
        if (admitted.type !== this.#policy.successType) {
          throw new GeneralSearchTransportErrorV11(
            'GENERAL_SEARCH_SERVICE_ERROR',
            retryableServiceMessage(admitted),
            operation,
            requestId,
            plan.identity.requestFingerprint,
            true,
          );
        }

        const integrity = auditGeneralSearchResponseIntegrityV11(admitted.data);
        if (!integrity.accepted) {
          throw new GeneralSearchTransportErrorV11(
            'GENERAL_SEARCH_RESPONSE_INVALID',
            `Genel arama yanıtı veri bütünlüğü bütçesini aştı: ${summarizeGeneralSearchIntegrityV11(integrity)}`,
            operation,
            requestId,
            plan.identity.requestFingerprint,
            true,
          );
        }

        const completedAt = this.#now();
        const envelope: GeneralSearchTransportEnvelopeV11 = Object.freeze({
          version: GENERAL_SEARCH_TRANSPORT_VERSION_V11,
          operation,
          requestId,
          requestFingerprint: plan.identity.requestFingerprint,
          records: admitted.data,
          message: admitted.message,
          inputRecordCount: admitted.inputRecordCount,
          acceptedRecordCount: admitted.acceptedRecordCount,
          malformedRecordCount: admitted.malformedRecordCount,
          elapsedMs: Math.max(0, completedAt - startedAt),
          stale: false,
        });
        rememberOnce(
          'success',
          admitted.inputRecordCount,
          admitted.acceptedRecordCount,
          admitted.malformedRecordCount,
          'OK',
        );
        return envelope;
      })
      .catch((error: unknown) => {
        const superseded = active.superseded || !this.#isCurrent(operation, requestId);
        const outcome = outcomeForError(error, superseded);
        rememberOnce(outcome, 0, 0, 0, codeForError(error));

        if (superseded && !(error instanceof GeneralSearchTransportErrorV11
          && error.code === 'GENERAL_SEARCH_SUPERSEDED')) {
          throw new GeneralSearchTransportErrorV11(
            'GENERAL_SEARCH_SUPERSEDED',
            'Daha yeni bir istek bu işlemi geçersiz kıldı.',
            operation,
            requestId,
            plan.identity.requestFingerprint,
            false,
          );
        }
        if (isAbortError(error) && !(error instanceof GeneralSearchTransportErrorV11)) {
          throw new GeneralSearchTransportErrorV11(
            'GENERAL_SEARCH_ABORTED',
            'İşlem iptal edildi.',
            operation,
            requestId,
            plan.identity.requestFingerprint,
            false,
          );
        }
        throw error;
      })
      .finally(() => {
        detachExternal();
        if (this.#active(operation)?.requestId === requestId) {
          this.#setActive(operation, null);
        }
      });

    return Object.freeze({
      operation,
      requestId,
      requestFingerprint: plan.identity.requestFingerprint,
      promise,
      cancel: (reason = 'İşlem kullanıcı tarafından iptal edildi.') => {
        if (!this.#isCurrent(operation, requestId)) return;
        this.#cancelActive(operation, false, reason);
      },
      isCurrent: () => this.#isCurrent(operation, requestId),
    });
  }

  startSearch(
    input: GeneralSearchSearchTaskInputV11,
  ): GeneralSearchTransportTaskV11 {
    const query = Object.freeze({ ...input.query });
    return this.#createTask('search', query, false, input.execution ?? {});
  }

  startDetail(
    input: GeneralSearchDetailTaskInputV11,
  ): GeneralSearchTransportTaskV11 {
    const objectId = typeof input.objectId === 'number'
      ? input.objectId
      : normalizeText(input.objectId).slice(0, 64);
    if (objectId === '') {
      throw new TypeError('Genel arama detay kaydı için objectId gereklidir.');
    }
    return this.#createTask(
      'detail',
      Object.freeze({ ObjectId: objectId }),
      true,
      input.execution ?? {},
    );
  }

  cancelSearch(reason = 'Arama isteği iptal edildi.'): boolean {
    return this.#cancelActive('search', false, reason);
  }

  cancelDetail(reason = 'Detay isteği iptal edildi.'): boolean {
    return this.#cancelActive('detail', false, reason);
  }

  cancelAll(reason = 'Genel arama işlemleri iptal edildi.'): number {
    let count = 0;
    if (this.#cancelActive('search', false, reason)) count += 1;
    if (this.#cancelActive('detail', false, reason)) count += 1;
    return count;
  }

  snapshot(): GeneralSearchTransportSnapshotV11 {
    return Object.freeze({
      version: GENERAL_SEARCH_TRANSPORT_VERSION_V11,
      disposed: this.#disposed,
      activeSearchRequestId: this.#activeSearch?.requestId ?? null,
      activeDetailRequestId: this.#activeDetail?.requestId ?? null,
      started: this.#counters.started,
      completed: this.#counters.completed,
      failed: this.#counters.failed,
      cancelled: this.#counters.cancelled,
      superseded: this.#counters.superseded,
      blocked: this.#counters.blocked,
      malformedRecords: this.#counters.malformedRecords,
      reporterFailures: this.#counters.reporterFailures,
      diagnostics: Object.freeze([...this.#diagnostics]),
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.cancelAll('Genel arama transport runtime kapatıldı.');
    this.#activeSearch = null;
    this.#activeDetail = null;
    this.#disposed = true;
  }
}

export const createGeneralSearchTransportRuntimeV11 = (
  source: GeneralSearchTransportSourceV11,
  options: GeneralSearchTransportRuntimeOptionsV11 = {},
): GeneralSearchTransportRuntimeV11 => new GeneralSearchTransportRuntimeV11(source, options);
