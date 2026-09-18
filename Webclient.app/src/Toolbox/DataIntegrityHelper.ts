const DEFAULT_LOCALE = "tr-TR";
const MAX_PAGE_SIZE = 1000;
const MAX_CONTROL_CHARACTER_CODE = 31;
const DELETE_CHARACTER_CODE = 127;

type UnknownRecord = Record<string, unknown>;

export interface NormalizeTextOptions {
    locale?: string;
    empty?: string;
}

export interface IntegerOptions {
    min?: number;
    max?: number;
    fallback?: number | null;
}

export interface PaginationInput {
    offset?: unknown;
    limit?: unknown;
}

export interface Pagination {
    offset: number;
    limit: number;
}

export type CoordinateAxis = "lat" | "lon";

export interface Coordinates {
    latitude: number;
    longitude: number;
}

export interface RecordSchema {
    id?: readonly string[];
    title?: readonly string[];
    category?: readonly string[];
    address?: readonly string[];
    latitude?: readonly string[];
    longitude?: readonly string[];
}

export interface NormalizedRecord {
    id: string | null;
    title: string;
    searchTitle: string;
    category: string;
    categoryKey: string;
    address: string;
    searchAddress: string;
    coordinates: Coordinates | null;
    source: UnknownRecord;
}

export interface NormalizeRecordsDiagnostics {
    input: number;
    accepted: number;
    invalid: number;
    duplicates: number;
}

export interface NormalizeRecordsResult {
    records: NormalizedRecord[];
    diagnostics: NormalizeRecordsDiagnostics;
}

export interface SearchIndexEntry {
    index: number;
    record: NormalizedRecord;
    haystack: string;
}

export interface SearchIndexOptions {
    offset?: unknown;
    limit?: unknown;
    category?: unknown;
}

export interface SearchIndexPage extends Pagination {
    count: number;
    total: number;
    hasMore: boolean;
    nextOffset: number | null;
}

export interface SearchIndexResult {
    records: NormalizedRecord[];
    page: SearchIndexPage;
}

const isNil = (value: unknown): value is null | undefined =>
    value === null || value === undefined;

const isPlainObject = (value: unknown): value is UnknownRecord =>
    Object.prototype.toString.call(value) === "[object Object]";

export const replaceControlCharacters = (value: unknown): string => String(value)
    .split("")
    .map(character => {
        const code = character.charCodeAt(0);
        return code <= MAX_CONTROL_CHARACTER_CODE || code === DELETE_CHARACTER_CODE ? " " : character;
    })
    .join("");

export const normalizeText = (
    value: unknown,
    { empty = "" }: NormalizeTextOptions = {}
): string => {
    if (isNil(value)) return empty;
    return replaceControlCharacters(value)
        .normalize("NFKC")
        .replace(/\s+/g, " ")
        .trim();
};

export const normalizeSearchText = (value: unknown, locale = DEFAULT_LOCALE): string =>
    normalizeText(value)
        .toLocaleLowerCase(locale)
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/ı/g, "i");

export const normalizeCategoryKey = (value: unknown): string =>
    normalizeSearchText(value)
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");

export const normalizeFiniteNumber = (
    value: unknown,
    fallback: number | null = null
): number | null => {
    if (value === "" || isNil(value)) return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
};

export const normalizeInteger = (
    value: unknown,
    {
        min = Number.MIN_SAFE_INTEGER,
        max = Number.MAX_SAFE_INTEGER,
        fallback = null
    }: IntegerOptions = {}
): number | null => {
    const number = normalizeFiniteNumber(value, fallback);
    if (number === null || number === fallback || !Number.isInteger(number)) return fallback;
    return Math.min(max, Math.max(min, number));
};

export const normalizePagination = (
    { offset = 0, limit = 50 }: PaginationInput = {}
): Pagination => ({
    offset: normalizeInteger(offset, { min: 0, fallback: 0 }) ?? 0,
    limit: normalizeInteger(limit, { min: 1, max: MAX_PAGE_SIZE, fallback: 50 }) ?? 50
});

export const normalizeCoordinate = (
    value: unknown,
    axis: CoordinateAxis
): number | null => {
    const number = normalizeFiniteNumber(value);
    if (number === null) return null;
    const bounds: readonly [number, number] | null = axis === "lat"
        ? [-90, 90]
        : axis === "lon"
            ? [-180, 180]
            : null;
    if (!bounds || number < bounds[0] || number > bounds[1]) return null;
    return number;
};

export const normalizeCoordinates = (value: unknown): Coordinates | null => {
    if (!isPlainObject(value)) return null;
    const latitude = normalizeCoordinate(value.latitude ?? value.lat ?? value.y, "lat");
    const longitude = normalizeCoordinate(value.longitude ?? value.lon ?? value.lng ?? value.x, "lon");
    return latitude === null || longitude === null ? null : { latitude, longitude };
};

export const normalizeId = (value: unknown): string | null => {
    if (isNil(value)) return null;
    if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
    const normalized = normalizeText(value);
    return normalized || null;
};

export const pickFirst = (
    record: unknown,
    keys: readonly string[],
    fallback: unknown = null
): unknown => {
    if (!isPlainObject(record)) return fallback;
    for (const key of keys) {
        const value = record[key];
        if (!isNil(value) && value !== "") return value;
    }
    return fallback;
};

export const normalizeRecord = (
    record: unknown,
    schema: RecordSchema = {}
): NormalizedRecord | null => {
    if (!isPlainObject(record)) return null;
    const id = normalizeId(pickFirst(
        record,
        schema.id || ["id", "objectid", "OBJECTID", "globalid", "GLOBALID"]
    ));
    const title = normalizeText(pickFirst(
        record,
        schema.title || ["title", "adi", "name", "ADI", "NAME"],
        ""
    ));
    const category = normalizeText(pickFirst(
        record,
        schema.category || ["category", "kategori", "type", "tur"],
        ""
    ));
    const address = normalizeText(pickFirst(
        record,
        schema.address || ["address", "adres", "ADRES"],
        ""
    ));
    const coordinates = normalizeCoordinates({
        latitude: pickFirst(record, schema.latitude || ["latitude", "lat", "y", "Y"]),
        longitude: pickFirst(record, schema.longitude || ["longitude", "lon", "lng", "x", "X"])
    });
    return {
        id,
        title,
        searchTitle: normalizeSearchText(title),
        category,
        categoryKey: normalizeCategoryKey(category),
        address,
        searchAddress: normalizeSearchText(address),
        coordinates,
        source: record
    };
};

export const createRecordFingerprint = (
    record: NormalizedRecord | null | undefined
): string | null => {
    if (!record) return null;
    if (record.id) return `id:${record.id}`;
    const coords = record.coordinates
        ? `${record.coordinates.latitude.toFixed(6)},${record.coordinates.longitude.toFixed(6)}`
        : "";
    const semantic = [
        record.searchTitle,
        record.searchAddress,
        record.categoryKey,
        coords
    ].join("|");
    return semantic.replace(/\|/g, "") ? `semantic:${semantic}` : null;
};

export const normalizeRecords = (
    records: unknown,
    schema: RecordSchema = {}
): NormalizeRecordsResult => {
    const input: unknown[] = Array.isArray(records) ? records : [];
    const seen = new Set<string>();
    const normalized: NormalizedRecord[] = [];
    const diagnostics: NormalizeRecordsDiagnostics = {
        input: input.length,
        accepted: 0,
        invalid: 0,
        duplicates: 0
    };

    input.forEach(record => {
        const item = normalizeRecord(record, schema);
        if (!item) {
            diagnostics.invalid += 1;
            return;
        }
        const fingerprint = createRecordFingerprint(item);
        if (fingerprint && seen.has(fingerprint)) {
            diagnostics.duplicates += 1;
            return;
        }
        if (fingerprint) seen.add(fingerprint);
        normalized.push(item);
    });

    diagnostics.accepted = normalized.length;
    return { records: normalized, diagnostics };
};

export const createSearchIndex = (records: unknown): SearchIndexEntry[] => {
    const input = (Array.isArray(records) ? records : []) as NormalizedRecord[];
    return input.map((record, index) => ({
        index,
        record,
        haystack: [
            record.searchTitle,
            record.searchAddress,
            record.categoryKey
        ].filter(Boolean).join(" ")
    }));
};

export const searchIndex = (
    index: unknown,
    query: unknown,
    { offset = 0, limit = 50, category = null }: SearchIndexOptions = {}
): SearchIndexResult => {
    const page = normalizePagination({ offset, limit });
    const needle = normalizeSearchText(query);
    const categoryKey = category ? normalizeCategoryKey(category) : null;
    const input = (Array.isArray(index) ? index : []) as SearchIndexEntry[];
    const matches = input.filter(item => {
        if (categoryKey && item.record?.categoryKey !== categoryKey) return false;
        return !needle || item.haystack.includes(needle);
    });
    const records = matches
        .slice(page.offset, page.offset + page.limit)
        .map(item => item.record);
    const nextOffset = page.offset + records.length;
    return {
        records,
        page: {
            offset: page.offset,
            limit: page.limit,
            count: records.length,
            total: matches.length,
            hasMore: nextOffset < matches.length,
            nextOffset: nextOffset < matches.length ? nextOffset : null
        }
    };
};

export const sortRecords = (
    records: unknown,
    field = "title",
    locale = DEFAULT_LOCALE
): unknown[] => {
    const input = Array.isArray(records) ? [...records] : [];
    return input.sort((left, right) => {
        const leftRecord = left as UnknownRecord | null | undefined;
        const rightRecord = right as UnknownRecord | null | undefined;
        return normalizeText(leftRecord?.[field]).localeCompare(
            normalizeText(rightRecord?.[field]),
            locale,
            { sensitivity: "base", numeric: true }
        );
    });
};

export const DataIntegrityHelper = {
    replaceControlCharacters,
    normalizeText,
    normalizeSearchText,
    normalizeCategoryKey,
    normalizeFiniteNumber,
    normalizeInteger,
    normalizePagination,
    normalizeCoordinate,
    normalizeCoordinates,
    normalizeId,
    pickFirst,
    normalizeRecord,
    createRecordFingerprint,
    normalizeRecords,
    createSearchIndex,
    searchIndex,
    sortRecords
};
