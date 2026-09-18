import { BusinessContractError, type UnknownRecord, isRecord } from './contracts';

const DEFAULT_TEXT_LIMIT = 256;
const MAX_TEXT_LIMIT = 4096;
const DEFAULT_IDENTIFIER_LIMIT = 160;
const DEFAULT_NEARBY_DISTANCE_METERS = 2_000;
const MAX_NEARBY_DISTANCE_METERS = 50_000;
const FIELD_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/gu;

export interface ArcGisWhereBuilderOptions {
  readonly maxTextLength?: number;
  readonly uppercase?: (value: string) => string;
}

export interface NearbyDistanceOptions {
  readonly fallbackMeters?: number;
  readonly maximumMeters?: number;
  readonly multiplier?: number;
}

export const normalizeQueryText = (
  value: unknown,
  maximumLength = DEFAULT_TEXT_LIMIT,
): string => {
  const limit = Math.min(MAX_TEXT_LIMIT, Math.max(1, Math.trunc(maximumLength)));
  return String(value ?? '')
    .replace(CONTROL_CHARACTER_PATTERN, ' ')
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, limit);
};

export const normalizeLegacyIdentifier = (
  value: unknown,
  maximumLength = DEFAULT_IDENTIFIER_LIMIT,
): string => {
  const candidate = isRecord(value) && isRecord(value.attr)
    ? value.attr.id
    : isRecord(value)
      ? value.id ?? value.objectid ?? value.ObjectId
      : value;

  let normalized = normalizeQueryText(candidate, maximumLength);
  if (
    normalized.length >= 2
    && normalized.startsWith("'")
    && normalized.endsWith("'")
  ) {
    normalized = normalized.slice(1, -1).trim();
  }
  return normalized;
};

export const hasQueryIdentifier = (value: unknown): boolean =>
  normalizeLegacyIdentifier(value).length > 0;

export const normalizeIdentifierList = (
  value: unknown,
  maximumItems = 2_000,
): readonly string[] => {
  const source = Array.isArray(value)
    ? value
    : value === null || value === undefined || value === ''
      ? []
      : String(value).split(',');

  const limit = Math.min(10_000, Math.max(1, Math.trunc(maximumItems)));
  const seen = new Set<string>();
  const result: string[] = [];

  for (const candidate of source) {
    const normalized = normalizeLegacyIdentifier(candidate);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= limit) break;
  }

  return Object.freeze(result);
};

export const assertArcGisFieldName = (field: unknown): string => {
  const normalized = normalizeQueryText(field, 128);
  if (!FIELD_NAME_PATTERN.test(normalized)) {
    throw new BusinessContractError(
      'INVALID_QUERY_FIELD',
      'ArcGIS sorgu alanı geçersiz.',
      false,
    );
  }
  return normalized;
};

export const escapeArcGisSqlLiteral = (value: unknown): string =>
  normalizeQueryText(value, MAX_TEXT_LIMIT).replace(/'/gu, "''");

export const quoteArcGisSqlLiteral = (value: unknown): string =>
  `'${escapeArcGisSqlLiteral(normalizeLegacyIdentifier(value, MAX_TEXT_LIMIT))}'`;

export const buildArcGisEqualsFilter = (
  field: unknown,
  value: unknown,
): string => `${assertArcGisFieldName(field)}=${quoteArcGisSqlLiteral(value)}`;

export const buildArcGisInFilter = (
  field: unknown,
  values: unknown,
  maximumItems = 2_000,
): string | null => {
  const normalized = normalizeIdentifierList(values, maximumItems);
  if (normalized.length === 0) return null;
  return `${assertArcGisFieldName(field)} IN (${normalized.map(quoteArcGisSqlLiteral).join(',')})`;
};

export const buildArcGisUpperContainsFilter = (
  field: unknown,
  value: unknown,
  options: ArcGisWhereBuilderOptions = {},
): string | null => {
  const normalized = normalizeQueryText(
    value,
    options.maxTextLength ?? DEFAULT_TEXT_LIMIT,
  );
  if (!normalized) return null;

  const transformed = options.uppercase ? options.uppercase(normalized) : normalized.toUpperCase();
  return `UPPER(${assertArcGisFieldName(field)}) LIKE '%${escapeArcGisSqlLiteral(transformed)}%'`;
};

export const normalizeFiniteInteger = (
  value: unknown,
  minimum = Number.MIN_SAFE_INTEGER,
  maximum = Number.MAX_SAFE_INTEGER,
): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    return null;
  }
  if (value < minimum || value > maximum) return null;
  return value;
};

export const buildArcGisNumericEqualsFilter = (
  field: unknown,
  value: unknown,
  minimum = Number.MIN_SAFE_INTEGER,
  maximum = Number.MAX_SAFE_INTEGER,
): string | null => {
  const numeric = normalizeFiniteInteger(value, minimum, maximum);
  if (numeric === null) return null;
  return `${assertArcGisFieldName(field)}=${numeric}`;
};

export const normalizeFiniteNumber = (
  value: unknown,
  minimum = Number.NEGATIVE_INFINITY,
  maximum = Number.POSITIVE_INFINITY,
): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < minimum || value > maximum) return null;
  return value;
};

export const normalizeNearbyDistanceMeters = (
  value: unknown,
  options: NearbyDistanceOptions = {},
): number => {
  const fallback = normalizeFiniteNumber(
    options.fallbackMeters ?? DEFAULT_NEARBY_DISTANCE_METERS,
    1,
    MAX_NEARBY_DISTANCE_METERS,
  ) ?? DEFAULT_NEARBY_DISTANCE_METERS;
  const maximum = normalizeFiniteNumber(
    options.maximumMeters ?? MAX_NEARBY_DISTANCE_METERS,
    1,
    MAX_NEARBY_DISTANCE_METERS,
  ) ?? MAX_NEARBY_DISTANCE_METERS;
  const multiplier = normalizeFiniteNumber(options.multiplier ?? 1, 0.000001, 100_000) ?? 1;

  const source = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim().length > 0
      ? Number(value)
      : Number.NaN;
  const numeric = Number.isFinite(source) ? source * multiplier : fallback;
  return Math.min(maximum, Math.max(1, numeric));
};

export const readRecordValue = (
  value: unknown,
  key: string,
): unknown => isRecord(value) ? value[key] : undefined;

export const readAttributeValue = (
  value: unknown,
  key: string,
): unknown => {
  if (!isRecord(value)) return undefined;
  const container: UnknownRecord = isRecord(value.attr) ? value.attr : value;
  return container[key];
};

export const normalizeHttpUrl = (
  value: unknown,
  baseOrigin?: string,
): string | null => {
  const text = normalizeQueryText(value, 2_048);
  if (!text) return null;
  try {
    const base = baseOrigin
      ?? (typeof window !== 'undefined' ? window.location.origin : 'https://local.invalid');
    const url = new URL(text, base);
    if (url.username || url.password) return null;
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.href;
  } catch {
    return null;
  }
};

export const QuerySafetyLimits = Object.freeze({
  maxTextLength: MAX_TEXT_LIMIT,
  maxIdentifierItems: 2_000,
  defaultNearbyDistanceMeters: DEFAULT_NEARBY_DISTANCE_METERS,
  maxNearbyDistanceMeters: MAX_NEARBY_DISTANCE_METERS,
});
