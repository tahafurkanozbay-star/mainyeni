const STORAGE_PREFIX = "kr:v2:";
const MAX_SERIALIZED_BYTES = 512 * 1024;

const getStorage = () => {
    try {
        return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
    }
    catch {
        return null;
    }
};

const safeKey = (key) => {
    if (typeof key !== "string") {
        return null;
    }

    const normalized = key.trim();
    if (!normalized || normalized.length > 256) {
        return null;
    }

    for (let index = 0; index < normalized.length; index += 1) {
        const code = normalized.charCodeAt(index);
        if (code <= 31 || code === 127) {
            return null;
        }
    }

    return normalized;
};

const byteLength = (value) => {
    if (typeof TextEncoder !== "undefined") {
        return new TextEncoder().encode(value).byteLength;
    }

    return value.length * 2;
};

const parseEnvelope = (text) => {
    const payload = text.startsWith(STORAGE_PREFIX) ? text.slice(STORAGE_PREFIX.length) : text;

    try {
        const parsed = JSON.parse(payload);
        if (
            parsed !== null &&
            typeof parsed === "object" &&
            !Array.isArray(parsed) &&
            parsed.version === 2 &&
            Object.prototype.hasOwnProperty.call(parsed, "value")
        ) {
            return parsed.value;
        }

        return parsed;
    }
    catch {
        return null;
    }
};

const serializeEnvelope = (value) => {
    try {
        const serialized = STORAGE_PREFIX + JSON.stringify({
            version: 2,
            savedAt: Date.now(),
            value
        });

        return byteLength(serialized) <= MAX_SERIALIZED_BYTES ? serialized : null;
    }
    catch {
        return null;
    }
};

export const LocalStorageHelper = Object.freeze({
    Get: (_key) => {
        const storage = getStorage();
        const key = safeKey(_key);
        if (!storage || !key) {
            return null;
        }

        try {
            const raw = storage.getItem(key);
            if (raw === null || raw === "") {
                return null;
            }

            return parseEnvelope(raw);
        }
        catch {
            return null;
        }
    },

    Set: (_key, _obj) => {
        const storage = getStorage();
        const key = safeKey(_key);
        if (!storage || !key) {
            return;
        }

        const serialized = serializeEnvelope(_obj);
        if (!serialized) {
            return;
        }

        try {
            storage.setItem(key, serialized);
        }
        catch {
            // Storage may be disabled, sandboxed or quota constrained. Persistence is best effort.
        }
    }
});
