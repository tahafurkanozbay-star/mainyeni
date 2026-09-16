import {
    normalizeText
} from "./DataIntegrityHelper";

export const DEFAULT_DATASET_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_MAX_DATASETS = 12;
export const DEFAULT_MAX_RECORDS = 100000;
export const MAX_DATASET_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_DATASETS = 128;
export const MAX_DATASET_RECORDS = 1000000;

const asArray = value => Array.isArray(value) ? value : [];
const isPromiseLike = value => value && typeof value.then === "function";

const boundedPositiveInteger = (value, fallback, maximum) => {
    if (value === undefined || value === null || value === "") return fallback;
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || !Number.isInteger(numeric) || numeric <= 0) return fallback;
    return Math.min(maximum, numeric);
};

export const createSearchAbortError = (message = "Search dataset operation aborted") => {
    const error = new Error(message);
    error.name = "AbortError";
    return error;
};

export const throwIfDatasetAborted = signal => {
    if (signal?.aborted) throw createSearchAbortError();
};

export const normalizeDatasetName = value => normalizeText(value)
    .toLocaleLowerCase("tr-TR")
    .replace(/[^a-z0-9ğüşöçı_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);

export const normalizeDatasetOptions = options => ({
    ttlMs: boundedPositiveInteger(options?.ttlMs, DEFAULT_DATASET_TTL_MS, MAX_DATASET_TTL_MS),
    maxDatasets: boundedPositiveInteger(options?.maxDatasets, DEFAULT_MAX_DATASETS, MAX_DATASETS),
    maxRecords: boundedPositiveInteger(options?.maxRecords, DEFAULT_MAX_RECORDS, MAX_DATASET_RECORDS),
    rejectOversized: options?.rejectOversized !== false,
    freezeSnapshots: options?.freezeSnapshots !== false
});

const normalizeScalarForFingerprint = value => {
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    if (typeof value === "number") return Number.isFinite(value) ? String(value) : "invalid-number";
    if (typeof value === "boolean") return value ? "true" : "false";
    if (typeof value === "string") return value;
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : "invalid-date";
    return null;
};

export const stableSerializeForFingerprint = (value, seen = new WeakSet()) => {
    const scalar = normalizeScalarForFingerprint(value);
    if (scalar !== null) return JSON.stringify(scalar);
    if (typeof value !== "object" || value === null) return JSON.stringify(String(value));
    if (seen.has(value)) return '"[Circular]"';
    seen.add(value);
    try {
        if (Array.isArray(value)) {
            return `[${value.map(item => stableSerializeForFingerprint(item, seen)).join(",")}]`;
        }
        const keys = Object.keys(value).sort((left, right) => left.localeCompare(right));
        return `{${keys.map(key => `${JSON.stringify(key)}:${stableSerializeForFingerprint(value[key], seen)}`).join(",")}}`;
    } finally {
        seen.delete(value);
    }
};

export const hashSearchDataset = value => {
    const input = stableSerializeForFingerprint(value);
    let hash = 2166136261;
    for (let index = 0; index < input.length; index += 1) {
        hash ^= input.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
};

export const createDatasetFingerprint = (records, metadata = {}) => hashSearchDataset({
    count: asArray(records).length,
    metadata,
    records: asArray(records)
});

export const normalizeDatasetRecords = (records, options = {}) => {
    const normalizedOptions = normalizeDatasetOptions(options);
    const input = asArray(records);
    if (normalizedOptions.rejectOversized && input.length > normalizedOptions.maxRecords) {
        const error = new RangeError(`Dataset contains ${input.length} records; maximum is ${normalizedOptions.maxRecords}`);
        error.code = "DATASET_RECORD_LIMIT";
        throw error;
    }
    return input.slice(0, normalizedOptions.maxRecords);
};

const freezeSnapshot = (snapshot, enabled) => {
    if (!enabled) return snapshot;
    Object.freeze(snapshot.records);
    Object.freeze(snapshot.metadata);
    return Object.freeze(snapshot);
};

export const createDatasetSnapshot = ({
    name,
    records,
    revision = 1,
    metadata = {},
    fingerprint,
    createdAt,
    updatedAt,
    expiresAt,
    stale = false
}, options = {}) => {
    const normalizedOptions = normalizeDatasetOptions(options);
    const normalizedRecords = normalizeDatasetRecords(records, normalizedOptions);
    const safeMetadata = metadata && typeof metadata === "object" && !Array.isArray(metadata)
        ? { ...metadata }
        : {};
    const safeRevision = boundedPositiveInteger(revision, 1, Number.MAX_SAFE_INTEGER);
    return freezeSnapshot({
        name: normalizeDatasetName(name),
        revision: safeRevision,
        fingerprint: fingerprint || createDatasetFingerprint(normalizedRecords, safeMetadata),
        records: normalizedRecords.slice(),
        recordCount: normalizedRecords.length,
        metadata: safeMetadata,
        createdAt,
        updatedAt,
        expiresAt,
        stale: stale === true
    }, normalizedOptions.freezeSnapshots);
};

const createStats = () => ({
    registrations: 0,
    replacements: 0,
    appends: 0,
    removals: 0,
    cacheHits: 0,
    cacheMisses: 0,
    loadsStarted: 0,
    loadsDeduped: 0,
    loadsSucceeded: 0,
    loadsFailed: 0,
    evictions: 0,
    staleReads: 0,
    derivedBuilds: 0,
    derivedHits: 0,
    derivedInvalidations: 0
});

const resolveLoaderPayload = payload => {
    if (Array.isArray(payload)) return { records: payload, metadata: {} };
    if (payload && typeof payload === "object" && Array.isArray(payload.records)) {
        return {
            records: payload.records,
            metadata: payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {}
        };
    }
    return { records: [], metadata: {} };
};

export const createSearchDatasetRegistry = (options = {}) => {
    const normalizedOptions = normalizeDatasetOptions(options);
    const entries = new Map();
    const loaders = new Map();
    const inFlight = new Map();
    const stats = createStats();
    const nowValue = supplied => Number.isFinite(supplied) ? supplied : Date.now();

    const touch = (entry, now) => {
        entry.lastAccessAt = now;
        entries.delete(entry.name);
        entries.set(entry.name, entry);
    };

    const createEntry = ({ name, records, metadata, now, previous }) => {
        const normalizedRecords = normalizeDatasetRecords(records, normalizedOptions);
        const safeMetadata = metadata && typeof metadata === "object" && !Array.isArray(metadata)
            ? { ...metadata }
            : {};
        return {
            name,
            records: normalizedRecords,
            metadata: safeMetadata,
            revision: previous ? previous.revision + 1 : 1,
            fingerprint: createDatasetFingerprint(normalizedRecords, safeMetadata),
            createdAt: previous?.createdAt ?? now,
            updatedAt: now,
            expiresAt: now + normalizedOptions.ttlMs,
            lastAccessAt: now,
            stale: false,
            derived: new Map()
        };
    };

    const publicSnapshot = (entry, now) => createDatasetSnapshot({
        ...entry,
        stale: entry.stale || entry.expiresAt <= now
    }, normalizedOptions);

    const evictIfNeeded = () => {
        while (entries.size > normalizedOptions.maxDatasets) {
            const oldestName = entries.keys().next().value;
            if (oldestName === undefined) break;
            entries.delete(oldestName);
            stats.evictions += 1;
        }
    };

    const getEntry = (name, suppliedNow, { allowStale = true, touchEntry = true } = {}) => {
        const normalizedName = normalizeDatasetName(name);
        if (!normalizedName) return null;
        const entry = entries.get(normalizedName);
        if (!entry) {
            stats.cacheMisses += 1;
            return null;
        }
        const now = nowValue(suppliedNow);
        const stale = entry.stale || entry.expiresAt <= now;
        if (stale && !allowStale) {
            stats.cacheMisses += 1;
            return null;
        }
        if (stale) stats.staleReads += 1;
        stats.cacheHits += 1;
        if (touchEntry) touch(entry, now);
        return entry;
    };

    const write = (name, records, metadata, suppliedNow, mode = "replace") => {
        const normalizedName = normalizeDatasetName(name);
        if (!normalizedName) throw new TypeError("Dataset name is required");
        const now = nowValue(suppliedNow);
        const previous = entries.get(normalizedName) || null;
        const entry = createEntry({ name: normalizedName, records, metadata, now, previous });
        entries.set(normalizedName, entry);
        touch(entry, now);
        evictIfNeeded();
        if (!previous) stats.registrations += 1;
        else if (mode === "append") stats.appends += 1;
        else stats.replacements += 1;
        return publicSnapshot(entry, now);
    };

    const registerLoader = (name, loader) => {
        const normalizedName = normalizeDatasetName(name);
        if (!normalizedName) throw new TypeError("Dataset name is required");
        if (typeof loader !== "function") throw new TypeError("Dataset loader must be a function");
        loaders.set(normalizedName, loader);
        return () => loaders.delete(normalizedName);
    };

    const load = async (name, loadOptions = {}) => {
        const normalizedName = normalizeDatasetName(name);
        if (!normalizedName) throw new TypeError("Dataset name is required");
        throwIfDatasetAborted(loadOptions.signal);
        const now = nowValue(loadOptions.now);
        const existing = getEntry(normalizedName, now, {
            allowStale: loadOptions.allowStale === true,
            touchEntry: true
        });
        if (existing && loadOptions.force !== true) return publicSnapshot(existing, now);

        const loader = loadOptions.loader || loaders.get(normalizedName);
        if (typeof loader !== "function") {
            if (existing) return publicSnapshot(existing, now);
            const error = new Error(`No loader registered for dataset: ${normalizedName}`);
            error.code = "DATASET_LOADER_MISSING";
            throw error;
        }
        if (inFlight.has(normalizedName)) {
            stats.loadsDeduped += 1;
            const shared = await inFlight.get(normalizedName);
            throwIfDatasetAborted(loadOptions.signal);
            return shared;
        }

        stats.loadsStarted += 1;
        const operation = Promise.resolve().then(async () => {
            throwIfDatasetAborted(loadOptions.signal);
            const payload = loader({
                name: normalizedName,
                previous: existing ? publicSnapshot(existing, now) : null,
                signal: loadOptions.signal
            });
            const resolved = isPromiseLike(payload) ? await payload : payload;
            throwIfDatasetAborted(loadOptions.signal);
            const normalizedPayload = resolveLoaderPayload(resolved);
            const snapshot = write(
                normalizedName,
                normalizedPayload.records,
                normalizedPayload.metadata,
                nowValue(loadOptions.completedAt),
                existing ? "replace" : "register"
            );
            stats.loadsSucceeded += 1;
            return snapshot;
        }).catch(error => {
            stats.loadsFailed += 1;
            throw error;
        }).finally(() => {
            inFlight.delete(normalizedName);
        });
        inFlight.set(normalizedName, operation);
        return operation;
    };

    const api = {
        options: normalizedOptions,

        register(name, records, metadata = {}, writeOptions = {}) {
            return write(name, records, metadata, writeOptions.now, "register");
        },

        replace(name, records, metadata = {}, writeOptions = {}) {
            return write(name, records, metadata, writeOptions.now, "replace");
        },

        append(name, records, metadata = {}, writeOptions = {}) {
            const normalizedName = normalizeDatasetName(name);
            const previous = entries.get(normalizedName);
            const nextRecords = previous ? [...previous.records, ...asArray(records)] : asArray(records);
            const nextMetadata = previous ? { ...previous.metadata, ...metadata } : metadata;
            return write(normalizedName, nextRecords, nextMetadata, writeOptions.now, "append");
        },

        get(name, readOptions = {}) {
            const entry = getEntry(name, readOptions.now, {
                allowStale: readOptions.allowStale !== false,
                touchEntry: readOptions.touch !== false
            });
            return entry ? publicSnapshot(entry, nowValue(readOptions.now)) : null;
        },

        peek(name, readOptions = {}) {
            const entry = entries.get(normalizeDatasetName(name));
            return entry ? publicSnapshot(entry, nowValue(readOptions.now)) : null;
        },

        has(name, readOptions = {}) {
            const entry = entries.get(normalizeDatasetName(name));
            if (!entry) return false;
            if (readOptions.allowStale === true) return true;
            const now = nowValue(readOptions.now);
            return !entry.stale && entry.expiresAt > now;
        },

        list(readOptions = {}) {
            const now = nowValue(readOptions.now);
            return Array.from(entries.values()).map(entry => publicSnapshot(entry, now));
        },

        remove(name) {
            const normalizedName = normalizeDatasetName(name);
            const removed = entries.delete(normalizedName);
            loaders.delete(normalizedName);
            inFlight.delete(normalizedName);
            if (removed) stats.removals += 1;
            return removed;
        },

        clear() {
            const count = entries.size;
            entries.clear();
            inFlight.clear();
            stats.removals += count;
            return count;
        },

        markStale(name) {
            const entry = entries.get(normalizeDatasetName(name));
            if (!entry) return false;
            entry.stale = true;
            if (entry.derived.size) {
                entry.derived.clear();
                stats.derivedInvalidations += 1;
            }
            return true;
        },

        refreshExpiry(name, ttlMs, suppliedNow) {
            const entry = entries.get(normalizeDatasetName(name));
            if (!entry) return null;
            const now = nowValue(suppliedNow);
            const normalizedTtl = boundedPositiveInteger(ttlMs, normalizedOptions.ttlMs, MAX_DATASET_TTL_MS);
            entry.expiresAt = now + normalizedTtl;
            entry.stale = false;
            touch(entry, now);
            return publicSnapshot(entry, now);
        },

        registerLoader,
        load,

        async ensure(name, ensureOptions = {}) {
            const cached = api.get(name, { now: ensureOptions.now, allowStale: false });
            if (cached && ensureOptions.force !== true) return cached;
            return load(name, ensureOptions);
        },

        getDerived(name, key) {
            const entry = entries.get(normalizeDatasetName(name));
            if (!entry) return undefined;
            const derived = entry.derived.get(normalizeText(key));
            if (!derived || derived.revision !== entry.revision || derived.fingerprint !== entry.fingerprint) return undefined;
            stats.derivedHits += 1;
            return derived.value;
        },

        setDerived(name, key, value) {
            const entry = entries.get(normalizeDatasetName(name));
            const normalizedKey = normalizeText(key);
            if (!entry || !normalizedKey) return undefined;
            entry.derived.set(normalizedKey, {
                revision: entry.revision,
                fingerprint: entry.fingerprint,
                value
            });
            stats.derivedBuilds += 1;
            return value;
        },

        getOrBuildDerived(name, key, builder) {
            const cached = api.getDerived(name, key);
            if (cached !== undefined) return cached;
            if (typeof builder !== "function") throw new TypeError("Derived dataset builder must be a function");
            const snapshot = api.peek(name);
            if (!snapshot) return undefined;
            return api.setDerived(name, key, builder(snapshot));
        },

        invalidateDerived(name, key) {
            const entry = entries.get(normalizeDatasetName(name));
            if (!entry) return false;
            let removed = false;
            if (key === undefined) {
                removed = entry.derived.size > 0;
                entry.derived.clear();
            } else {
                removed = entry.derived.delete(normalizeText(key));
            }
            if (removed) stats.derivedInvalidations += 1;
            return removed;
        },

        diagnostics(readOptions = {}) {
            const now = nowValue(readOptions.now);
            const snapshots = Array.from(entries.values());
            return {
                ...stats,
                datasetCount: snapshots.length,
                totalRecords: snapshots.reduce((sum, entry) => sum + entry.records.length, 0),
                staleDatasetCount: snapshots.filter(entry => entry.stale || entry.expiresAt <= now).length,
                inFlightCount: inFlight.size,
                loaderCount: loaders.size,
                names: snapshots.map(entry => entry.name),
                revisions: snapshots.reduce((result, entry) => ({ ...result, [entry.name]: entry.revision }), {})
            };
        },

        resetStatistics() {
            Object.keys(stats).forEach(key => {
                stats[key] = 0;
            });
        },

        _unsafeEntries: entries,
        _unsafeInFlight: inFlight
    };

    return api;
};

export const SearchDatasetRegistry = {
    DEFAULT_DATASET_TTL_MS,
    DEFAULT_MAX_DATASETS,
    DEFAULT_MAX_RECORDS,
    MAX_DATASET_TTL_MS,
    MAX_DATASETS,
    MAX_DATASET_RECORDS,
    createSearchAbortError,
    throwIfDatasetAborted,
    normalizeDatasetName,
    normalizeDatasetOptions,
    stableSerializeForFingerprint,
    hashSearchDataset,
    createDatasetFingerprint,
    normalizeDatasetRecords,
    createDatasetSnapshot,
    createSearchDatasetRegistry
};