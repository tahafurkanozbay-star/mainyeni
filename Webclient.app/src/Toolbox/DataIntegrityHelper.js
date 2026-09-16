const DEFAULT_LOCALE = "tr-TR";
const MAX_PAGE_SIZE = 1000;
const MAX_CONTROL_CHARACTER_CODE = 31;
const DELETE_CHARACTER_CODE = 127;

const isNil = value => value === null || value === undefined;
const isPlainObject = value => Object.prototype.toString.call(value) === "[object Object]";

export const replaceControlCharacters = value => String(value)
    .split("")
    .map(character => {
        const code = character.charCodeAt(0);
        return code <= MAX_CONTROL_CHARACTER_CODE || code === DELETE_CHARACTER_CODE ? " " : character;
    })
    .join("");

export const normalizeText = (value, { locale = DEFAULT_LOCALE, empty = "" } = {}) => {
    if (isNil(value)) return empty;
    return replaceControlCharacters(value)
        .normalize("NFKC")
        .replace(/\s+/g, " ")
        .trim();
};

export const normalizeSearchText = (value, locale = DEFAULT_LOCALE) => normalizeText(value)
    .toLocaleLowerCase(locale)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ı/g, "i");

export const normalizeCategoryKey = value => normalizeSearchText(value)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export const normalizeFiniteNumber = (value, fallback = null) => {
    if (value === "" || isNil(value)) return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
};

export const normalizeInteger = (value, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER, fallback = null } = {}) => {
    const number = normalizeFiniteNumber(value, fallback);
    if (number === fallback || !Number.isInteger(number)) return fallback;
    return Math.min(max, Math.max(min, number));
};

export const normalizePagination = ({ offset = 0, limit = 50 } = {}) => ({
    offset: normalizeInteger(offset, { min: 0, fallback: 0 }),
    limit: normalizeInteger(limit, { min: 1, max: MAX_PAGE_SIZE, fallback: 50 })
});

export const normalizeCoordinate = (value, axis) => {
    const number = normalizeFiniteNumber(value);
    if (number === null) return null;
    const bounds = axis === "lat" ? [-90, 90] : axis === "lon" ? [-180, 180] : null;
    if (!bounds || number < bounds[0] || number > bounds[1]) return null;
    return number;
};

export const normalizeCoordinates = value => {
    if (!value) return null;
    const latitude = normalizeCoordinate(value.latitude ?? value.lat ?? value.y, "lat");
    const longitude = normalizeCoordinate(value.longitude ?? value.lon ?? value.lng ?? value.x, "lon");
    return latitude === null || longitude === null ? null : { latitude, longitude };
};

export const normalizeId = value => {
    if (isNil(value)) return null;
    if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
    const normalized = normalizeText(value);
    return normalized || null;
};

export const pickFirst = (record, keys, fallback = null) => {
    if (!isPlainObject(record)) return fallback;
    for (const key of keys) {
        const value = record[key];
        if (!isNil(value) && value !== "") return value;
    }
    return fallback;
};

export const normalizeRecord = (record, schema = {}) => {
    if (!isPlainObject(record)) return null;
    const id = normalizeId(pickFirst(record, schema.id || ["id", "objectid", "OBJECTID", "globalid", "GLOBALID"]));
    const title = normalizeText(pickFirst(record, schema.title || ["title", "adi", "name", "ADI", "NAME"], ""));
    const category = normalizeText(pickFirst(record, schema.category || ["category", "kategori", "type", "tur"], ""));
    const address = normalizeText(pickFirst(record, schema.address || ["address", "adres", "ADRES"], ""));
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

export const createRecordFingerprint = record => {
    if (!record) return null;
    if (record.id) return `id:${record.id}`;
    const coords = record.coordinates ? `${record.coordinates.latitude.toFixed(6)},${record.coordinates.longitude.toFixed(6)}` : "";
    const semantic = [record.searchTitle, record.searchAddress, record.categoryKey, coords].join("|");
    return semantic.replace(/\|/g, "") ? `semantic:${semantic}` : null;
};

export const normalizeRecords = (records, schema = {}) => {
    const input = Array.isArray(records) ? records : [];
    const seen = new Set();
    const normalized = [];
    const diagnostics = { input: input.length, accepted: 0, invalid: 0, duplicates: 0 };
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

export const createSearchIndex = records => (Array.isArray(records) ? records : []).map((record, index) => ({
    index,
    record,
    haystack: [record.searchTitle, record.searchAddress, record.categoryKey].filter(Boolean).join(" ")
}));

export const searchIndex = (index, query, { offset = 0, limit = 50, category = null } = {}) => {
    const page = normalizePagination({ offset, limit });
    const needle = normalizeSearchText(query);
    const categoryKey = category ? normalizeCategoryKey(category) : null;
    const matches = (Array.isArray(index) ? index : []).filter(item => {
        if (categoryKey && item.record?.categoryKey !== categoryKey) return false;
        return !needle || item.haystack.includes(needle);
    });
    const records = matches.slice(page.offset, page.offset + page.limit).map(item => item.record);
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

export const sortRecords = (records, field = "title", locale = DEFAULT_LOCALE) => [...(Array.isArray(records) ? records : [])]
    .sort((left, right) => normalizeText(left?.[field]).localeCompare(normalizeText(right?.[field]), locale, { sensitivity: "base", numeric: true }));

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
