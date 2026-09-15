const DEFAULT_CAPACITY = 120;
const MAX_CAPACITY = 500;
const MAX_STRING_LENGTH = 160;
const MAX_METADATA_KEYS = 24;
const MAX_ARRAY_ITEMS = 24;

const SENSITIVE_KEY_PATTERN = /(authorization|cookie|password|secret|token|credential|apikey|api_key|connection|string)/i;
const URL_KEY_PATTERN = /(url|uri|href|endpoint)/i;

const clampInteger = (value, fallback, minimum, maximum) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
};

const truncate = (value, limit = MAX_STRING_LENGTH) => {
  const text = String(value);
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
};

const normalizePathLikeValue = (value) => {
  const text = truncate(value);

  try {
    if (/^https?:\/\//i.test(text)) {
      const parsed = new URL(text);
      return parsed.pathname || '/';
    }
  } catch (_error) {
    return '[invalid-url]';
  }

  const queryIndex = text.indexOf('?');
  const hashIndex = text.indexOf('#');
  const cutPoints = [queryIndex, hashIndex].filter((index) => index >= 0);
  if (!cutPoints.length) return text;
  return text.slice(0, Math.min(...cutPoints));
};

export const sanitizeDiagnosticValue = (key, value, depth = 0) => {
  if (SENSITIVE_KEY_PATTERN.test(String(key))) return '[redacted]';
  if (value === null || value === undefined) return value;
  if (depth > 3) return '[max-depth]';

  if (typeof value === 'string') {
    return URL_KEY_PATTERN.test(String(key))
      ? normalizePathLikeValue(value)
      : truncate(value);
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return truncate(value.toString());
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;

  if (value instanceof Error) {
    return {
      name: truncate(value.name || 'Error', 80),
      code: value.code ? truncate(value.code, 80) : undefined
    };
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item, index) => sanitizeDiagnosticValue(String(index), item, depth + 1));
  }

  if (typeof value === 'object') {
    const safeObject = {};
    Object.keys(value)
      .slice(0, MAX_METADATA_KEYS)
      .forEach((nestedKey) => {
        const safeValue = sanitizeDiagnosticValue(nestedKey, value[nestedKey], depth + 1);
        if (safeValue !== undefined) safeObject[nestedKey] = safeValue;
      });
    return safeObject;
  }

  return truncate(value);
};

export const sanitizeDiagnosticMetadata = (metadata = {}) => {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};

  const safe = {};
  Object.keys(metadata)
    .slice(0, MAX_METADATA_KEYS)
    .forEach((key) => {
      const value = sanitizeDiagnosticValue(key, metadata[key]);
      if (value !== undefined) safe[key] = value;
    });

  return safe;
};

const normalizeEventName = (eventName) => {
  const normalized = String(eventName || '').trim().toLowerCase();
  if (!normalized) return 'unknown';
  return truncate(normalized.replace(/[^a-z0-9._:-]+/g, '-'), 96);
};

const normalizeClock = (clock) => typeof clock === 'function' ? clock : () => Date.now();

const immutableEvent = (entry) => Object.freeze({
  id: entry.id,
  name: entry.name,
  timestamp: entry.timestamp,
  elapsedMs: entry.elapsedMs,
  metadata: Object.freeze(entry.metadata)
});

const toSnapshot = (events) => Object.freeze(events.map((event) => Object.freeze({
  ...event,
  metadata: Object.freeze({ ...event.metadata })
})));

export class BootstrapDiagnostics {
  constructor(options = {}) {
    this.capacity = clampInteger(options.capacity, DEFAULT_CAPACITY, 10, MAX_CAPACITY);
    this.clock = normalizeClock(options.clock);
    this.sessionStartedAt = this.clock();
    this.sequence = 0;
    this.events = [];
    this.counters = new Map();
    this.lastStage = null;
  }

  record(eventName, metadata = {}) {
    const timestamp = this.clock();
    const name = normalizeEventName(eventName);
    const safeMetadata = sanitizeDiagnosticMetadata(metadata);
    const event = immutableEvent({
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
    if (name === 'bootstrap.stage' && typeof safeMetadata.stage === 'string') {
      this.lastStage = safeMetadata.stage;
    }

    return event;
  }

  count(eventName) {
    return this.counters.get(normalizeEventName(eventName)) || 0;
  }

  latest(eventName) {
    if (!eventName) return this.events[this.events.length - 1] || null;
    const normalizedName = normalizeEventName(eventName);
    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      if (this.events[index].name === normalizedName) return this.events[index];
    }
    return null;
  }

  snapshot(options = {}) {
    const {
      eventName,
      limit = this.capacity,
      sinceId = 0
    } = options;
    const normalizedName = eventName ? normalizeEventName(eventName) : null;
    const normalizedLimit = clampInteger(limit, this.capacity, 1, this.capacity);

    const filtered = this.events.filter((event) =>
      event.id > sinceId && (!normalizedName || event.name === normalizedName));

    return toSnapshot(filtered.slice(Math.max(0, filtered.length - normalizedLimit)));
  }

  summary() {
    const counters = {};
    [...this.counters.keys()]
      .sort()
      .forEach((key) => {
        counters[key] = this.counters.get(key);
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

  clear() {
    this.events = [];
    this.counters.clear();
    this.lastStage = null;
    this.sequence = 0;
    this.sessionStartedAt = this.clock();
  }
}

export const createBootstrapDiagnostics = (options = {}) => new BootstrapDiagnostics(options);

export const createBootstrapDiagnosticBridge = (diagnostics, onEvent) => {
  if (!diagnostics || typeof diagnostics.record !== 'function') {
    throw new TypeError('diagnostics.record fonksiyonu gereklidir.');
  }

  if (typeof onEvent !== 'function') {
    return {
      record: (eventName, metadata) => diagnostics.record(eventName, metadata)
    };
  }

  return {
    record: (eventName, metadata) => {
      const event = diagnostics.record(eventName, metadata);
      onEvent(event);
      return event;
    }
  };
};

export const summarizeBootstrapDiagnostics = (diagnostics) => {
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
