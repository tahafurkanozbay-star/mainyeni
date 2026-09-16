export type DiagnosticScalar = string | number | boolean | null | undefined;
export type DiagnosticValue = DiagnosticScalar | readonly DiagnosticValue[] | Readonly<Record<string, DiagnosticValue>>;

export interface BootstrapDiagnosticEvent {
  readonly id: number;
  readonly name: string;
  readonly timestamp: number;
  readonly elapsedMs: number;
  readonly metadata: Readonly<Record<string, DiagnosticValue>>;
}

export interface BootstrapDiagnosticSummary {
  readonly sessionStartedAt?: number;
  readonly eventCount: number;
  readonly totalRecorded: number;
  readonly droppedCount: number;
  readonly lastStage: string | null;
  readonly counters: Readonly<Record<string, number>>;
}

export interface BootstrapDiagnosticsOptions {
  capacity?: number;
  clock?: () => number;
}

const DEFAULT_CAPACITY = 120;
const MAX_CAPACITY = 500;
const MAX_STRING_LENGTH = 160;
const MAX_METADATA_KEYS = 24;
const MAX_ARRAY_ITEMS = 24;
const SENSITIVE_KEY_PATTERN = /(authorization|cookie|password|secret|token|credential|apikey|api_key|connection|string)/i;
const URL_KEY_PATTERN = /(url|uri|href|endpoint)/i;

const clampInteger = (value: unknown, fallback: number, minimum: number, maximum: number): number => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
};

const truncate = (value: unknown, limit = MAX_STRING_LENGTH): string => {
  const text = String(value ?? '');
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
};

const normalizePathLikeValue = (value: unknown): string => {
  const text = truncate(value);
  try {
    const base = typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : 'https://localhost.invalid';
    const parsed = new URL(text, base);
    return parsed.pathname || '/';
  } catch (_error) {
    return '[invalid-url]';
  }
};

export const sanitizeDiagnosticValue = (
  key: string,
  value: unknown,
  depth = 0
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
    const candidate = value as Error & { code?: unknown };
    return Object.freeze({
      name: truncate(candidate.name || 'Error', 80),
      code: candidate.code ? truncate(candidate.code, 80) : undefined
    }) as Readonly<Record<string, DiagnosticValue>>;
  }

  if (Array.isArray(value)) {
    return Object.freeze(value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item, index) => sanitizeDiagnosticValue(String(index), item, depth + 1)));
  }

  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const safeObject: Record<string, DiagnosticValue> = {};
    Object.keys(source).slice(0, MAX_METADATA_KEYS).forEach((nestedKey) => {
      const safeValue = sanitizeDiagnosticValue(nestedKey, source[nestedKey], depth + 1);
      if (safeValue !== undefined) safeObject[nestedKey] = safeValue;
    });
    return Object.freeze(safeObject);
  }

  return truncate(value);
};

export const sanitizeDiagnosticMetadata = (metadata: unknown = {}): Readonly<Record<string, DiagnosticValue>> => {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return Object.freeze({});
  const source = metadata as Record<string, unknown>;
  const safe: Record<string, DiagnosticValue> = {};
  Object.keys(source).slice(0, MAX_METADATA_KEYS).forEach((key) => {
    const value = sanitizeDiagnosticValue(key, source[key]);
    if (value !== undefined) safe[key] = value;
  });
  return Object.freeze(safe);
};

const normalizeEventName = (eventName: unknown): string => {
  const normalized = String(eventName || '').trim().toLowerCase();
  if (!normalized) return 'unknown';
  return truncate(normalized.replace(/[^a-z0-9._:-]+/g, '-'), 96);
};

export class BootstrapDiagnostics {
  readonly capacity: number;
  private readonly clock: () => number;
  private sessionStartedAt: number;
  private sequence = 0;
  private events: BootstrapDiagnosticEvent[] = [];
  private readonly counters = new Map<string, number>();
  private lastStage: string | null = null;

  constructor(options: BootstrapDiagnosticsOptions = {}) {
    this.capacity = clampInteger(options.capacity, DEFAULT_CAPACITY, 10, MAX_CAPACITY);
    this.clock = typeof options.clock === 'function' ? options.clock : () => Date.now();
    this.sessionStartedAt = this.clock();
  }

  record(eventName: unknown, metadata: unknown = {}): BootstrapDiagnosticEvent {
    const timestamp = this.clock();
    const name = normalizeEventName(eventName);
    const safeMetadata = sanitizeDiagnosticMetadata(metadata);
    const event = Object.freeze({
      id: ++this.sequence,
      name,
      timestamp,
      elapsedMs: Math.max(0, timestamp - this.sessionStartedAt),
      metadata: safeMetadata
    });
    this.events.push(event);
    if (this.events.length > this.capacity) {
      this.events.splice(0, this.events.length - this.capacity);
    }
    this.counters.set(name, (this.counters.get(name) || 0) + 1);
    const stage = safeMetadata.stage;
    if (name === 'bootstrap.stage' && typeof stage === 'string') this.lastStage = stage;
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

  snapshot(options: { eventName?: string; limit?: number; sinceId?: number } = {}): readonly BootstrapDiagnosticEvent[] {
    const normalizedName = options.eventName ? normalizeEventName(options.eventName) : null;
    const normalizedLimit = clampInteger(options.limit, this.capacity, 1, this.capacity);
    const sinceId = Math.max(0, Number(options.sinceId) || 0);
    const filtered = this.events.filter((event) =>
      event.id > sinceId && (!normalizedName || event.name === normalizedName));
    return Object.freeze(filtered.slice(Math.max(0, filtered.length - normalizedLimit)));
  }

  summary(): BootstrapDiagnosticSummary {
    const counters: Record<string, number> = {};
    Array.from(this.counters.keys()).sort().forEach((key) => {
      counters[key] = this.counters.get(key) || 0;
    });
    return Object.freeze({
      sessionStartedAt: this.sessionStartedAt,
      eventCount: this.events.length,
      totalRecorded: this.sequence,
      droppedCount: Math.max(0, this.sequence - this.events.length),
      lastStage: this.lastStage,
      counters: Object.freeze(counters)
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
  diagnostics: Pick<BootstrapDiagnostics, 'record'>,
  onEvent?: (event: BootstrapDiagnosticEvent) => void
) => {
  if (!diagnostics || typeof diagnostics.record !== 'function') {
    throw new TypeError('diagnostics.record fonksiyonu gereklidir.');
  }
  return Object.freeze({
    record: (eventName: unknown, metadata?: unknown) => {
      const event = diagnostics.record(eventName, metadata);
      if (typeof onEvent === 'function') onEvent(event);
      return event;
    }
  });
};

export const summarizeBootstrapDiagnostics = (
  diagnostics?: Pick<BootstrapDiagnostics, 'summary'> | null
): BootstrapDiagnosticSummary => {
  if (!diagnostics || typeof diagnostics.summary !== 'function') {
    return Object.freeze({
      eventCount: 0,
      totalRecorded: 0,
      droppedCount: 0,
      lastStage: null,
      counters: Object.freeze({})
    });
  }
  return diagnostics.summary();
};
