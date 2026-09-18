import {
  type CompiledRecordSchema,
  type FieldDefinition,
  type FieldDefinitionInput,
  type FieldMetadata,
  type RecordSchemaDefinition,
  type ReadRecordResult,
  type RecordValidationIssue,
  type RecordValidationResult,
  type UnknownRecord,
} from './contracts';
import {
  DEFAULT_FIELD_ALIASES,
  FIELD_TYPES,
  normalizeFieldValue,
  readAliasedValue,
} from './normalization';

const isMissing = (value: unknown): boolean =>
  value === null || value === undefined || value === '';

export const createFieldDefinition = (
  name: string,
  definition: FieldDefinitionInput = {},
): FieldDefinition => ({
  name,
  aliases: Object.freeze(Array.from(new Set([
    ...(definition.aliases ?? []),
    ...(DEFAULT_FIELD_ALIASES[name] ?? []),
  ]))),
  type: definition.type ?? FIELD_TYPES.Text,
  required: definition.required === true,
  defaultValue: definition.defaultValue ?? null,
  searchable: definition.searchable !== false,
  facet: definition.facet === true,
  validate: typeof definition.validate === 'function' ? definition.validate : null,
});

export const compileSchema = (
  schema: RecordSchemaDefinition = {},
): CompiledRecordSchema => {
  const rawFields = schema.fields ?? {};
  const fields = Object.keys(rawFields).map(name =>
    createFieldDefinition(name, rawFields[name]),
  );

  return {
    id: schema.id ?? 'generic',
    version: schema.version ?? 1,
    strict: schema.strict === true,
    fields,
    fieldMap: new Map(fields.map(field => [field.name, field] as const)),
    requiredFields: fields.filter(field => field.required).map(field => field.name),
    searchableFields: fields.filter(field => field.searchable).map(field => field.name),
    facetFields: fields.filter(field => field.facet).map(field => field.name),
  };
};

export const GENERIC_RECORD_SCHEMA = compileSchema({
  id: 'generic-record',
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
    url: { type: FIELD_TYPES.Url, searchable: false },
  },
});

export const ADDRESS_RECORD_SCHEMA = compileSchema({
  id: 'address-record',
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
    longitude: { type: FIELD_TYPES.Longitude, searchable: false },
  },
});

export const readRecordWithSchema = (
  record: unknown,
  compiledSchema: CompiledRecordSchema = GENERIC_RECORD_SCHEMA,
): ReadRecordResult => {
  const output: UnknownRecord = {};
  const metadata: Record<string, FieldMetadata> = {};

  for (const field of compiledSchema.fields) {
    const resolved = readAliasedValue(record, field.aliases, field.defaultValue);
    output[field.name] = normalizeFieldValue(
      resolved.value,
      field.type,
      { fallback: field.defaultValue },
    );
    metadata[field.name] = {
      alias: resolved.alias,
      source: resolved.source,
      present: resolved.alias !== null,
    };
  }

  return { output, metadata };
};

export const validateNormalizedRecord = (
  record: UnknownRecord,
  compiledSchema: CompiledRecordSchema = GENERIC_RECORD_SCHEMA,
): RecordValidationResult => {
  const issues: RecordValidationIssue[] = [];

  for (const field of compiledSchema.fields) {
    const value = record[field.name];
    const missing = isMissing(value);

    if (field.required && missing) {
      issues.push({
        code: 'required-field-missing',
        field: field.name,
        severity: 'error',
      });
    }

    if (field.validate && !missing) {
      const result = field.validate(value, record);
      if (result === false) {
        issues.push({
          code: 'field-validation-failed',
          field: field.name,
          severity: 'error',
        });
      } else if (typeof result === 'string') {
        issues.push({
          code: result,
          field: field.name,
          severity: 'error',
        });
      }
    }
  }

  if ((record.latitude === null) !== (record.longitude === null)) {
    issues.push({
      code: 'partial-coordinate-pair',
      field: 'coordinates',
      severity: 'warning',
    });
  }

  return {
    valid: !issues.some(issue => issue.severity === 'error'),
    issues,
  };
};

export const createSchemaFingerprint = (
  compiledSchema: CompiledRecordSchema,
): string => compiledSchema.fields
  .map(field => `${field.name}:${field.type}:${field.aliases.join(',')}`)
  .join('|');
