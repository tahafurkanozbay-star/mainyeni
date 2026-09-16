import {
    create3DGraphicModel,
    createListIconModel,
    createPictureMarkerSymbol,
    getIconKey,
    resolveRecordIcon,
    resolveRecordIconUrl
} from "../gis-engine/iconPresentation";
import {
    normalizeCategoryKey,
    normalizeSearchText,
    normalizeText
} from "./DataIntegrityHelper";
import {
    GENERIC_RECORD_SCHEMA,
    createSearchDocumentFromSchema
} from "./RecordSchemaRuntime";

const readNestedCandidate = (record, keys) => {
    const sources = [record, record?.attr, record?.attributes, record?.properties].filter(Boolean);
    for (const source of sources) {
        for (const key of keys) {
            const value = source?.[key];
            if (value !== null && value !== undefined && normalizeText(value) !== "") return value;
        }
    }
    return null;
};

export const createSharedIconCandidate = (record, normalizedDocument = null) => {
    const document = normalizedDocument || createSearchDocumentFromSchema(record, GENERIC_RECORD_SCHEMA, 0);
    const type = normalizeText(
        document.type
        || readNestedCandidate(record, ["type", "Type", "TYPE", "tur", "TUR", "tip", "TIP"])
    );
    const category = normalizeText(
        document.category
        || readNestedCandidate(record, ["category", "Category", "KATEGORI", "kategori"])
    );
    const iconKey = normalizeText(
        readNestedCandidate(record, ["iconKey", "IconKey", "ICON_KEY", "serviceTitle", "ServiceTitle", "titleKey"])
    );
    const id = normalizeText(document.id || readNestedCandidate(record, ["id", "Id", "OBJECTID"]));
    return {
        type,
        category,
        kind: normalizeText(readNestedCandidate(record, ["kind", "Kind", "KIND"])),
        className: normalizeText(readNestedCandidate(record, ["className", "ClassName", "CLASS_NAME"])),
        iconKey,
        id
    };
};

export const resolveSharedRecordIcon = (record, options = {}) => {
    const document = options.document || createSearchDocumentFromSchema(
        record,
        options.schema || GENERIC_RECORD_SCHEMA,
        options.sourceIndex || 0
    );
    const candidate = createSharedIconCandidate(record, document);
    const resolved = resolveRecordIcon(candidate, {
        fallback: options.fallback || "default",
        onFallback: options.onFallback
    });
    return {
        ...resolved,
        candidate,
        url: resolved.url || resolved.src || resolved.icon || resolveRecordIconUrl(candidate, options)
    };
};

export const createRecordPresentation = (record, sourceIndex = 0, options = {}) => {
    const document = createSearchDocumentFromSchema(
        record,
        options.schema || GENERIC_RECORD_SCHEMA,
        sourceIndex
    );
    const candidate = createSharedIconCandidate(record, document);
    const resolved = resolveSharedRecordIcon(record, {
        ...options,
        document,
        sourceIndex
    });
    const title = document.title || normalizeText(options.untitledLabel || "İsimsiz kayıt");
    const category = document.category || document.type || normalizeText(options.otherCategoryLabel || "Diğer");
    return {
        key: document.key,
        id: document.id,
        title,
        subtitle: document.address || document.district || document.neighborhood || "",
        address: document.address,
        category,
        categoryKey: normalizeCategoryKey(category),
        type: document.type,
        searchText: normalizeSearchText([
            title,
            document.address,
            category,
            document.type,
            document.district,
            document.neighborhood,
            document.street
        ].filter(Boolean).join(" ")),
        icon: {
            key: resolved.id || "default",
            src: resolved.url,
            alt: title,
            matchedBy: resolved.matchedBy || null,
            isFallback: Boolean(resolved.isFallback)
        },
        iconCandidate: candidate,
        coordinates: document.coordinates,
        fields: document.fields,
        validation: document.validation,
        source: record,
        sourceIndex
    };
};

export const createRecordPresentations = (records, options = {}) => (
    Array.isArray(records)
        ? records.map((record, index) => createRecordPresentation(record, index, options))
        : []
);

export const createPresentationFacets = presentations => {
    const categoryCounts = new Map();
    const iconCounts = new Map();
    let fallbackIconCount = 0;
    (Array.isArray(presentations) ? presentations : []).forEach(presentation => {
        const categoryKey = presentation.categoryKey || "diger";
        const category = presentation.category || "Diğer";
        const categoryEntry = categoryCounts.get(categoryKey) || {
            key: categoryKey,
            label: category,
            count: 0
        };
        categoryEntry.count += 1;
        categoryCounts.set(categoryKey, categoryEntry);

        const iconKey = presentation.icon?.key || "default";
        const iconEntry = iconCounts.get(iconKey) || {
            key: iconKey,
            src: presentation.icon?.src || "",
            count: 0,
            fallbackCount: 0
        };
        iconEntry.count += 1;
        if (presentation.icon?.isFallback) {
            iconEntry.fallbackCount += 1;
            fallbackIconCount += 1;
        }
        iconCounts.set(iconKey, iconEntry);
    });
    return {
        categories: Array.from(categoryCounts.values())
            .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, "tr-TR")),
        icons: Array.from(iconCounts.values())
            .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key)),
        fallbackIconCount
    };
};

export const filterPresentations = (presentations, options = {}) => {
    const query = normalizeSearchText(options.query);
    const categoryKey = normalizeCategoryKey(options.category);
    const iconKey = normalizeText(options.iconKey);
    const fallbackOnly = options.fallbackOnly === true;
    return (Array.isArray(presentations) ? presentations : []).filter(presentation => {
        if (query && !presentation.searchText.includes(query)) return false;
        if (categoryKey && presentation.categoryKey !== categoryKey) return false;
        if (iconKey && presentation.icon?.key !== iconKey) return false;
        if (fallbackOnly && !presentation.icon?.isFallback) return false;
        return true;
    });
};

export const createPresentationPage = (presentations, options = {}) => {
    const filtered = filterPresentations(presentations, options);
    const offset = Math.max(0, Number.isFinite(Number(options.offset)) ? Math.trunc(Number(options.offset)) : 0);
    const limitCandidate = Number.isFinite(Number(options.limit)) ? Math.trunc(Number(options.limit)) : 50;
    const limit = Math.min(500, Math.max(1, limitCandidate));
    const items = filtered.slice(offset, offset + limit);
    const nextOffset = offset + items.length;
    return {
        items,
        facets: createPresentationFacets(filtered),
        page: {
            offset,
            limit,
            count: items.length,
            total: filtered.length,
            hasMore: nextOffset < filtered.length,
            nextOffset: nextOffset < filtered.length ? nextOffset : null
        }
    };
};

export const createIconCoverageReport = presentations => {
    const input = Array.isArray(presentations) ? presentations : [];
    const fallbackRecords = input
        .filter(presentation => presentation.icon?.isFallback)
        .map(presentation => ({
            key: presentation.key,
            id: presentation.id,
            title: presentation.title,
            category: presentation.category,
            type: presentation.type,
            candidate: presentation.iconCandidate
        }));
    const matchedRecords = input.length - fallbackRecords.length;
    return {
        total: input.length,
        matched: matchedRecords,
        fallback: fallbackRecords.length,
        coverageRatio: input.length ? matchedRecords / input.length : 1,
        fallbackRecords,
        facets: createPresentationFacets(input)
    };
};

export const createSharedMapModels = (record, options = {}) => {
    const presentation = createRecordPresentation(record, options.sourceIndex || 0, options);
    const candidate = presentation.iconCandidate;
    return {
        presentation,
        iconKey: getIconKey(candidate, { fallback: options.fallback || "default" }),
        list: createListIconModel({
            ...candidate,
            title: presentation.title
        }, { fallback: options.fallback || "default" }),
        marker2D: createPictureMarkerSymbol(candidate, options.zoom ?? 12, {
            fallback: options.fallback || "default",
            minSize: options.minSize,
            maxSize: options.maxSize,
            zoomThreshold: options.zoomThreshold
        }),
        graphic3D: create3DGraphicModel({
            ...candidate,
            title: presentation.title
        }, { fallback: options.fallback || "default" })
    };
};

export const RecordPresentationRuntime = {
    createSharedIconCandidate,
    resolveSharedRecordIcon,
    createRecordPresentation,
    createRecordPresentations,
    createPresentationFacets,
    filterPresentations,
    createPresentationPage,
    createIconCoverageReport,
    createSharedMapModels
};
