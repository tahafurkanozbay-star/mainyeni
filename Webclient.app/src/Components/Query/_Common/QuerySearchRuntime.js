import { createListIconModel } from "../../../gis-engine/iconPresentation";

const TURKISH_LOCALE = "tr-TR";

export const DEFAULT_GROUP_LIMIT = 10;

export const normalizeWhitespace = value => String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

export const normalizeTurkishSearchText = value => normalizeWhitespace(value)
    .toLocaleUpperCase(TURKISH_LOCALE);

export const matchesSearchText = (value, searchText) => {
    const needle = normalizeTurkishSearchText(searchText);
    if (!needle) return true;
    return normalizeTurkishSearchText(value).includes(needle);
};

export const readFirstValue = (record, keys, fallback = "") => {
    const sources = [record, record?.attr, record?.attributes, record?.properties].filter(Boolean);
    for (const source of sources) {
        for (const key of keys) {
            const value = source?.[key];
            if (value !== null && value !== undefined && String(value).trim() !== "") return value;
        }
    }
    return fallback;
};

export const getRecordId = record => readFirstValue(
    record,
    ["ObjectId", "objectId", "objectid", "OBJECTID", "Id", "id", "ID"],
    null
);

export const getRecordTitle = record => normalizeWhitespace(readFirstValue(
    record,
    ["Title", "title", "ADI", "adi", "ad", "AD", "name", "Name"],
    "İsimsiz kayıt"
));

export const getRecordAddress = record => normalizeWhitespace(readFirstValue(
    record,
    ["Address", "address", "ADRES", "adres", "_MAHALLE_ADI", "mahalleAdi"],
    ""
));

export const getRecordPhone = record => normalizeWhitespace(readFirstValue(
    record,
    ["Phone", "phone", "TELEFON", "telefon", "TEL", "tel"],
    ""
));

export const getRecordCategory = record => {
    const semanticCategory = normalizeWhitespace(readFirstValue(
        record,
        ["Category", "category", "kategori", "KATEGORI"],
        ""
    ));
    if (semanticCategory) return semanticCategory;

    const technicalType = normalizeWhitespace(readFirstValue(record, ["type", "Type"], ""));
    return technicalType || "Diğer";
};

export const createStableResultKey = (record, fallbackIndex = 0) => {
    const id = getRecordId(record);
    if (id !== null && id !== undefined && String(id).trim() !== "") {
        return `id:${String(id)}`;
    }

    const category = getRecordCategory(record);
    const title = getRecordTitle(record);
    const address = getRecordAddress(record);
    return `record:${category}|${title}|${address}|${fallbackIndex}`;
};

export const normalizeSearchRecord = (record, index = 0) => {
    const id = getRecordId(record);
    const title = getRecordTitle(record);
    const category = getRecordCategory(record);
    const type = normalizeWhitespace(readFirstValue(record, ["type", "Type", "TYPE", "tur", "TUR", "tip", "TIP"], ""));
    const icon = createListIconModel({
        id,
        title,
        category,
        type,
        iconKey: normalizeWhitespace(readFirstValue(record, ["iconKey", "IconKey", "serviceTitle", "ServiceTitle"], ""))
    });
    return {
        raw: record,
        id,
        key: createStableResultKey(record, index),
        title,
        address: getRecordAddress(record),
        phone: getRecordPhone(record),
        category,
        type,
        icon
    };
};

export const normalizeSearchCollection = records => Array.isArray(records)
    ? records.map((record, index) => normalizeSearchRecord(record, index))
    : [];

export const groupSearchResults = (records, groupLimit = DEFAULT_GROUP_LIMIT) => {
    const normalized = normalizeSearchCollection(records);
    const groupsByName = new Map();

    normalized.forEach(record => {
        if (!groupsByName.has(record.category)) groupsByName.set(record.category, []);
        groupsByName.get(record.category).push(record);
    });

    const groups = [];
    const flatItems = [];
    groupsByName.forEach((items, category) => {
        const visibleItems = items.slice(0, Math.max(0, groupLimit));
        const startIndex = flatItems.length;
        flatItems.push(...visibleItems);
        groups.push({
            category,
            totalCount: items.length,
            visibleCount: visibleItems.length,
            startIndex,
            items: visibleItems
        });
    });

    return {
        groups,
        flatItems,
        totalCount: normalized.length,
        visibleCount: flatItems.length
    };
};

export const filterBySearchFields = (records, searchText, selectors = []) => {
    if (!Array.isArray(records)) return [];
    const needle = normalizeTurkishSearchText(searchText);
    if (!needle) return [...records];

    return records.filter(record => selectors.some(selector => {
        const value = typeof selector === "function" ? selector(record) : record?.[selector];
        return normalizeTurkishSearchText(value).includes(needle);
    }));
};

export const normalizeEgoLine = line => ({
    ...line,
    lineNo: normalizeWhitespace(readFirstValue(line, ["haT_NO", "HAT_NO", "hatNo"], "")),
    lineName: normalizeWhitespace(readFirstValue(line, ["haT_ADI", "HAT_ADI", "hatAdi"], "")),
    lineType: normalizeWhitespace(readFirstValue(line, ["haT_TIPI", "HAT_TIPI", "hatTipi"], ""))
});

export const normalizeEgoStop = stop => ({
    ...stop,
    stopNo: normalizeWhitespace(readFirstValue(stop, ["duraK_NO", "DURAK_NO", "durakNo"], "")),
    stopName: normalizeWhitespace(readFirstValue(stop, ["duraK_ADI", "DURAK_ADI", "durakAdi"], "")),
    lineType: normalizeWhitespace(readFirstValue(stop, ["haT_TIPI", "HAT_TIPI", "hatTipi"], "")),
    latitude: Number.parseFloat(String(readFirstValue(stop, ["lat", "latitude", "LAT"], "")).replace(",", ".")),
    longitude: Number.parseFloat(String(readFirstValue(stop, ["lng", "longitude", "LNG"], "")).replace(",", "."))
});

export const filterEgoLines = (lines, searchText, showAll = false) => {
    const normalized = Array.isArray(lines) ? lines.map(normalizeEgoLine) : [];
    const needle = normalizeTurkishSearchText(searchText);
    if (!needle) return showAll ? normalized : [];
    return normalized.filter(line => (
        normalizeTurkishSearchText(line.lineNo).includes(needle)
        || normalizeTurkishSearchText(line.lineName).includes(needle)
    ));
};

export const filterEgoStops = (stops, searchText, showAll = false) => {
    const normalized = Array.isArray(stops) ? stops.map(normalizeEgoStop) : [];
    const needle = normalizeTurkishSearchText(searchText);
    if (!needle) return showAll ? normalized : [];
    return normalized.filter(stop => (
        normalizeTurkishSearchText(stop.stopNo).includes(needle)
        || normalizeTurkishSearchText(stop.stopName).includes(needle)
    ));
};

export const parseRouteCoordinatePairs = value => {
    const tokens = normalizeWhitespace(value).split(" ").filter(Boolean);
    const points = [];
    for (let index = 0; index + 1 < tokens.length; index += 2) {
        const latitude = Number.parseFloat(tokens[index].replace(",", "."));
        const longitude = Number.parseFloat(tokens[index + 1].replace(",", "."));
        if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
            points.push([longitude, latitude]);
        }
    }
    return points;
};

export const normalizeActiveIndex = (index, count) => {
    if (!Number.isFinite(count) || count <= 0) return -1;
    const numeric = Number.isFinite(index) ? Math.trunc(index) : 0;
    return Math.min(count - 1, Math.max(0, numeric));
};

export const moveActiveIndex = (current, direction, count) => {
    if (!Number.isFinite(count) || count <= 0) return -1;
    const normalizedCurrent = normalizeActiveIndex(current, count);
    if (direction === "previous") return Math.max(0, normalizedCurrent - 1);
    if (direction === "next") return Math.min(count - 1, normalizedCurrent + 1);
    if (direction === "first") return 0;
    if (direction === "last") return count - 1;
    return normalizedCurrent;
};

export const isResultActivationKey = key => key === "Enter" || key === " ";

export const createAriaOptionId = (ownerId, recordKey) => {
    const safeOwner = normalizeWhitespace(ownerId).replace(/[^a-zA-Z0-9_-]/g, "-") || "query-search";
    const safeKey = normalizeWhitespace(recordKey).replace(/[^a-zA-Z0-9_-]/g, "-") || "option";
    return `${safeOwner}-${safeKey}`;
};

export const isSmallViewport = (matchMedia = typeof window !== "undefined" ? window.matchMedia : null) => {
    if (typeof matchMedia !== "function") return false;
    return Boolean(matchMedia("(max-width: 959px)")?.matches);
};

/**
 * Loads the large production search stack only when a query surface opts in.
 * Existing lightweight query helpers therefore stay in the initial bundle,
 * while dataset indexing/session/observability code is emitted as lazy chunks.
 */
export const loadProductionSearchRuntimeModules = async () => Promise.all([
    import("../../../Toolbox/NextGenerationSearchCoordinatorRuntime"),
    import("../../../Toolbox/SearchSessionRuntime"),
    import("../../../Toolbox/SearchObservabilityRuntime")
]);

export const createProductionSearchRuntime = async (options = {}) => {
    const modules = options.modules || await loadProductionSearchRuntimeModules();
    const [coordinatorModule, sessionModule, observabilityModule] = modules;
    const createCoordinator = coordinatorModule?.createSearchCoordinator;
    const createSession = sessionModule?.createSearchSession;
    const createObservability = observabilityModule?.createSearchObservability;
    const measureAsync = observabilityModule?.measureAsyncOperation;

    if (typeof createCoordinator !== "function"
        || typeof createSession !== "function"
        || typeof createObservability !== "function"
        || typeof measureAsync !== "function") {
        throw new Error("Production search runtime modules are incomplete");
    }

    const coordinator = options.coordinator || createCoordinator(options.coordinatorOptions);
    const observability = options.observability || createObservability(options.observabilityOptions);
    const session = options.session || createSession(coordinator, {
        ...options.sessionOptions,
        debounceMs: options.sessionOptions?.debounceMs
            ?? observability.recommendDebounce({ queryLength: 0 })
    });
    const now = options.now;

    const observeEnvelope = (envelope, measured, context = {}) => {
        if (measured.error) {
            observability.recordError(context);
            throw measured.error;
        }
        const result = envelope?.result || envelope;
        observability.recordSearch(result, measured.durationMs, context);
        return envelope;
    };

    const measuredSearch = async (method, datasetName, request, searchOptions = {}) => {
        const measured = await measureAsync(
            () => method(datasetName, request, searchOptions),
            { now: searchOptions.now || now }
        );
        return observeEnvelope(measured.value, measured, {
            dataset: datasetName,
            mode: request?.mode
        });
    };

    return {
        coordinator,
        session,
        observability,

        ingest(datasetName, payload, ingestOptions = {}) {
            const snapshot = coordinator.ingest(datasetName, payload, ingestOptions);
            observability.recordDatasetSize(snapshot.recordCount, { dataset: snapshot.name });
            return snapshot;
        },

        register(datasetName, records, metadata = {}, registerOptions = {}) {
            const snapshot = coordinator.register(datasetName, records, metadata, registerOptions);
            observability.recordDatasetSize(snapshot.recordCount, { dataset: snapshot.name });
            return snapshot;
        },

        registerLoader(datasetName, loader) {
            return coordinator.registerLoader(datasetName, loader);
        },

        search(datasetName, request = {}, searchOptions = {}) {
            return measuredSearch(session.searchNow.bind(session), datasetName, request, searchOptions);
        },

        schedule(datasetName, request = {}, searchOptions = {}) {
            return measuredSearch(session.schedule.bind(session), datasetName, request, searchOptions);
        },

        loadMore(searchOptions = {}) {
            return measureAsync(() => session.loadMore(searchOptions), {
                now: searchOptions.now || now
            }).then(measured => observeEnvelope(measured.value, measured, {
                dataset: session.getState().dataset,
                mode: session.getState().result?.mode
            }));
        },

        invalidate(datasetName) {
            return coordinator.invalidate(datasetName);
        },

        getState() {
            return session.getState();
        },

        diagnostics() {
            return {
                coordinator: coordinator.diagnostics(),
                session: session.diagnostics(),
                observability: observability.snapshot(),
                performanceGate: observability.evaluate()
            };
        },

        recommendDebounce(query = "") {
            const datasetCount = coordinator.diagnostics().registry.totalRecords;
            return observability.recommendDebounce({
                queryLength: normalizeWhitespace(query).length,
                recordCount: datasetCount
            });
        },

        dispose() {
            return session.dispose();
        }
    };
};