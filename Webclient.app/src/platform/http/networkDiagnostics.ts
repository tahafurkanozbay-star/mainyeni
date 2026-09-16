import { readErrorLike } from './contracts';
import type {
  DiagnosticEvent,
  DiagnosticSummary,
  DiagnosticsSnapshotOptions
} from './contracts';

const DEFAULT_CAPACITY = 200;
const MAX_CAPACITY = 1000;
const MAX_STRING_LENGTH = 240;
const MAX_ARRAY_ITEMS = 30;
const MAX_OBJECT_KEYS = 30;

const SENSITIVE_KEY_PATTERN =
  /(authorization|cookie|password|passwd|secret|token|credential|api[-_]?key|client[-_]?key|connectionstring)/i;
const URL_KEY_PATTERN = /(url|uri|href|endpoint|path)/i;

export const DURATION_BUCKETS = Object.freeze([
  'lt-100ms',
  '100-249ms',
  '250-499ms',
  '500-999ms',
  '1-2.9s',
  '3-9.9s',
  'gte-10s'
] as const);

export type DurationBucket = typeof DURATION_BUCKETS[number];
export interface SanitizedDiagnosticArray extends ReadonlyArray<SanitizedDiagnosticValue> {}
export interface SanitizedDiagnosticObject {
  readonly [key: string]: SanitizedDiagnosticValue;
}
export type SanitizedDiagnosticValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | SanitizedDiagnosticArray
  | SanitizedDiagnosticObject;

interface NetworkDiagnosticsOptions {
  capacity?: number;
  clock?: () => number;
}

interface DiagnosticBridge {
  record(eventName: string, metadata?: Record<string, unknown>): DiagnosticEvent | unknown;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const toInteger = (value: unknown, fallback: number): number => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const truncate = (value: unknown, maxLength = MAX_STRING_LENGTH): string => {
  const text = String(value ?? '');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
};

const sanitizeUrlLike = (value: unknown): string => {
  const text = truncate(value);
  if (!text) return '';

  try {
    const base = typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : 'http://localhost';
    const parsed = new URL(text, base);
    return parsed.pathname || '/';
  } catch (_error) {
    const queryIndex = text.indexOf('?');
    const hashIndex = text.indexOf('#');
    const cutPoints = [queryIndex, hashIndex].filter((index) => index >= 0);
    return cutPoints.length ? text.slice(0, Math.min(...cutPoints)) : text;
  }
};

export const sanitizeNetworkDiagnosticValue = (
  key: unknown,
  value: unknown,
  depth = 0
): SanitizedDiagnosticValue => {
  const normalizedKey = String(key || '');
  if (SENSITIVE_KEY_PATTERN.test(normalizedKey)) return '[redacted]';
  if (value === null || value === undefined) return value;
  if (depth > 4) return '[max-depth]';

  if (typeof value === 'string') {
    return URL_KEY_PATTERN.test(normalizedKey)
      ? sanitizeUrlLike(value)
      : truncate(value);
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return truncate(value.toString());
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;

  if (value instanceof Error) {
    const errorLike = readErrorLike(value);
    return Object.freeze({
      name: truncate(value.name || 'Error', 80),
      code: errorLike.code ? truncate(errorLike.code, 80) : undefined,
      status: Number.isFinite(Number(errorLike.status)) ? Number(errorLike.status) : undefined,
      retryable: errorLike.retryable === true
    });
  }

  if (Array.isArray(value)) {
    return Object.freeze(value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item, index) => sanitizeNetworkDiagnosticValue(String(index), item, depth + 1)));
  }

  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const result: Record<string, SanitizedDiagnosticValue> = {};
    Object.keys(source)
      .slice(0, MAX_OBJECT_KEYS)
      .forEach((nestedKey) => {
        const sanitized = sanitizeNetworkDiagnosticValue(
          nestedKey,
          source[nestedKey],
          depth + 1
        );
        if (sanitized !== undefined) result[nestedKey] = sanitized;
      });
    return Object.freeze(result);
  }

  return truncate(value);
};

export const sanitizeNetworkDiagnosticMetadata = (
  metadata: unknown = {}
): Readonly<Record<string, SanitizedDiagnosticValue>> => {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return Object.freeze({});

  const source = metadata as Record<string, unknown>;
  const result: Record<string, SanitizedDiagnosticValue> = {};
  Object.keys(source)
    .slice(0, MAX_OBJECT_KEYS)
    .forEach((key) => {
      const sanitized = sanitizeNetworkDiagnosticValue(key, source[key]);
      if (sanitized !== undefined) result[key] = sanitized;
    });
  return Object.freeze(result);
};

export const normalizeNetworkEventName = (value: unknown): string => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return truncate(normalized || 'network.unknown', 96);
};

const freezeEvent = (event: DiagnosticEvent): DiagnosticEvent => Object.freeze({
  id: event.id,
  name: event.name,
  timestamp: event.timestamp,
  elapsedMs: event.elapsedMs,
  metadata: Object.freeze({ ...event.metadata })
});

export const getDurationBucket = (durationMs: unknown): DurationBucket => {
  const value = Math.max(0, Number(durationMs) || 0);
  if (value < 100) return 'lt-100ms';
  if (value < 250) return '100-249ms';
  if (value < 500) return '250-499ms';
  if (value < 1000) return '500-999ms';
  if (value < 3000) return '1-2.9s';
  if (value < 10000) return '3-9.9s';
  return 'gte-10s';
};

export class NetworkDiagnostics {
  readonly capacity: number;
  private readonly clock: () => number;
  private startedAt: number;
  private sequence = 0;
  private events: DiagnosticEvent[] = [];
  private readonly counters = new Map<string, number>();
  private readonly statusCounters = new Map<string, number>();
  private readonly durationBuckets = new Map<DurationBucket, number>();

  constructor(options: NetworkDiagnosticsOptions = {}) {
    this.capacity = clamp(
      toInteger(options.capacity, DEFAULT_CAPACITY),
      10,
      MAX_CAPACITY
    );
    this.clock = typeof options.clock === 'function' ? options.clock : () => Date.now();
    this.startedAt = this.safeClock();
  }

  private safeClock(): number {
    const value = Number(this.clock());
    return Number.isFinite(value) ? value : Date.now();
  }

  record(eventName: string, metadata: Record<string, unknown> = {}): DiagnosticEvent {
    const timestamp = this.safeClock();
    const name = normalizeNetworkEventName(eventName);
    const safeMetadata = sanitizeNetworkDiagnosticMetadata(metadata) as Readonly<Record<string, unknown>>;
    const event = freezeEvent({
      id: ++this.sequence,
      name,
      timestamp,
      elapsedMs: Math.max(0, timestamp - this.startedAt),
      metadata: safeMetadata
    });

    this.events.push(event);
    if (this.events.length > this.capacity) {
      this.events.splice(0, this.events.length - this.capacity);
    }

    this.counters.set(name, (this.counters.get(name) || 0) + 1);

    const status = Number(safeMetadata.status);
    if (Number.isFinite(status) && status > 0) {
      const key = String(status);
      this.statusCounters.set(key, (this.statusCounters.get(key) || 0) + 1);
    }

    const duration = Number(safeMetadata.durationMs);
    if (Number.isFinite(duration) && duration >= 0) {
      const bucket = getDurationBucket(duration);
      this.durationBuckets.set(bucket, (this.durationBuckets.get(bucket) || 0) + 1);
    }

    return event;
  }

  count(eventName: string): number {
    return this.counters.get(normalizeNetworkEventName(eventName)) || 0;
  }

  latest(eventName?: string): DiagnosticEvent | null {
    const target = eventName ? normalizeNetworkEventName(eventName) : null;
    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      const candidate = this.events[index];
      if (candidate && (!target || candidate.name === target)) return candidate;
    }
    return null;
  }

  snapshot(options: DiagnosticsSnapshotOptions = {}): readonly DiagnosticEvent[] {
    const eventName = options.eventName
      ? normalizeNetworkEventName(options.eventName)
      : null;
    const sinceId = Math.max(0, toInteger(options.sinceId, 0));
    const limit = clamp(
      toInteger(options.limit, this.capacity),
      1,
      this.capacity
    );

    const filtered = this.events.filter((event) =>
      event.id > sinceId &&
      (!eventName || event.name === eventName));

    return Object.freeze(
      filtered
        .slice(Math.max(0, filtered.length - limit))
        .map((event) => freezeEvent(event))
    );
  }

  summary(): DiagnosticSummary {
    const counters: Record<string, number> = {};
    [...this.counters.keys()].sort().forEach((key) => {
      counters[key] = this.counters.get(key) || 0;
    });

    const statusCounters: Record<string, number> = {};
    [...this.statusCounters.keys()]
      .sort((left, right) => Number(left) - Number(right))
      .forEach((key) => {
        statusCounters[key] = this.statusCounters.get(key) || 0;
      });

    const durationBuckets: Record<string, number> = {};
    DURATION_BUCKETS.forEach((bucket) => {
      if (this.durationBuckets.has(bucket)) {
        durationBuckets[bucket] = this.durationBuckets.get(bucket) || 0;
      }
    });

    return Object.freeze({
      startedAt: this.startedAt,
      retainedEvents: this.events.length,
      totalRecorded: this.sequence,
      droppedEvents: Math.max(0, this.sequence - this.events.length),
      counters: Object.freeze(counters),
      statusCounters: Object.freeze(statusCounters),
      durationBuckets: Object.freeze(durationBuckets)
    });
  }

  clear(): void {
    this.events = [];
    this.counters.clear();
    this.statusCounters.clear();
    this.durationBuckets.clear();
    this.sequence = 0;
    this.startedAt = this.safeClock();
  }
}

export const createNetworkDiagnostics = (options: NetworkDiagnosticsOptions = {}): NetworkDiagnostics =>
  new NetworkDiagnostics(options);

export const createDiagnosticsBridge = (
  diagnostics: DiagnosticBridge,
  observer?: (event: DiagnosticEvent | unknown) => void
) => {
  if (!diagnostics || typeof diagnostics.record !== 'function') {
    throw new TypeError('diagnostics.record is required');
  }

  return Object.freeze({
    record: (eventName: string, metadata?: Record<string, unknown>) => {
      const event = diagnostics.record(eventName, metadata);
      observer?.(event);
      return event;
    }
  });
};

export const recordNetworkEvent = (
  diagnostics: DiagnosticBridge | null | undefined,
  eventName: string,
  metadata: Record<string, unknown> = {}
): DiagnosticEvent | unknown | null => {
  if (!diagnostics || typeof diagnostics.record !== 'function') return null;
  return diagnostics.record(eventName, metadata);
};

export const NetworkDiagnosticPolicy = Object.freeze({
  sanitizeNetworkDiagnosticValue,
  sanitizeNetworkDiagnosticMetadata,
  normalizeNetworkEventName,
  getDurationBucket,
  createNetworkDiagnostics,
  createDiagnosticsBridge,
  recordNetworkEvent
});
