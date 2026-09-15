const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_TTL_MS = 30000;

const now = () => Date.now();

const safeKey = (key) => (typeof key === 'string' ? key : JSON.stringify(key));

export class RequestCache {
  constructor({ ttlMs = DEFAULT_TTL_MS, maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
    this.ttlMs = Math.max(0, ttlMs);
    this.maxEntries = Math.max(1, maxEntries);
    this.entries = new Map();
    this.inFlight = new Map();
  }

  _pruneExpired(current = now()) {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= current) this.entries.delete(key);
    }
  }

  _enforceLimit() {
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      this.entries.delete(oldestKey);
    }
  }

  has(key) {
    const normalizedKey = safeKey(key);
    this._pruneExpired();
    return this.entries.has(normalizedKey);
  }

  get(key) {
    const normalizedKey = safeKey(key);
    const entry = this.entries.get(normalizedKey);
    if (!entry) return undefined;
    if (entry.expiresAt <= now()) {
      this.entries.delete(normalizedKey);
      return undefined;
    }
    this.entries.delete(normalizedKey);
    this.entries.set(normalizedKey, entry);
    return entry.value;
  }

  set(key, value, ttlMs = this.ttlMs) {
    if (ttlMs <= 0) return value;
    const normalizedKey = safeKey(key);
    this.entries.delete(normalizedKey);
    this.entries.set(normalizedKey, { value, expiresAt: now() + ttlMs });
    this._enforceLimit();
    return value;
  }

  delete(key) {
    return this.entries.delete(safeKey(key));
  }

  clear() {
    this.entries.clear();
  }

  async getOrCreate(key, factory, { ttlMs = this.ttlMs, force = false } = {}) {
    const normalizedKey = safeKey(key);
    if (!force) {
      const cached = this.get(normalizedKey);
      if (cached !== undefined) return cached;
    }

    if (this.inFlight.has(normalizedKey)) return this.inFlight.get(normalizedKey);

    const request = Promise.resolve()
      .then(factory)
      .then((value) => {
        this.set(normalizedKey, value, ttlMs);
        return value;
      })
      .finally(() => {
        this.inFlight.delete(normalizedKey);
      });

    this.inFlight.set(normalizedKey, request);
    return request;
  }

  invalidatePrefix(prefix) {
    const normalizedPrefix = safeKey(prefix);
    for (const key of this.entries.keys()) {
      if (key.startsWith(normalizedPrefix)) this.entries.delete(key);
    }
  }

  stats() {
    this._pruneExpired();
    return { entries: this.entries.size, inFlight: this.inFlight.size, maxEntries: this.maxEntries, ttlMs: this.ttlMs };
  }
}

export const createRequestCache = (options) => new RequestCache(options);
