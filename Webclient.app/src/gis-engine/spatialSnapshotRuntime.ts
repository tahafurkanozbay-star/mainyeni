export interface SpatialSnapshotExtent {
    readonly xmin: number;
    readonly ymin: number;
    readonly xmax: number;
    readonly ymax: number;
    readonly wkid: number;
}

export interface SpatialSnapshotLayerState {
    readonly layerId: string;
    readonly visible: boolean;
    readonly opacity: number;
    readonly minScale: number;
    readonly maxScale: number;
    readonly revision: string;
}

export interface SpatialSnapshotSelection {
    readonly layerId: string;
    readonly objectIds: readonly (string | number)[];
}

export interface SpatialSnapshot {
    readonly id: string;
    readonly createdAt: number;
    readonly mode: "2d" | "3d";
    readonly extent: SpatialSnapshotExtent;
    readonly scale: number;
    readonly rotation: number;
    readonly tilt: number;
    readonly layers: readonly SpatialSnapshotLayerState[];
    readonly selections: readonly SpatialSnapshotSelection[];
}

export interface SpatialSnapshotInput {
    readonly id: string;
    readonly mode: "2d" | "3d";
    readonly extent: SpatialSnapshotExtent;
    readonly scale: number;
    readonly rotation?: number;
    readonly tilt?: number;
    readonly layers?: readonly SpatialSnapshotLayerState[];
    readonly selections?: readonly SpatialSnapshotSelection[];
}

export interface SpatialSnapshotRuntimeConfig {
    readonly maxSnapshots: number;
    readonly maxLayersPerSnapshot: number;
    readonly maxSelectionsPerSnapshot: number;
    readonly maxObjectIdsPerSelection: number;
    readonly maxEstimatedBytes: number;
    readonly maxAgeMs: number;
}

export interface SpatialSnapshotRuntimeStats {
    readonly count: number;
    readonly estimatedBytes: number;
    readonly inserted: number;
    readonly replaced: number;
    readonly evicted: number;
    readonly expired: number;
}

export interface SpatialSnapshotRuntime {
    put(input: SpatialSnapshotInput): SpatialSnapshot;
    get(id: string): SpatialSnapshot | null;
    has(id: string): boolean;
    remove(id: string): boolean;
    list(): readonly SpatialSnapshot[];
    pruneExpired(): number;
    stats(): SpatialSnapshotRuntimeStats;
    clear(): void;
}

interface StoredSnapshot {
    readonly snapshot: SpatialSnapshot;
    readonly bytes: number;
    readonly sequence: number;
    lastAccess: number;
}

const DEFAULT_CONFIG: SpatialSnapshotRuntimeConfig = {
    maxSnapshots: 32,
    maxLayersPerSnapshot: 128,
    maxSelectionsPerSnapshot: 32,
    maxObjectIdsPerSelection: 2_000,
    maxEstimatedBytes: 4 * 1024 * 1024,
    maxAgeMs: 30 * 60 * 1_000,
};

const assertPositiveInteger = (name: string, value: number): void => {
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
};

const normalizeConfig = (input: Partial<SpatialSnapshotRuntimeConfig>): SpatialSnapshotRuntimeConfig => {
    const config = { ...DEFAULT_CONFIG, ...input };
    assertPositiveInteger("maxSnapshots", config.maxSnapshots);
    assertPositiveInteger("maxLayersPerSnapshot", config.maxLayersPerSnapshot);
    assertPositiveInteger("maxSelectionsPerSnapshot", config.maxSelectionsPerSnapshot);
    assertPositiveInteger("maxObjectIdsPerSelection", config.maxObjectIdsPerSelection);
    assertPositiveInteger("maxEstimatedBytes", config.maxEstimatedBytes);
    assertPositiveInteger("maxAgeMs", config.maxAgeMs);
    return Object.freeze(config);
};

const normalizeId = (name: string, value: string): string => {
    const normalized = value.trim();
    if (!normalized || normalized.length > 256) throw new RangeError(`${name} must contain between 1 and 256 characters`);
    return normalized;
};

const finite = (name: string, value: number): number => {
    if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
    return value;
};

const normalizeExtent = (extent: SpatialSnapshotExtent): SpatialSnapshotExtent => {
    const xmin = finite("extent.xmin", extent.xmin);
    const ymin = finite("extent.ymin", extent.ymin);
    const xmax = finite("extent.xmax", extent.xmax);
    const ymax = finite("extent.ymax", extent.ymax);
    if (xmin > xmax || ymin > ymax) throw new RangeError("Spatial snapshot extent is inverted");
    if (!Number.isSafeInteger(extent.wkid) || extent.wkid <= 0) throw new RangeError("Spatial snapshot wkid must be a positive safe integer");
    return Object.freeze({ xmin, ymin, xmax, ymax, wkid: extent.wkid });
};

const normalizeOpacity = (value: number): number => {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError("Layer opacity must be between 0 and 1");
    return value;
};

const normalizeScale = (name: string, value: number): number => {
    if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a finite non-negative number`);
    return value;
};

const normalizeLayer = (layer: SpatialSnapshotLayerState): SpatialSnapshotLayerState => Object.freeze({
    layerId: normalizeId("layerId", layer.layerId),
    visible: layer.visible,
    opacity: normalizeOpacity(layer.opacity),
    minScale: normalizeScale("minScale", layer.minScale),
    maxScale: normalizeScale("maxScale", layer.maxScale),
    revision: normalizeId("revision", layer.revision),
});

const stableObjectIdKey = (value: string | number): string => {
    if (typeof value === "number") {
        if (!Number.isSafeInteger(value)) throw new RangeError("Numeric object ids must be safe integers");
        return `n:${value}`;
    }
    const normalized = value.trim();
    if (!normalized || normalized.length > 256) throw new RangeError("String object ids must contain between 1 and 256 characters");
    return `s:${normalized}`;
};

const normalizeSelection = (
    selection: SpatialSnapshotSelection,
    maxObjectIds: number,
): SpatialSnapshotSelection => {
    const layerId = normalizeId("selection.layerId", selection.layerId);
    if (selection.objectIds.length > maxObjectIds) throw new RangeError(`Selection object-id budget exceeded for ${layerId}`);
    const seen = new Set<string>();
    const objectIds: (string | number)[] = [];
    for (const raw of selection.objectIds) {
        const key = stableObjectIdKey(raw);
        if (seen.has(key)) continue;
        seen.add(key);
        objectIds.push(typeof raw === "string" ? raw.trim() : raw);
    }
    return Object.freeze({ layerId, objectIds: Object.freeze(objectIds) });
};

const estimateSnapshotBytes = (snapshot: SpatialSnapshot): number => {
    let bytes = 160 + snapshot.id.length * 2;
    for (const layer of snapshot.layers) bytes += 96 + (layer.layerId.length + layer.revision.length) * 2;
    for (const selection of snapshot.selections) {
        bytes += 64 + selection.layerId.length * 2;
        for (const objectId of selection.objectIds) bytes += typeof objectId === "number" ? 8 : 16 + objectId.length * 2;
    }
    return bytes;
};

export const createSpatialSnapshotRuntime = (
    input: Partial<SpatialSnapshotRuntimeConfig> = {},
    now: () => number = () => Date.now(),
): SpatialSnapshotRuntime => {
    const config = normalizeConfig(input);
    const entries = new Map<string, StoredSnapshot>();
    let estimatedBytes = 0;
    let sequence = 0;
    let inserted = 0;
    let replaced = 0;
    let evicted = 0;
    let expired = 0;

    const removeStored = (id: string): boolean => {
        const existing = entries.get(id);
        if (!existing) return false;
        entries.delete(id);
        estimatedBytes = Math.max(0, estimatedBytes - existing.bytes);
        return true;
    };

    const isExpired = (entry: StoredSnapshot, time: number): boolean => time - entry.snapshot.createdAt >= config.maxAgeMs;

    const pruneExpired = (): number => {
        const time = now();
        let count = 0;
        for (const [id, entry] of entries) {
            if (!isExpired(entry, time)) continue;
            removeStored(id);
            expired += 1;
            count += 1;
        }
        return count;
    };

    const selectEvictionCandidate = (protectedId: string): string | null => {
        let candidate: StoredSnapshot | null = null;
        for (const entry of entries.values()) {
            if (entry.snapshot.id === protectedId) continue;
            if (candidate === null || entry.lastAccess < candidate.lastAccess ||
                (entry.lastAccess === candidate.lastAccess && entry.sequence < candidate.sequence)) {
                candidate = entry;
            }
        }
        return candidate?.snapshot.id ?? null;
    };

    const enforceBudgets = (protectedId: string): void => {
        while (entries.size > config.maxSnapshots || estimatedBytes > config.maxEstimatedBytes) {
            const candidate = selectEvictionCandidate(protectedId);
            if (candidate === null) break;
            removeStored(candidate);
            evicted += 1;
        }
        const protectedEntry = entries.get(protectedId);
        if (protectedEntry && (entries.size > config.maxSnapshots || estimatedBytes > config.maxEstimatedBytes)) {
            removeStored(protectedId);
            throw new RangeError("Spatial snapshot exceeds configured storage budgets");
        }
    };

    const put = (inputSnapshot: SpatialSnapshotInput): SpatialSnapshot => {
        pruneExpired();
        const id = normalizeId("snapshot.id", inputSnapshot.id);
        const layersInput = inputSnapshot.layers ?? [];
        const selectionsInput = inputSnapshot.selections ?? [];
        if (layersInput.length > config.maxLayersPerSnapshot) throw new RangeError("Spatial snapshot layer budget exceeded");
        if (selectionsInput.length > config.maxSelectionsPerSnapshot) throw new RangeError("Spatial snapshot selection budget exceeded");

        const layerIds = new Set<string>();
        const layers = layersInput.map((layer) => {
            const normalized = normalizeLayer(layer);
            if (layerIds.has(normalized.layerId)) throw new Error(`Duplicate layer state: ${normalized.layerId}`);
            layerIds.add(normalized.layerId);
            return normalized;
        });
        const selectionLayers = new Set<string>();
        const selections = selectionsInput.map((selection) => {
            const normalized = normalizeSelection(selection, config.maxObjectIdsPerSelection);
            if (selectionLayers.has(normalized.layerId)) throw new Error(`Duplicate selection state: ${normalized.layerId}`);
            selectionLayers.add(normalized.layerId);
            return normalized;
        });
        const createdAt = now();
        const snapshot: SpatialSnapshot = Object.freeze({
            id,
            createdAt,
            mode: inputSnapshot.mode,
            extent: normalizeExtent(inputSnapshot.extent),
            scale: normalizeScale("scale", inputSnapshot.scale),
            rotation: finite("rotation", inputSnapshot.rotation ?? 0),
            tilt: finite("tilt", inputSnapshot.tilt ?? 0),
            layers: Object.freeze(layers),
            selections: Object.freeze(selections),
        });
        const bytes = estimateSnapshotBytes(snapshot);
        if (bytes > config.maxEstimatedBytes) throw new RangeError("Spatial snapshot exceeds the total byte budget");
        const existing = entries.get(id);
        if (existing) {
            estimatedBytes -= existing.bytes;
            replaced += 1;
        } else inserted += 1;
        const stored: StoredSnapshot = { snapshot, bytes, sequence: sequence++, lastAccess: createdAt };
        entries.set(id, stored);
        estimatedBytes += bytes;
        enforceBudgets(id);
        return snapshot;
    };

    const get = (idInput: string): SpatialSnapshot | null => {
        const id = idInput.trim();
        const entry = entries.get(id);
        if (!entry) return null;
        const time = now();
        if (isExpired(entry, time)) {
            removeStored(id);
            expired += 1;
            return null;
        }
        entry.lastAccess = time;
        return entry.snapshot;
    };

    const has = (id: string): boolean => get(id) !== null;

    const list = (): readonly SpatialSnapshot[] => {
        pruneExpired();
        return Object.freeze(Array.from(entries.values(), (entry) => entry.snapshot));
    };

    const clear = (): void => {
        entries.clear();
        estimatedBytes = 0;
    };

    return Object.freeze({
        put,
        get,
        has,
        remove: (id: string) => removeStored(id.trim()),
        list,
        pruneExpired,
        stats: () => Object.freeze({ count: entries.size, estimatedBytes, inserted, replaced, evicted, expired }),
        clear,
    });
};
