import { IsNull } from "./ObjectHelper";

const STORAGE_PREFIX = "kent-rehberi:v2:";

const getStorage = () => {
    try {
        return typeof window !== "undefined" ? window.localStorage : null;
    } catch {
        return null;
    }
};

export const LocalStorageHelper = {

    Get: (_key) => {
        const storage = getStorage();
        if (!storage) return null;
        try {
            const stored = storage.getItem(_key);
            if (IsNull(stored) || typeof stored !== "string") return null;
            if (!stored.startsWith(STORAGE_PREFIX)) return null;
            return JSON.parse(stored.slice(STORAGE_PREFIX.length));
        }
        catch {
            return null;
        }
    },

    Set: (_key, _obj) => {
        const storage = getStorage();
        if (!storage) return null;
        try {
            const json = JSON.stringify(_obj);
            storage.setItem(_key, STORAGE_PREFIX + json);
            return undefined;
        }
        catch {
            return null;
        }
    }
}
