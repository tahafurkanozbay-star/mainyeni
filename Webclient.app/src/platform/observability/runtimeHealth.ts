export type RuntimeHealthStatus = 'healthy' | 'degraded' | 'unhealthy';
export type RuntimeHealthSeverity = 'info' | 'warning' | 'critical';

export interface RuntimeHealthEvent {
  readonly id: number;
  readonly timestamp: number;
  readonly domain: string;
  readonly severity: RuntimeHealthSeverity;
  readonly code: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface RuntimeHealthSnapshot {
  readonly status: RuntimeHealthStatus;
  readonly eventCount: number;
  readonly warningCount: number;
  readonly criticalCount: number;
  readonly droppedCount: number;
  readonly domains: Readonly<Record<string, number>>;
  readonly latest: readonly RuntimeHealthEvent[];
}

export interface RuntimeHealthOptions {
  capacity?: number;
  clock?: () => number;
}

const SENSITIVE_PATTERN = /(authorization|cookie|password|secret|token|credential|api[-_]?key|connection|string)/i;
const URL_PATTERN = /(url|uri|href|endpoint)/i;
const MAX_STRING = 160;
const MAX_KEYS = 20;
const MAX_ARRAY = 20;

const safeInteger = (value: unknown, fallback: number, min: number, max: number): number => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
};

const truncate = (value: unknown, limit = MAX_STRING): string => {
  const text = String(value ?? '');
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
};

const safePath = (value: unknown): string => {
  const text = truncate(value);
  try {
    const base = typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : 'https://localhost.invalid';
    const parsed = new URL(text, base);
    return parsed.pathname || '/';
  } catch (_error) {
    return '[invalid-path]';
  }
};

const sanitize = (key: string, value: unknown, depth = 0): unknown => {
  if (SENSITIVE_PATTERN.test(key)) return '[redacted]';
  if (value === null || value === undefined) return value;
  if (depth >= 3) return '[max-depth]';

  if (typeof value === 'string') return URL_PATTERN.test(key) ? safePath(value) : truncate(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return truncate(value.toString());
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;

  if (value instanceof Error) {
    const candidate = value as Error & { code?: unknown };
    return Object.freeze({
      name: truncate(candidate.name || 'Error', 80),
      code: candidate.code ? truncate(candidate.code, 80) : undefined
    });
  }

  if (Array.isArray(value)) {
    return Object.freeze(value.slice(0, MAX_ARRAY).map((item, index) => sanitize(String(index), item, depth + 1)));
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    Object.keys(record).slice(0, MAX_KEYS).forEach((nestedKey) => {
      const safe = sanitize(nestedKey, record[nestedKey], depth + 1);
      if (safe !== undefined) result[nestedKey] = safe;
    });
    return Object.freeze(result);
  }

  return truncate(value);
};

const sanitizeMetadata = (metadata: unknown): Readonly<Record<string, unknown>> => {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return Object.freeze({});
  const source = metadata as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  Object.keys(source).slice(0, MAX_KEYS).forEach((key) => {
    const value = sanitize(key, source[key]);
    if (value !== undefined) result[key] = value;
  });
  return Object.freeze(result);
};

const normalizeIdentifier = (value: unknown, fallback: string): string => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, '-')
    .slice(0, 96);
  return normalized || fallback;
};

const normalizeSeverity = (value: unknown): RuntimeHealthSeverity => {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'critical') return 'critical';
  if (normalized === 'warning' || normalized === 'warn') return 'warning';
  return 'info';
};

export class RuntimeHealthMonitor {
  private readonly capacity: number;
  private readonly clock: () => number;
  private events: RuntimeHealthEvent[] = [];
  private sequence = 0;
  private totalRecorded = 0;

  constructor(options: RuntimeHealthOptions = {}) {
    this.capacity = safeInteger(options.capacity, 200, 20, 1000);
    this.clock = typeof options.clock === 'function' ? options.clock : () => Date.now();
  }

  record(
    domain: string,
    code: string,
    severity: RuntimeHealthSeverity = 'info',
    metadata: unknown = {}
  ): RuntimeHealthEvent {
    const event = Object.freeze({
      id: ++this.sequence,
      timestamp: this.clock(),
      domain: normalizeIdentifier(domain, 'runtime'),
      severity: normalizeSeverity(severity),
      code: normalizeIdentifier(code, 'unknown'),
      metadata: sanitizeMetadata(metadata)
    });
    this.events.push(event);
    this.totalRecorded += 1;
    if (this.events.length > this.capacity) {
      this.events.splice(0, this.events.length - this.capacity);
    }
    return event;
  }

  info(domain: string, code: string, metadata: unknown = {}): RuntimeHealthEvent {
    return this.record(domain, code, 'info', metadata);
  }

  warn(domain: string, code: string, metadata: unknown = {}): RuntimeHealthEvent {
    return this.record(domain, code, 'warning', metadata);
  }

  critical(domain: string, code: string, metadata: unknown = {}): RuntimeHealthEvent {
    return this.record(domain, code, 'critical', metadata);
  }

  clear(): void {
    this.events = [];
    this.sequence = 0;
    this.totalRecorded = 0;
  }

  snapshot(options: { limit?: number; domain?: string; since?: number } = {}): RuntimeHealthSnapshot {
    const domain = options.domain ? normalizeIdentifier(options.domain, 'runtime') : null;
    const since = Number.isFinite(Number(options.since)) ? Number(options.since) : 0;
    const limit = safeInteger(options.limit, 30, 1, this.capacity);
    const filtered = this.events.filter((event) =>
      event.timestamp >= since && (!domain || event.domain === domain));
    const latest = filtered.slice(Math.max(0, filtered.length - limit));
    const warningCount = this.events.filter((event) => event.severity === 'warning').length;
    const criticalCount = this.events.filter((event) => event.severity === 'critical').length;
    const domains: Record<string, number> = {};
    this.events.forEach((event) => {
      domains[event.domain] = (domains[event.domain] || 0) + 1;
    });

    const status: RuntimeHealthStatus = criticalCount > 0
      ? 'unhealthy'
      : warningCount > 0
        ? 'degraded'
        : 'healthy';

    return Object.freeze({
      status,
      eventCount: this.events.length,
      warningCount,
      criticalCount,
      droppedCount: Math.max(0, this.totalRecorded - this.events.length),
      domains: Object.freeze(domains),
      latest: Object.freeze(latest.map((event) => Object.freeze({ ...event })))
    });
  }

  count(domain?: string, severity?: RuntimeHealthSeverity): number {
    const normalizedDomain = domain ? normalizeIdentifier(domain, 'runtime') : null;
    const normalizedSeverity = severity ? normalizeSeverity(severity) : null;
    return this.events.filter((event) =>
      (!normalizedDomain || event.domain === normalizedDomain)
      && (!normalizedSeverity || event.severity === normalizedSeverity)).length;
  }
}

export const createRuntimeHealthMonitor = (options: RuntimeHealthOptions = {}): RuntimeHealthMonitor =>
  new RuntimeHealthMonitor(options);

export const runtimeHealth = createRuntimeHealthMonitor();

export const healthStatusFrom = (
  input: { critical?: number; warnings?: number; failed?: boolean } = {}
): RuntimeHealthStatus => {
  if (input.failed || (input.critical || 0) > 0) return 'unhealthy';
  if ((input.warnings || 0) > 0) return 'degraded';
  return 'healthy';
};
