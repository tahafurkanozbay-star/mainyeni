import {
  createRecordFingerprint,
  normalizeCategoryKey,
  normalizeCoordinates,
  normalizeId,
  normalizeSearchText,
  normalizeText,
  type NormalizedRecord,
} from '../../Toolbox/DataIntegrityHelper';
import {
  isPlainObject,
  type CompiledRecordSchema,
  type FacetCount,
  type NormalizeRecordCollectionOptions,
  type NormalizeRecordCollectionResult,
  type RejectedSchemaRecord,
  type SchemaQualityIssue,
  type SchemaQualityReport,
  type SchemaSearchDocument,
  type UnknownRecord,
} from './contracts';
import {
  GENERIC_RECORD_SCHEMA,
  createSchemaFingerprint,
  readRecordWithSchema,
  validateNormalizedRecord,
} from './compiler';
import { detectSchemaDrift } from './drift';

const textField = (record: UnknownRecord, key: string): string =>
  normalizeText(record[key]);

export const createSearchDocumentFromSchema = (
  record: unknown,
  compiledSchema: CompiledRecordSchema = GENERIC_RECORD_SCHEMA,
  sourceIndex = 0,
): SchemaSearchDocument => {
  const source = isPlainObject(record) ? record : {};
  const { output, metadata } = readRecordWithSchema(source, compiledSchema);
  const validation = validateNormalizedRecord(output, compiledSchema);
  const searchValues = compiledSchema.searchableFields
    .map(fieldName => output[fieldName])
    .filter(value => value !== null && value !== undefined && value !== '')
    .map(value => normalizeSearchText(value));

  const id = normalizeId(output.id);
  const title = textField(output, 'title');
  const category = textField(output, 'category') || textField(output, 'type');
  const address = textField(output, 'address');
  const coordinates = normalizeCoordinates({
    latitude: output.latitude,
    longitude: output.longitude,
  });
  const normalizedForFingerprint: NormalizedRecord = {
    id,
    title,
    searchTitle: normalizeSearchText(title),
    category,
    categoryKey: normalizeCategoryKey(category),
    address,
    searchAddress: normalizeSearchText(address),
    coordinates,
    source,
  };

  return {
    ...output,
    id,
    key: createRecordFingerprint(normalizedForFingerprint) ?? `source:${sourceIndex}`,
    title,
    category,
    categoryKey: normalizeCategoryKey(category),
    type: textField(output, 'type'),
    address,
    district: textField(output, 'district'),
    neighborhood: textField(output, 'neighborhood'),
    street: textField(output, 'street'),
    door: textField(output, 'door'),
    phone: textField(output, 'phone'),
    url: textField(output, 'url'),
    coordinates,
    searchText: searchValues.join(' '),
    fields: output,
    metadata,
    validation,
    source,
    sourceIndex,
  };
};

export const normalizeRecordCollection = (
  records: unknown,
  compiledSchema: CompiledRecordSchema = GENERIC_RECORD_SCHEMA,
  options: NormalizeRecordCollectionOptions = {},
): NormalizeRecordCollectionResult => {
  const input = Array.isArray(records) ? records : [];
  const dedupe = options.dedupe !== false;
  const keepInvalid = options.keepInvalid === true;
  const seen = new Set<string>();
  const documents: SchemaSearchDocument[] = [];
  const rejected: RejectedSchemaRecord[] = [];
  let duplicateCount = 0;

  input.forEach((record, sourceIndex) => {
    if (!isPlainObject(record)) {
      rejected.push({ sourceIndex, reason: 'record-not-object', record });
      return;
    }

    const document = createSearchDocumentFromSchema(record, compiledSchema, sourceIndex);
    if (!document.validation.valid && !keepInvalid) {
      rejected.push({
        sourceIndex,
        reason: 'validation-failed',
        issues: document.validation.issues,
        record,
      });
      return;
    }

    if (dedupe && seen.has(document.key)) {
      duplicateCount += 1;
      rejected.push({
        sourceIndex,
        reason: 'duplicate',
        key: document.key,
        record,
      });
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
      invalidCount: rejected.filter(item => item.reason === 'validation-failed').length,
      nonObjectCount: rejected.filter(item => item.reason === 'record-not-object').length,
    },
    drift: detectSchemaDrift(input.filter(isPlainObject), compiledSchema),
  };
};

export const buildFacetCounts = (
  documents: unknown,
  fieldName: string,
): FacetCount[] => {
  const counts = new Map<string, FacetCount>();
  const input = Array.isArray(documents) ? documents : [];

  for (const candidate of input) {
    if (!isPlainObject(candidate)) continue;
    const fields = isPlainObject(candidate.fields) ? candidate.fields : {};
    const value = fields[fieldName] ?? candidate[fieldName];
    const label = normalizeText(value);
    if (!label) continue;

    const key = normalizeCategoryKey(label) || normalizeSearchText(label);
    const current = counts.get(key) ?? { key, label, count: 0 };
    counts.set(key, { ...current, count: current.count + 1 });
  }

  return Array.from(counts.values())
    .sort((left, right) =>
      right.count - left.count
      || left.label.localeCompare(right.label, 'tr-TR'));
};

export const createSchemaQualityReport = (
  records: unknown,
  compiledSchema: CompiledRecordSchema = GENERIC_RECORD_SCHEMA,
  options: NormalizeRecordCollectionOptions = {},
): SchemaQualityReport => {
  const normalized = normalizeRecordCollection(records, compiledSchema, {
    ...options,
    keepInvalid: true,
  });
  const issueCounts = new Map<string, number>();

  for (const document of normalized.documents) {
    for (const issue of document.validation.issues) {
      const key = `${issue.severity}:${issue.code}:${issue.field}`;
      issueCounts.set(key, (issueCounts.get(key) ?? 0) + 1);
    }
  }

  const issues: SchemaQualityIssue[] = Array.from(issueCounts.entries())
    .map(([key, count]) => {
      const [severity = '', code = '', field = ''] = key.split(':');
      return { severity, code, field, count };
    })
    .sort((left, right) =>
      right.count - left.count || left.code.localeCompare(right.code));

  const facets: Record<string, readonly FacetCount[]> = {};
  for (const fieldName of compiledSchema.facetFields) {
    facets[fieldName] = buildFacetCounts(normalized.documents, fieldName);
  }

  return {
    schemaId: compiledSchema.id,
    schemaVersion: compiledSchema.version,
    schemaFingerprint: createSchemaFingerprint(compiledSchema),
    diagnostics: normalized.diagnostics,
    drift: normalized.drift,
    issues,
    facets,
  };
};
