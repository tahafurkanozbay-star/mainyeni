const isBrowser = () => typeof window !== 'undefined';

const canUseStorage = (storage) => {
  if (!storage) return false;
  try {
    const probe = '__kent_rehberi_storage_probe__';
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return true;
  } catch (error) {
    return false;
  }
};

const createMemoryStorage = () => {
  const values = new Map();
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(String(key), String(value)),
    removeItem: (key) => values.delete(String(key)),
    clear: () => values.clear(),
  };
};

export const createSafeStorage = (type = 'session') => {
  if (!isBrowser()) return createMemoryStorage();
  const candidate = type === 'local' ? window.localStorage : window.sessionStorage;
  return canUseStorage(candidate) ? candidate : createMemoryStorage();
};

const ALLOWED_KEY = /^[a-zA-Z0-9._:-]{1,120}$/;

export class SafeStorage {
  constructor({ type = 'session', prefix = 'kent-rehberi' } = {}) {
    this.storage = createSafeStorage(type);
    this.prefix = String(prefix).replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 40);
  }

  key(rawKey) {
    const normalized = String(rawKey || '').trim();
    if (!ALLOWED_KEY.test(normalized)) throw new Error('Invalid storage key');
    return `${this.prefix}:${normalized}`;
  }

  get(key, fallback = null) {
    try {
      const value = this.storage.getItem(this.key(key));
      return value === null ? fallback : JSON.parse(value);
    } catch (error) {
      return fallback;
    }
  }

  set(key, value) {
    const serialized = JSON.stringify(value);
    if (serialized.length > 100000) throw new Error('Storage value exceeds the supported limit');
    try {
      this.storage.setItem(this.key(key), serialized);
      return true;
    } catch (error) {
      return false;
    }
  }

  remove(key) {
    try {
      this.storage.removeItem(this.key(key));
    } catch (error) {
      // Storage failures must not break the application.
    }
  }

  clear() {
    const prefix = `${this.prefix}:`;
    try {
      const keys = [];
      for (let index = 0; index < this.storage.length; index += 1) {
        const key = this.storage.key(index);
        if (key && key.startsWith(prefix)) keys.push(key);
      }
      keys.forEach((key) => this.storage.removeItem(key));
    } catch (error) {
      // Storage failures must not break the application.
    }
  }
}

export const transientStorage = new SafeStorage({ type: 'session' });

/**
 * Deliberately do not expose a generic token storage helper. Authentication
 * tokens should prefer secure, HttpOnly, SameSite cookies managed by the server.
 */
export const storagePolicy = Object.freeze({
  secretsAllowed: false,
  authTokenClientStorage: false,
  recommendedAuthTransport: 'HttpOnly; Secure; SameSite cookie',
  maxValueBytes: 100000,
});
