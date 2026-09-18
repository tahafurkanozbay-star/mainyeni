import {
    createRecordFingerprint,
    normalizeCoordinates,
    normalizeId,
    normalizeInteger,
    normalizePagination,
    normalizeRecord,
    normalizeText,
    type Coordinates,
    type RecordSchema
} from "./DataIntegrityHelper";
import {
    createIconCoverageReport,
    createRecordPresentations,
    type IconCoverageReport,
    type RecordPresentation,
    type RecordPresentationOptions
} from "./RecordPresentationRuntime";

export const RESULT_CONTAINER_KEYS = Object.freeze([
    "records", "results", "features", "items", "data", "Data"
] as const);
export const RESULT_TITLE_KEYS = Object.freeze([
    "title", "Title", "serviceTitle", "ServiceTitle", "name", "Name"
] as const);
export const RESULT_ERROR_KEYS = Object.freeze([
    "error", "Error", "message", "Message", "errorMessage", "ErrorMessage"
] as const);
export const RESULT_STATUS_KEYS = Object.freeze([
    "status", "Status", "resultType", "ResultType", "type", "Type"
] as const);

export const DEFAULT_ADAPTER_LIMIT = 50;
export const MAX_ADAPTER_LIMIT = 1000;
export const MAX_UNWRAP_DEPTH = 8;

type UnknownRecord = Record<string, unknown>;

export type ResultContract =
    | "array"
    | "empty"
    | "arcgis-or-geojson"
    | "legacy-service-result"
    | "service-result"
    | "records"
    | "results"
    | "nested"
    | "object";

export interface AdaptedFeatureRecord extends UnknownRecord {
    id?: string;
    coordinates?: Coordinates;
    latitude?: number;
    longitude?: number;
    geometry: unknown;
    attr: UnknownRecord | undefined;
    attributes: UnknownRecord | undefined;
    properties: UnknownRecord | undefined;
    sourceIndex: number;
    source: UnknownRecord;
}

export interface AdapterValidation {
    normalized: boolean;
    hasId: boolean;
    hasCoordinates: boolean;
    hasGeometry: boolean;
}

export interface AdapterRecord extends AdaptedFeatureRecord {
    adapterFingerprint: string | null;
    adapterValidation: AdapterValidation;
}

export interface RecordContainer {
    records: unknown[];
    key: string;
    owner: UnknownRecord | null;
    depth: number;
}

export interface AdapterRecordOptions {
    schema?: RecordSchema;
}

export interface AdapterPageOptions {
    offset?: unknown;
    limit?: unknown;
}

export interface AdapterOptions extends AdapterRecordOptions, AdapterPageOptions {
    dedupe?: boolean;
    presentation?: boolean;
    presentationOptions?: RecordPresentationOptions;
    title?: unknown;
    includeRaw?: boolean;
    duplicateCount?: number;
    ok?: boolean;
    error?: unknown;
    total?: unknown;
}

export interface AdapterPage {
    offset: number;
    limit: number;
    count: number;
    total: number | null;
    hasMore: boolean;
    nextOffset: number | null;
    transferLimited: boolean;
    progressed: boolean;
}

export interface AdapterDiagnostics extends Record<string, unknown> {
    contract: ResultContract;
    inputCount: number;
    acceptedCount: number;
    invalidCount: number;
    duplicateCount: number;
    coordinateCount: number;
    missingCoordinateCount: number;
    idCount: number;
    missingIdCount: number;
    fieldCount: number;
    transferLimited: boolean;
    mergedPageCount?: number;
    mergedRecordCount?: number;
}

export interface AdaptedSearchResult {
    title: string;
    status: string;
    ok: boolean;
    error: Error | unknown | null;
    records: AdapterRecord[];
    presentations: RecordPresentation[];
    iconCoverage: IconCoverageReport | null;
    fields: unknown[];
    page: AdapterPage;
    diagnostics: AdapterDiagnostics;
    raw: unknown | undefined;
}

export interface AdapterPageIterator {
    offset: number;
    limit: number;
    pages: number;
    received: number;
    done: boolean;
}

const isObject = (value: unknown): value is UnknownRecord =>
    value !== null && typeof value === "object" && !Array.isArray(value);

const hasOwn = (value: unknown, key: string): boolean =>
    Boolean(isObject(value) && Object.prototype.hasOwnProperty.call(value, key));

const firstDefined = (value: unknown, keys: readonly string[]): unknown => {
    if (!isObject(value)) return undefined;
    for (const key of keys) {
        if (hasOwn(value, key) && value[key] !== undefined && value[key] !== null) return value[key];
    }
    return undefined;
};

const readProperty = (value: unknown, key: string): unknown =>
    isObject(value) ? value[key] : undefined;

const readNestedProperty = (value: unknown, container: string, key: string): unknown =>
    readProperty(readProperty(value, container), key);

const toFiniteNumber = (value: unknown): number | null => {
    if (value === "" || value === null || value === undefined) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
};

const normalizeTechnicalToken = (value: unknown): string => normalizeText(value).toLowerCase();

export const normalizeResultTitle = (payload: unknown, fallback = ""): string => normalizeText(
    firstDefined(payload, RESULT_TITLE_KEYS) ?? fallback
);

export const normalizeResultStatus = (payload: unknown): string => normalizeTechnicalToken(
    firstDefined(payload, RESULT_STATUS_KEYS) ?? ""
);

export const normalizeResultError = (payload: unknown): Error | null => {
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

export const isFailureStatus = (status: unknown): boolean => [
    "error", "failed", "failure", "fail", "exception", "hata", "false", "0"
].includes(normalizeTechnicalToken(status));

export const isSuccessStatus = (status: unknown): boolean => [
    "success", "ok", "successful", "başarılı", "basarili", "true", "1"
].includes(normalizeTechnicalToken(status));

export const normalizeGeometryCoordinates = (geometry: unknown): Coordinates | null => {
    if (!isObject(geometry)) return null;
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

export const getFeatureAttributes = (record: unknown): UnknownRecord => {
    if (!isObject(record)) return {};
    if (isObject(record.attributes)) return record.attributes;
    if (isObject(record.attr)) return record.attr;
    if (isObject(record.properties)) return record.properties;
    return record;
};

export const adaptFeatureRecord = (
    record: unknown,
    sourceIndex = 0
): AdaptedFeatureRecord | null => {
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

export const findRecordContainer = (
    payload: unknown,
    depth = 0,
    visited: WeakSet<object> = new WeakSet()
): RecordContainer | null => {
    if (Array.isArray(payload)) return { records: payload, key: "array", owner: null, depth };
    if (!isObject(payload) || depth > MAX_UNWRAP_DEPTH || visited.has(payload)) return null;
    visited.add(payload);

    for (const key of RESULT_CONTAINER_KEYS) {
        if (Array.isArray(payload[key])) {
            return { records: payload[key] as unknown[], key, owner: payload, depth };
        }
    }
    for (const key of RESULT_CONTAINER_KEYS) {
        const nested = payload[key];
        if (!isObject(nested)) continue;
        const found = findRecordContainer(nested, depth + 1, visited);
        if (found) return found;
    }
    for (const nested of [
        payload.result,
        payload.Result,
        payload.response,
        payload.Response,
        payload.value,
        payload.Value
    ]) {
        if (!isObject(nested) && !Array.isArray(nested)) continue;
        const found = findRecordContainer(nested, depth + 1, visited);
        if (found) return found;
    }
    return null;
};

export const extractResultRecords = (payload: unknown): unknown[] =>
    findRecordContainer(payload)?.records || [];

export const normalizeAdapterRecord = (
    record: unknown,
    sourceIndex = 0,
    options: AdapterRecordOptions = {}
): AdapterRecord | null => {
    const adapted = adaptFeatureRecord(record, sourceIndex);
    if (!adapted) return null;
    const normalized = normalizeRecord(adapted, options.schema || {});
    const fallbackId = normalizeId(adapted.id);
    const id = normalized?.id ?? fallbackId;
    const fingerprint = normalized
        ? createRecordFingerprint(normalized)
        : id !== null ? `id:${id}` : null;
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

export const dedupeAdaptedRecords = (
    records: unknown
): { records: AdapterRecord[]; duplicates: number } => {
    const seen = new Set<string>();
    const output: AdapterRecord[] = [];
    let duplicates = 0;
    const input = Array.isArray(records) ? records : [];
    input.forEach((record, index) => {
        const normalized = isObject(record) && isObject(record.adapterValidation)
            ? record as unknown as AdapterRecord
            : normalizeAdapterRecord(record, index);
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

export const readResultFields = (payload: unknown): unknown[] => {
    const candidates = [
        readProperty(payload, "fields"),
        readProperty(payload, "Fields"),
        readNestedProperty(payload, "data", "fields"),
        readNestedProperty(payload, "Data", "fields"),
        readNestedProperty(payload, "result", "fields"),
        readNestedProperty(payload, "Result", "fields")
    ];
    const fields = candidates.find(Array.isArray);
    if (!Array.isArray(fields)) return [];
    return fields.every(Boolean) ? fields : fields.filter(Boolean);
};

export const readTransferLimit = (payload: unknown): boolean => Boolean(
    readProperty(payload, "exceededTransferLimit")
    ?? readProperty(payload, "ExceededTransferLimit")
    ?? readNestedProperty(payload, "data", "exceededTransferLimit")
    ?? readNestedProperty(payload, "Data", "exceededTransferLimit")
    ?? readNestedProperty(payload, "result", "exceededTransferLimit")
    ?? readNestedProperty(payload, "Result", "exceededTransferLimit")
);

export const normalizeResultPage = (
    payload: unknown,
    recordCount: unknown,
    options: AdapterPageOptions = {}
): AdapterPage => {
    const requested = normalizePagination({
        offset: options.offset
            ?? readProperty(payload, "offset")
            ?? readProperty(payload, "resultOffset")
            ?? 0,
        limit: options.limit
            ?? readProperty(payload, "limit")
            ?? readProperty(payload, "resultRecordCount")
            ?? DEFAULT_ADAPTER_LIMIT
    });
    const offset = requested.offset;
    const limit = Math.min(MAX_ADAPTER_LIMIT, requested.limit);
    const count = normalizeInteger(recordCount, { min: 0, fallback: 0 }) ?? 0;
    const explicitTotal = toFiniteNumber(
        readProperty(payload, "total")
        ?? readProperty(payload, "totalCount")
        ?? readProperty(payload, "TotalCount")
        ?? readProperty(payload, "countTotal")
        ?? readNestedProperty(payload, "data", "total")
        ?? readNestedProperty(payload, "Data", "total")
    );
    const explicitNextOffset = toFiniteNumber(
        readProperty(payload, "nextOffset")
        ?? readProperty(payload, "NextOffset")
        ?? readNestedProperty(payload, "data", "nextOffset")
        ?? readNestedProperty(payload, "Data", "nextOffset")
    );
    const transferLimited = readTransferLimit(payload);
    const progressedOffset = offset + count;
    const forwardExplicit = explicitNextOffset !== null && explicitNextOffset > offset
        ? Math.trunc(explicitNextOffset)
        : null;
    const hasMoreByTotal = explicitTotal !== null && progressedOffset < explicitTotal;
    const hasMore = count > 0 && (transferLimited || hasMoreByTotal || forwardExplicit !== null);
    return {
        offset,
        limit,
        count,
        total: explicitTotal === null ? null : Math.max(0, Math.trunc(explicitTotal)),
        hasMore,
        nextOffset: hasMore ? (forwardExplicit ?? progressedOffset) : null,
        transferLimited,
        progressed: count > 0
    };
};

export const inferResultContract = (payload: unknown): ResultContract => {
    if (Array.isArray(payload)) return "array";
    if (!isObject(payload)) return "empty";
    if (Array.isArray(payload.features)) return "arcgis-or-geojson";
    if (hasOwn(payload, "Title") && hasOwn(payload, "Data")) return "legacy-service-result";
    if (hasOwn(payload, "title") && hasOwn(payload, "data")) return "service-result";
    if (Array.isArray(payload.records)) return "records";
    if (Array.isArray(payload.results)) return "results";
    return findRecordContainer(payload) ? "nested" : "object";
};

export const collectPayloadDiagnostics = (
    payload: unknown,
    adaptedRecords: readonly AdapterRecord[],
    options: Pick<AdapterOptions, "duplicateCount"> = {}
): AdapterDiagnostics => {
    const inputRecords = extractResultRecords(payload);
    const invalidCount = inputRecords.reduce(
        (count, record) => count + (adaptFeatureRecord(record) ? 0 : 1),
        0
    );
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

export const adaptSearchResult = (
    payload: unknown,
    options: AdapterOptions = {}
): AdaptedSearchResult => {
    const adapted = extractResultRecords(payload)
        .map((record, index) => normalizeAdapterRecord(record, index, options))
        .filter((record): record is AdapterRecord => record !== null);
    const deduped = options.dedupe === false
        ? { records: adapted, duplicates: 0 }
        : dedupeAdaptedRecords(adapted);
    const records = deduped.records;
    const page = normalizeResultPage(payload, records.length, options);
    const status = normalizeResultStatus(payload);
    const explicitError = normalizeResultError(payload);
    const statusError = isFailureStatus(status) && !explicitError
        ? new Error(`Search result reported failure status: ${status}`)
        : null;
    const error = explicitError || statusError;
    const presentations = options.presentation === false
        ? []
        : createRecordPresentations(records, options.presentationOptions || {});
    return {
        title: normalizeResultTitle(payload, normalizeText(options.title)),
        status,
        ok: !error && !isFailureStatus(status),
        error,
        records,
        presentations,
        iconCoverage: options.presentation === false ? null : createIconCoverageReport(presentations),
        fields: readResultFields(payload),
        page,
        diagnostics: collectPayloadDiagnostics(payload, records, { duplicateCount: deduped.duplicates }),
        raw: options.includeRaw === true ? payload : undefined
    };
};

export const createEmptySearchResult = (
    options: AdapterOptions = {}
): AdaptedSearchResult => ({
    title: normalizeText(options.title),
    status: "",
    ok: options.ok !== false,
    error: options.error || null,
    records: [],
    presentations: [],
    iconCoverage: options.presentation === false ? null : createIconCoverageReport([]),
    fields: [],
    page: {
        offset: normalizeInteger(options.offset, { min: 0, fallback: 0 }) ?? 0,
        limit: normalizeInteger(options.limit, {
            min: 1,
            max: MAX_ADAPTER_LIMIT,
            fallback: DEFAULT_ADAPTER_LIMIT
        }) ?? DEFAULT_ADAPTER_LIMIT,
        count: 0,
        total: options.total === null
            ? null
            : normalizeInteger(options.total, { min: 0, fallback: 0 }) ?? 0,
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

export const mergeAdaptedSearchResults = (
    previous: AdaptedSearchResult | null | undefined,
    next: AdaptedSearchResult | null | undefined,
    options: AdapterOptions = {}
) => {
    const combined = [
        ...(Array.isArray(previous?.records) ? previous.records : []),
        ...(Array.isArray(next?.records) ? next.records : [])
    ];
    const deduped = options.dedupe === false
        ? { records: combined, duplicates: 0 }
        : dedupeAdaptedRecords(combined);
    const presentations = options.presentation === false
        ? []
        : createRecordPresentations(deduped.records, options.presentationOptions || {});
    const nextPage: Partial<AdapterPage> = next?.page ?? {};
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
            ...(next?.diagnostics ?? {}),
            mergedPageCount: (previous?.diagnostics?.mergedPageCount || 1) + 1,
            mergedRecordCount: deduped.records.length,
            duplicateCount: (previous?.diagnostics?.duplicateCount || 0)
                + (next?.diagnostics?.duplicateCount || 0)
                + deduped.duplicates
        }
    };
};

export const createAdapterPageIterator = (
    initialOptions: AdapterPageOptions = {}
): AdapterPageIterator => {
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

export const advanceAdapterPageIterator = (
    state: AdapterPageIterator | null | undefined,
    result: AdaptedSearchResult | null | undefined
): AdapterPageIterator => {
    const current = state || createAdapterPageIterator();
    const count = normalizeInteger(result?.page?.count, { min: 0, fallback: 0 }) ?? 0;
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
