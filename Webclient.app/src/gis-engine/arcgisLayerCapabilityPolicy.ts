export type ArcGisLayerServiceKind = 'feature' | 'map-image' | 'scene' | 'imagery' | 'tile' | 'vector-tile';
export type ArcGisQueryOperation = 'count' | 'extent' | 'features' | 'ids' | 'statistics';

export interface ArcGisLayerCapabilities {
  readonly serviceKind: ArcGisLayerServiceKind;
  readonly supportsQuery: boolean;
  readonly supportsPagination?: boolean | undefined;
  readonly supportsOrderBy?: boolean | undefined;
  readonly supportsStatistics?: boolean | undefined;
  readonly supportsDistinct?: boolean | undefined;
  readonly supportsReturningGeometry?: boolean | undefined;
  readonly supportsQuantization?: boolean | undefined;
  readonly supportsClustering?: boolean | undefined;
  readonly supportsZ?: boolean | undefined;
  readonly maxRecordCount?: number | undefined;
  readonly maxRecordCountFactor?: number | undefined;
  readonly objectIdField?: string | undefined;
  readonly globalIdField?: string | undefined;
}

export interface ArcGisQueryIntent {
  readonly operation: ArcGisQueryOperation;
  readonly requestedRecordCount?: number;
  readonly returnGeometry?: boolean;
  readonly orderBy?: readonly string[];
  readonly statistics?: readonly string[];
  readonly distinct?: boolean;
  readonly quantize?: boolean;
  readonly requireStablePaging?: boolean;
}

export interface ArcGisQueryPlan {
  readonly allowed: boolean;
  readonly operation: ArcGisQueryOperation;
  readonly pageSize: number;
  readonly returnGeometry: boolean;
  readonly usePagination: boolean;
  readonly useOrderBy: boolean;
  readonly useStatistics: boolean;
  readonly useDistinct: boolean;
  readonly useQuantization: boolean;
  readonly stableIdField?: string;
  readonly reasons: readonly string[];
}

export interface ArcGisCapabilityPolicyOptions {
  readonly defaultPageSize?: number;
  readonly hardMaxPageSize?: number;
  readonly maxOrderByFields?: number;
  readonly maxStatistics?: number;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new RangeError(`${name} must be a positive safe integer`);
  return resolved;
}

function optionalPositiveInteger(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  return positiveInteger(value, 1, name);
}

function normalizeField(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.length > 128) throw new RangeError('ArcGIS field name exceeds 128 characters');
  return normalized;
}

function normalizeStringList(values: readonly string[] | undefined, max: number, name: string): readonly string[] {
  if (values === undefined) return Object.freeze([]);
  if (values.length > max) throw new RangeError(`${name} exceeds configured limit`);
  const normalized = values.map((value) => value.trim());
  if (normalized.some((value) => value.length === 0)) throw new TypeError(`${name} contains an empty value`);
  if (normalized.some((value) => value.length > 512)) throw new RangeError(`${name} contains an oversized value`);
  return Object.freeze(normalized);
}

function supportsFeatureQueries(kind: ArcGisLayerServiceKind): boolean {
  return kind === 'feature' || kind === 'map-image' || kind === 'scene';
}

/**
 * Converts already-verified ArcGIS REST metadata into a fail-closed client query policy.
 * This module never discovers endpoints and never upgrades unknown capability facts to true.
 */
export class ArcGisLayerCapabilityPolicy {
  private readonly defaultPageSize: number;
  private readonly hardMaxPageSize: number;
  private readonly maxOrderByFields: number;
  private readonly maxStatistics: number;

  constructor(options: ArcGisCapabilityPolicyOptions = {}) {
    this.defaultPageSize = positiveInteger(options.defaultPageSize, 500, 'defaultPageSize');
    this.hardMaxPageSize = positiveInteger(options.hardMaxPageSize, 2_000, 'hardMaxPageSize');
    this.maxOrderByFields = positiveInteger(options.maxOrderByFields, 8, 'maxOrderByFields');
    this.maxStatistics = positiveInteger(options.maxStatistics, 16, 'maxStatistics');
    if (this.defaultPageSize > this.hardMaxPageSize) throw new RangeError('defaultPageSize exceeds hardMaxPageSize');
  }

  plan(capabilitiesInput: ArcGisLayerCapabilities, intent: ArcGisQueryIntent): ArcGisQueryPlan {
    const capabilities = this.normalizeCapabilities(capabilitiesInput);
    const orderBy = normalizeStringList(intent.orderBy, this.maxOrderByFields, 'orderBy');
    const statistics = normalizeStringList(intent.statistics, this.maxStatistics, 'statistics');
    const reasons: string[] = [];
    const queryCapableKind = supportsFeatureQueries(capabilities.serviceKind);
    if (!queryCapableKind) reasons.push(`service kind ${capabilities.serviceKind} is not feature-query capable`);
    if (!capabilities.supportsQuery) reasons.push('service metadata does not advertise query support');

    const requestedRecordCount = optionalPositiveInteger(intent.requestedRecordCount, 'requestedRecordCount');
    const advertisedMax = capabilities.maxRecordCount ?? this.defaultPageSize;
    const factor = capabilities.maxRecordCountFactor ?? 1;
    const effectiveAdvertisedMax = Math.max(1, Math.floor(advertisedMax * factor));
    const pageSize = Math.min(requestedRecordCount ?? this.defaultPageSize, effectiveAdvertisedMax, this.hardMaxPageSize);

    const returnGeometry = intent.returnGeometry === true;
    if (returnGeometry && capabilities.supportsReturningGeometry !== true) reasons.push('geometry return was requested but is not explicitly supported');

    const useOrderBy = orderBy.length > 0;
    if (useOrderBy && capabilities.supportsOrderBy !== true) reasons.push('orderBy was requested but is not explicitly supported');

    const useStatistics = statistics.length > 0 || intent.operation === 'statistics';
    if (useStatistics && capabilities.supportsStatistics !== true) reasons.push('statistics were requested but are not explicitly supported');

    const useDistinct = intent.distinct === true;
    if (useDistinct && capabilities.supportsDistinct !== true) reasons.push('distinct values were requested but are not explicitly supported');

    const useQuantization = intent.quantize === true;
    if (useQuantization && capabilities.supportsQuantization !== true) reasons.push('quantization was requested but is not explicitly supported');

    const stableIdField = capabilities.objectIdField ?? capabilities.globalIdField;
    const wantsPaging = intent.operation === 'features' && (requestedRecordCount === undefined || requestedRecordCount > pageSize);
    const usePagination = wantsPaging && capabilities.supportsPagination === true;
    if (wantsPaging && !usePagination && intent.requireStablePaging === true) reasons.push('stable paging was required but pagination is not explicitly supported');
    if (usePagination && intent.requireStablePaging === true && stableIdField === undefined) reasons.push('stable paging requires a verified object/global id field');

    if (intent.operation === 'statistics' && statistics.length === 0) reasons.push('statistics operation requires at least one statistic expression');
    if (intent.operation === 'extent' && returnGeometry) reasons.push('extent operation must not request feature geometry payloads');
    if ((intent.operation === 'count' || intent.operation === 'ids') && returnGeometry) reasons.push(`${intent.operation} operation must not request geometry`);

    return Object.freeze({
      allowed: reasons.length === 0,
      operation: intent.operation,
      pageSize,
      returnGeometry,
      usePagination,
      useOrderBy,
      useStatistics,
      useDistinct,
      useQuantization,
      ...(stableIdField === undefined ? {} : { stableIdField }),
      reasons: Object.freeze(reasons),
    });
  }

  canCluster(capabilitiesInput: ArcGisLayerCapabilities): boolean {
    const capabilities = this.normalizeCapabilities(capabilitiesInput);
    return capabilities.serviceKind === 'feature' && capabilities.supportsClustering === true;
  }

  canRenderZ(capabilitiesInput: ArcGisLayerCapabilities): boolean {
    const capabilities = this.normalizeCapabilities(capabilitiesInput);
    return (capabilities.serviceKind === 'feature' || capabilities.serviceKind === 'scene') && capabilities.supportsZ === true;
  }

  private normalizeCapabilities(input: ArcGisLayerCapabilities): ArcGisLayerCapabilities {
    const maxRecordCount = optionalPositiveInteger(input.maxRecordCount, 'maxRecordCount');
    const maxRecordCountFactor = input.maxRecordCountFactor;
    if (maxRecordCountFactor !== undefined && (!Number.isFinite(maxRecordCountFactor) || maxRecordCountFactor <= 0 || maxRecordCountFactor > 100)) {
      throw new RangeError('maxRecordCountFactor must be finite and between 0 and 100');
    }
    const objectIdField = normalizeField(input.objectIdField);
    const globalIdField = normalizeField(input.globalIdField);
    return Object.freeze({
      ...input,
      ...(maxRecordCount === undefined ? {} : { maxRecordCount }),
      ...(maxRecordCountFactor === undefined ? {} : { maxRecordCountFactor }),
      ...(objectIdField === undefined ? {} : { objectIdField }),
      ...(globalIdField === undefined ? {} : { globalIdField }),
    });
  }
}
