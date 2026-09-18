import type {
  Coordinates,
  NormalizeTextOptions,
} from '../../Toolbox/DataIntegrityHelper';

export type UnknownRecord = Record<string, unknown>;

export type SourceContainerName =
  | 'root'
  | 'attr'
  | 'attributes'
  | 'properties';

export type FieldType =
  | 'text'
  | 'id'
  | 'integer'
  | 'number'
  | 'boolean'
  | 'category'
  | 'latitude'
  | 'longitude'
  | 'url'
  | 'phone';

export interface FieldNormalizeOptions extends NormalizeTextOptions {
  fallback?: unknown;
}

export type FieldValidator = (
  value: unknown,
  record: UnknownRecord,
) => boolean | string;

export interface FieldDefinitionInput {
  aliases?: readonly string[];
  type?: FieldType;
  required?: boolean;
  defaultValue?: unknown;
  searchable?: boolean;
  facet?: boolean;
  validate?: FieldValidator | null;
}

export interface FieldDefinition {
  name: string;
  aliases: readonly string[];
  type: FieldType;
  required: boolean;
  defaultValue: unknown;
  searchable: boolean;
  facet: boolean;
  validate: FieldValidator | null;
}

export interface RecordSchemaDefinition {
  id?: string;
  version?: string | number;
  strict?: boolean;
  fields?: Readonly<Record<string, FieldDefinitionInput>>;
}

export interface CompiledRecordSchema {
  id: string;
  version: string | number;
  strict: boolean;
  fields: readonly FieldDefinition[];
  fieldMap: ReadonlyMap<string, FieldDefinition>;
  requiredFields: readonly string[];
  searchableFields: readonly string[];
  facetFields: readonly string[];
}

export interface RecordSource {
  name: SourceContainerName;
  value: UnknownRecord;
}

export interface AliasedValue {
  value: unknown;
  alias: string | null;
  source: SourceContainerName | null;
}

export interface FieldMetadata {
  alias: string | null;
  source: SourceContainerName | null;
  present: boolean;
}

export interface ReadRecordResult {
  output: UnknownRecord;
  metadata: Record<string, FieldMetadata>;
}

export interface RecordValidationIssue {
  code: string;
  field: string;
  severity: 'error' | 'warning';
}

export interface RecordValidationResult {
  valid: boolean;
  issues: readonly RecordValidationIssue[];
}

export interface RecordShapeInspection {
  sources: readonly SourceContainerName[];
  fields: readonly string[];
  bySource: Readonly<Record<string, readonly string[]>>;
}

export interface SchemaDriftCount {
  name: string;
  count: number;
}

export interface SchemaDriftReport {
  totalRecords: number;
  unknownFields: readonly SchemaDriftCount[];
  aliasUsage: readonly SchemaDriftCount[];
  sourceUsage: readonly SchemaDriftCount[];
  missingRequired: readonly SchemaDriftCount[];
  hasDrift: boolean;
}

export interface SchemaSearchDocument extends UnknownRecord {
  id: unknown;
  key: string;
  title: string;
  category: string;
  categoryKey: string;
  type: string;
  address: string;
  district: string;
  neighborhood: string;
  street: string;
  door: string;
  phone: string;
  url: string;
  coordinates: Coordinates | null;
  searchText: string;
  fields: UnknownRecord;
  metadata: Record<string, FieldMetadata>;
  validation: RecordValidationResult;
  source: UnknownRecord;
  sourceIndex: number;
}

export interface RejectedSchemaRecord {
  sourceIndex: number;
  reason: 'record-not-object' | 'validation-failed' | 'duplicate';
  record: unknown;
  issues?: readonly RecordValidationIssue[];
  key?: string;
}

export interface SchemaCollectionDiagnostics {
  inputCount: number;
  acceptedCount: number;
  rejectedCount: number;
  duplicateCount: number;
  invalidCount: number;
  nonObjectCount: number;
}

export interface NormalizeRecordCollectionOptions {
  dedupe?: boolean;
  keepInvalid?: boolean;
}

export interface NormalizeRecordCollectionResult {
  documents: SchemaSearchDocument[];
  rejected: RejectedSchemaRecord[];
  diagnostics: SchemaCollectionDiagnostics;
  drift: SchemaDriftReport;
}

export interface FacetCount {
  key: string;
  label: string;
  count: number;
}

export interface SchemaQualityIssue {
  severity: string;
  code: string;
  field: string;
  count: number;
}

export interface SchemaQualityReport {
  schemaId: string;
  schemaVersion: string | number;
  schemaFingerprint: string;
  diagnostics: SchemaCollectionDiagnostics;
  drift: SchemaDriftReport;
  issues: readonly SchemaQualityIssue[];
  facets: Readonly<Record<string, readonly FacetCount[]>>;
}

export const isPlainObject = (value: unknown): value is UnknownRecord =>
  Object.prototype.toString.call(value) === '[object Object]';
