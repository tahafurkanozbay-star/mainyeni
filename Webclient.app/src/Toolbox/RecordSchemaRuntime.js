import {
    createRecordFingerprint,
    normalizeCategoryKey,
    normalizeCoordinates,
    normalizeFiniteNumber,
    normalizeId,
    normalizeSearchText,
    normalizeText
} from "./DataIntegrityHelper";

export const SOURCE_CONTAINERS = Object.freeze([
    "root",
    "attr",
    "attributes",
    "properties"
]);

export const FIELD_TYPES = Object.freeze({
    Text: "text",
    Id: "id",
    Integer: "integer",
    Number: "number",
    Boolean: "boolean",
    Category: "category",
    Latitude: "latitude",
    Longitude: "longitude",
    Url: "url",
    Phone: "phone"
});

export const DEFAULT_FIELD_ALIASES = Object.freeze({
    id: [
        "id",
        "Id",
        "ID",
        "objectid",
        "ObjectId",
        "OBJECTID",
        "objectId",
        "globalid",
        "GlobalId",
        "GLOBALID"
    ],
    title: [
        "title",
        "Title",
        "name",
        "Name",
        "NAME",
        "ad",
        "Ad",
        "AD",
        "adi",
        "Adi",
        "ADI"
    ],
    category: [
        "category",
        "Category",
        "CATEGORY",
        "kategori",
        "Kategori",
        "KATEGORI",
        "tur",
        "Tur",
        "TUR"
    ],
    type: [
        "type",
        "Type",
        "TYPE",
        "tip",
        "Tip",
        "TIP",
        "turu",
        "Turu",
        "TURU"
    ],
    address: [
        "address",
        "Address",
        "ADDRESS",
        "adres",
        "Adres",
        "ADRES",
        "acik_adres",
        "ACIK_ADRES",
        "acikAdres"
    ],
    district: [
        "district",
        "District",
        "ilce",
        "Ilce",
        "ILCE",
        "ilce_adi",
        "ILCE_ADI",
        "ilceAdi"
    ],
    neighborhood: [
        "neighborhood",
        "Neighborhood",
        "mahalle",
        "Mahalle",
        "MAHALLE",
        "mahalle_adi",
        "MAHALLE_ADI",
        "mahalleAdi",
        "_MAHALLE_ADI"
    ],
    street: [
        "street",
        "Street",
        "sokak",
        "Sokak",
        "SOKAK",
        "cadde",
        "Cadde",
        "CADDE",
        "yol",
        "YOL",
        "yol_adi",
        "YOL_ADI",
        "yolAdi"
    ],
    door: [
        "door",
        "Door",
        "doorNo",
        "doorNumber",
        "kapino",
        "kapiNo",
        "KAPINO",
        "KAPI_NO"
    ],
    phone: [
        "phone",
        "Phone",
        "PHONE",
        "telefon",
        "Telefon",
        "TELEFON",
        "tel",
        "TEL"
    ],
    latitude: [
        "latitude",
        "Latitude",
        "LATITUDE",
        "lat",
        "Lat",
        "LAT",
        "y",
        "Y"
    ],
    longitude: [
        "longitude",
        "Longitude",
        "LONGITUDE",
        "lon",
        "Lon",
        "LON",
        "lng",
        "Lng",
        "LNG",
        "x",
        "X"
    ],
    url: [
        "url",
        "Url",
        "URL",
        "web",
        "Web",
        "website",
        "Website",
        "WEB_SITE"
    ]
});

const isNil = value => value === null || value === undefined;

export const isPlainObject = value => Object.prototype.toString.call(value) === "[object Object]";

export const getRecordSources = record => {
    if (!isPlainObject(record)) return [];
    const sources = [{ name: "root", value: record }];
    ["attr", "attributes", "properties"].forEach(name => {
        if (isPlainObject(record[name])) sources.push({ name, value: record[name] });
    });
    return sources;
};

export const readAliasedValue = (record, aliases = [], fallback = null) => {
    const sourceList = getRecordSources(record);
    for (const source of sourceList) {
        for (const alias of aliases) {
            const value = source.value[alias];
            if (!isNil(value) && value !== "") {
                return {
                    value,
                    alias,
                    source: source.name
                };
            }
        }
    }
    return {
        value: fallback,
        alias: null,
        source: null
    };
};

export const normalizeBoolean = (value, fallback = null) => {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") {
        if (value === 1) return true;
        if (value === 0) return false;
        return fallback;
    }
    const normalized = normalizeSearchText(value);
    if (["true", "1", "evet", "yes", "aktif"].includes(normalized)) return true;
    if (["false", "0", "hayir", "no", "pasif"].includes(normalized)) return false;
    return fallback;
};

export const normalizePhone = value => {
    const text = normalizeText(value);
    if (!text) return "";
    const leadingPlus = text.startsWith("+") ? "+" : "";
    const digits = text.replace(/\D/g, "");
    return digits ? `${leadingPlus}${digits}` : "";
};

export const normalizeSafeHttpUrl = value => {
    const text = normalizeText(value);
    if (!text) return "";
    try {
        const parsed = new URL(text, "https://localhost.invalid");
        if (!/^https?:$/i.test(parsed.protocol)) return "";
        if (!/^https?:\/\//i.test(text)) return text;
        return parsed.toString();
    } catch (_error) {
        return "";
    }
};

export const normalizeFieldValue = (value, type, options = {}) => {
    switch (type) {
        case FIELD_TYPES.Id:
            return normalizeId(value);
        case FIELD_TYPES.Integer: {
            const number = normalizeFiniteNumber(value, null);
            return Number.isInteger(number) ? number : null;
        }
        case FIELD_TYPES.Number:
            return normalizeFiniteNumber(value, null);
        case FIELD_TYPES.Boolean:
            return normalizeBoolean(value, options.fallback ?? null);
        case FIELD_TYPES.Category:
            return normalizeText(value);
        case FIELD_TYPES.Latitude: {
            const coordinates = normalizeCoordinates({ latitude: value, longitude: 0 });
            return coordinates ? coordinates.latitude : null;
        }
        case FIELD_TYPES.Longitude: {
            const coordinates = normalizeCoordinates({ latitude: 0, longitude: value });
            return coordinates ? coordinates.longitude : null;
        }
        case FIELD_TYPES.Url:
            return normalizeSafeHttpUrl(value);
        case FIELD_TYPES.Phone:
            return normalizePhone(value);
        case FIELD_TYPES.Text:
        default:
            return normalizeText(value, options);
    }
};

export const createFieldDefinition = (name, definition = {}) => ({
    name,
    aliases: Array.from(new Set([
        ...(definition.aliases || []),
        ...(DEFAULT_FIELD_ALIASES[name] || [])
    ])),
    type: definition.type || FIELD_TYPES.Text,
    required: definition.required === true,
    defaultValue: definition.defaultValue ?? null,
    searchable: definition.searchable !== false,
    facet: definition.facet === true,
    validate: typeof definition.validate === "function" ? definition.validate : null
});

export const compileSchema = (schema = {}) => {
    const rawFields = schema.fields || {};
    const fields = Object.keys(rawFields).map(name => createFieldDefinition(name, rawFields[name]));
    return {
        id: schema.id || "generic",
        version: schema.version || 1,
        strict: schema.strict === true,
        fields,
        fieldMap: new Map(fields.map(field => [field.name, field])),
        requiredFields: fields.filter(field => field.required).map(field => field.name),
        searchableFields: fields.filter(field => field.searchable).map(field => field.name),
        facetFields: fields.filter(field => field.facet).map(field => field.name)
    };
};

export const GENERIC_RECORD_SCHEMA = compileSchema({
    id: "generic-record",
    version: 1,
    fields: {
        id: { type: FIELD_TYPES.Id, searchable: false },
        title: { type: FIELD_TYPES.Text, searchable: true },
        category: { type: FIELD_TYPES.Category, searchable: true, facet: true },
        type: { type: FIELD_TYPES.Category, searchable: true, facet: true },
        address: { type: FIELD_TYPES.Text, searchable: true },
        district: { type: FIELD_TYPES.Text, searchable: true, facet: true },
        neighborhood: { type: FIELD_TYPES.Text, searchable: true, facet: true },
        street: { type: FIELD_TYPES.Text, searchable: true },
        door: { type: FIELD_TYPES.Text, searchable: true },
        phone: { type: FIELD_TYPES.Phone, searchable: true },
        latitude: { type: FIELD_TYPES.Latitude, searchable: false },
        longitude: { type: FIELD_TYPES.Longitude, searchable: false },
        url: { type: FIELD_TYPES.Url, searchable: false }
    }
});

export const ADDRESS_RECORD_SCHEMA = compileSchema({
    id: "address-record",
    version: 1,
    fields: {
        id: { type: FIELD_TYPES.Id, searchable: false },
        title: { type: FIELD_TYPES.Text, searchable: true },
        district: { type: FIELD_TYPES.Text, searchable: true, facet: true },
        neighborhood: { type: FIELD_TYPES.Text, searchable: true, facet: true },
        street: { type: FIELD_TYPES.Text, searchable: true },
        door: { type: FIELD_TYPES.Text, searchable: true },
        address: { type: FIELD_TYPES.Text, searchable: true },
        latitude: { type: FIELD_TYPES.Latitude, searchable: false },
        longitude: { type: FIELD_TYPES.Longitude, searchable: false }
    }
});

export const readRecordWithSchema = (record, compiledSchema = GENERIC_RECORD_SCHEMA) => {
    const output = {};
    const metadata = {};
    compiledSchema.fields.forEach(field => {
        const resolved = readAliasedValue(record, field.aliases, field.defaultValue);
        output[field.name] = normalizeFieldValue(resolved.value, field.type, { fallback: field.defaultValue });
        metadata[field.name] = {
            alias: resolved.alias,
            source: resolved.source,
            present: resolved.alias !== null
        };
    });
    return { output, metadata };
};

export const validateNormalizedRecord = (record, compiledSchema = GENERIC_RECORD_SCHEMA) => {
    const issues = [];
    compiledSchema.fields.forEach(field => {
        const value = record[field.name];
        const missing = isNil(value) || value === "";
        if (field.required && missing) {
            issues.push({
                code: "required-field-missing",
                field: field.name,
                severity: "error"
            });
        }
        if (field.validate && !missing) {
            const result = field.validate(value, record);
            if (result === false) {
                issues.push({
                    code: "field-validation-failed",
                    field: field.name,
                    severity: "error"
                });
            } else if (typeof result === "string") {
                issues.push({
                    code: result,
                    field: field.name,
                    severity: "error"
                });
            }
        }
    });

    if ((record.latitude === null) !== (record.longitude === null)) {
        issues.push({
            code: "partial-coordinate-pair",
            field: "coordinates",
            severity: "warning"
        });
    }

    return {
        valid: !issues.some(issue => issue.severity === "error"),
        issues
    };
};

export const createSchemaFingerprint = compiledSchema => compiledSchema.fields
    .map(field => `${field.name}:${field.type}:${field.aliases.join(",")}`)
    .join("|");

export const inspectRecordShape = record => {
    const sources = getRecordSources(record);
    const fields = new Set();
    const bySource = {};
    sources.forEach(source => {
        const keys = Object.keys(source.value).sort();
        bySource[source.name] = keys;
        keys.forEach(key => {
            if (!["attr", "attributes", "properties"].includes(key)) fields.add(key);
        });
    });
    return {
        sources: sources.map(source => source.name),
        fields: Array.from(fields).sort(),
        bySource
    };
};

export const detectSchemaDrift = (records, compiledSchema = GENERIC_RECORD_SCHEMA) => {
    const input = Array.isArray(records) ? records : [];
    const expectedAliases = new Set();
    compiledSchema.fields.forEach(field => field.aliases.forEach(alias => expectedAliases.add(alias)));

    const unknownFields = new Map();
    const aliasUsage = new Map();
    const sourceUsage = new Map();
    const missingRequired = new Map();

    input.forEach(record => {
        getRecordSources(record).forEach(source => {
            sourceUsage.set(source.name, (sourceUsage.get(source.name) || 0) + 1);
            Object.keys(source.value).forEach(key => {
                if (["attr", "attributes", "properties"].includes(key)) return;
                if (!expectedAliases.has(key)) {
                    unknownFields.set(key, (unknownFields.get(key) || 0) + 1);
                }
            });
        });

        const { metadata } = readRecordWithSchema(record, compiledSchema);
        Object.keys(metadata).forEach(fieldName => {
            const meta = metadata[fieldName];
            if (meta.alias) {
                const key = `${fieldName}:${meta.alias}`;
                aliasUsage.set(key, (aliasUsage.get(key) || 0) + 1);
            }
        });
        compiledSchema.requiredFields.forEach(fieldName => {
            if (!metadata[fieldName]?.present) {
                missingRequired.set(fieldName, (missingRequired.get(fieldName) || 0) + 1);
            }
        });
    });

    const toCountList = map => Array.from(map.entries())
        .map(([name, count]) => ({ name, count }))
        .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));

    return {
        totalRecords: input.length,
        unknownFields: toCountList(unknownFields),
        aliasUsage: toCountList(aliasUsage),
        sourceUsage: toCountList(sourceUsage),
        missingRequired: toCountList(missingRequired),
        hasDrift: unknownFields.size > 0 || missingRequired.size > 0
    };
};

export const createSearchDocumentFromSchema = (
    record,
    compiledSchema = GENERIC_RECORD_SCHEMA,
    sourceIndex = 0
) => {
    const { output, metadata } = readRecordWithSchema(record, compiledSchema);
    const validation = validateNormalizedRecord(output, compiledSchema);
    const searchValues = compiledSchema.searchableFields
        .map(fieldName => output[fieldName])
        .filter(value => !isNil(value) && value !== "")
        .map(value => normalizeSearchText(value));
    const category = output.category || output.type || "";
    const coordinates = normalizeCoordinates({
        latitude: output.latitude,
        longitude: output.longitude
    });
    const normalizedForFingerprint = {
        id: output.id,
        searchTitle: normalizeSearchText(output.title),
        searchAddress: normalizeSearchText(output.address),
        categoryKey: normalizeCategoryKey(category),
        coordinates
    };

    return {
        id: output.id,
        key: createRecordFingerprint(normalizedForFingerprint) || `source:${sourceIndex}`,
        title: output.title || "",
        category,
        categoryKey: normalizeCategoryKey(category),
        type: output.type || "",
        address: output.address || "",
        district: output.district || "",
        neighborhood: output.neighborhood || "",
        street: output.street || "",
        door: output.door || "",
        phone: output.phone || "",
        url: output.url || "",
        coordinates,
        searchText: searchValues.join(" "),
        fields: output,
        metadata,
        validation,
        source: record,
        sourceIndex
    };
};

export const normalizeRecordCollection = (
    records,
    compiledSchema = GENERIC_RECORD_SCHEMA,
    options = {}
) => {
    const input = Array.isArray(records) ? records : [];
    const dedupe = options.dedupe !== false;
    const keepInvalid = options.keepInvalid === true;
    const seen = new Set();
    const documents = [];
    const rejected = [];
    let duplicateCount = 0;

    input.forEach((record, sourceIndex) => {
        if (!isPlainObject(record)) {
            rejected.push({ sourceIndex, reason: "record-not-object", record });
            return;
        }
        const document = createSearchDocumentFromSchema(record, compiledSchema, sourceIndex);
        if (!document.validation.valid && !keepInvalid) {
            rejected.push({
                sourceIndex,
                reason: "validation-failed",
                issues: document.validation.issues,
                record
            });
            return;
        }
        if (dedupe && seen.has(document.key)) {
            duplicateCount += 1;
            rejected.push({ sourceIndex, reason: "duplicate", key: document.key, record });
            return;
        }
        seen.add(document.key);
        documents.push(document);
    });

    return {
        documents,
        rejected,
        diagnostics: {
            inputCount: input.length,
            acceptedCount: documents.length,
            rejectedCount: rejected.length,
            duplicateCount,
            invalidCount: rejected.filter(item => item.reason === "validation-failed").length,
            nonObjectCount: rejected.filter(item => item.reason === "record-not-object").length
        },
        drift: detectSchemaDrift(input.filter(isPlainObject), compiledSchema)
    };
};

export const buildFacetCounts = (documents, fieldName) => {
    const counts = new Map();
    (Array.isArray(documents) ? documents : []).forEach(document => {
        const value = document?.fields?.[fieldName] ?? document?.[fieldName];
        const label = normalizeText(value);
        if (!label) return;
        const key = normalizeCategoryKey(label) || normalizeSearchText(label);
        const current = counts.get(key) || { key, label, count: 0 };
        current.count += 1;
        counts.set(key, current);
    });
    return Array.from(counts.values())
        .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, "tr-TR"));
};

export const createSchemaQualityReport = (
    records,
    compiledSchema = GENERIC_RECORD_SCHEMA,
    options = {}
) => {
    const normalized = normalizeRecordCollection(records, compiledSchema, {
        ...options,
        keepInvalid: true
    });
    const issueCounts = new Map();
    normalized.documents.forEach(document => {
        document.validation.issues.forEach(issue => {
            const key = `${issue.severity}:${issue.code}:${issue.field}`;
            issueCounts.set(key, (issueCounts.get(key) || 0) + 1);
        });
    });
    return {
        schemaId: compiledSchema.id,
        schemaVersion: compiledSchema.version,
        schemaFingerprint: createSchemaFingerprint(compiledSchema),
        diagnostics: normalized.diagnostics,
        drift: normalized.drift,
        issues: Array.from(issueCounts.entries())
            .map(([key, count]) => {
                const [severity, code, field] = key.split(":");
                return { severity, code, field, count };
            })
            .sort((left, right) => right.count - left.count || left.code.localeCompare(right.code)),
        facets: compiledSchema.facetFields.reduce((result, fieldName) => ({
            ...result,
            [fieldName]: buildFacetCounts(normalized.documents, fieldName)
        }), {})
    };
};

export const RecordSchemaRuntime = {
    SOURCE_CONTAINERS,
    FIELD_TYPES,
    DEFAULT_FIELD_ALIASES,
    GENERIC_RECORD_SCHEMA,
    ADDRESS_RECORD_SCHEMA,
    isPlainObject,
    getRecordSources,
    readAliasedValue,
    normalizeBoolean,
    normalizePhone,
    normalizeSafeHttpUrl,
    normalizeFieldValue,
    createFieldDefinition,
    compileSchema,
    readRecordWithSchema,
    validateNormalizedRecord,
    createSchemaFingerprint,
    inspectRecordShape,
    detectSchemaDrift,
    createSearchDocumentFromSchema,
    normalizeRecordCollection,
    buildFacetCounts,
    createSchemaQualityReport
};
