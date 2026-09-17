import type { ArcGisGeometryType, ArcGisServiceCapabilities } from './arcgisCapabilityAdapter';

export type SpatialIntegritySeverity = 'info' | 'warning' | 'error' | 'critical';
export type SpatialIntegrityMode = 'audit' | 'quarantine' | 'strict';
export type SpatialIntegrityGeometryKind = 'point' | 'multipoint' | 'polyline' | 'polygon' | 'extent' | 'unknown';

export interface SpatialReferenceLike {
  wkid?: number;
  latestWkid?: number;
}

export interface ArcGisFeatureLike {
  attributes?: Record<string, unknown> | null;
  geometry?: unknown;
}

export interface SpatialIntegrityFinding {
  severity: SpatialIntegritySeverity;
  code: string;
  message: string;
  featureIndex: number | null;
  path: string | null;
}

export interface SpatialIntegrityConfiguration {
  mode?: SpatialIntegrityMode;
  maxFeatures?: number;
  maxAttributesPerFeature?: number;
  maxVerticesPerFeature?: number;
  maxTotalVertices?: number;
  maxGeometryDepth?: number;
  requiredFields?: readonly string[];
  allowedFields?: readonly string[];
  expectedGeometryType?: ArcGisGeometryType | SpatialIntegrityGeometryKind;
  expectedWkid?: number;
  objectIdField?: string;
  requireUniqueObjectIds?: boolean;
}

export interface SpatialIntegrityFeatureRecord<TFeature extends ArcGisFeatureLike = ArcGisFeatureLike> {
  feature: TFeature;
  index: number;
  objectId: string | number | null;
  geometryKind: SpatialIntegrityGeometryKind;
  vertexCount: number;
  fingerprint: string;
  valid: boolean;
  quarantined: boolean;
  findings: readonly SpatialIntegrityFinding[];
}

export interface SpatialIntegrityBatchResult<TFeature extends ArcGisFeatureLike = ArcGisFeatureLike> {
  mode: SpatialIntegrityMode;
  accepted: readonly TFeature[];
  quarantined: readonly TFeature[];
  records: readonly SpatialIntegrityFeatureRecord<TFeature>[];
  findings: readonly SpatialIntegrityFinding[];
  totalVertices: number;
  duplicateObjectIds: readonly (string | number)[];
  truncated: boolean;
  valid: boolean;
  fingerprint: string;
}

export interface SpatialIntegritySnapshot {
  batches: number;
  inspectedFeatures: number;
  acceptedFeatures: number;
  quarantinedFeatures: number;
  findings: number;
  errors: number;
  critical: number;
  totalVertices: number;
  disposed: boolean;
}

interface NormalizedConfiguration {
  mode: SpatialIntegrityMode;
  maxFeatures: number;
  maxAttributesPerFeature: number;
  maxVerticesPerFeature: number;
  maxTotalVertices: number;
  maxGeometryDepth: number;
  requiredFields: readonly string[];
  allowedFields: ReadonlySet<string> | null;
  expectedGeometryType: SpatialIntegrityGeometryKind | null;
  expectedWkid: number | null;
  objectIdField: string | null;
  requireUniqueObjectIds: boolean;
}

interface GeometryInspection {
  kind: SpatialIntegrityGeometryKind;
  vertexCount: number;
  wkid: number | null;
  findings: SpatialIntegrityFinding[];
}

const DEFAULT_MAX_FEATURES = 25_000;
const DEFAULT_MAX_ATTRIBUTES = 256;
const DEFAULT_MAX_VERTICES_PER_FEATURE = 100_000;
const DEFAULT_MAX_TOTAL_VERTICES = 1_000_000;
const DEFAULT_MAX_DEPTH = 8;

const finiteInteger = (value: unknown, fallback: number, min: number, max: number): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(numeric)));
};

const normalizeText = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

const normalizeFieldList = (values: readonly string[] | undefined): readonly string[] => Object.freeze(
  [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))],
);

const normalizeGeometryKind = (value: unknown): SpatialIntegrityGeometryKind | null => {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized || normalized === 'unknown') return null;
  if (normalized.includes('multipoint')) return 'multipoint';
  if (normalized.includes('point')) return 'point';
  if (normalized.includes('polyline') || normalized.includes('line')) return 'polyline';
  if (normalized.includes('polygon')) return 'polygon';
  if (normalized.includes('extent')) return 'extent';
  return null;
};

const normalizeConfiguration = (input: SpatialIntegrityConfiguration = {}): NormalizedConfiguration => {
  const allowedFields = normalizeFieldList(input.allowedFields);
  const expectedWkid = Number(input.expectedWkid);
  return Object.freeze({
    mode: input.mode ?? 'quarantine',
    maxFeatures: finiteInteger(input.maxFeatures, DEFAULT_MAX_FEATURES, 1, 500_000),
    maxAttributesPerFeature: finiteInteger(input.maxAttributesPerFeature, DEFAULT_MAX_ATTRIBUTES, 1, 10_000),
    maxVerticesPerFeature: finiteInteger(input.maxVerticesPerFeature, DEFAULT_MAX_VERTICES_PER_FEATURE, 1, 5_000_000),
    maxTotalVertices: finiteInteger(input.maxTotalVertices, DEFAULT_MAX_TOTAL_VERTICES, 1, 20_000_000),
    maxGeometryDepth: finiteInteger(input.maxGeometryDepth, DEFAULT_MAX_DEPTH, 2, 32),
    requiredFields: normalizeFieldList(input.requiredFields),
    allowedFields: allowedFields.length ? new Set(allowedFields) : null,
    expectedGeometryType: normalizeGeometryKind(input.expectedGeometryType),
    expectedWkid: Number.isFinite(expectedWkid) && expectedWkid > 0 ? Math.floor(expectedWkid) : null,
    objectIdField: normalizeText(input.objectIdField) || null,
    requireUniqueObjectIds: input.requireUniqueObjectIds !== false,
  });
};

const finding = (
  severity: SpatialIntegritySeverity,
  code: string,
  message: string,
  featureIndex: number | null,
  path: string | null = null,
): SpatialIntegrityFinding => Object.freeze({ severity, code, message, featureIndex, path });

const isRecord = (value: unknown): value is Record<string, unknown> => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const finiteCoordinate = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value);

const spatialReferenceWkid = (geometry: Record<string, unknown>): number | null => {
  const spatialReference = geometry.spatialReference;
  if (!isRecord(spatialReference)) return null;
  const candidate = spatialReference.latestWkid ?? spatialReference.wkid;
  const numeric = Number(candidate);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : null;
};

const coordinatePairValid = (value: unknown): boolean => (
  Array.isArray(value)
  && value.length >= 2
  && finiteCoordinate(value[0])
  && finiteCoordinate(value[1])
);

const countCoordinateTree = (
  value: unknown,
  depth: number,
  maxDepth: number,
): { count: number; invalid: boolean; depthExceeded: boolean } => {
  if (depth > maxDepth) return { count: 0, invalid: false, depthExceeded: true };
  if (coordinatePairValid(value)) return { count: 1, invalid: false, depthExceeded: false };
  if (!Array.isArray(value)) return { count: 0, invalid: true, depthExceeded: false };

  let count = 0;
  let invalid = false;
  let depthExceeded = false;
  for (const child of value) {
    const result = countCoordinateTree(child, depth + 1, maxDepth);
    count += result.count;
    invalid ||= result.invalid;
    depthExceeded ||= result.depthExceeded;
  }
  return { count, invalid, depthExceeded };
};

const inferGeometryKind = (geometry: Record<string, unknown>): SpatialIntegrityGeometryKind => {
  if (finiteCoordinate(geometry.x) && finiteCoordinate(geometry.y)) return 'point';
  if (Array.isArray(geometry.points)) return 'multipoint';
  if (Array.isArray(geometry.paths)) return 'polyline';
  if (Array.isArray(geometry.rings)) return 'polygon';
  if (
    finiteCoordinate(geometry.xmin)
    && finiteCoordinate(geometry.ymin)
    && finiteCoordinate(geometry.xmax)
    && finiteCoordinate(geometry.ymax)
  ) return 'extent';
  return 'unknown';
};

const inspectGeometry = (
  geometry: unknown,
  featureIndex: number,
  configuration: NormalizedConfiguration,
): GeometryInspection => {
  const findings: SpatialIntegrityFinding[] = [];
  if (geometry == null) {
    return { kind: 'unknown', vertexCount: 0, wkid: null, findings };
  }
  if (!isRecord(geometry)) {
    findings.push(finding('error', 'geometry-not-object', 'Geometry must be an object.', featureIndex, 'geometry'));
    return { kind: 'unknown', vertexCount: 0, wkid: null, findings };
  }

  const kind = inferGeometryKind(geometry);
  const wkid = spatialReferenceWkid(geometry);
  let vertexCount = 0;

  if (kind === 'point') {
    vertexCount = 1;
  } else if (kind === 'extent') {
    vertexCount = 2;
    if (Number(geometry.xmin) > Number(geometry.xmax) || Number(geometry.ymin) > Number(geometry.ymax)) {
      findings.push(finding('error', 'extent-order-invalid', 'Extent minimum coordinates exceed maximum coordinates.', featureIndex, 'geometry'));
    }
  } else if (kind === 'multipoint' || kind === 'polyline' || kind === 'polygon') {
    const tree = kind === 'multipoint' ? geometry.points : kind === 'polyline' ? geometry.paths : geometry.rings;
    const counted = countCoordinateTree(tree, 0, configuration.maxGeometryDepth);
    vertexCount = counted.count;
    if (counted.invalid) {
      findings.push(finding('error', 'geometry-coordinate-invalid', 'Geometry contains a malformed coordinate node.', featureIndex, 'geometry'));
    }
    if (counted.depthExceeded) {
      findings.push(finding('critical', 'geometry-depth-exceeded', 'Geometry nesting exceeds the configured safety depth.', featureIndex, 'geometry'));
    }
  } else {
    findings.push(finding('error', 'geometry-kind-unknown', 'Geometry shape could not be recognized.', featureIndex, 'geometry'));
  }

  if (vertexCount > configuration.maxVerticesPerFeature) {
    findings.push(finding(
      'critical',
      'feature-vertex-budget-exceeded',
      `Feature contains ${vertexCount} vertices, exceeding the configured per-feature budget.`,
      featureIndex,
      'geometry',
    ));
  }

  if (configuration.expectedGeometryType && kind !== 'unknown' && kind !== configuration.expectedGeometryType) {
    findings.push(finding(
      'error',
      'geometry-type-mismatch',
      `Expected ${configuration.expectedGeometryType} geometry but received ${kind}.`,
      featureIndex,
      'geometry',
    ));
  }

  if (configuration.expectedWkid && wkid && wkid !== configuration.expectedWkid) {
    findings.push(finding(
      'error',
      'spatial-reference-mismatch',
      `Expected WKID ${configuration.expectedWkid} but received ${wkid}.`,
      featureIndex,
      'geometry.spatialReference',
    ));
  }

  return { kind, vertexCount, wkid, findings };
};

const scalarFingerprint = (value: unknown): string => {
  if (value === null) return 'null';
  if (typeof value === 'string') return `s:${value}`;
  if (typeof value === 'number') return Number.isFinite(value) ? `n:${value}` : 'n:invalid';
  if (typeof value === 'boolean') return value ? 'b:1' : 'b:0';
  return `t:${typeof value}`;
};

const fnv = (parts: readonly string[]): string => {
  let hash = 2_166_136_261;
  for (const part of parts) {
    for (let index = 0; index < part.length; index += 1) {
      hash ^= part.charCodeAt(index);
      hash = Math.imul(hash, 16_777_619) >>> 0;
    }
  }
  return hash.toString(16).padStart(8, '0');
};

const inspectAttributes = (
  attributes: Record<string, unknown> | null | undefined,
  featureIndex: number,
  configuration: NormalizedConfiguration,
): { objectId: string | number | null; findings: SpatialIntegrityFinding[]; fingerprintParts: string[] } => {
  const findings: SpatialIntegrityFinding[] = [];
  if (!isRecord(attributes)) {
    findings.push(finding('error', 'attributes-not-object', 'Feature attributes must be an object.', featureIndex, 'attributes'));
    return { objectId: null, findings, fingerprintParts: ['attributes:null'] };
  }

  const keys = Object.keys(attributes).sort();
  if (keys.length > configuration.maxAttributesPerFeature) {
    findings.push(finding(
      'critical',
      'attribute-budget-exceeded',
      `Feature contains ${keys.length} attributes, exceeding the configured budget.`,
      featureIndex,
      'attributes',
    ));
  }

  for (const required of configuration.requiredFields) {
    if (!(required in attributes) || attributes[required] == null) {
      findings.push(finding('error', 'required-field-missing', `Required field ${required} is missing.`, featureIndex, `attributes.${required}`));
    }
  }

  if (configuration.allowedFields) {
    for (const key of keys) {
      if (!configuration.allowedFields.has(key)) {
        findings.push(finding('warning', 'field-not-allowlisted', `Field ${key} is outside the configured allowlist.`, featureIndex, `attributes.${key}`));
      }
    }
  }

  let objectId: string | number | null = null;
  if (configuration.objectIdField) {
    const value = attributes[configuration.objectIdField];
    if (typeof value === 'string' || typeof value === 'number') objectId = value;
    else findings.push(finding('error', 'object-id-missing', `Object id field ${configuration.objectIdField} is missing or invalid.`, featureIndex, `attributes.${configuration.objectIdField}`));
  }

  const fingerprintParts = keys.map((key) => `${key}=${scalarFingerprint(attributes[key])}`);
  return { objectId, findings, fingerprintParts };
};

const recordInvalid = (findings: readonly SpatialIntegrityFinding[]): boolean => findings.some(
  (item) => item.severity === 'error' || item.severity === 'critical',
);

export const configurationFromCapabilities = (
  capabilities: ArcGisServiceCapabilities,
  overrides: SpatialIntegrityConfiguration = {},
): SpatialIntegrityConfiguration => {
  const configuration: SpatialIntegrityConfiguration = {
    expectedGeometryType: capabilities.geometryType,
    allowedFields: capabilities.fieldNames,
  };
  Object.assign(configuration, overrides);
  if (overrides.expectedWkid === undefined && capabilities.spatialReferenceWkid !== null) {
    configuration.expectedWkid = capabilities.spatialReferenceWkid;
  }
  if (overrides.objectIdField === undefined && capabilities.objectIdField !== null) {
    configuration.objectIdField = capabilities.objectIdField;
  }
  return configuration;
};

export class SpatialIntegrityRuntime {
  #configuration: NormalizedConfiguration;
  #batches = 0;
  #inspectedFeatures = 0;
  #acceptedFeatures = 0;
  #quarantinedFeatures = 0;
  #findingCount = 0;
  #errors = 0;
  #critical = 0;
  #totalVertices = 0;
  #disposed = false;

  constructor(configuration: SpatialIntegrityConfiguration = {}) {
    this.#configuration = normalizeConfiguration(configuration);
  }

  configure(configuration: SpatialIntegrityConfiguration): SpatialIntegritySnapshot {
    this.#assertActive();
    this.#configuration = normalizeConfiguration(configuration);
    return this.snapshot();
  }

  inspectBatch<TFeature extends ArcGisFeatureLike>(features: readonly TFeature[]): SpatialIntegrityBatchResult<TFeature> {
    this.#assertActive();
    const accepted: TFeature[] = [];
    const quarantined: TFeature[] = [];
    const records: SpatialIntegrityFeatureRecord<TFeature>[] = [];
    const findings: SpatialIntegrityFinding[] = [];
    const duplicateObjectIds: (string | number)[] = [];
    const seenObjectIds = new Set<string>();
    const batchFingerprintParts: string[] = [];
    const inspected = features.slice(0, this.#configuration.maxFeatures);
    const truncated = features.length > inspected.length;
    let totalVertices = 0;

    if (truncated) {
      findings.push(finding(
        'critical',
        'feature-batch-budget-exceeded',
        `Batch contains ${features.length} features; only ${inspected.length} were inspected.`,
        null,
      ));
    }

    for (const [index, feature] of inspected.entries()) {
      const attributeInspection = inspectAttributes(feature.attributes, index, this.#configuration);
      const geometryInspection = inspectGeometry(feature.geometry, index, this.#configuration);
      const featureFindings = [...attributeInspection.findings, ...geometryInspection.findings];
      totalVertices += geometryInspection.vertexCount;

      if (totalVertices > this.#configuration.maxTotalVertices) {
        featureFindings.push(finding(
          'critical',
          'batch-vertex-budget-exceeded',
          `Batch vertex total exceeds ${this.#configuration.maxTotalVertices}.`,
          index,
          'geometry',
        ));
      }

      if (this.#configuration.requireUniqueObjectIds && attributeInspection.objectId != null) {
        const identity = `${typeof attributeInspection.objectId}:${String(attributeInspection.objectId)}`;
        if (seenObjectIds.has(identity)) {
          duplicateObjectIds.push(attributeInspection.objectId);
          featureFindings.push(finding(
            'error',
            'duplicate-object-id',
            `Duplicate object id ${String(attributeInspection.objectId)} encountered.`,
            index,
            this.#configuration.objectIdField ? `attributes.${this.#configuration.objectIdField}` : 'attributes',
          ));
        } else {
          seenObjectIds.add(identity);
        }
      }

      const fingerprint = fnv([
        ...attributeInspection.fingerprintParts,
        `geometry:${geometryInspection.kind}`,
        `vertices:${geometryInspection.vertexCount}`,
        `wkid:${geometryInspection.wkid ?? 'none'}`,
      ]);
      const invalid = recordInvalid(featureFindings);
      const shouldQuarantine = invalid && this.#configuration.mode !== 'audit';
      if (shouldQuarantine) quarantined.push(feature);
      else accepted.push(feature);
      findings.push(...featureFindings);
      batchFingerprintParts.push(fingerprint);
      records.push(Object.freeze({
        feature,
        index,
        objectId: attributeInspection.objectId,
        geometryKind: geometryInspection.kind,
        vertexCount: geometryInspection.vertexCount,
        fingerprint,
        valid: !invalid,
        quarantined: shouldQuarantine,
        findings: Object.freeze(featureFindings),
      }));

      if (this.#configuration.mode === 'strict' && invalid) break;
      if (totalVertices > this.#configuration.maxTotalVertices && this.#configuration.mode !== 'audit') break;
    }

    const valid = !recordInvalid(findings) && !truncated;
    this.#batches += 1;
    this.#inspectedFeatures += records.length;
    this.#acceptedFeatures += accepted.length;
    this.#quarantinedFeatures += quarantined.length;
    this.#findingCount += findings.length;
    this.#errors += findings.filter((item) => item.severity === 'error').length;
    this.#critical += findings.filter((item) => item.severity === 'critical').length;
    this.#totalVertices += totalVertices;

    return Object.freeze({
      mode: this.#configuration.mode,
      accepted: Object.freeze(accepted),
      quarantined: Object.freeze(quarantined),
      records: Object.freeze(records),
      findings: Object.freeze(findings),
      totalVertices,
      duplicateObjectIds: Object.freeze(duplicateObjectIds),
      truncated,
      valid,
      fingerprint: fnv(batchFingerprintParts),
    });
  }

  snapshot(): SpatialIntegritySnapshot {
    return Object.freeze({
      batches: this.#batches,
      inspectedFeatures: this.#inspectedFeatures,
      acceptedFeatures: this.#acceptedFeatures,
      quarantinedFeatures: this.#quarantinedFeatures,
      findings: this.#findingCount,
      errors: this.#errors,
      critical: this.#critical,
      totalVertices: this.#totalVertices,
      disposed: this.#disposed,
    });
  }

  resetMetrics(): void {
    this.#assertActive();
    this.#batches = 0;
    this.#inspectedFeatures = 0;
    this.#acceptedFeatures = 0;
    this.#quarantinedFeatures = 0;
    this.#findingCount = 0;
    this.#errors = 0;
    this.#critical = 0;
    this.#totalVertices = 0;
  }

  dispose(): void {
    this.#disposed = true;
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw Object.assign(new Error('Spatial integrity runtime has been disposed.'), {
        code: 'SPATIAL_INTEGRITY_DISPOSED',
      });
    }
  }
}

export const createSpatialIntegrityRuntime = (
  configuration: SpatialIntegrityConfiguration = {},
): SpatialIntegrityRuntime => new SpatialIntegrityRuntime(configuration);
