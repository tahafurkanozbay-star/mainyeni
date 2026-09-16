const DEFAULT_CAPACITY = 300;
const DEFAULT_WINDOW_MS = 5 * 60 * 1000;

const DYNAMIC_SEGMENT_PATTERNS = [
  /^\d+$/,
  /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i,
  /^[0-9a-f]{16,}$/i,
  /^[A-Za-z0-9_-]{32,}$/
];

const asFiniteNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const sanitizeTelemetryPath = (value) => {
  let raw = String(value || '/').trim();
  const delimiter = raw.search(/[?#]/);
  if (delimiter >= 0) raw = raw.slice(0, delimiter);
  if (!raw.startsWith('/')) raw = `/${raw}`;

  const segments = raw.split('/').map((segment, index) => {
    if (index === 0 || !segment) return segment;
    if (DYNAMIC_SEGMENT_PATTERNS.some((pattern) => pattern.test(segment))) return '{id}';
    return segment.length > 64 ? '{value}' : segment;
  });

  const sanitized = segments.join('/').replace(/\/{2,}/g, '/');
  return sanitized.length > 192 ? `${sanitized.slice(0, 184)}/{…}` : sanitized;
};

const durationBucket = (durationMs) => {
  const value = Math.max(0, asFiniteNumber(durationMs, 0));
  if (value < 100) return 'lt-100ms';
  if (value < 300) return '100-300ms';
  if (value < 1000) return '300ms-1s';
  if (value < 3000) return '1-3s';
  if (value < 10000) return '3-10s';
  return 'gte-10s';
};

const statusClass = (status) => {
  const numeric = Number(status);
  if (!Number.isInteger(numeric) || numeric < 100 || numeric > 599) return 'none';
  return `${Math.floor(numeric / 100)}xx`;
};

const safeMethod = (method) => {
  const normalized = String(method || 'GET').trim().toUpperCase();
  return ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(normalized)
    ? normalized
    : 'OTHER';
};

const safeCode = (code) => {
  const normalized = String(code || 'UNKNOWN').trim().toUpperCase();
  return /^[A-Z0-9_-]{1,64}$/.test(normalized) ? normalized : 'UNKNOWN';
};

export class RequestTelemetry {
  constructor(options = {}) {
    this.capacity = Math.max(20, Math.floor(asFiniteNumber(options.capacity, DEFAULT_CAPACITY)));
    this.windowMs = Math.max(1000, asFiniteNumber(options.windowMs, DEFAULT_WINDOW_MS));
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.events = [];
    this.nextRequestId = 1;
    this.active = new Map();
  }

  start({ method, url } = {}) {
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    if (this.nextRequestId > Number.MAX_SAFE_INTEGER - 1) this.nextRequestId = 1;

    const startedAt = this.now();
    const context = Object.freeze({
      id,
      method: safeMethod(method),
      path: sanitizeTelemetryPath(url),
      startedAt
    });
    this.active.set(id, context);
    this.push({
      type: 'request-started',
      requestId: id,
      method: context.method,
      path: context.path,
      timestamp: startedAt
    });
    return context;
  }

  complete(context, details = {}) {
    if (!context || !this.active.has(context.id)) return null;
    this.active.delete(context.id);
    const timestamp = this.now();
    const durationMs = Math.max(0, timestamp - context.startedAt);
    const event = {
      type: 'request-completed',
      requestId: context.id,
      method: context.method,
      path: context.path,
      statusClass: statusClass(details.status),
      durationBucket: durationBucket(durationMs),
      durationMs,
      timestamp,
      attempts: Math.max(1, Number(details.attempts) || 1),
      cache: details.cache === true,
      deduped: details.deduped === true
    };
    this.push(event);
    return event;
  }

  fail(context, details = {}) {
    if (!context || !this.active.has(context.id)) return null;
    this.active.delete(context.id);
    const timestamp = this.now();
    const durationMs = Math.max(0, timestamp - context.startedAt);
    const event = {
      type: details.aborted ? 'request-aborted' : 'request-failed',
      requestId: context.id,
      method: context.method,
      path: context.path,
      statusClass: statusClass(details.status),
      errorCode: safeCode(details.errorCode),
      durationBucket: durationBucket(durationMs),
      durationMs,
      timestamp,
      attempts: Math.max(1, Number(details.attempts) || 1)
    };
    this.push(event);
    return event;
  }

  retry(context, details = {}) {
    if (!context || !this.active.has(context.id)) return null;
    const event = {
      type: 'request-retry',
      requestId: context.id,
      method: context.method,
      path: context.path,
      attempt: Math.max(1, Number(details.attempt) || 1),
      delayBucket: durationBucket(details.delayMs),
      statusClass: statusClass(details.status),
      timestamp: this.now()
    };
    this.push(event);
    return event;
  }

  cacheHit({ method, url } = {}) {
    this.push({
      type: 'cache-hit',
      method: safeMethod(method),
      path: sanitizeTelemetryPath(url),
      timestamp: this.now()
    });
  }

  dedupeHit({ method, url } = {}) {
    this.push({
      type: 'dedupe-hit',
      method: safeMethod(method),
      path: sanitizeTelemetryPath(url),
      timestamp: this.now()
    });
  }

  push(event) {
    this.events.push(Object.freeze({ ...event }));
    this.prune();
    while (this.events.length > this.capacity) this.events.shift();
  }

  prune() {
    const threshold = this.now() - this.windowMs;
    let removeCount = 0;
    while (removeCount < this.events.length && this.events[removeCount].timestamp < threshold) {
      removeCount += 1;
    }
    if (removeCount > 0) this.events.splice(0, removeCount);
  }

  snapshot() {
    this.prune();
    return this.events.map((event) => ({ ...event }));
  }

  summary() {
    this.prune();
    const completed = this.events.filter((event) => event.type === 'request-completed');
    const failed = this.events.filter((event) => event.type === 'request-failed');
    const aborted = this.events.filter((event) => event.type === 'request-aborted');
    const retries = this.events.filter((event) => event.type === 'request-retry');
    const cacheHits = this.events.filter((event) => event.type === 'cache-hit');
    const dedupeHits = this.events.filter((event) => event.type === 'dedupe-hit');
    const durationTotal = completed.reduce((total, event) => total + event.durationMs, 0);

    const byStatusClass = {};
    [...completed, ...failed].forEach((event) => {
      byStatusClass[event.statusClass] = (byStatusClass[event.statusClass] || 0) + 1;
    });

    const byPath = {};
    completed.forEach((event) => {
      if (!byPath[event.path]) {
        byPath[event.path] = { count: 0, totalDurationMs: 0, maxDurationMs: 0 };
      }
      const bucket = byPath[event.path];
      bucket.count += 1;
      bucket.totalDurationMs += event.durationMs;
      bucket.maxDurationMs = Math.max(bucket.maxDurationMs, event.durationMs);
    });

    Object.values(byPath).forEach((bucket) => {
      bucket.averageDurationMs = bucket.count
        ? Math.round((bucket.totalDurationMs / bucket.count) * 10) / 10
        : 0;
      delete bucket.totalDurationMs;
    });

    return Object.freeze({
      windowMs: this.windowMs,
      activeRequests: this.active.size,
      completedRequests: completed.length,
      failedRequests: failed.length,
      abortedRequests: aborted.length,
      retryCount: retries.length,
      cacheHits: cacheHits.length,
      dedupeHits: dedupeHits.length,
      averageDurationMs: completed.length
        ? Math.round((durationTotal / completed.length) * 10) / 10
        : 0,
      byStatusClass: Object.freeze({ ...byStatusClass }),
      byPath: Object.freeze(Object.fromEntries(
        Object.entries(byPath).map(([key, value]) => [key, Object.freeze({ ...value })])
      ))
    });
  }

  clear() {
    this.events = [];
    this.active.clear();
  }
}

export const requestTelemetry = new RequestTelemetry();
