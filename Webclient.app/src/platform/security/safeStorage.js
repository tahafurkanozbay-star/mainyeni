const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const blockedKeys = /token|secret|password|authorization|cookie|api[_-]?key|credential/i;

const storageAvailable = (storage) => {
    try {
        const probe = '__kent_rehberi_storage_probe__';
        storage.setItem(probe, '1');
        storage.removeItem(probe);
        return true;
    } catch (error) {
        return false;
    }
};

export const safeStorage = {
    isSafeKey: (key) => typeof key === 'string' && !blockedKeys.test(key),
    set(storage, key, value, maxAgeMs = DEFAULT_MAX_AGE_MS) {
        if (!storage || !safeStorage.isSafeKey(key) || !storageAvailable(storage)) return false;
        try {
            storage.setItem(key, JSON.stringify({ value, expiresAt: Date.now() + Math.max(0, maxAgeMs) }));
            return true;
        } catch (error) { return false; }
    },
    get(storage, key) {
        if (!storage || !safeStorage.isSafeKey(key) || !storageAvailable(storage)) return undefined;
        try {
            const raw = storage.getItem(key);
            if (!raw) return undefined;
            const parsed = JSON.parse(raw);
            if (parsed?.expiresAt && parsed.expiresAt <= Date.now()) {
                storage.removeItem(key);
                return undefined;
            }
            return parsed?.value;
        } catch (error) { return undefined; }
    },
    remove(storage, key) {
        if (!storage || !safeStorage.isSafeKey(key)) return false;
        try { storage.removeItem(key); return true; } catch (error) { return false; }
    }
};
