/**
 * Small in-memory TTL cache for public GET responses.
 *
 * The cache is deliberately bounded and process-local. It must not be used for
 * credentials, authorization decisions or other security-sensitive state.
 */

const now = () => Date.now();

export class RequestCache {
    constructor(options = {}) {
        this.ttlMs = Math.max(0, options.ttlMs ?? 30000);
        this.maxEntries = Math.max(1, options.maxEntries ?? 100);
        this.entries = new Map();
    }

    _isFresh(entry, at = now()) {
        return entry && entry.expiresAt > at;
    }

    _touch(key, entry) {
        this.entries.delete(key);
        this.entries.set(key, entry);
    }

    get(key) {
        const entry = this.entries.get(key);
        if (!this._isFresh(entry)) {
            if (entry) this.entries.delete(key);
            return undefined;
        }
        this._touch(key, entry);
        return entry.value;
    }

    set(key, value, ttlMs = this.ttlMs) {
        const ttl = Math.max(0, ttlMs);
        if (ttl === 0) return value;

        const entry = {
            value,
            createdAt: now(),
            expiresAt: now() + ttl
        };
        this.entries.set(key, entry);

        while (this.entries.size > this.maxEntries) {
            const oldestKey = this.entries.keys().next().value;
            this.entries.delete(oldestKey);
        }
        return value;
    }

    delete(key) {
        return this.entries.delete(key);
    }

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

    clear() {
        this.entries.clear();
    }

    size() {
        return this.entries.size;
    }
}

export const createRequestCache = (options) => new RequestCache(options);
