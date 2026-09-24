import type {
  ArcGisGeometryType,
  ArcGisLayerCapabilities,
  ArcGisQueryCapability,
  ArcGisSpatialReference,
} from './arcgisQueryContract';

export type ArcGisFieldType =
  | 'oid'
  | 'global-id'
  | 'guid'
  | 'string'
  | 'small-integer'
  | 'integer'
  | 'big-integer'
  | 'single'
  | 'double'
  | 'date'
  | 'date-only'
  | 'time-only'
  | 'timestamp-offset'
  | 'blob'
  | 'raster'
  | 'xml'
  | 'geometry'
  | 'unknown';

export type ArcGisFieldDomain = Readonly<{
  type: 'coded-value' | 'range' | 'unknown';
  name: string | null;
  codedValues: ReadonlyMap<string | number, string>;
  range: readonly [number, number] | null;
}>;

export type ArcGisFieldContract = Readonly<{
  name: string;
  alias: string;
  type: ArcGisFieldType;
  nullable: boolean;
  editable: boolean;
  length: number | null;
  defaultValue: unknown;
  domain: ArcGisFieldDomain | null;
}>;

export type ArcGisScaleRange = Readonly<{
  minScale: number;
  maxScale: number;
}>;

export type ArcGisTimeContract = Readonly<{
  enabled: boolean;
  startField: string | null;
  endField: string | null;
  trackIdField: string | null;
  defaultInterval: number | null;
  defaultIntervalUnits: string | null;
}>;

export type ArcGisEditContract = Readonly<{
  create: boolean;
  update: boolean;
  delete: boolean;
  sync: boolean;
  attachments: boolean;
  supportsApplyEditsWithGlobalIds: boolean;
}>;

export type ArcGisRendererContract = Readonly<{
  type: string | null;
  field: string | null;
  field2: string | null;
  field3: string | null;
  normalizationField: string | null;
  visualVariableCount: number;
  labelingRuleCount: number;
  transparency: number | null;
}>;

export type ArcGisMetadataIssueCode =
  | 'invalid-resource-url'
  | 'missing-query-capability'
  | 'missing-object-id'
  | 'missing-spatial-reference'
  | 'invalid-max-record-count'
  | 'pagination-without-ordering'
  | 'duplicate-field-name'
  | 'invalid-field-name'
  | 'display-field-not-found'
  | 'time-field-not-found'
  | 'geometry-field-not-found'
  | 'invalid-scale-range'
  | 'editing-without-identity'
  | 'unknown-geometry-type'
  | 'metadata-not-object';

export type ArcGisMetadataIssue = Readonly<{
  code: ArcGisMetadataIssueCode;
  severity: 'info' | 'warning' | 'error';
  message: string;
  field?: string;
}>;

export type ArcGisMetadataContract = Readonly<{
  resourceUrl: string;
  name: string | null;
  type: string | null;
  geometryType: ArcGisGeometryType;
  spatialReference: ArcGisSpatialReference | null;
  objectIdField: string | null;
  globalIdField: string | null;
  displayField: string | null;
  geometryField: string | null;
  maxRecordCount: number;
  capabilities: ReadonlySet<ArcGisQueryCapability>;
  fields: readonly ArcGisFieldContract[];
  fieldMap: ReadonlyMap<string, ArcGisFieldContract>;
  scales: ArcGisScaleRange;
  time: ArcGisTimeContract;
  editing: ArcGisEditContract;
  renderer: ArcGisRendererContract;
  hasZ: boolean;
  hasM: boolean;
  issues: readonly ArcGisMetadataIssue[];
  queryReady: boolean;
  identityReady: boolean;
}>;

export class ArcGisMetadataContractError extends Error {
  readonly code: string;
  readonly resourceUrl: string | null;

  constructor(message: string, code = 'ARCGIS_METADATA_CONTRACT_ERROR', resourceUrl: string | null = null) {
    super(message);
    this.name = 'ArcGisMetadataContractError';
    this.code = code;
    this.resourceUrl = resourceUrl;
  }
}

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const record = (value: unknown): UnknownRecord => (isRecord(value) ? value : {});

const text = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
};

const finite = (value: unknown): number | null => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const positiveInteger = (value: unknown, fallback: number): number => {
  const numeric = finite(value);
  if (numeric === null || numeric <= 0) return fallback;
  return Math.max(1, Math.floor(numeric));
};

const nonNegative = (value: unknown): number => {
  const numeric = finite(value);
  return numeric !== null && numeric >= 0 ? numeric : 0;
};

const boolean = (value: unknown): boolean => value === true;

const asArray = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

const normalizeResourceUrl = (value: unknown): string => {
  const url = text(value);
  if (!url) {
    throw new ArcGisMetadataContractError('ArcGIS metadata requires a concrete resource URL.', 'MISSING_RESOURCE_URL');
  }
  const normalized = url.replace(/\/+$/, '');
  const forbiddenOgcResource = /(?:\/|\b)(?:wms|wfs)(?:\/|\b|\?)/i.test(normalized)
    || /[?&]service=(?:wms|wfs)(?:&|$)/i.test(normalized);
  if (forbiddenOgcResource || !/\/(?:FeatureServer|MapServer)\/\d+$/i.test(normalized)) {
    throw new ArcGisMetadataContractError(
      'ArcGIS metadata adapter accepts only concrete FeatureServer/MapServer layer resources.',
      'INVALID_RESOURCE_URL',
      normalized,
    );
  }
  return normalized;
};

const geometryType = (value: unknown): ArcGisGeometryType => {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized.includes('multipoint')) return 'multipoint';
  if (normalized.includes('point')) return 'point';
  if (normalized.includes('polyline')) return 'polyline';
  if (normalized.includes('polygon')) return 'polygon';
  if (normalized.includes('envelope') || normalized.includes('extent')) return 'extent';
  return 'unknown';
};

const spatialReference = (metadata: UnknownRecord): ArcGisSpatialReference | null => {
  const candidates = [
    record(record(metadata.extent).spatialReference),
    record(record(metadata.fullExtent).spatialReference),
    record(metadata.spatialReference),
  ];
  for (const candidate of candidates) {
    const wkidCandidate = finite(candidate.latestWkid ?? candidate.wkid);
    if (wkidCandidate !== null && Number.isInteger(wkidCandidate) && wkidCandidate > 0) {
      return Object.freeze({ wkid: wkidCandidate });
    }
    const wktCandidate = text(candidate.wkt);
    if (wktCandidate) return Object.freeze({ wkt: wktCandidate });
  }
  return null;
};

const normalizeFieldType = (value: unknown): ArcGisFieldType => {
  const normalized = String(value ?? '').trim().toLowerCase();
  const mapping: Readonly<Record<string, ArcGisFieldType>> = Object.freeze({
    esrifieldtypeoid: 'oid',
    oid: 'oid',
    esrifieldtypeglobalid: 'global-id',
    globalid: 'global-id',
    'global-id': 'global-id',
    esrifieldtypeguid: 'guid',
    guid: 'guid',
    esrifieldtypestring: 'string',
    string: 'string',
    esrifieldtypesmallinteger: 'small-integer',
    smallinteger: 'small-integer',
    'small-integer': 'small-integer',
    esrifieldtypeinteger: 'integer',
    integer: 'integer',
    esrifieldtypebiginteger: 'big-integer',
    biginteger: 'big-integer',
    'big-integer': 'big-integer',
    esrifieldtypesingle: 'single',
    single: 'single',
    esrifieldtypedouble: 'double',
    double: 'double',
    esrifieldtypedate: 'date',
    date: 'date',
    esrifieldtypedateonly: 'date-only',
    dateonly: 'date-only',
    'date-only': 'date-only',
    esrifieldtypetimeonly: 'time-only',
    timeonly: 'time-only',
    'time-only': 'time-only',
    esrifieldtypetimestampoffset: 'timestamp-offset',
    timestampoffset: 'timestamp-offset',
    'timestamp-offset': 'timestamp-offset',
    esrifieldtypeblob: 'blob',
    blob: 'blob',
    esrifieldtyperaster: 'raster',
    raster: 'raster',
    esrifieldtypexml: 'xml',
    xml: 'xml',
    esrifieldtypegeometry: 'geometry',
    geometry: 'geometry',
  });
  return mapping[normalized] ?? 'unknown';
};

const domain = (value: unknown): ArcGisFieldDomain | null => {
  const source = record(value);
  if (!Object.keys(source).length) return null;
  const rawType = String(source.type ?? '').toLowerCase();
  const name = text(source.name);
  if (rawType.includes('coded')) {
    const codedValues = new Map<string | number, string>();
    for (const item of asArray(source.codedValues)) {
      const entry = record(item);
      const code = entry.code;
      const label = text(entry.name);
      if ((typeof code === 'string' || typeof code === 'number') && label) {
        codedValues.set(code, label);
      }
    }
    return Object.freeze({
      type: 'coded-value' as const,
      name,
      codedValues,
      range: null,
    });
  }
  if (rawType.includes('range')) {
    const values = asArray(source.range);
    const minimum = finite(values[0]);
    const maximum = finite(values[1]);
    return Object.freeze({
      type: 'range' as const,
      name,
      codedValues: new Map<string | number, string>(),
      range: minimum !== null && maximum !== null && minimum <= maximum
        ? Object.freeze([minimum, maximum] as const)
        : null,
    });
  }
  return Object.freeze({
    type: 'unknown' as const,
    name,
    codedValues: new Map<string | number, string>(),
    range: null,
  });
};

const fieldContract = (value: unknown): ArcGisFieldContract | null => {
  const source = record(value);
  const name = text(source.name);
  if (!name) return null;
  const lengthValue = finite(source.length);
  return Object.freeze({
    name,
    alias: text(source.alias) ?? name,
    type: normalizeFieldType(source.type),
    nullable: source.nullable !== false,
    editable: source.editable !== false,
    length: lengthValue !== null && lengthValue > 0 ? Math.floor(lengthValue) : null,
    defaultValue: source.defaultValue,
    domain: domain(source.domain),
  });
};

const parseCapabilities = (metadata: UnknownRecord): ReadonlySet<ArcGisQueryCapability> => {
  const output = new Set<ArcGisQueryCapability>();
  const rawCapabilities = String(metadata.capabilities ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const advanced = record(metadata.advancedQueryCapabilities ?? metadata.advancedQueryCapabilitiesV2);
  if (rawCapabilities.includes('query') || metadata.geometryType || Array.isArray(metadata.fields)) output.add('query');
  if (advanced.supportsPagination === true || metadata.supportsPagination === true) output.add('pagination');
  if (advanced.supportsOrderBy === true || metadata.supportsOrderBy === true) output.add('order-by');
  if (advanced.supportsStatistics === true || metadata.supportsStatistics === true) output.add('statistics');
  if (advanced.supportsDistinct === true || advanced.supportsDistinctValues === true) output.add('distinct');
  if (advanced.supportsReturningQueryExtent === true || metadata.supportsReturningQueryExtent === true) output.add('extent');
  if (advanced.supportsReturningGeometryCentroid === true) output.add('centroid');
  if (advanced.supportsQuantization === true) output.add('quantization');
  return output;
};

const findIdentityField = (
  metadata: UnknownRecord,
  fields: readonly ArcGisFieldContract[],
  directKeys: readonly string[],
  expectedType: ArcGisFieldType,
): string | null => {
  for (const key of directKeys) {
    const direct = text(metadata[key]);
    if (direct) return direct;
  }
  return fields.find((field) => field.type === expectedType)?.name ?? null;
};

const normalizeScaleRange = (metadata: UnknownRecord): ArcGisScaleRange => Object.freeze({
  minScale: nonNegative(metadata.minScale),
  maxScale: nonNegative(metadata.maxScale),
});

const timeContract = (metadata: UnknownRecord): ArcGisTimeContract => {
  const time = record(metadata.timeInfo);
  const interval = finite(time.defaultTimeInterval);
  const startField = text(time.startTimeField);
  const endField = text(time.endTimeField);
  return Object.freeze({
    enabled: Boolean(startField || endField),
    startField,
    endField,
    trackIdField: text(time.trackIdField),
    defaultInterval: interval !== null && interval > 0 ? interval : null,
    defaultIntervalUnits: text(time.defaultTimeIntervalUnits),
  });
};

const editingContract = (metadata: UnknownRecord): ArcGisEditContract => {
  const capabilities = String(metadata.capabilities ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase());
  const applyEdits = record(metadata.advancedEditingCapabilities);
  return Object.freeze({
    create: capabilities.includes('create'),
    update: capabilities.includes('update'),
    delete: capabilities.includes('delete'),
    sync: capabilities.includes('sync'),
    attachments: boolean(metadata.hasAttachments),
    supportsApplyEditsWithGlobalIds: boolean(applyEdits.supportsApplyEditsWithGlobalIds),
  });
};

const rendererContract = (metadata: UnknownRecord): ArcGisRendererContract => {
  const drawingInfo = record(metadata.drawingInfo);
  const renderer = record(drawingInfo.renderer);
  const visualVariables = asArray(renderer.visualVariables);
  const labelingInfo = asArray(drawingInfo.labelingInfo);
  const transparencyValue = finite(drawingInfo.transparency);
  return Object.freeze({
    type: text(renderer.type),
    field: text(renderer.field),
    field2: text(renderer.field2),
    field3: text(renderer.field3),
    normalizationField: text(renderer.normalizationField),
    visualVariableCount: visualVariables.length,
    labelingRuleCount: labelingInfo.length,
    transparency: transparencyValue !== null
      ? Math.min(100, Math.max(0, transparencyValue))
      : null,
  });
};

const issue = (
  code: ArcGisMetadataIssueCode,
  severity: ArcGisMetadataIssue['severity'],
  message: string,
  field?: string,
): ArcGisMetadataIssue => Object.freeze({ code, severity, message, ...(field ? { field } : {}) });

const collectIssues = (contract: Omit<ArcGisMetadataContract, 'issues' | 'queryReady' | 'identityReady'>): ArcGisMetadataIssue[] => {
  const issues: ArcGisMetadataIssue[] = [];
  if (!contract.capabilities.has('query')) {
    issues.push(issue('missing-query-capability', 'error', 'Layer metadata does not advertise query support.'));
  }
  if (!contract.objectIdField) {
    issues.push(issue('missing-object-id', 'warning', 'Layer metadata has no object-id field.'));
  }
  if (contract.geometryType !== 'unknown' && !contract.spatialReference) {
    issues.push(issue('missing-spatial-reference', 'error', 'Spatial layer metadata has no usable spatial reference.'));
  }
  if (contract.maxRecordCount <= 0) {
    issues.push(issue('invalid-max-record-count', 'error', 'Layer maxRecordCount is invalid.'));
  }
  if (contract.capabilities.has('pagination') && !contract.capabilities.has('order-by') && !contract.objectIdField) {
    issues.push(issue('pagination-without-ordering', 'warning', 'Pagination is advertised without a deterministic identity/order field.'));
  }
  if (contract.geometryType === 'unknown') {
    issues.push(issue('unknown-geometry-type', 'warning', 'Layer geometry type could not be normalized.'));
  }
  if (contract.scales.minScale > 0 && contract.scales.maxScale > 0 && contract.scales.minScale <= contract.scales.maxScale) {
    issues.push(issue('invalid-scale-range', 'warning', 'ArcGIS scale range is internally inconsistent.'));
  }
  const fieldNames = new Set<string>();
  for (const field of contract.fields) {
    if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(field.name)) {
      issues.push(issue('invalid-field-name', 'warning', 'Field name does not match the safe query-field contract.', field.name));
    }
    const canonical = field.name.toLocaleLowerCase('en-US');
    if (fieldNames.has(canonical)) {
      issues.push(issue('duplicate-field-name', 'error', 'Layer metadata contains duplicate field names.', field.name));
    }
    fieldNames.add(canonical);
  }
  const hasField = (name: string | null): boolean => !name || contract.fieldMap.has(name);
  if (!hasField(contract.displayField)) {
    issues.push(issue('display-field-not-found', 'warning', 'Display field is missing from the field collection.', contract.displayField ?? undefined));
  }
  if (!hasField(contract.geometryField)) {
    issues.push(issue('geometry-field-not-found', 'warning', 'Geometry field is missing from the field collection.', contract.geometryField ?? undefined));
  }
  for (const timeField of [contract.time.startField, contract.time.endField, contract.time.trackIdField]) {
    if (timeField && !contract.fieldMap.has(timeField)) {
      issues.push(issue('time-field-not-found', 'warning', 'Time metadata references a missing field.', timeField));
    }
  }
  if ((contract.editing.create || contract.editing.update || contract.editing.delete) && !contract.objectIdField && !contract.globalIdField) {
    issues.push(issue('editing-without-identity', 'error', 'Editing is advertised without object-id or global-id identity.'));
  }
  return issues;
};

export const adaptArcGisLayerMetadata = (
  resourceUrl: string,
  metadataValue: unknown,
): ArcGisMetadataContract => {
  const normalizedUrl = normalizeResourceUrl(resourceUrl);
  if (!isRecord(metadataValue)) {
    throw new ArcGisMetadataContractError('ArcGIS layer metadata must be an object.', 'METADATA_NOT_OBJECT', normalizedUrl);
  }
  const metadata = metadataValue;
  const fields = Object.freeze(asArray(metadata.fields).map(fieldContract).filter((value): value is ArcGisFieldContract => value !== null));
  const fieldMap = new Map<string, ArcGisFieldContract>();
  for (const field of fields) {
    if (!fieldMap.has(field.name)) fieldMap.set(field.name, field);
  }
  const objectIdField = findIdentityField(metadata, fields, ['objectIdField', 'objectIdFieldName'], 'oid');
  const globalIdField = findIdentityField(metadata, fields, ['globalIdField', 'globalIdFieldName'], 'global-id');
  const capabilities = parseCapabilities(metadata);
  const maxRecordCount = positiveInteger(metadata.maxRecordCount, 1000);
  const base = {
    resourceUrl: normalizedUrl,
    name: text(metadata.name) ?? text(metadata.mapName),
    type: text(metadata.type) ?? text(metadata.layerType),
    geometryType: geometryType(metadata.geometryType),
    spatialReference: spatialReference(metadata),
    objectIdField,
    globalIdField,
    displayField: text(metadata.displayField),
    geometryField: text(metadata.geometryField?.toString()) ?? fields.find((field) => field.type === 'geometry')?.name ?? null,
    maxRecordCount,
    capabilities,
    fields,
    fieldMap,
    scales: normalizeScaleRange(metadata),
    time: timeContract(metadata),
    editing: editingContract(metadata),
    renderer: rendererContract(metadata),
    hasZ: boolean(metadata.hasZ),
    hasM: boolean(metadata.hasM),
  } satisfies Omit<ArcGisMetadataContract, 'issues' | 'queryReady' | 'identityReady'>;
  const issues = Object.freeze(collectIssues(base));
  const errorIssues = issues.filter((candidate) => candidate.severity === 'error');
  return Object.freeze({
    ...base,
    issues,
    queryReady: capabilities.has('query') && maxRecordCount > 0 && errorIssues.every((candidate) => candidate.code !== 'missing-spatial-reference'),
    identityReady: Boolean(objectIdField || globalIdField),
  });
};

export const metadataContractToQueryCapabilities = (
  contract: ArcGisMetadataContract,
): ArcGisLayerCapabilities => Object.freeze({
  resourceUrl: contract.resourceUrl,
  objectIdField: contract.objectIdField,
  maxRecordCount: contract.maxRecordCount,
  geometryType: contract.geometryType,
  spatialReference: contract.spatialReference,
  capabilities: contract.capabilities,
});

export const selectMetadataFields = (
  contract: ArcGisMetadataContract,
  requested: readonly string[],
): readonly ArcGisFieldContract[] => {
  const selected: ArcGisFieldContract[] = [];
  const seen = new Set<string>();
  for (const rawName of requested) {
    const name = String(rawName ?? '').trim();
    if (!name || seen.has(name)) continue;
    const field = contract.fieldMap.get(name);
    if (!field) continue;
    seen.add(name);
    selected.push(field);
  }
  return Object.freeze(selected);
};

export const diffArcGisMetadataContracts = (
  previous: ArcGisMetadataContract,
  next: ArcGisMetadataContract,
): Readonly<{
  breaking: readonly string[];
  warnings: readonly string[];
  addedFields: readonly string[];
  removedFields: readonly string[];
}> => {
  const breaking: string[] = [];
  const warnings: string[] = [];
  const previousNames = new Set(previous.fields.map((field) => field.name));
  const nextNames = new Set(next.fields.map((field) => field.name));
  const addedFields = next.fields.map((field) => field.name).filter((name) => !previousNames.has(name));
  const removedFields = previous.fields.map((field) => field.name).filter((name) => !nextNames.has(name));
  if (previous.geometryType !== next.geometryType) breaking.push('geometry-type-changed');
  if (previous.objectIdField !== next.objectIdField) breaking.push('object-id-field-changed');
  if (previous.globalIdField !== next.globalIdField) warnings.push('global-id-field-changed');
  if (previous.spatialReference?.wkid !== next.spatialReference?.wkid || previous.spatialReference?.wkt !== next.spatialReference?.wkt) {
    breaking.push('spatial-reference-changed');
  }
  if (previous.capabilities.has('query') && !next.capabilities.has('query')) breaking.push('query-capability-removed');
  if (previous.capabilities.has('pagination') && !next.capabilities.has('pagination')) warnings.push('pagination-capability-removed');
  if (next.maxRecordCount < previous.maxRecordCount) warnings.push('max-record-count-reduced');
  for (const removed of removedFields) {
    if ([previous.objectIdField, previous.globalIdField, previous.displayField].includes(removed)) {
      breaking.push(`critical-field-removed:${removed}`);
    }
  }
  return Object.freeze({
    breaking: Object.freeze([...new Set(breaking)]),
    warnings: Object.freeze([...new Set(warnings)]),
    addedFields: Object.freeze(addedFields),
    removedFields: Object.freeze(removedFields),
  });
};