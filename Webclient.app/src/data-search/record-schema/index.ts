export * from './contracts';
export * from './normalization';
export * from './compiler';
export * from './drift';
export * from './documents';

import {
  isPlainObject,
} from './contracts';
import {
  ADDRESS_RECORD_SCHEMA,
  GENERIC_RECORD_SCHEMA,
  compileSchema,
  createFieldDefinition,
  createSchemaFingerprint,
  readRecordWithSchema,
  validateNormalizedRecord,
} from './compiler';
import {
  detectSchemaDrift,
  inspectRecordShape,
} from './drift';
import {
  buildFacetCounts,
  createSchemaQualityReport,
  createSearchDocumentFromSchema,
  normalizeRecordCollection,
} from './documents';
import {
  DEFAULT_FIELD_ALIASES,
  FIELD_TYPES,
  SOURCE_CONTAINERS,
  getRecordSources,
  normalizeBoolean,
  normalizeFieldValue,
  normalizePhone,
  normalizeSafeHttpUrl,
  readAliasedValue,
} from './normalization';

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
  createSchemaQualityReport,
};
