import {
  type ArcGisCapabilityContract,
  type ArcGisFieldContract,
  ARCGIS_QUERY_CAPABILITY,
} from "./serviceCapabilityRuntime";
import {
  type NormalizedSpatialReference,
  normalizeSpatialReference,
} from "./spatialReferenceRuntime";

export type SpatialQueryStatisticType =
  | "count"
  | "sum"
  | "min"
  | "max"
  | "avg"
  | "stddev"
  | "var";

export interface SpatialQueryStatisticInput {
  readonly statisticType: SpatialQueryStatisticType;
  readonly onStatisticField?: string | null;
  readonly outStatisticFieldName: string;
}

export interface SpatialQueryOrderInput {
  readonly field: string;
  readonly direction?: "ASC" | "DESC";
}

export interface SpatialQueryContractInput {
  readonly where?: string;
  readonly outFields?: readonly string[];
  readonly orderBy?: readonly SpatialQueryOrderInput[];
  readonly statistics?: readonly SpatialQueryStatisticInput[];
  readonly groupByFields?: readonly string[];
  readonly distinct?: boolean;
  readonly returnGeometry?: boolean;
  readonly returnCentroid?: boolean;
  readonly geometryPrecision?: number | null;
  readonly outSpatialReference?: NormalizedSpatialReference | null;
  readonly requireStablePagination?: boolean;
}

export interface CompiledSpatialQueryStatistic {
  readonly statisticType: SpatialQueryStatisticType;
  readonly onStatisticField: string | null;
  readonly outStatisticFieldName: string;
}

export interface CompiledSpatialQueryOrder {
  readonly field: string;
  readonly direction: "ASC" | "DESC";
}

export interface CompiledSpatialQueryContract {
  readonly where: string;
  readonly outFields: readonly string[];
  readonly orderBy: readonly CompiledSpatialQueryOrder[];
  readonly statistics: readonly CompiledSpatialQueryStatistic[];
  readonly groupByFields: readonly string[];
  readonly distinct: boolean;
  readonly returnGeometry: boolean;
  readonly returnCentroid: boolean;
  readonly geometryPrecision: number | null;
  readonly sourceSpatialReference: NormalizedSpatialReference | null;
  readonly outSpatialReference: NormalizedSpatialReference | null;
  readonly objectIdField: string | null;
  readonly stablePagination: boolean;
  readonly fingerprint: string;
}

export interface SpatialQueryContractLimits {
  readonly maxWhereLength?: number;
  readonly maxOutFields?: number;
  readonly maxOrderFields?: number;
  readonly maxStatistics?: number;
  readonly maxGroupFields?: number;
  readonly maxAliasLength?: number;
}

const DEFAULT_LIMITS = Object.freeze({
  maxWhereLength: 8_192,
  maxOutFields: 256,
  maxOrderFields: 16,
  maxStatistics: 32,
  maxGroupFields: 16,
  maxAliasLength: 128,
});

const MAX_IDENTIFIER_LENGTH = 128;
const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_.]*$/;
const ALIAS_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NUMERIC_FIELD_TYPES = new Set([
  "esriFieldTypeSmallInteger",
  "esriFieldTypeInteger",
  "esriFieldTypeSingle",
  "esriFieldTypeDouble",
  "esriFieldTypeOID",
  "small-integer",
  "integer",
  "single",
  "double",
  "oid",
]);

function positiveLimit(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return resolved;
}

function normalizeWhere(value: string | undefined, maxLength: number): string {
  const where = (value ?? "1=1").trim();
  if (where.length === 0) {
    throw new TypeError("where clause must not be empty");
  }
  if (where.length > maxLength) {
    throw new RangeError("where clause exceeds configured length budget");
  }
  for (let index = 0; index < where.length; index += 1) {
    const code = where.charCodeAt(index);
    if (code === 0 || code === 10 || code === 13) {
      throw new TypeError("where clause contains unsupported control characters");
    }
  }
  return where;
}

function normalizeIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > MAX_IDENTIFIER_LENGTH) {
    throw new RangeError(`${label} has invalid length`);
  }
  if (!IDENTIFIER_PATTERN.test(normalized)) {
    throw new TypeError(`${label} contains unsupported characters`);
  }
  return normalized;
}

function normalizeAlias(value: string, maxLength: number): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) {
    throw new RangeError("statistic output alias has invalid length");
  }
  if (!ALIAS_PATTERN.test(normalized)) {
    throw new TypeError("statistic output alias contains unsupported characters");
  }
  return normalized;
}

function fieldMap(contract: ArcGisCapabilityContract): ReadonlyMap<string, ArcGisFieldContract> {
  const map = new Map<string, ArcGisFieldContract>();
  for (const field of contract.fields) {
    const name = field.name.trim();
    if (name.length > 0) {
      map.set(name.toLowerCase(), field);
    }
  }
  return map;
}

function requireField(
  fields: ReadonlyMap<string, ArcGisFieldContract>,
  value: string,
  label: string,
): string {
  const normalized = normalizeIdentifier(value, label);
  if (!fields.has(normalized.toLowerCase())) {
    throw new TypeError(`${label} is not present in verified ArcGIS metadata`);
  }
  return normalized;
}

function uniqueFields(
  input: readonly string[] | undefined,
  fields: ReadonlyMap<string, ArcGisFieldContract>,
  limit: number,
  label: string,
): readonly string[] {
  if (!input || input.length === 0) {
    return Object.freeze([]);
  }
  if (input.length > limit) {
    throw new RangeError(`${label} exceeds configured cardinality budget`);
  }
  const output: string[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    const normalized = requireField(fields, item, label);
    const key = normalized.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      output.push(normalized);
    }
  }
  return Object.freeze(output);
}

function normalizeOutFields(
  input: readonly string[] | undefined,
  contract: ArcGisCapabilityContract,
  fields: ReadonlyMap<string, ArcGisFieldContract>,
  limit: number,
): readonly string[] {
  if (!input || input.length === 0) {
    const identity = contract.objectIdField;
    return identity ? Object.freeze([identity]) : Object.freeze([]);
  }
  if (input.length > limit) {
    throw new RangeError("outFields exceeds configured cardinality budget");
  }
  const output: string[] = [];
  const seen = new Set<string>();
  for (const candidate of input) {
    if (candidate.trim() === "*") {
      if (input.length !== 1) {
        throw new TypeError("wildcard outFields must be used alone");
      }
      return Object.freeze(["*"]);
    }
    const field = requireField(fields, candidate, "outField");
    const key = field.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      output.push(field);
    }
  }
  return Object.freeze(output);
}

function normalizeOrder(
  input: readonly SpatialQueryOrderInput[] | undefined,
  contract: ArcGisCapabilityContract,
  fields: ReadonlyMap<string, ArcGisFieldContract>,
  limit: number,
): readonly CompiledSpatialQueryOrder[] {
  if (!input || input.length === 0) {
    return Object.freeze([]);
  }
  if (!contract.supportsOrderBy) {
    throw new Error("orderBy requested without verified ArcGIS orderBy capability");
  }
  if (input.length > limit) {
    throw new RangeError("orderBy exceeds configured cardinality budget");
  }
  const output: CompiledSpatialQueryOrder[] = [];
  const seen = new Set<string>();
  for (const candidate of input) {
    const field = requireField(fields, candidate.field, "orderBy field");
    const key = field.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(Object.freeze({
      field,
      direction: candidate.direction ?? "ASC",
    }));
  }
  return Object.freeze(output);
}

function normalizeStatistics(
  input: readonly SpatialQueryStatisticInput[] | undefined,
  contract: ArcGisCapabilityContract,
  fields: ReadonlyMap<string, ArcGisFieldContract>,
  limit: number,
  maxAliasLength: number,
): readonly CompiledSpatialQueryStatistic[] {
  if (!input || input.length === 0) {
    return Object.freeze([]);
  }
  if (!contract.supportsStatistics) {
    throw new Error("statistics requested without verified ArcGIS statistics capability");
  }
  if (input.length > limit) {
    throw new RangeError("statistics exceeds configured cardinality budget");
  }
  const aliases = new Set<string>();
  const output: CompiledSpatialQueryStatistic[] = [];
  for (const statistic of input) {
    const alias = normalizeAlias(statistic.outStatisticFieldName, maxAliasLength);
    const aliasKey = alias.toLowerCase();
    if (aliases.has(aliasKey)) {
      throw new TypeError("statistic output aliases must be unique");
    }
    aliases.add(aliasKey);

    let field: string | null = null;
    if (statistic.statisticType !== "count") {
      if (!statistic.onStatisticField) {
        throw new TypeError("non-count statistics require onStatisticField");
      }
      field = requireField(fields, statistic.onStatisticField, "statistic field");
      const definition = fields.get(field.toLowerCase());
      if (!definition || !NUMERIC_FIELD_TYPES.has(definition.type)) {
        throw new TypeError("numeric statistic requires a verified numeric field");
      }
    } else if (statistic.onStatisticField) {
      field = requireField(fields, statistic.onStatisticField, "statistic field");
    }

    output.push(Object.freeze({
      statisticType: statistic.statisticType,
      onStatisticField: field,
      outStatisticFieldName: alias,
    }));
  }
  return Object.freeze(output);
}

function normalizePrecision(value: number | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!Number.isInteger(value) || value < 0 || value > 12) {
    throw new RangeError("geometryPrecision must be an integer between 0 and 12");
  }
  return value;
}

function normalizeSourceSpatialReference(
  contract: ArcGisCapabilityContract,
): NormalizedSpatialReference | null {
  const source = contract.spatialReference;
  if (!source) {
    return null;
  }
  return normalizeSpatialReference(source);
}

function hash(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ (code + index), 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
}

function fingerprintPayload(
  contract: ArcGisCapabilityContract,
  compiled: Omit<CompiledSpatialQueryContract, "fingerprint">,
): string {
  return JSON.stringify({
    service: contract.resourceUrl ?? contract.serviceId ?? contract.name ?? "anonymous",
    where: compiled.where,
    outFields: compiled.outFields,
    orderBy: compiled.orderBy,
    statistics: compiled.statistics,
    groupByFields: compiled.groupByFields,
    distinct: compiled.distinct,
    returnGeometry: compiled.returnGeometry,
    returnCentroid: compiled.returnCentroid,
    geometryPrecision: compiled.geometryPrecision,
    sourceSpatialReference: compiled.sourceSpatialReference?.key ?? null,
    outSpatialReference: compiled.outSpatialReference?.key ?? null,
    stablePagination: compiled.stablePagination,
  });
}

export function compileSpatialQueryContract(
  capability: ArcGisCapabilityContract,
  input: SpatialQueryContractInput = {},
  limits: SpatialQueryContractLimits = {},
): CompiledSpatialQueryContract {
  if (!capability.supportsQuery) {
    throw new Error("query requested for a resource without verified ArcGIS query capability");
  }

  const maxWhereLength = positiveLimit(
    limits.maxWhereLength,
    DEFAULT_LIMITS.maxWhereLength,
    "maxWhereLength",
  );
  const maxOutFields = positiveLimit(
    limits.maxOutFields,
    DEFAULT_LIMITS.maxOutFields,
    "maxOutFields",
  );
  const maxOrderFields = positiveLimit(
    limits.maxOrderFields,
    DEFAULT_LIMITS.maxOrderFields,
    "maxOrderFields",
  );
  const maxStatistics = positiveLimit(
    limits.maxStatistics,
    DEFAULT_LIMITS.maxStatistics,
    "maxStatistics",
  );
  const maxGroupFields = positiveLimit(
    limits.maxGroupFields,
    DEFAULT_LIMITS.maxGroupFields,
    "maxGroupFields",
  );
  const maxAliasLength = positiveLimit(
    limits.maxAliasLength,
    DEFAULT_LIMITS.maxAliasLength,
    "maxAliasLength",
  );

  const fields = fieldMap(capability);
  const where = normalizeWhere(input.where, maxWhereLength);
  const outFields = normalizeOutFields(input.outFields, capability, fields, maxOutFields);
  const orderBy = normalizeOrder(input.orderBy, capability, fields, maxOrderFields);
  const statistics = normalizeStatistics(
    input.statistics,
    capability,
    fields,
    maxStatistics,
    maxAliasLength,
  );
  const groupByFields = uniqueFields(
    input.groupByFields,
    fields,
    maxGroupFields,
    "groupBy",
  );

  if (groupByFields.length > 0 && statistics.length === 0) {
    throw new TypeError("groupBy requires at least one statistic");
  }

  const distinct = input.distinct === true;
  if (
    distinct &&
    !capability.queryCapabilities.includes(ARCGIS_QUERY_CAPABILITY.DISTINCT)
  ) {
    throw new Error("distinct requested without verified ArcGIS distinct capability");
  }

  const returnCentroid = input.returnCentroid === true;
  if (
    returnCentroid &&
    !capability.queryCapabilities.includes(ARCGIS_QUERY_CAPABILITY.CENTROID)
  ) {
    throw new Error("centroid requested without verified ArcGIS centroid capability");
  }

  const stablePagination = input.requireStablePagination === true;
  if (stablePagination) {
    if (!capability.supportsPagination) {
      throw new Error("stable pagination requested without verified pagination capability");
    }
    if (!capability.supportsOrderBy) {
      throw new Error("stable pagination requires verified orderBy capability");
    }
    if (!capability.objectIdField) {
      throw new Error("stable pagination requires a verified objectId field");
    }
  }

  const effectiveOrder = [...orderBy];
  if (
    stablePagination &&
    capability.objectIdField &&
    !effectiveOrder.some(
      (entry) => entry.field.toLowerCase() === capability.objectIdField!.toLowerCase(),
    )
  ) {
    effectiveOrder.push(Object.freeze({
      field: capability.objectIdField,
      direction: "ASC",
    }));
  }

  const sourceSpatialReference = normalizeSourceSpatialReference(capability);
  const compiledBase = Object.freeze({
    where,
    outFields,
    orderBy: Object.freeze(effectiveOrder),
    statistics,
    groupByFields,
    distinct,
    returnGeometry: input.returnGeometry !== false,
    returnCentroid,
    geometryPrecision: normalizePrecision(input.geometryPrecision),
    sourceSpatialReference,
    outSpatialReference: input.outSpatialReference ?? null,
    objectIdField: capability.objectIdField,
    stablePagination,
  });

  return Object.freeze({
    ...compiledBase,
    fingerprint: hash(fingerprintPayload(capability, compiledBase)),
  });
}

export function spatialQueryContractCacheKey(
  capability: ArcGisCapabilityContract,
  compiled: CompiledSpatialQueryContract,
  namespace = "spatial-query",
): string {
  const service = capability.resourceUrl ?? capability.serviceId ?? capability.name ?? "anonymous";
  const normalizedNamespace = namespace.trim();
  if (!normalizedNamespace) {
    throw new TypeError("cache-key namespace must not be empty");
  }
  return `${normalizedNamespace}:${hash(service)}:${compiled.fingerprint}`;
}
