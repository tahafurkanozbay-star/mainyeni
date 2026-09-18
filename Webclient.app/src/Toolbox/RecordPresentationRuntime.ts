import {
    create3DGraphicModel,
    createListIconModel,
    createPictureMarkerSymbol,
    getIconKey,
    resolveRecordIcon,
    resolveRecordIconUrl
} from "../gis-engine/iconPresentation";
import type {
    Graphic3DModel,
    IconRecord,
    IconResolveOptions,
    ListIconModel,
    PictureMarkerOptions,
    PictureMarkerSymbolModel,
    ResolvedIconEntry
} from "../gis-engine/contracts";
import {
    normalizeCategoryKey,
    normalizeSearchText,
    normalizeText
} from "./DataIntegrityHelper";
import {
    GENERIC_RECORD_SCHEMA,
    createSearchDocumentFromSchema
} from "./RecordSchemaRuntime";

type UnknownRecord = Record<string, unknown>;

interface SearchDocumentLike {
    key: string;
    id: string | null;
    title: string;
    address: string;
    district: string;
    neighborhood: string;
    street: string;
    category: string;
    type: string;
    coordinates: unknown;
    fields: unknown;
    validation: unknown;
}

export interface SharedIconCandidate extends IconRecord {
    type: string;
    category: string;
    kind: string;
    className: string;
    iconKey: string;
    id: string;
}

export type RecordPresentationOptions = IconResolveOptions & PictureMarkerOptions & {
    document?: SearchDocumentLike | null;
    schema?: typeof GENERIC_RECORD_SCHEMA;
    sourceIndex?: number;
    untitledLabel?: unknown;
    otherCategoryLabel?: unknown;
    zoom?: number;
};

export interface SharedResolvedRecordIcon extends ResolvedIconEntry {
    candidate: SharedIconCandidate;
    url: string;
}

export interface RecordPresentationIcon {
    key: string;
    src: string;
    alt: string;
    matchedBy: ResolvedIconEntry["matchedBy"] | null;
    isFallback: boolean;
}

export interface RecordPresentation {
    key: string;
    id: string | null;
    title: string;
    subtitle: string;
    address: string;
    category: string;
    categoryKey: string;
    type: string;
    searchText: string;
    icon: RecordPresentationIcon;
    iconCandidate: SharedIconCandidate;
    coordinates: unknown;
    fields: unknown;
    validation: unknown;
    source: unknown;
    sourceIndex: number;
}

export interface PresentationCategoryFacet {
    key: string;
    label: string;
    count: number;
}

export interface PresentationIconFacet {
    key: string;
    src: string;
    count: number;
    fallbackCount: number;
}

export interface PresentationFacets {
    categories: PresentationCategoryFacet[];
    icons: PresentationIconFacet[];
    fallbackIconCount: number;
}

export interface PresentationFilterOptions {
    query?: unknown;
    category?: unknown;
    iconKey?: unknown;
    fallbackOnly?: boolean;
}

export interface PresentationPageOptions extends PresentationFilterOptions {
    offset?: unknown;
    limit?: unknown;
}

export interface PresentationPage {
    items: RecordPresentation[];
    facets: PresentationFacets;
    page: {
        offset: number;
        limit: number;
        count: number;
        total: number;
        hasMore: boolean;
        nextOffset: number | null;
    };
}

export interface IconCoverageFallbackRecord {
    key: string;
    id: string | null;
    title: string;
    category: string;
    type: string;
    candidate: SharedIconCandidate;
}

export interface IconCoverageReport {
    total: number;
    matched: number;
    fallback: number;
    coverageRatio: number;
    fallbackRecords: IconCoverageFallbackRecord[];
    facets: PresentationFacets;
}

export interface SharedMapModels {
    presentation: RecordPresentation;
    iconKey: string;
    list: ListIconModel;
    marker2D: PictureMarkerSymbolModel;
    graphic3D: Graphic3DModel;
}

const isRecord = (value: unknown): value is UnknownRecord =>
    value !== null && typeof value === "object" && !Array.isArray(value);

const toSearchDocument = (
    record: unknown,
    schema: typeof GENERIC_RECORD_SCHEMA,
    sourceIndex: number
): SearchDocumentLike => createSearchDocumentFromSchema(
    record,
    schema,
    sourceIndex
) as SearchDocumentLike;

const readNestedCandidate = (record: unknown, keys: readonly string[]): unknown => {
    const root = isRecord(record) ? record : null;
    const sources: UnknownRecord[] = [
        root,
        root && isRecord(root.attr) ? root.attr : null,
        root && isRecord(root.attributes) ? root.attributes : null,
        root && isRecord(root.properties) ? root.properties : null
    ].filter((source): source is UnknownRecord => Boolean(source));

    for (const source of sources) {
        for (const key of keys) {
            const value = source[key];
            if (value !== null && value !== undefined && normalizeText(value) !== "") return value;
        }
    }
    return null;
};

export const createSharedIconCandidate = (
    record: unknown,
    normalizedDocument: SearchDocumentLike | null = null
): SharedIconCandidate => {
    const document = normalizedDocument || toSearchDocument(record, GENERIC_RECORD_SCHEMA, 0);
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

export const resolveSharedRecordIcon = (
    record: unknown,
    options: RecordPresentationOptions = {}
): SharedResolvedRecordIcon => {
    const document = options.document || toSearchDocument(
        record,
        options.schema || GENERIC_RECORD_SCHEMA,
        options.sourceIndex || 0
    );
    const candidate = createSharedIconCandidate(record, document);
    const iconOptions = {
        ...options,
        fallback: options.fallback || "default"
    } as IconResolveOptions;
    const resolved = resolveRecordIcon(candidate, iconOptions);
    return {
        ...resolved,
        candidate,
        url: resolved.url || resolved.src || resolved.icon || resolveRecordIconUrl(candidate, iconOptions)
    };
};

export const createRecordPresentation = (
    record: unknown,
    sourceIndex = 0,
    options: RecordPresentationOptions = {}
): RecordPresentation => {
    const document = toSearchDocument(
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

export const createRecordPresentations = (
    records: unknown,
    options: RecordPresentationOptions = {}
): RecordPresentation[] => (
    Array.isArray(records)
        ? records.map((record, index) => createRecordPresentation(record, index, options))
        : []
);

export const createPresentationFacets = (presentations: unknown): PresentationFacets => {
    const categoryCounts = new Map<string, PresentationCategoryFacet>();
    const iconCounts = new Map<string, PresentationIconFacet>();
    let fallbackIconCount = 0;
    const input = (Array.isArray(presentations) ? presentations : []) as RecordPresentation[];

    input.forEach(presentation => {
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

export const filterPresentations = (
    presentations: unknown,
    options: PresentationFilterOptions = {}
): RecordPresentation[] => {
    const query = normalizeSearchText(options.query);
    const categoryKey = normalizeCategoryKey(options.category);
    const iconKey = normalizeText(options.iconKey);
    const fallbackOnly = options.fallbackOnly === true;
    const input = (Array.isArray(presentations) ? presentations : []) as RecordPresentation[];

    return input.filter(presentation => {
        if (query && !presentation.searchText.includes(query)) return false;
        if (categoryKey && presentation.categoryKey !== categoryKey) return false;
        if (iconKey && presentation.icon?.key !== iconKey) return false;
        if (fallbackOnly && !presentation.icon?.isFallback) return false;
        return true;
    });
};

export const createPresentationPage = (
    presentations: unknown,
    options: PresentationPageOptions = {}
): PresentationPage => {
    const filtered = filterPresentations(presentations, options);
    const offset = Math.max(
        0,
        Number.isFinite(Number(options.offset)) ? Math.trunc(Number(options.offset)) : 0
    );
    const limitCandidate = Number.isFinite(Number(options.limit))
        ? Math.trunc(Number(options.limit))
        : 50;
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

export const createIconCoverageReport = (presentations: unknown): IconCoverageReport => {
    const input = (Array.isArray(presentations) ? presentations : []) as RecordPresentation[];
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

export const createSharedMapModels = (
    record: unknown,
    options: RecordPresentationOptions = {}
): SharedMapModels => {
    const presentation = createRecordPresentation(record, options.sourceIndex || 0, options);
    const candidate = presentation.iconCandidate;
    const iconOptions = {
        ...options,
        fallback: options.fallback || "default"
    } as IconResolveOptions;
    const markerOptions = {
        ...options,
        fallback: options.fallback || "default"
    } as PictureMarkerOptions;

    return {
        presentation,
        iconKey: getIconKey(candidate, iconOptions),
        list: createListIconModel({
            ...candidate,
            title: presentation.title
        }, iconOptions),
        marker2D: createPictureMarkerSymbol(candidate, options.zoom ?? 12, markerOptions),
        graphic3D: create3DGraphicModel({
            ...candidate,
            title: presentation.title
        }, iconOptions)
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
