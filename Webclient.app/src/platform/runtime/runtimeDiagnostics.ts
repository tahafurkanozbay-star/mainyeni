export type RuntimeSeverity = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface RuntimeDiagnosticEvent {
  readonly id: number;
  readonly timestamp: number;
  readonly type: string;
  readonly severity: RuntimeSeverity;
  readonly message: string | null;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface RuntimeDiagnosticsSnapshot {
  readonly capacity: number;
  readonly size: number;
  readonly dropped: number;
  readonly nextId: number;
  readonly events: readonly RuntimeDiagnosticEvent[];
}

export interface RuntimeDiagnosticsOptions {
  readonly capacity?: number;
  readonly now?: () => number;
  readonly redactKeys?: readonly string[];
}

const DEFAULT_CAPACITY = 200;
const MAX_CAPACITY = 2000;
const MAX_OBJECT_KEYS = 80;
const MAX_ARRAY_ITEMS = 50;
const REDACTED = '[redacted]';
const DEFAULT_REDACT_KEYS = [
  'authorization',
  'cookie',
  'password',
  'token',
  'secret',
  'apikey',
  'api-key',
  'access_token',
  'refresh_token',
  'address',
  'coordinates',
  'coordinate',
  'latitude',
  'longitude',
  'search',
  'query',
  'searchterm',
  'searchtext',
  'email',
  'phone',
  'telephone',
] as const;

const SENSITIVE_KEY_FRAGMENT_PATTERN = /(authorization|cookie|password|secret|token|credential|apikey|connectionstring|sessionid)/i;
const ABSOLUTE_URL_PATTERN = /https?:\/\/[^\s<>"'`)\]]+/gi;
const AUTHORIZATION_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const SENSITIVE_QUERY_PATTERN = /([?&](?:access[_-]?token|refresh[_-]?token|token|api[_-]?key|key|password|secret|credential|authorization)=)[^&#\s]*/gi;

const normalizeCapacity = (value: number | undefined): number => {
  if (!Number.isFinite(value)) return DEFAULT_CAPACITY;
  return Math.min(MAX_CAPACITY, Math.max(10, Math.floor(value as number)));
};

const truncate = (value: string, maxLength: number): string => {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
};

const stripAbsoluteUrlQuery = (value: string): string => {
  try {
    const parsed = new URL(value);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '[invalid-url]';
  }
};

const stripRelativeUrlQuery = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed.startsWith('/') || (!trimmed.includes('?') && !trimmed.includes('#'))) return value;
  try {
    const parsed = new URL(trimmed, 'https://runtime.invalid');
    return parsed.pathname;
  } catch {
    return value;
  }
};

/**
 * Runtime diagnostics are local support data, not analytics. Any free-form text
 * can still contain a request URL or an authorization fragment, so text is
 * sanitized independently from object-key redaction before being retained.
 */
export const sanitizeRuntimeDiagnosticText = (
  value: unknown,
  maxLength = 800,
): string | null => {
  if (value === null || value === undefined) return null;

  let text: string;
  try {
    text = typeof value === 'string' ? value : String(value);
  } catch {
    return '[unprintable]';
  }

  text = stripRelativeUrlQuery(text)
    .replace(AUTHORIZATION_PATTERN, (_match, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(ABSOLUTE_URL_PATTERN, (url) => stripAbsoluteUrlQuery(url))
    .replace(SENSITIVE_QUERY_PATTERN, (_match, prefix: string) => `${prefix}${REDACTED}`);

  return truncate(text, maxLength);
};

const normalizeKey = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, '');

const isSensitiveKey = (key: string, redactKeys: Set<string>): boolean => {
  const lower = key.toLowerCase();
  if (redactKeys.has(lower)) return true;
  return SENSITIVE_KEY_FRAGMENT_PATTERN.test(normalizeKey(key));
};

const redactValue = (
  value: unknown,
  redactKeys: Set<string>,
  depth = 0,
): unknown => {
  if (depth > 4) return '[max-depth]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return sanitizeRuntimeDiagnosticText(value, 1200);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    const result: Record<string, unknown> = {
      name: sanitizeRuntimeDiagnosticText(value.name, 120),
      message: sanitizeRuntimeDiagnosticText(value.message, 800),
      stack: sanitizeRuntimeDiagnosticText(value.stack, 2000),
    };
    if ('cause' in value && value.cause !== undefined) {
      result.cause = redactValue(value.cause, redactKeys, depth + 1);
    }
    return result;
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => redactValue(item, redactKeys, depth + 1));
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_OBJECT_KEYS);
    for (const [key, item] of entries) {
      const sanitized = isSensitiveKey(key, redactKeys)
        ? REDACTED
        : redactValue(item, redactKeys, depth + 1);
      if (sanitized !== undefined) result[key] = sanitized;
    }
    return result;
  }
  return sanitizeRuntimeDiagnosticText(value);
};

export const sanitizeRuntimeDiagnosticValue = (
  value: unknown,
  redactKeys: readonly string[] = DEFAULT_REDACT_KEYS,
): unknown => redactValue(
  value,
  new Set(redactKeys.map((key) => key.toLowerCase())),
);

export class RuntimeDiagnostics {
  readonly #capacity: number;
  readonly #now: () => number;
  readonly #redactKeys: Set<string>;
  readonly #events: RuntimeDiagnosticEvent[] = [];
  #dropped = 0;
  #nextId = 1;

  constructor(options: RuntimeDiagnosticsOptions = {}) {
    this.#capacity = normalizeCapacity(options.capacity);
    this.#now = options.now ?? Date.now;
    this.#redactKeys = new Set(
      [...DEFAULT_REDACT_KEYS, ...(options.redactKeys ?? [])].map((key) => key.toLowerCase()),
    );
  }

  record(
    type: string,
    details: Record<string, unknown> = {},
    options: { severity?: RuntimeSeverity; message?: unknown } = {},
  ): RuntimeDiagnosticEvent {
    const event: RuntimeDiagnosticEvent = Object.freeze({
      id: this.#nextId++,
      timestamp: this.#now(),
      type: sanitizeRuntimeDiagnosticText(type, 120) ?? 'runtime.event',
      severity: options.severity ?? 'info',
      message: sanitizeRuntimeDiagnosticText(options.message),
      details: Object.freeze(
        (redactValue(details, this.#redactKeys) as Record<string, unknown>) ?? {},
      ),
    });

    if (this.#events.length >= this.#capacity) {
      this.#events.shift();
      this.#dropped += 1;
    }
    this.#events.push(event);
    return event;
  }

  captureError(
    error: unknown,
    context: Record<string, unknown> = {},
    severity: RuntimeSeverity = 'error',
  ): RuntimeDiagnosticEvent {
    const normalized = error instanceof Error
      ? error
      : new Error(sanitizeRuntimeDiagnosticText(error) ?? 'Unknown runtime error');

    return this.record('runtime.error', {
      ...context,
      error: normalized,
    }, {
      severity,
      message: normalized.message,
    });
  }

  snapshot(): RuntimeDiagnosticsSnapshot {
    return Object.freeze({
      capacity: this.#capacity,
      size: this.#events.length,
      dropped: this.#dropped,
      nextId: this.#nextId,
      events: Object.freeze([...this.#events]),
    });
  }

  clear(): void {
    this.#events.length = 0;
    this.#dropped = 0;
  }
}

export interface RuntimeObserverHandle {
  dispose(): void;
}

export const installBrowserRuntimeObservers = (
  diagnostics: RuntimeDiagnostics,
): RuntimeObserverHandle => {
  if (typeof window === 'undefined') return { dispose: () => undefined };

  const onError = (event: ErrorEvent): void => {
    diagnostics.captureError(event.error ?? event.message, {
      source: 'window.error',
      filename: event.filename || null,
      line: event.lineno || null,
      column: event.colno || null,
    }, 'fatal');
  };

  const onUnhandledRejection = (event: PromiseRejectionEvent): void => {
    diagnostics.captureError(event.reason, {
      source: 'window.unhandledrejection',
    }, 'error');
  };

  const onOnline = (): void => {
    diagnostics.record('network.connectivity', { online: true });
  };

  const onOffline = (): void => {
    diagnostics.record('network.connectivity', { online: false }, { severity: 'warn' });
  };

  const onVisibilityChange = (): void => {
    diagnostics.record('document.visibility', {
      state: typeof document === 'undefined' ? 'unknown' : document.visibilityState,
    }, { severity: 'debug' });
  };

  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onUnhandledRejection);
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibilityChange);

  const observers: PerformanceObserver[] = [];
  if (typeof PerformanceObserver !== 'undefined') {
    const observe = (type: string, handler: (entry: PerformanceEntry) => void): void => {
      try {
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) handler(entry);
        });
        observer.observe({ type, buffered: true });
        observers.push(observer);
      } catch {
        // Some browsers expose PerformanceObserver but not every entry type.
      }
    };

    observe('longtask', (entry) => {
      diagnostics.record('performance.longtask', {
        durationMs: Math.round(entry.duration),
        startTimeMs: Math.round(entry.startTime),
      }, { severity: entry.duration >= 250 ? 'warn' : 'info' });
    });

    observe('largest-contentful-paint', (entry) => {
      diagnostics.record('performance.lcp', {
        startTimeMs: Math.round(entry.startTime),
      });
    });
  }

  return {
    dispose(): void {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibilityChange);
      observers.forEach((observer) => observer.disconnect());
    },
  };
};

export const runtimeDiagnostics = new RuntimeDiagnostics();
