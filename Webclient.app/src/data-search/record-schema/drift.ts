import {
  type CompiledRecordSchema,
  type RecordShapeInspection,
  type SchemaDriftCount,
  type SchemaDriftReport,
} from './contracts';
import {
  GENERIC_RECORD_SCHEMA,
  readRecordWithSchema,
} from './compiler';
import {
  getRecordSources,
} from './normalization';

const nestedContainerKeys = new Set(['attr', 'attributes', 'properties']);

const toCountList = (
  map: ReadonlyMap<string, number>,
): SchemaDriftCount[] => Array.from(map.entries())
  .map(([name, count]) => ({ name, count }))
  .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));

export const inspectRecordShape = (record: unknown): RecordShapeInspection => {
  const sources = getRecordSources(record);
  const fields = new Set<string>();
  const bySource: Record<string, readonly string[]> = {};

  for (const source of sources) {
    const keys = Object.keys(source.value).sort();
    bySource[source.name] = keys;
    for (const key of keys) {
      if (!nestedContainerKeys.has(key)) fields.add(key);
    }
  }

  return {
    sources: sources.map(source => source.name),
    fields: Array.from(fields).sort(),
    bySource,
  };
};

export const detectSchemaDrift = (
  records: unknown,
  compiledSchema: CompiledRecordSchema = GENERIC_RECORD_SCHEMA,
): SchemaDriftReport => {
  const input = Array.isArray(records) ? records : [];
  const expectedAliases = new Set<string>();

  for (const field of compiledSchema.fields) {
    for (const alias of field.aliases) {
      expectedAliases.add(alias);
    }
  }

  const unknownFields = new Map<string, number>();
  const aliasUsage = new Map<string, number>();
  const sourceUsage = new Map<string, number>();
  const missingRequired = new Map<string, number>();

  for (const record of input) {
    for (const source of getRecordSources(record)) {
      sourceUsage.set(source.name, (sourceUsage.get(source.name) ?? 0) + 1);
      for (const key of Object.keys(source.value)) {
        if (nestedContainerKeys.has(key)) continue;
        if (!expectedAliases.has(key)) {
          unknownFields.set(key, (unknownFields.get(key) ?? 0) + 1);
        }
      }
    }

    const { metadata } = readRecordWithSchema(record, compiledSchema);
    for (const [fieldName, meta] of Object.entries(metadata)) {
      if (meta.alias) {
        const key = `${fieldName}:${meta.alias}`;
        aliasUsage.set(key, (aliasUsage.get(key) ?? 0) + 1);
      }
    }

    for (const fieldName of compiledSchema.requiredFields) {
      if (!metadata[fieldName]?.present) {
        missingRequired.set(fieldName, (missingRequired.get(fieldName) ?? 0) + 1);
      }
    }
  }

  return {
    totalRecords: input.length,
    unknownFields: toCountList(unknownFields),
    aliasUsage: toCountList(aliasUsage),
    sourceUsage: toCountList(sourceUsage),
    missingRequired: toCountList(missingRequired),
    hasDrift: unknownFields.size > 0 || missingRequired.size > 0,
  };
};
