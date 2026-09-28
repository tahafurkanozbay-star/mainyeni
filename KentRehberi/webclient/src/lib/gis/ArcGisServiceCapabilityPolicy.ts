export type ArcGisServiceKind = 'MapServer' | 'FeatureServer';
export type ArcGisLayerKind = 'feature' | 'map-image' | 'table';
export type ArcGisOperation =
  | 'query'
  | 'identify'
  | 'statistics'
  | 'pagination'
  | 'orderBy'
  | 'distinct'
  | 'create'
  | 'update'
  | 'delete'
  | 'attachments';

export interface ArcGisAdvancedQueryCapabilities {
  supportsPagination?: boolean;
  supportsOrderBy?: boolean;
  supportsStatistics?: boolean;
  supportsDistinct?: boolean;
}

export interface ArcGisEditingCapabilities {
  supportsAdd?: boolean;
  supportsUpdate?: boolean;
  supportsDelete?: boolean;
  supportsAttachments?: boolean;
}

export interface ArcGisServiceMetadata {
  serviceKind: ArcGisServiceKind;
  layerKind: ArcGisLayerKind;
  layerId: number;
  maxRecordCount?: number;
  minScale?: number;
  maxScale?: number;
  capabilities?: string | readonly string[];
  advancedQueryCapabilities?: ArcGisAdvancedQueryCapabilities;
  editing?: ArcGisEditingCapabilities;
  objectIdField?: string;
  globalIdField?: string;
  geometryType?: string | null;
}

export interface ArcGisCapabilityPolicyLimits {
  maxRecordCountCeiling: number;
  maxCapabilityTokens: number;
  maxFieldNameLength: number;
}

export interface ArcGisCapabilitySnapshot {
  readonly serviceKind: ArcGisServiceKind;
  readonly layerKind: ArcGisLayerKind;
  readonly layerId: number;
  readonly maxRecordCount: number;
  readonly minScale: number;
  readonly maxScale: number;
  readonly objectIdField: string | null;
  readonly globalIdField: string | null;
  readonly geometryType: string | null;
  readonly capabilities: ReadonlySet<string>;
  readonly operations: ReadonlySet<ArcGisOperation>;
}

export interface ArcGisOperationDecision {
  readonly allowed: boolean;
  readonly operation: ArcGisOperation;
  readonly reason: string;
  readonly maxRecordCount: number;
}

const DEFAULT_LIMITS: ArcGisCapabilityPolicyLimits = {
  maxRecordCountCeiling: 10_000,
  maxCapabilityTokens: 64,
  maxFieldNameLength: 128,
};

const SAFE_FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KNOWN_CAPABILITIES = new Set(['query', 'data', 'editing', 'create', 'update', 'delete', 'uploads']);

function finiteNonNegative(value: number | undefined, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function normalizeField(value: string | undefined, maxLength: number): string | null {
  if (!value || value.length > maxLength || !SAFE_FIELD.test(value)) return null;
  return value;
}

function normalizeCapabilities(
  value: string | readonly string[] | undefined,
  maxTokens: number,
): ReadonlySet<string> {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  if (raw.length > maxTokens) return new Set();
  const result = new Set<string>();
  for (const item of raw) {
    const token = item.trim().toLowerCase();
    if (!token || token.length > 64) continue;
    if (KNOWN_CAPABILITIES.has(token)) result.add(token);
  }
  return result;
}

function hasQuery(capabilities: ReadonlySet<string>): boolean {
  return capabilities.has('query') || capabilities.has('data');
}

function canEdit(capabilities: ReadonlySet<string>): boolean {
  return capabilities.has('editing');
}

export class ArcGisServiceCapabilityPolicy {
  private readonly limits: ArcGisCapabilityPolicyLimits;

  constructor(limits: Partial<ArcGisCapabilityPolicyLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    if (!Number.isInteger(this.limits.maxRecordCountCeiling) || this.limits.maxRecordCountCeiling < 1) {
      throw new Error('maxRecordCountCeiling must be a positive integer');
    }
    if (!Number.isInteger(this.limits.maxCapabilityTokens) || this.limits.maxCapabilityTokens < 1) {
      throw new Error('maxCapabilityTokens must be a positive integer');
    }
    if (!Number.isInteger(this.limits.maxFieldNameLength) || this.limits.maxFieldNameLength < 1) {
      throw new Error('maxFieldNameLength must be a positive integer');
    }
  }

  admit(metadata: ArcGisServiceMetadata): ArcGisCapabilitySnapshot {
    if (!Number.isInteger(metadata.layerId) || metadata.layerId < 0) {
      throw new Error('ArcGIS layerId must be a non-negative integer');
    }

    const capabilities = normalizeCapabilities(metadata.capabilities, this.limits.maxCapabilityTokens);
    const operations = new Set<ArcGisOperation>();
    const queryAllowed = hasQuery(capabilities);
    const isFeatureLayer = metadata.serviceKind === 'FeatureServer' && metadata.layerKind === 'feature';
    const isSpatial = metadata.layerKind !== 'table';

    if (queryAllowed) {
      operations.add('query');
      if (isSpatial) operations.add('identify');
      if (metadata.advancedQueryCapabilities?.supportsStatistics === true) operations.add('statistics');
      if (metadata.advancedQueryCapabilities?.supportsPagination === true) operations.add('pagination');
      if (metadata.advancedQueryCapabilities?.supportsOrderBy === true) operations.add('orderBy');
      if (metadata.advancedQueryCapabilities?.supportsDistinct === true) operations.add('distinct');
    }

    if (isFeatureLayer && canEdit(capabilities)) {
      if (metadata.editing?.supportsAdd === true || capabilities.has('create')) operations.add('create');
      if (metadata.editing?.supportsUpdate === true || capabilities.has('update')) operations.add('update');
      if (metadata.editing?.supportsDelete === true || capabilities.has('delete')) operations.add('delete');
      if (metadata.editing?.supportsAttachments === true || capabilities.has('uploads')) operations.add('attachments');
    }

    const advertisedRecordCount = finiteNonNegative(metadata.maxRecordCount, 0);
    const maxRecordCount = Math.min(
      this.limits.maxRecordCountCeiling,
      Number.isInteger(advertisedRecordCount) ? advertisedRecordCount : 0,
    );

    const minScale = finiteNonNegative(metadata.minScale);
    const maxScale = finiteNonNegative(metadata.maxScale);
    if (minScale > 0 && maxScale > 0 && minScale < maxScale) {
      throw new Error('ArcGIS scale range is inverted');
    }

    return Object.freeze({
      serviceKind: metadata.serviceKind,
      layerKind: metadata.layerKind,
      layerId: metadata.layerId,
      maxRecordCount,
      minScale,
      maxScale,
      objectIdField: normalizeField(metadata.objectIdField, this.limits.maxFieldNameLength),
      globalIdField: normalizeField(metadata.globalIdField, this.limits.maxFieldNameLength),
      geometryType: typeof metadata.geometryType === 'string' ? metadata.geometryType.slice(0, 64) : null,
      capabilities,
      operations,
    });
  }

  decide(snapshot: ArcGisCapabilitySnapshot, operation: ArcGisOperation): ArcGisOperationDecision {
    if (!snapshot.operations.has(operation)) {
      return Object.freeze({
        allowed: false,
        operation,
        reason: `operation-not-advertised:${operation}`,
        maxRecordCount: snapshot.maxRecordCount,
      });
    }

    if ((operation === 'update' || operation === 'delete') && !snapshot.objectIdField && !snapshot.globalIdField) {
      return Object.freeze({
        allowed: false,
        operation,
        reason: 'mutation-identity-missing',
        maxRecordCount: snapshot.maxRecordCount,
      });
    }

    if (operation === 'query' && snapshot.maxRecordCount < 1) {
      return Object.freeze({
        allowed: false,
        operation,
        reason: 'record-budget-missing',
        maxRecordCount: 0,
      });
    }

    return Object.freeze({
      allowed: true,
      operation,
      reason: 'allowed',
      maxRecordCount: snapshot.maxRecordCount,
    });
  }

  isVisibleAtScale(snapshot: ArcGisCapabilitySnapshot, scale: number): boolean {
    if (!Number.isFinite(scale) || scale <= 0) return false;
    if (snapshot.minScale > 0 && scale > snapshot.minScale) return false;
    if (snapshot.maxScale > 0 && scale < snapshot.maxScale) return false;
    return true;
  }

  clampRequestedRecordCount(snapshot: ArcGisCapabilitySnapshot, requested: number): number {
    if (!Number.isInteger(requested) || requested < 1 || snapshot.maxRecordCount < 1) return 0;
    return Math.min(requested, snapshot.maxRecordCount);
  }
}
