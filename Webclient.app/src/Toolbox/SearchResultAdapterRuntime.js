import {
    createRecordFingerprint,
    normalizeCoordinates,
    normalizeId,
    normalizeInteger,
    normalizePagination,
    normalizeRecord,
    normalizeText
} from "./DataIntegrityHelper";
import {
    createIconCoverageReport,
    createRecordPresentations
} from "./RecordPresentationRuntime";

export const RESULT_CONTAINER_KEYS = Object.freeze([
    "records",
    "results",
    "features",
    "items",
    "data",
    "Data"
]);

export const RESULT_TITLE_KEYS = Object.freeze([
    "title",
    "Title",
    "serviceTitle",
    "ServiceTitle",
    "name",
    "Name"
]);

export const RESULT_ERROR_KEYS = Object.freeze([
    "error",
    "Error",
    "message",
    "Message",
    "errorMessage",
    "ErrorMessage"
]);

export const RESULT_STATUS_KEYS = Object.freeze([
    "status",
    "Status",
    "resultType",
    "ResultType",
    "type",
    "Type"
]);

export const DEFAULT_ADAPTER_LIMIT = 50;
export const MAX_ADAPTER_LIMIT = 1000;
export const MAX_UNWRAP_DEPTH = 8;

const hasOwn = (value, key) => Boolean(value && Object.prototype.hasOwnProperty.call(value, key));
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const firstDefined = (value, keys) => {
    if (!isObject(value)) return undefined;
    for (const key of keys) {
        if (hasOwn(value, key) && value[key] !== undefined && value[key] !== null) return value[key];
    }
    return undefined;
};

const toFiniteNumber = value => {
    if (value === "" || value === null || value === undefined) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
};

export const normalizeResultTitle = (payload, fallback = "") => normalizeText(
    firstDefined(payload, RESULT_TITLE_KEYS) ?? fallback
);

export const normalizeResultStatus = payload => normalizeText(
    firstDefined(payload, RESULT_STATUS_KEYS) ?? ""
).toLocaleLowerCase("tr-TR");

export const normalizeResultError = payload => {
    if (!payload) return null;
    const candidate = firstDefined(payload, RESULT_ERROR_KEYS);
    if (!candidate) return null;
    if (candidate instanceof Error) return candidate;
    if (isObject(candidate)) {
        const nested = normalizeText(candidate.message ?? candidate.Message ?? JSON.stringify(candidate));
        return nested ? new Error(nested) : null;
    }
    const message = normalizeText(candidate);
    return message ? new Error(message) : null;
};

export const isFailureStatus = status => {
    const normalized = normalizeText(status).toLocaleLowerCase("tr-TR");
    return ["error", "failed", "failure", "fail", "exception", "hata", "false", "0"].includes(normalized);
};

export const isSuccessStatus = status => {
    const normalized = normalizeText(status).toLocaleLowerCase("tr-TR");
    return ["success", "ok", "successful", "başarılı", "basarili", "true", "1"].includes(normalized);
};

export const normalizeGeometryCoordinates = geometry => {
    if (!geometry || typeof geometry !== "object") return null;
    const direct = normalizeCoordinates(geometry);
    if (direct) return direct;
    if (Array.isArray(geometry.coordinates) && geometry.coordinates.length >= 2) {
        return normalizeCoordinates({
            longitude: geometry.coordinates[0],
            latitude: geometry.coordinates[1]
        });
    }
    if (geometry.center) return normalizeGeometryCoordinates(geometry.center);
    if (geometry.centroid) return normalizeGeometryCoordinates(geometry.centroid);
    return null;
};

export const getFeatureAttributes = record => {
    if (!isObject(record)) return {};
    if (isObject(record.attributes)) return record.attributes;
    if (isObject(record.attr)) return record.attr;
    if (isObject(record.properties)) return record.properties;
    return record;
};

export const adaptFeatureRecord = (record, sourceIndex = 0) => {
    if (!isObject(record)) return null;
    const attributes = getFeatureAttributes(record);
    const geometry = record.geometry ?? attributes.geometry ?? null;
    const coordinates = normalizeGeometryCoordinates(geometry)
        || normalizeCoordinates(attributes)
        || normalizeCoordinates(record);
    const id = normalizeId(
        record.id
        ?? attributes.id
        ?? attributes.Id
        ?? attributes.OBJECTID
        ?? attributes.objectid
        ?? attributes.GlobalID
        ?? attributes.GLOBALID
    );
    return {
        ...attributes,
        ...(id !== null ? { id } : {}),
        ...(coordinates ? {
            coordinates,
            latitude: coordinates.latitude,
            longitude: coordinates.longitude
        } : {}),
        geometry,
        attr: isObject(record.attr) ? record.attr : undefined,
        attributes: isObject(record.attributes) ? record.attributes : undefined,
        properties: isObject(record.properties) ? record.properties : undefined,
        sourceIndex,
        source: record
    };
};

export const findRecordContainer = (payload, depth = 0, visited = new WeakSet()) => {
    if (Array.isArray(payload)) return { records: payload, key: "array", owner: null, depth };
    if (!isObject(payload) || depth > MAX_UNWRAP_DEPTH) return null;
    if (visited.has(payload)) return null;
    visited.add(payload);
    for (const key of RESULT_CONTAINER_KEYS) {
        if (Array.isArray(payload[key])) {
            return { records: payload[key], key, owner: payload, depth };
        }
    }
    for (const key of RESULT_CONTAINER_KEYS) {
        const nested = payload[key];
        if (!isObject(nested)) continue;
        const found = findRecordContainer(nested, depth + 1, visited);
        if (found) return found;
    }
    const serviceCandidates = [payload.result, payload.Result, payload.response, payload.Response, payload.value, payload.Value];
    for (const nested of serviceCandidates) {
        if (!isObject(nested) && !Array.isArray(nested)) continue;
        const found = findRecordContainer(nested, depth + 1, visited);
        if (found) return found;
    }
    return null;
};

export const extractResultRecords = payload => {
    const container = findRecordContainer(payload);
    return container ? container.records : [];
};

export const normalizeAdapterRecord = (record, sourceIndex = 0, options = {}) => {
    const adapted = adaptFeatureRecord(record, sourceIndex);
    if (!adapted) return null;
    const normalized = normalizeRecord(adapted, options.schema || {});
    const fallbackId = normalizeId(adapted.id);
    const id = normalized?.id ?? fallbackId;
    const fingerprint = normalized
        ? createRecordFingerprint(normalized)
        : id !== null
            ? `id:${id}`
            : null;
    return {
        ...adapted,
        ...(id !== null ? { id } : {}),
        adapterFingerprint: fingerprint,
        adapterValidation: {
            normalized: Boolean(normalized),
            hasId: id !== null,
            hasCoordinates: Boolean(adapted.coordinates),
            hasGeometry: Boolean(adapted.geometry)
        }
    };
};

export const dedupeAdaptedRecords = records => {
    const seen = new Set();
    const output = [];
    let duplicates = 0;
    (Array.isArray(records) ? records : []).forEach((record, index) => {
        const normalized = normalizeAdapterRecord(record, index);
        if (!normalized) return;
        const key = normalized.adapterFingerprint;
        if (key && seen.has(key)) {
            duplicates += 1;
            return;
        }
        if (key) seen.add(key);
        output.push(normalized);
    });
    return { records: output, duplicates };
};

export const readResultFields = payload => {
    const candidates = [
        payload?.fields,
        payload?.Fields,
        payload?.data?.fields,
        payload?.Data?.fields,
        payload?.result?.fields,
        payload?.Result?.fields
    ];
    const fields = candidates.find(Array.isArray);
    return Array.isArray(fields) ? fields.filter(Boolean) : [];
};

export const readTransferLimit = payload => Boolean(
    payload?.exceededTransferLimit
    ?? payload?.ExceededTransferLimit
    ?? payload?.data?.exceededTransferLimit
    ?? payload?.Data?.exceededTransferLimit
    ?? payload?.result?.exceededTransferLimit
    ?? payload?.Result?.exceededTransferLimit
);

export const normalizeResultPage = (payload, recordCount, options = {}) => {
    const requested = normalizePagination({
        offset: options.offset ?? payload?.offset ?? payload?.resultOffset ?? 0,
        limit: options.limit ?? payload?.limit ?? payload?.resultRecordCount ?? DEFAULT_ADAPTER_LIMIT
    });
    const offset = requested.offset;
    const limit = Math.min(MAX_ADAPTER_LIMIT, requested.limit);
    const count = normalizeInteger(recordCount, { min: 0, fallback: 0 });
    const explicitTotal = toFiniteNumber(
        payload?.total
        ?? payload?.totalCount
        ?? payload?.TotalCount
        ?? payload?.countTotal
        ?? payload?.data?.total
        ?? payload?.Data?.total
    );
    const explicitNextOffset = toFiniteNumber(
        payload?.nextOffset
        ?? payload?.NextOffset
        ?? payload?.data?.nextOffset
        ?? payload?.Data?.nextOffset
    );
    const transferLimited = readTransferLimit(payload);
    const progressedOffset = offset + count;
    const nextOffset = explicitNextOffset !== null && explicitNextOffset > offset
        ? Math.trunc(explicitNextOffset)
        : count > 0 && transferLimited
            ? progressedOffset
            : null;
    const hasMoreByTotal = explicitTotal !== null && progressedOffset < explicitTotal;
    const hasMore = count > 0 && (transferLimited || hasMoreByTotal || nextOffset !== null);
    return {
        offset,
        limit,
        count,
        total: explicitTotal === null ? null : Math.max(0, Math.trunc(explicitTotal)),
        hasMore,
        nextOffset: hasMore ? (nextOffset ?? progressedOffset) : null,
        transferLimited,
        progressed: count > 0
    };
};

export const inferResultContract = payload => {
    if (Array.isArray(payload)) return "array";
    if (!isObject(payload)) return "empty";
    if (Array.isArray(payload.features)) return "arcgis-or-geojson";
    if (hasOwn(payload, "Title") && hasOwn(payload, "Data")) return "legacy-service-result";
    if (hasOwn(payload, "title") && hasOwn(payload, "data")) return "service-result";
    if (Array.isArray(payload.records)) return "records";
    if (Array.isArray(payload.results)) return "results";
    if (findRecordContainer(payload)) return "nested";
    return "object";
};

export const collectPayloadDiagnostics = (payload, adaptedRecords, options = {}) => {
    const inputRecords = extractResultRecords(payload);
    const invalidCount = inputRecords.reduce((count, record) => count + (adaptFeatureRecord(record) ? 0 : 1), 0);
    const withCoordinates = adaptedRecords.filter(record => record.coordinates).length;
    const withId = adaptedRecords.filter(record => normalizeId(record.id) !== null).length;
    return {
        contract: inferResultContract(payload),
        inputCount: inputRecords.length,
        acceptedCount: adaptedRecords.length,
        invalidCount,
        duplicateCount: options.duplicateCount || 0,
        coordinateCount: withCoordinates,
        missingCoordinateCount: adaptedRecords.length - withCoordinates,
        idCount: withId,
        missingIdCount: adaptedRecords.length - withId,
        fieldCount: readResultFields(payload).length,
        transferLimited: readTransferLimit(payload)
    };
};

export const adaptSearchResult = (payload, options = {}) => {
    const input = extractResultRecords(payload);
    const adapted = input
        .map((record, index) => normalizeAdapterRecord(record, index, options))
        .filter(Boolean);
    let records = adapted;
    let duplicateCount = 0;
    if (options.dedupe !== false) {
        const deduped = dedupeAdaptedRecords(adapted);
        records = deduped.records;
        duplicateCount = deduped.duplicates;
    }
    const page = normalizeResultPage(payload, records.length, options);
    const status = normalizeResultStatus(payload);
    const explicitError = normalizeResultError(payload);
    const statusError = isFailureStatus(status) && !explicitError
        ? new Error(`Search result reported failure status: ${status}`)
        : null;
    const error = explicitError || statusError;
    const title = normalizeResultTitle(payload, options.title || "");
    const presentations = options.presentation === false
        ? []
        : createRecordPresentations(records, options.presentationOptions || {});
    return {
        title,
        status,
        ok: !error && !isFailureStatus(status),
        error,
        records,
        presentations,
        iconCoverage: options.presentation === false ? null : createIconCoverageReport(presentations),
        fields: readResultFields(payload),
        page,
        diagnostics: collectPayloadDiagnostics(payload, records, { duplicateCount }),
        raw: options.includeRaw === true ? payload : undefined
    };
};

export const createEmptySearchResult = (options = {}) => ({
    title: normalizeText(options.title),
    status: "",
    ok: options.ok !== false,
    error: options.error || null,
    records: [],
    presentations: [],
    iconCoverage: options.presentation === false ? null : createIconCoverageReport([]),
    fields: [],
    page: {
        offset: normalizeInteger(options.offset, { min: 0, fallback: 0 }),
        limit: normalizeInteger(options.limit, { min: 1, max: MAX_ADAPTER_LIMIT, fallback: DEFAULT_ADAPTER_LIMIT }),
        count: 0,
        total: options.total === null ? null : normalizeInteger(options.total, { min: 0, fallback: 0 }),
        hasMore: false,
        nextOffset: null,
        transferLimited: false,
        progressed: false
    },
    diagnostics: {
        contract: "empty",
        inputCount: 0,
        acceptedCount: 0,
        invalidCount: 0,
        duplicateCount: 0,
        coordinateCount: 0,
        missingCoordinateCount: 0,
        idCount: 0,
        missingIdCount: 0,
        fieldCount: 0,
        transferLimited: false
    },
    raw: undefined
});

export const mergeAdaptedSearchResults = (previous, next, options = {}) => {
    const left = Array.isArray(previous?.records) ? previous.records : [];
    const right = Array.isArray(next?.records) ? next.records : [];
    const combined = [...left, ...right];
    const deduped = options.dedupe === false
        ? { records: combined, duplicates: 0 }
        : dedupeAdaptedRecords(combined);
    const presentations = options.presentation === false
        ? []
        : createRecordPresentations(deduped.records, options.presentationOptions || {});
    const nextPage = next?.page || {};
    const hasMore = nextPage.hasMore === true && nextPage.nextOffset !== null;
    return {
        ...next,
        title: next?.title || previous?.title || "",
        ok: previous?.ok !== false && next?.ok !== false,
        error: next?.error || previous?.error || null,
        records: deduped.records,
        presentations,
        iconCoverage: options.presentation === false ? null : createIconCoverageReport(presentations),
        fields: Array.isArray(next?.fields) && next.fields.length ? next.fields : previous?.fields || [],
        page: {
            ...nextPage,
            count: deduped.records.length,
            hasMore,
            nextOffset: hasMore ? nextPage.nextOffset : null
        },
        diagnostics: {
            ...(next?.diagnostics || {}),
            mergedPageCount: (previous?.diagnostics?.mergedPageCount || 1) + 1,
            mergedRecordCount: deduped.records.length,
            duplicateCount: (previous?.diagnostics?.duplicateCount || 0)
                + (next?.diagnostics?.duplicateCount || 0)
                + deduped.duplicates
        }
    };
};

export const createAdapterPageIterator = (initialOptions = {}) => {
    const initial = normalizePagination({
        offset: initialOptions.offset,
        limit: initialOptions.limit ?? DEFAULT_ADAPTER_LIMIT
    });
    return {
        offset: initial.offset,
        limit: Math.min(initial.limit, MAX_ADAPTER_LIMIT),
        pages: 0,
        received: 0,
        done: false
    };
};

export const advanceAdapterPageIterator = (state, result) => {
    const current = state || createAdapterPageIterator();
    const count = normalizeInteger(result?.page?.count, { min: 0, fallback: 0 });
    const candidate = normalizeInteger(result?.page?.nextOffset, { min: 0, fallback: null });
    const progressed = candidate !== null && candidate > current.offset;
    const hasMore = result?.page?.hasMore === true;
    return {
        ...current,
        offset: hasMore && progressed ? candidate : current.offset + count,
        pages: current.pages + 1,
        received: current.received + count,
        done: !hasMore || (!progressed && count === 0)
    };
};

export const SearchResultAdapterRuntime = {
    RESULT_CONTAINER_KEYS,
    RESULT_TITLE_KEYS,
    RESULT_ERROR_KEYS,
    RESULT_STATUS_KEYS,
    DEFAULT_ADAPTER_LIMIT,
    MAX_ADAPTER_LIMIT,
    normalizeResultTitle,
    normalizeResultStatus,
    normalizeResultError,
    isFailureStatus,
    isSuccessStatus,
    normalizeGeometryCoordinates,
    getFeatureAttributes,
    adaptFeatureRecord,
    findRecordContainer,
    extractResultRecords,
    normalizeAdapterRecord,
    dedupeAdaptedRecords,
    readResultFields,
    readTransferLimit,
    normalizeResultPage,
    inferResultContract,
    collectPayloadDiagnostics,
    adaptSearchResult,
    createEmptySearchResult,
    mergeAdaptedSearchResults,
    createAdapterPageIterator,
    advanceAdapterPageIterator
};