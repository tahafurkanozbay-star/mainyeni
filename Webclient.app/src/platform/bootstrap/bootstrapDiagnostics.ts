const DEFAULT_CAPACITY = 120;
const MAX_CAPACITY = 500;
const MAX_STRING_LENGTH = 160;
const MAX_METADATA_KEYS = 24;
const MAX_ARRAY_ITEMS = 24;

const SENSITIVE_KEY_PATTERN = /(authorization|cookie|password|secret|token|credential|apikey|api_key|connection|string)/i;
const URL_KEY_PATTERN = /(url|uri|href|endpoint)/i;

export type DiagnosticPrimitive = string | number | boolean | null | undefined;
export type DiagnosticValue = DiagnosticPrimitive | readonly DiagnosticValue[] | Readonly<Record<string, DiagnosticValue>>;

export interface BootstrapDiagnosticEvent {
  readonly id: number;
  readonly name: string;
  readonly timestamp: number;
  readonly elapsedMs: number;
  readonly metadata: Readonly<Record<string, DiagnosticValue>>;
}

export interface BootstrapDiagnosticsOptions {
  readonly capacity?: number;
  readonly clock?: () => number;
}

export interface BootstrapDiagnosticSnapshotOptions {
  readonly eventName?: string;
  readonly limit?: number;
  readonly sinceId?: number;
}

export interface BootstrapDiagnosticSummary {
  readonly sessionStartedAt?: number;
  readonly eventCount: number;
  readonly totalRecorded: number;
  readonly droppedCount: number;
  readonly lastStage: string | null;
  readonly counters: Readonly<Record<string, number>>;
}

const clampInteger = (value: unknown, fallback: number, minimum: number, maximum: number): number => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
};

const truncate = (value: unknown, limit = MAX_STRING_LENGTH): string => {
  const text = String(value);
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
};

const normalizePathLikeValue = (value: unknown): string => {
  const text = truncate(value);
  try {
    if (/^https?:\/\//i.test(text)) {
      const parsed = new URL(text);
      return parsed.pathname || '/';
    }
  } catch {
    return '[invalid-url]';
  }

  const queryIndex = text.indexOf('?');
  const hashIndex = text.indexOf('#');
  const cutPoints = [queryIndex, hashIndex].filter((index) => index >= 0);
  if (!cutPoints.length) return text;
  return text.slice(0, Math.min(...cutPoints));
};

const errorCode = (error: Error): string | undefined => {
  const candidate = error as Error & { readonly code?: unknown };
  return candidate.code ? truncate(candidate.code, 80) : undefined;
};

export const sanitizeDiagnosticValue = (
  key: unknown,
  value: unknown,
  depth = 0,
): DiagnosticValue => {
  if (SENSITIVE_KEY_PATTERN.test(String(key))) return '[redacted]';
  if (value === null || value === undefined) return value;
  if (depth > 3) return '[max-depth]';

  if (typeof value === 'string') {
    return URL_KEY_PATTERN.test(String(key)) ? normalizePathLikeValue(value) : truncate(value);
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return truncate(value.toString());
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;

  if (value instanceof Error) {
    return Object.freeze({
      name: truncate(value.name || 'Error', 80),
      code: errorCode(value),
    });
  }

  if (Array.isArray(value)) {
    return Object.freeze(value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item, index) => sanitizeDiagnosticValue(String(index), item, depth + 1)));
  }

  if (typeof value === 'object') {
    const safeObject: Record<string, DiagnosticValue> = {};
    Object.keys(value)
      .slice(0, MAX_METADATA_KEYS)
      .forEach((nestedKey) => {
        const safeValue = sanitizeDiagnosticValue(
          nestedKey,
          (value as Record<string, unknown>)[nestedKey],
          depth + 1,
        );
        if (safeValue !== undefined) safeObject[nestedKey] = safeValue;
      });
    return Object.freeze(safeObject);
  }

  return truncate(value);
};

export const sanitizeDiagnosticMetadata = (
  metadata: unknown = {},
): Readonly<Record<string, DiagnosticValue>> => {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return Object.freeze({});
  const safe: Record<string, DiagnosticValue> = {};
  Object.keys(metadata)
    .slice(0, MAX_METADATA_KEYS)
    .forEach((key) => {
      const value = sanitizeDiagnosticValue(key, (metadata as Record<string, unknown>)[key]);
      if (value !== undefined) safe[key] = value;
    });
  return Object.freeze(safe);
};

const normalizeEventName = (eventName: unknown): string => {
  const normalized = String(eventName || '').trim().toLowerCase();
  if (!normalized) return 'unknown';
  return truncate(normalized.replace(/[^a-z0-9._:-]+/g, '-'), 96);
};

const normalizeClock = (clock: unknown): (() => number) =>
  typeof clock === 'function' ? clock as () => number : () => Date.now();

const immutableEvent = (entry: BootstrapDiagnosticEvent): BootstrapDiagnosticEvent => Object.freeze({
  id: entry.id,
  name: entry.name,
  timestamp: entry.timestamp,
  elapsedMs: entry.elapsedMs,
  metadata: Object.freeze({ ...entry.metadata }),
});

const toSnapshot = (events: readonly BootstrapDiagnosticEvent[]): readonly BootstrapDiagnosticEvent[] =>
  Object.freeze(events.map((event) => immutableEvent(event)));

export class BootstrapDiagnostics {
  readonly capacity: number;
  readonly clock: () => number;
  private sessionStartedAt: number;
  private sequence = 0;
  private events: BootstrapDiagnosticEvent[] = [];
  private readonly counters = new Map<string, number>();
  private lastStage: string | null = null;

  constructor(options: BootstrapDiagnosticsOptions = {}) {
    this.capacity = clampInteger(options.capacity, DEFAULT_CAPACITY, 10, MAX_CAPACITY);
    this.clock = normalizeClock(options.clock);
    this.sessionStartedAt = this.clock();
  }

  record(eventName: unknown, metadata: unknown = {}): BootstrapDiagnosticEvent {
    const timestamp = this.clock();
    const name = normalizeEventName(eventName);
    const safeMetadata = sanitizeDiagnosticMetadata(metadata);
    const event = immutableEvent({
      id: ++this.sequence,
      name,
      timestamp,
      elapsedMs: Math.max(0, timestamp - this.sessionStartedAt),
      metadata: safeMetadata,
    });

    this.events.push(event);
    if (this.events.length > this.capacity) this.events.splice(0, this.events.length - this.capacity);
    this.counters.set(name, (this.counters.get(name) || 0) + 1);
    if (name === 'bootstrap.stage' && typeof safeMetadata.stage === 'string') {
      this.lastStage = safeMetadata.stage;
    }
    return event;
  }

  count(eventName: unknown): number {
    return this.counters.get(normalizeEventName(eventName)) || 0;
  }

  latest(eventName?: unknown): BootstrapDiagnosticEvent | null {
    if (!eventName) return this.events[this.events.length - 1] || null;
    const normalizedName = normalizeEventName(eventName);
    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      const event = this.events[index];
      if (event?.name === normalizedName) return event;
    }
    return null;
  }

  snapshot(options: BootstrapDiagnosticSnapshotOptions = {}): readonly BootstrapDiagnosticEvent[] {
    const normalizedName = options.eventName ? normalizeEventName(options.eventName) : null;
    const normalizedLimit = clampInteger(options.limit, this.capacity, 1, this.capacity);
    const sinceId = Math.max(0, Number(options.sinceId) || 0);
    const filtered = this.events.filter((event) =>
      event.id > sinceId && (!normalizedName || event.name === normalizedName));
    return toSnapshot(filtered.slice(Math.max(0, filtered.length - normalizedLimit)));
  }

  summary(): BootstrapDiagnosticSummary {
    const counters: Record<string, number> = {};
    [...this.counters.keys()].sort().forEach((key) => { counters[key] = this.counters.get(key) || 0; });
    return Object.freeze({
      sessionStartedAt: this.sessionStartedAt,
      eventCount: this.events.length,
      totalRecorded: this.sequence,
      droppedCount: Math.max(0, this.sequence - this.events.length),
      lastStage: this.lastStage,
      counters: Object.freeze(counters),
    });
  }

  clear(): void {
    this.events = [];
    this.counters.clear();
    this.lastStage = null;
    this.sequence = 0;
    this.sessionStartedAt = this.clock();
  }
}

export const createBootstrapDiagnostics = (options: BootstrapDiagnosticsOptions = {}): BootstrapDiagnostics =>
  new BootstrapDiagnostics(options);

export const createBootstrapDiagnosticBridge = (
  diagnostics: { record: (eventName: unknown, metadata?: unknown) => BootstrapDiagnosticEvent },
  onEvent?: ((event: BootstrapDiagnosticEvent) => void) | null,
): { readonly record: (eventName: unknown, metadata?: unknown) => BootstrapDiagnosticEvent } => {
  if (!diagnostics || typeof diagnostics.record !== 'function') {
    throw new TypeError('diagnostics.record fonksiyonu gereklidir.');
  }
  if (typeof onEvent !== 'function') {
    return Object.freeze({ record: (eventName: unknown, metadata?: unknown) => diagnostics.record(eventName, metadata) });
  }
  return Object.freeze({
    record: (eventName: unknown, metadata?: unknown) => {
      const event = diagnostics.record(eventName, metadata);
      onEvent(event);
      return event;
    },
  });
};

export const summarizeBootstrapDiagnostics = (
  diagnostics: { summary?: () => BootstrapDiagnosticSummary } | null | undefined,
): BootstrapDiagnosticSummary => {
  if (!diagnostics || typeof diagnostics.summary !== 'function') {
    return Object.freeze({
      eventCount: 0,
      totalRecorded: 0,
      droppedCount: 0,
      lastStage: null,
      counters: Object.freeze({}),
    });
  }
  return diagnostics.summary();
};
