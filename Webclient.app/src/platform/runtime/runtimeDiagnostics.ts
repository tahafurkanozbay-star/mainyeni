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
] as const;

const normalizeCapacity = (value: number | undefined): number => {
  if (!Number.isFinite(value)) return DEFAULT_CAPACITY;
  return Math.min(MAX_CAPACITY, Math.max(10, Math.floor(value as number)));
};

const safeString = (value: unknown, maxLength = 800): string | null => {
  if (value === null || value === undefined) return null;
  let text: string;
  try {
    text = typeof value === 'string' ? value : String(value);
  } catch {
    return '[unprintable]';
  }
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}…`;
};

const redactValue = (
  value: unknown,
  redactKeys: Set<string>,
  depth = 0,
): unknown => {
  if (depth > 4) return '[max-depth]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return safeString(value, 1200);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: safeString(value.message),
      stack: safeString(value.stack, 2000),
    };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => redactValue(item, redactKeys, depth + 1));
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 80)) {
      result[key] = redactKeys.has(key.toLowerCase())
        ? '[redacted]'
        : redactValue(item, redactKeys, depth + 1);
    }
    return result;
  }
  return safeString(value);
};

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
      type: safeString(type, 120) ?? 'runtime.event',
      severity: options.severity ?? 'info',
      message: safeString(options.message),
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
      : new Error(safeString(error) ?? 'Unknown runtime error');

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

  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onUnhandledRejection);

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
      observers.forEach((observer) => observer.disconnect());
    },
  };
};

export const runtimeDiagnostics = new RuntimeDiagnostics();
