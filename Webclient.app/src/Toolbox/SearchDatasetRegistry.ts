import {
    normalizeText
} from "./DataIntegrityHelper";

export const DEFAULT_DATASET_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_MAX_DATASETS = 12;
export const DEFAULT_MAX_RECORDS = 100000;
export const MAX_DATASET_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_DATASETS = 128;
export const MAX_DATASET_RECORDS = 1000000;

type UnknownRecord = Record<string, unknown>;

export interface DatasetRegistryOptions {
    ttlMs?: unknown;
    maxDatasets?: unknown;
    maxRecords?: unknown;
    rejectOversized?: unknown;
    freezeSnapshots?: unknown;
}

export interface NormalizedDatasetOptions {
    ttlMs: number;
    maxDatasets: number;
    maxRecords: number;
    rejectOversized: boolean;
    freezeSnapshots: boolean;
}

export interface DatasetSnapshot {
    name: string;
    revision: number;
    fingerprint: string;
    records: unknown[];
    recordCount: number;
    metadata: UnknownRecord;
    createdAt: number;
    updatedAt: number;
    expiresAt: number;
    stale: boolean;
}

interface DatasetSnapshotInput {
    name: unknown;
    records: unknown;
    revision?: unknown;
    metadata?: unknown;
    fingerprint?: string | null;
    createdAt: number;
    updatedAt: number;
    expiresAt: number;
    stale?: boolean;
}

interface DerivedDatasetEntry {
    revision: number;
    fingerprint: string;
    value: unknown;
}

interface DatasetEntry {
    name: string;
    records: unknown[];
    metadata: UnknownRecord;
    revision: number;
    fingerprint: string;
    createdAt: number;
    updatedAt: number;
    expiresAt: number;
    lastAccessAt: number;
    stale: boolean;
    derived: Map<string, DerivedDatasetEntry>;
}

interface DatasetStats {
    registrations: number;
    replacements: number;
    appends: number;
    removals: number;
    cacheHits: number;
    cacheMisses: number;
    loadsStarted: number;
    loadsDeduped: number;
    loadsSucceeded: number;
    loadsFailed: number;
    evictions: number;
    staleReads: number;
    derivedBuilds: number;
    derivedHits: number;
    derivedInvalidations: number;
}

export interface DatasetLoaderContext {
    name: string;
    previous: DatasetSnapshot | null;
    signal: AbortSignal | null | undefined;
}

export type DatasetLoader = (context: DatasetLoaderContext) => unknown | PromiseLike<unknown>;

export interface DatasetLoadOptions {
    signal?: AbortSignal | null;
    now?: unknown;
    completedAt?: unknown;
    allowStale?: boolean;
    force?: boolean;
    loader?: DatasetLoader;
}

export interface DatasetReadOptions {
    now?: unknown;
    allowStale?: boolean;
    touch?: boolean;
}

export interface DatasetWriteOptions {
    now?: unknown;
}

export interface DatasetRegistryDiagnostics extends DatasetStats {
    datasetCount: number;
    totalRecords: number;
    staleDatasetCount: number;
    inFlightCount: number;
    loaderCount: number;
    names: string[];
    revisions: Record<string, number>;
}

export interface SearchDatasetRegistryApi {
    options: NormalizedDatasetOptions;
    register(name: unknown, records: unknown, metadata?: UnknownRecord, writeOptions?: DatasetWriteOptions): DatasetSnapshot;
    replace(name: unknown, records: unknown, metadata?: UnknownRecord, writeOptions?: DatasetWriteOptions): DatasetSnapshot;
    append(name: unknown, records: unknown, metadata?: UnknownRecord, writeOptions?: DatasetWriteOptions): DatasetSnapshot;
    get(name: unknown, readOptions?: DatasetReadOptions): DatasetSnapshot | null;
    peek(name: unknown, readOptions?: Pick<DatasetReadOptions, "now">): DatasetSnapshot | null;
    has(name: unknown, readOptions?: Pick<DatasetReadOptions, "now" | "allowStale">): boolean;
    list(readOptions?: Pick<DatasetReadOptions, "now">): DatasetSnapshot[];
    remove(name: unknown): boolean;
    clear(): number;
    markStale(name: unknown): boolean;
    refreshExpiry(name: unknown, ttlMs: unknown, suppliedNow?: unknown): DatasetSnapshot | null;
    registerLoader(name: unknown, loader: DatasetLoader): () => boolean;
    load(name: unknown, loadOptions?: DatasetLoadOptions): Promise<DatasetSnapshot>;
    ensure(name: unknown, ensureOptions?: DatasetLoadOptions): Promise<DatasetSnapshot>;
    getDerived<T = unknown>(name: unknown, key: unknown): T | undefined;
    setDerived<T>(name: unknown, key: unknown, value: T): T | undefined;
    getOrBuildDerived<T>(name: unknown, key: unknown, builder: (snapshot: DatasetSnapshot) => T): T | undefined;
    invalidateDerived(name: unknown, key?: unknown): boolean;
    diagnostics(readOptions?: Pick<DatasetReadOptions, "now">): DatasetRegistryDiagnostics;
    resetStatistics(): void;
    _unsafeEntries: Map<string, DatasetEntry>;
    _unsafeInFlight: Map<string, Promise<DatasetSnapshot>>;
}

interface CreateEntryInput {
    name: string;
    records: unknown;
    metadata: unknown;
    now: number;
    previous: DatasetEntry | null;
}

interface EntryReadOptions {
    allowStale?: boolean;
    touchEntry?: boolean;
}

interface LoaderPayload {
    records: unknown[];
    metadata: UnknownRecord;
}

const isRecord = (value: unknown): value is UnknownRecord =>
    value !== null && typeof value === "object" && !Array.isArray(value);

const normalizeMetadata = (value: unknown): UnknownRecord =>
    isRecord(value) ? { ...value } : {};

const asArray = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
    isRecord(value) && typeof value.then === "function";

const boundedPositiveInteger = (value: unknown, fallback: number, maximum: number): number => {
    if (value === undefined || value === null || value === "") return fallback;
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || !Number.isInteger(numeric) || numeric <= 0) return fallback;
    return Math.min(maximum, numeric);
};

export const createSearchAbortError = (message = "Search dataset operation aborted"): Error => {
    const error = new Error(message);
    error.name = "AbortError";
    return error;
};

export const throwIfDatasetAborted = (signal?: AbortSignal | null): void => {
    if (signal?.aborted) throw createSearchAbortError();
};

export const normalizeDatasetName = (value: unknown): string => normalizeText(value)
    .toLocaleLowerCase("tr-TR")
    .replace(/[^a-z0-9ğüşöçı_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);

export const normalizeDatasetOptions = (options: DatasetRegistryOptions = {}): NormalizedDatasetOptions => ({
    ttlMs: boundedPositiveInteger(options?.ttlMs, DEFAULT_DATASET_TTL_MS, MAX_DATASET_TTL_MS),
    maxDatasets: boundedPositiveInteger(options?.maxDatasets, DEFAULT_MAX_DATASETS, MAX_DATASETS),
    maxRecords: boundedPositiveInteger(options?.maxRecords, DEFAULT_MAX_RECORDS, MAX_DATASET_RECORDS),
    rejectOversized: options?.rejectOversized !== false,
    freezeSnapshots: options?.freezeSnapshots !== false
});

const normalizeScalarForFingerprint = (value: unknown): string | null => {
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    if (typeof value === "number") return Number.isFinite(value) ? String(value) : "invalid-number";
    if (typeof value === "boolean") return value ? "true" : "false";
    if (typeof value === "string") return value;
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : "invalid-date";
    return null;
};

export const stableSerializeForFingerprint = (value: unknown, seen: WeakSet<object> = new WeakSet()): string => {
    const scalar = normalizeScalarForFingerprint(value);
    if (scalar !== null) return JSON.stringify(scalar);
    if (typeof value !== "object" || value === null) return JSON.stringify(String(value));
    if (seen.has(value)) return '"[Circular]"';
    seen.add(value);
    try {
        if (Array.isArray(value)) {
            return `[${value.map(item => stableSerializeForFingerprint(item, seen)).join(",")}]`;
        }
        const record = value as UnknownRecord;
        const keys = Object.keys(record).sort((left, right) => left.localeCompare(right));
        return `{${keys.map(key => `${JSON.stringify(key)}:${stableSerializeForFingerprint(record[key], seen)}`).join(",")}}`;
    } finally {
        seen.delete(value);
    }
};

export const hashSearchDataset = (value: unknown): string => {
    const input = stableSerializeForFingerprint(value);
    let hash = 2166136261;
    for (let index = 0; index < input.length; index += 1) {
        hash ^= input.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
};

export const createDatasetFingerprint = (records: unknown, metadata: unknown = {}): string => hashSearchDataset({
    count: asArray(records).length,
    metadata,
    records: asArray(records)
});

export const normalizeDatasetRecords = (
    records: unknown,
    options: DatasetRegistryOptions | NormalizedDatasetOptions = {}
): unknown[] => {
    const normalizedOptions = normalizeDatasetOptions(options);
    const input = asArray(records);
    if (normalizedOptions.rejectOversized && input.length > normalizedOptions.maxRecords) {
        throw Object.assign(
            new RangeError(`Dataset contains ${input.length} records; maximum is ${normalizedOptions.maxRecords}`),
            { code: "DATASET_RECORD_LIMIT" }
        );
    }
    return input.slice(0, normalizedOptions.maxRecords);
};

const freezeSnapshot = (snapshot: DatasetSnapshot, enabled: boolean): DatasetSnapshot => {
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
}: DatasetSnapshotInput, options: DatasetRegistryOptions | NormalizedDatasetOptions = {}): DatasetSnapshot => {
    const normalizedOptions = normalizeDatasetOptions(options);
    const normalizedRecords = normalizeDatasetRecords(records, normalizedOptions);
    const safeMetadata = normalizeMetadata(metadata);
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

const createStats = (): DatasetStats => ({
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

const resolveLoaderPayload = (payload: unknown): LoaderPayload => {
    if (Array.isArray(payload)) return { records: payload, metadata: {} };
    if (isRecord(payload) && Array.isArray(payload.records)) {
        return {
            records: payload.records,
            metadata: normalizeMetadata(payload.metadata)
        };
    }
    return { records: [], metadata: {} };
};

export const createSearchDatasetRegistry = (options: DatasetRegistryOptions = {}): SearchDatasetRegistryApi => {
    const normalizedOptions = normalizeDatasetOptions(options);
    const entries = new Map<string, DatasetEntry>();
    const loaders = new Map<string, DatasetLoader>();
    const inFlight = new Map<string, Promise<DatasetSnapshot>>();
    const stats = createStats();
    const nowValue = (supplied: unknown): number =>
        typeof supplied === "number" && Number.isFinite(supplied) ? supplied : Date.now();

    const touch = (entry: DatasetEntry, now: number): void => {
        entry.lastAccessAt = now;
        entries.delete(entry.name);
        entries.set(entry.name, entry);
    };

    const createEntry = ({ name, records, metadata, now, previous }: CreateEntryInput): DatasetEntry => {
        const normalizedRecords = normalizeDatasetRecords(records, normalizedOptions);
        const safeMetadata = normalizeMetadata(metadata);
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

    const publicSnapshot = (entry: DatasetEntry, now: number): DatasetSnapshot => createDatasetSnapshot({
        ...entry,
        stale: entry.stale || entry.expiresAt <= now
    }, normalizedOptions);

    const evictIfNeeded = (): void => {
        while (entries.size > normalizedOptions.maxDatasets) {
            const oldestName = entries.keys().next().value;
            if (oldestName === undefined) break;
            entries.delete(oldestName);
            stats.evictions += 1;
        }
    };

    const getEntry = (
        name: unknown,
        suppliedNow: unknown,
        { allowStale = true, touchEntry = true }: EntryReadOptions = {}
    ): DatasetEntry | null => {
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

    const write = (
        name: unknown,
        records: unknown,
        metadata: unknown,
        suppliedNow: unknown,
        mode: "replace" | "append" | "register" = "replace"
    ): DatasetSnapshot => {
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

    const registerLoader = (name: unknown, loader: DatasetLoader): (() => boolean) => {
        const normalizedName = normalizeDatasetName(name);
        if (!normalizedName) throw new TypeError("Dataset name is required");
        if (typeof loader !== "function") throw new TypeError("Dataset loader must be a function");
        loaders.set(normalizedName, loader);
        return () => loaders.delete(normalizedName);
    };

    const load = async (name: unknown, loadOptions: DatasetLoadOptions = {}): Promise<DatasetSnapshot> => {
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
            throw Object.assign(
                new Error(`No loader registered for dataset: ${normalizedName}`),
                { code: "DATASET_LOADER_MISSING" }
            );
        }
        if (inFlight.has(normalizedName)) {
            stats.loadsDeduped += 1;
            const shared = await inFlight.get(normalizedName)!;
            throwIfDatasetAborted(loadOptions.signal);
            return shared;
        }

        stats.loadsStarted += 1;
        const operation: Promise<DatasetSnapshot> = Promise.resolve().then(async () => {
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

    const api: SearchDatasetRegistryApi = {
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

        getDerived<T = unknown>(name: unknown, key: unknown): T | undefined {
            const entry = entries.get(normalizeDatasetName(name));
            if (!entry) return undefined;
            const derived = entry.derived.get(normalizeText(key));
            if (!derived || derived.revision !== entry.revision || derived.fingerprint !== entry.fingerprint) return undefined;
            stats.derivedHits += 1;
            return derived.value as T;
        },

        setDerived<T>(name: unknown, key: unknown, value: T): T | undefined {
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

        getOrBuildDerived<T>(
            name: unknown,
            key: unknown,
            builder: (snapshot: DatasetSnapshot) => T
        ): T | undefined {
            const cached = api.getDerived(name, key);
            if (cached !== undefined) return cached;
            if (typeof builder !== "function") throw new TypeError("Derived dataset builder must be a function");
            const snapshot = api.peek(name);
            if (!snapshot) return undefined;
            return api.setDerived<T>(name, key, builder(snapshot));
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
                revisions: snapshots.reduce<Record<string, number>>(
                    (result, entry) => ({ ...result, [entry.name]: entry.revision }),
                    {}
                )
            };
        },

        resetStatistics() {
            (Object.keys(stats) as Array<keyof DatasetStats>).forEach(key => {
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