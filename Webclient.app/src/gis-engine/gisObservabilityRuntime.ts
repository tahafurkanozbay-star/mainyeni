import {
  average,
  clampNumber,
  createDeterministicFingerprint,
  createMonotonicSequence,
  finiteNumber,
  normalizeIdentifier,
  percentile,
  positiveInteger,
  stableSerialize,
  type GisDiagnosticEvent,
} from './runtimeContracts';

export interface GisObservabilitySettings {
  readonly capacity?: number;
  readonly maxFieldCount?: number;
  readonly maxFieldLength?: number;
  readonly maxTypeLength?: number;
  readonly maxTraceAgeMs?: number;
  readonly slowOperationMs?: number;
  readonly verySlowOperationMs?: number;
  readonly errorRateWarning?: number;
  readonly errorRateCritical?: number;
}

export interface GisObservabilityConfiguration {
  readonly now?: () => number;
  readonly settings?: GisObservabilitySettings;
  readonly onEvent?: (event: GisDiagnosticEvent) => void;
  readonly onListenerError?: (error: unknown, event: GisDiagnosticEvent) => void;
}

export interface GisDiagnosticInput {
  readonly type: string;
  readonly severity?: GisDiagnosticEvent['severity'];
  readonly serviceId?: string | null;
  readonly layerId?: string | null;
  readonly traceId?: string | null;
  readonly durationMs?: number | null;
  readonly fields?: Readonly<Record<string, unknown>>;
}

export interface GisTraceStart {
  readonly traceId?: string | null;
  readonly type: string;
  readonly serviceId?: string | null;
  readonly layerId?: string | null;
  readonly fields?: Readonly<Record<string, unknown>>;
}

export interface GisTraceCompletion {
  readonly ok?: boolean;
  readonly cancelled?: boolean;
  readonly errorCode?: string | null;
  readonly fields?: Readonly<Record<string, unknown>>;
  readonly severity?: GisDiagnosticEvent['severity'];
}

export interface GisTraceHandle {
  readonly traceId: string;
  readonly type: string;
  readonly startedAt: number;
  complete(result?: GisTraceCompletion): GisDiagnosticEvent;
  cancel(reason?: string): GisDiagnosticEvent;
}

export interface GisObservabilitySnapshot {
  readonly totalEvents: number;
  readonly retainedEvents: number;
  readonly droppedEvents: number;
  readonly activeTraces: number;
  readonly countsBySeverity: Readonly<Record<GisDiagnosticEvent['severity'], number>>;
  readonly countsByType: Readonly<Record<string, number>>;
  readonly duration: Readonly<{
    samples: number;
    averageMs: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    maxMs: number;
  }>;
  readonly recentErrorRate: number;
  readonly health: 'healthy' | 'warning' | 'critical';
  readonly fingerprint: string;
}

interface ActiveTrace {
  readonly traceId: string;
  readonly type: string;
  readonly startedAt: number;
  readonly serviceId: string | null;
  readonly layerId: string | null;
  readonly fields: Readonly<Record<string, unknown>>;
  completed: boolean;
}

const DEFAULT_SETTINGS: Required<GisObservabilitySettings> = Object.freeze({
  capacity: 500,
  maxFieldCount: 24,
  maxFieldLength: 240,
  maxTypeLength: 96,
  maxTraceAgeMs: 5 * 60 * 1000,
  slowOperationMs: 1500,
  verySlowOperationMs: 5000,
  errorRateWarning: 0.08,
  errorRateCritical: 0.2,
});

const SECRET_KEY_PATTERN = /(?:token|secret|password|passwd|authorization|cookie|api[-_]?key|credential|bearer|session)/i;
const SENSITIVE_LOCATION_KEY_PATTERN = /(?:latitude|longitude|\blat\b|\blon\b|\blng\b|coordinate|geometry|extent|address|query|where|objectids?)/i;
const URL_PATTERN = /\bhttps?:\/\/[^\s]+/gi;
const BEARER_PATTERN = /\bbearer\s+[a-z0-9._~+/-]+=*/gi;
const LONG_TOKEN_PATTERN = /\b[a-zA-Z0-9_-]{32,}\b/g;

const normalizeSettings = (input: GisObservabilitySettings = {}): Required<GisObservabilitySettings> => {
  const warning = clampNumber(input.errorRateWarning, 0.001, 0.9, DEFAULT_SETTINGS.errorRateWarning);
  return Object.freeze({
    capacity: positiveInteger(input.capacity, DEFAULT_SETTINGS.capacity, 10000),
    maxFieldCount: positiveInteger(input.maxFieldCount, DEFAULT_SETTINGS.maxFieldCount, 128),
    maxFieldLength: positiveInteger(input.maxFieldLength, DEFAULT_SETTINGS.maxFieldLength, 4096),
    maxTypeLength: positiveInteger(input.maxTypeLength, DEFAULT_SETTINGS.maxTypeLength, 256),
    maxTraceAgeMs: positiveInteger(input.maxTraceAgeMs, DEFAULT_SETTINGS.maxTraceAgeMs, 60 * 60 * 1000),
    slowOperationMs: positiveInteger(input.slowOperationMs, DEFAULT_SETTINGS.slowOperationMs, 120000),
    verySlowOperationMs: Math.max(
      positiveInteger(input.slowOperationMs, DEFAULT_SETTINGS.slowOperationMs, 120000),
      positiveInteger(input.verySlowOperationMs, DEFAULT_SETTINGS.verySlowOperationMs, 300000),
    ),
    errorRateWarning: warning,
    errorRateCritical: Math.max(
      warning,
      clampNumber(input.errorRateCritical, 0.001, 1, DEFAULT_SETTINGS.errorRateCritical),
    ),
  });
};

const normalizeType = (value: unknown, settings: Required<GisObservabilitySettings>): string => {
  const type = String(value ?? '').trim();
  if (!type) throw new TypeError('GIS diagnostic event type is required.');
  return type.slice(0, settings.maxTypeLength);
};

const normalizeSeverity = (value: unknown): GisDiagnosticEvent['severity'] => {
  switch (value) {
    case 'debug':
    case 'info':
    case 'warning':
    case 'error':
      return value;
    default:
      return 'info';
  }
};

const sanitizeString = (value: string, settings: Required<GisObservabilitySettings>): string => value
  .replace(BEARER_PATTERN, '[redacted-bearer]')
  .replace(URL_PATTERN, '[redacted-url]')
  .replace(LONG_TOKEN_PATTERN, '[redacted-token]')
  .slice(0, settings.maxFieldLength);

const sanitizeFieldValue = (
  key: string,
  value: unknown,
  settings: Required<GisObservabilitySettings>,
): string | number | boolean | null => {
  if (SECRET_KEY_PATTERN.test(key)) return '[redacted-secret]';
  if (SENSITIVE_LOCATION_KEY_PATTERN.test(key)) {
    if (value === null || value === undefined) return null;
    return `[redacted:${createDeterministicFingerprint('value', value)}]`;
  }
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return sanitizeString(value, settings);
  const serialized = stableSerialize(value);
  return sanitizeString(serialized, settings);
};

export const sanitizeDiagnosticFields = (
  fields: Readonly<Record<string, unknown>> | undefined,
  configuration: GisObservabilitySettings = {},
): Readonly<Record<string, string | number | boolean | null>> => {
  const settings = normalizeSettings(configuration);
  if (!fields || typeof fields !== 'object') return Object.freeze({});
  const entries = Object.entries(fields)
    .slice(0, settings.maxFieldCount)
    .map(([rawKey, value]) => {
      const key = String(rawKey).trim().slice(0, 96) || 'field';
      return [key, sanitizeFieldValue(key, value, settings)] as const;
    });
  return Object.freeze(Object.fromEntries(entries));
};

const mergeFields = (
  settings: Required<GisObservabilitySettings>,
  ...values: Array<Readonly<Record<string, unknown>> | undefined>
): Readonly<Record<string, string | number | boolean | null>> => sanitizeDiagnosticFields(
  Object.assign({}, ...values.filter(Boolean)),
  settings,
);

export const createGisObservabilityRuntime = (configuration: GisObservabilityConfiguration = {}) => {
  const clock = typeof configuration.now === 'function' ? configuration.now : () => Date.now();
  let settings = normalizeSettings(configuration.settings);
  const events: GisDiagnosticEvent[] = [];
  const listeners = new Set<(event: GisDiagnosticEvent) => void>();
  const activeTraces = new Map<string, ActiveTrace>();
  const nextSequence = createMonotonicSequence();
  const nextTraceSequence = createMonotonicSequence();
  let droppedEvents = 0;
  let totalEvents = 0;
  let destroyed = false;

  const notify = (event: GisDiagnosticEvent): void => {
    for (const listener of [...listeners]) {
      try { listener(event); } catch (error) { configuration.onListenerError?.(error, event); }
    }
    try { configuration.onEvent?.(event); } catch (error) { configuration.onListenerError?.(error, event); }
  };

  const retain = (event: GisDiagnosticEvent): void => {
    events.push(event);
    totalEvents += 1;
    while (events.length > settings.capacity) {
      events.shift();
      droppedEvents += 1;
    }
    notify(event);
  };

  const record = (input: GisDiagnosticInput): GisDiagnosticEvent => {
    if (destroyed) throw new Error('GIS observability runtime has been destroyed.');
    const event: GisDiagnosticEvent = Object.freeze({
      sequence: nextSequence(),
      timestamp: clock(),
      type: normalizeType(input.type, settings),
      severity: normalizeSeverity(input.severity),
      serviceId: input.serviceId == null ? null : normalizeIdentifier(input.serviceId, 'serviceId'),
      layerId: input.layerId == null ? null : normalizeIdentifier(input.layerId, 'layerId'),
      traceId: input.traceId == null ? null : normalizeIdentifier(input.traceId, 'traceId'),
      durationMs: input.durationMs == null ? null : Math.max(0, finiteNumber(input.durationMs, 0) ?? 0),
      fields: sanitizeDiagnosticFields(input.fields, settings),
    });
    retain(event);
    return event;
  };

  const inferCompletionSeverity = (durationMs: number, result: GisTraceCompletion): GisDiagnosticEvent['severity'] => {
    if (result.severity) return normalizeSeverity(result.severity);
    if (result.cancelled) return 'debug';
    if (result.ok === false) return 'error';
    if (durationMs >= settings.verySlowOperationMs) return 'warning';
    if (durationMs >= settings.slowOperationMs) return 'warning';
    return 'info';
  };

  const finishTrace = (
    trace: ActiveTrace,
    result: GisTraceCompletion = {},
    cancelled = false,
  ): GisDiagnosticEvent => {
    if (trace.completed) throw new Error(`GIS trace has already completed: ${trace.traceId}`);
    trace.completed = true;
    activeTraces.delete(trace.traceId);
    const durationMs = Math.max(0, clock() - trace.startedAt);
    const completion: GisTraceCompletion = cancelled ? { ...result, cancelled: true, ok: false } : result;
    return record({
      type: `${trace.type}.${cancelled ? 'cancelled' : completion.ok === false ? 'failed' : 'completed'}`,
      severity: inferCompletionSeverity(durationMs, completion),
      serviceId: trace.serviceId,
      layerId: trace.layerId,
      traceId: trace.traceId,
      durationMs,
      fields: mergeFields(settings, trace.fields, completion.fields, {
        ok: completion.ok !== false && !completion.cancelled,
        cancelled: completion.cancelled === true,
        errorCode: completion.errorCode ?? null,
      }),
    });
  };

  const startTrace = (input: GisTraceStart): GisTraceHandle => {
    if (destroyed) throw new Error('GIS observability runtime has been destroyed.');
    const traceId = input.traceId == null
      ? `gis-trace-${nextTraceSequence()}`
      : normalizeIdentifier(input.traceId, 'traceId');
    if (activeTraces.has(traceId)) throw new Error(`GIS trace id is already active: ${traceId}`);
    const trace: ActiveTrace = {
      traceId,
      type: normalizeType(input.type, settings),
      startedAt: clock(),
      serviceId: input.serviceId == null ? null : normalizeIdentifier(input.serviceId, 'serviceId'),
      layerId: input.layerId == null ? null : normalizeIdentifier(input.layerId, 'layerId'),
      fields: Object.freeze({ ...input.fields }),
      completed: false,
    };
    activeTraces.set(traceId, trace);
    record({
      type: `${trace.type}.started`,
      severity: 'debug',
      serviceId: trace.serviceId,
      layerId: trace.layerId,
      traceId,
      fields: trace.fields,
    });
    return Object.freeze({
      traceId,
      type: trace.type,
      startedAt: trace.startedAt,
      complete: (result: GisTraceCompletion = {}) => finishTrace(trace, result, false),
      cancel: (reason = 'cancelled') => finishTrace(trace, { cancelled: true, fields: { reason } }, true),
    });
  };

  const sweepStaleTraces = (): number => {
    if (destroyed) return 0;
    const now = clock();
    const stale = [...activeTraces.values()].filter((trace) => now - trace.startedAt >= settings.maxTraceAgeMs);
    for (const trace of stale) {
      finishTrace(trace, { ok: false, errorCode: 'TRACE_TIMEOUT', fields: { staleTrace: true } });
    }
    return stale.length;
  };

  const queryEvents = (options: {
    readonly type?: string | null;
    readonly severity?: GisDiagnosticEvent['severity'] | null;
    readonly serviceId?: string | null;
    readonly layerId?: string | null;
    readonly traceId?: string | null;
    readonly since?: number | null;
    readonly limit?: number | null;
  } = {}): readonly GisDiagnosticEvent[] => {
    const type = options.type == null ? null : String(options.type);
    const serviceId = options.serviceId == null ? null : String(options.serviceId);
    const layerId = options.layerId == null ? null : String(options.layerId);
    const traceId = options.traceId == null ? null : String(options.traceId);
    const since = finiteNumber(options.since);
    const limit = positiveInteger(options.limit, settings.capacity, settings.capacity);
    return Object.freeze(events
      .filter((event) => !type || event.type === type || event.type.startsWith(`${type}.`))
      .filter((event) => !options.severity || event.severity === options.severity)
      .filter((event) => !serviceId || event.serviceId === serviceId)
      .filter((event) => !layerId || event.layerId === layerId)
      .filter((event) => !traceId || event.traceId === traceId)
      .filter((event) => since === null || event.timestamp >= since)
      .slice(-limit));
  };

  const buildSnapshot = (): GisObservabilitySnapshot => {
    const durations = events
      .map((event) => event.durationMs)
      .filter((value): value is number => value !== null && value !== undefined && Number.isFinite(value));
    const countsBySeverity: Record<GisDiagnosticEvent['severity'], number> = { debug: 0, info: 0, warning: 0, error: 0 };
    const countsByType: Record<string, number> = {};
    for (const event of events) {
      countsBySeverity[event.severity] += 1;
      countsByType[event.type] = (countsByType[event.type] || 0) + 1;
    }
    const completionEvents = events.filter((event) => (
      event.type.endsWith('.completed') || event.type.endsWith('.failed') || event.type.endsWith('.cancelled')
    ));
    const errorEvents = completionEvents.filter((event) => event.type.endsWith('.failed'));
    const recentErrorRate = completionEvents.length ? errorEvents.length / completionEvents.length : 0;
    const health = recentErrorRate >= settings.errorRateCritical
      ? 'critical'
      : recentErrorRate >= settings.errorRateWarning
        ? 'warning'
        : 'healthy';
    const maxMs = durations.length ? Math.max(...durations) : 0;
    const fingerprint = createDeterministicFingerprint('gis-observability', {
      retainedEvents: events.length,
      droppedEvents,
      activeTraces: activeTraces.size,
      countsBySeverity,
      countsByType,
      durationP95: percentile(durations, 0.95),
      recentErrorRate: Math.round(recentErrorRate * 10000) / 10000,
    });
    return Object.freeze({
      totalEvents,
      retainedEvents: events.length,
      droppedEvents,
      activeTraces: activeTraces.size,
      countsBySeverity: Object.freeze(countsBySeverity),
      countsByType: Object.freeze(countsByType),
      duration: Object.freeze({
        samples: durations.length,
        averageMs: Math.round(average(durations) * 100) / 100,
        p50Ms: Math.round(percentile(durations, 0.5) * 100) / 100,
        p95Ms: Math.round(percentile(durations, 0.95) * 100) / 100,
        p99Ms: Math.round(percentile(durations, 0.99) * 100) / 100,
        maxMs: Math.round(maxMs * 100) / 100,
      }),
      recentErrorRate,
      health,
      fingerprint,
    });
  };

  const configure = (next: GisObservabilitySettings = {}): Required<GisObservabilitySettings> => {
    if (destroyed) throw new Error('GIS observability runtime has been destroyed.');
    settings = normalizeSettings({ ...settings, ...next });
    while (events.length > settings.capacity) {
      events.shift();
      droppedEvents += 1;
    }
    return settings;
  };

  const subscribe = (listener: (event: GisDiagnosticEvent) => void): (() => void) => {
    if (destroyed || typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  const clear = (): void => {
    events.length = 0;
    droppedEvents = 0;
    totalEvents = 0;
  };

  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    activeTraces.clear();
    events.length = 0;
    listeners.clear();
  };

  return Object.freeze({
    record,
    startTrace,
    sweepStaleTraces,
    queryEvents,
    getSnapshot: buildSnapshot,
    configure,
    subscribe,
    clear,
    destroy,
    isDestroyed: () => destroyed,
    getSettings: () => settings,
  });
};
