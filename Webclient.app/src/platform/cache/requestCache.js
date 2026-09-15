/** Bounded in-memory TTL cache for non-sensitive public GET responses. */

export class RequestCache {
  constructor(options = {}) {
    this.ttlMs = Math.max(0, options.ttlMs ?? 30000);
    this.maxEntries = Math.max(1, options.maxEntries ?? 100);
    this.entries = new Map();
  }

  _touch(key, entry) {
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry || entry.expiresAt <= Date.now()) {
      if (entry) this.entries.delete(key);
      return undefined;
    }
    this._touch(key, entry);
    return entry.value;
  }

  set(key, value, ttlMs = this.ttlMs) {
    const ttl = Math.max(0, ttlMs);
    if (ttl === 0) return value;
    this.entries.set(key, { value, createdAt: Date.now(), expiresAt: Date.now() + ttl });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      this.entries.delete(oldest);
    }
    return value;
  }

  delete(key) { return this.entries.delete(key); }

  invalidatePrefix(prefix) {
    let removed = 0;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  clear() { this.entries.clear(); }
  size() { return this.entries.size; }
}

export const createRequestCache = (options) => new RequestCache(options);
