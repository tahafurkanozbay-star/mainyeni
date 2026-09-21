import type {
  GeographicPoint,
  NormalizedBusinessQuery,
  NormalizedIdentifier,
  NormalizedIdentifierList,
  NumberingSearchQuery,
  RouteBusinessQuery,
  TkgmParcelQuery,
} from './contracts';
import { InvalidBusinessInputError } from './contracts';
import {
  DEFAULT_BUSINESS_RUNTIME_POLICY,
  normalizeNearbyDistance,
} from './policy';
import type { BusinessRuntimePolicy } from './contracts';

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const normalizeScalar = (
  value: unknown,
  maximumLength = DEFAULT_BUSINESS_RUNTIME_POLICY.maxTextLength,
): string => {
  if (value === null || value === undefined) return '';
  return String(value).trim().slice(0, Math.max(1, maximumLength));
};

export const normalizeNullableText = (
  value: unknown,
  maximumLength = DEFAULT_BUSINESS_RUNTIME_POLICY.maxTextLength,
): string | null => {
  const normalized = normalizeScalar(value, maximumLength);
  return normalized || null;
};

export const normalizeBoolean = (value: unknown): boolean => value === true;

export const normalizeFiniteNumber = (
  value: unknown,
  fallback: number | null = null,
): number | null => {
  if (value === null || value === undefined || value === '') return fallback;
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

export const normalizeInteger = (
  value: unknown,
  fallback: number | null = null,
): number | null => {
  const numeric = normalizeFiniteNumber(value, fallback);
  return numeric === null ? null : Math.trunc(numeric);
};

export const normalizeLegacyIdentifier = (
  value: unknown,
  policy: BusinessRuntimePolicy = DEFAULT_BUSINESS_RUNTIME_POLICY,
): NormalizedIdentifier | null => {
  const nested = isRecord(value) && isRecord(value.attr)
    ? value.attr.id
    : value;
  let normalized = normalizeScalar(nested, policy.maxIdentifierLength);
  if (
    normalized.length >= 2
    && normalized.startsWith("'")
    && normalized.endsWith("'")
  ) {
    normalized = normalized.slice(1, -1).trim();
  }
  if (!normalized) return null;
  return Object.freeze({ value: normalized, source: value });
};

export const normalizeIdentifierList = (
  input: unknown,
  policy: BusinessRuntimePolicy = DEFAULT_BUSINESS_RUNTIME_POLICY,
): NormalizedIdentifierList => {
  const source: readonly unknown[] = Array.isArray(input)
    ? input
    : input === null || input === undefined || input === ''
      ? []
      : String(input).split(',');

  const seen = new Set<string>();
  const values: string[] = [];
  let rejected = 0;
  let duplicates = 0;
  let truncated = false;

  for (const candidate of source) {
    const normalized = normalizeLegacyIdentifier(candidate, policy);
    if (!normalized) {
      rejected += 1;
      continue;
    }
    if (seen.has(normalized.value)) {
      duplicates += 1;
      continue;
    }
    if (values.length >= policy.maxIdentifierCount) {
      truncated = true;
      break;
    }
    seen.add(normalized.value);
    values.push(normalized.value);
  }

  return Object.freeze({
    values: Object.freeze(values),
    rejected,
    duplicates,
    truncated,
  });
};

export const normalizeBusinessQuery = (
  input: unknown,
  policy: BusinessRuntimePolicy = DEFAULT_BUSINESS_RUNTIME_POLICY,
): NormalizedBusinessQuery => {
  const query = isRecord(input) ? input : {};
  return Object.freeze({
    name: normalizeNullableText(query.name, policy.maxTextLength),
    districtId: normalizeLegacyIdentifier(query.districtId, policy)?.value ?? null,
    neighborhoodId: normalizeLegacyIdentifier(
      query.nbhoodId ?? query.neighborhoodId,
      policy,
    )?.value ?? null,
    objectId: normalizeLegacyIdentifier(
      query.Id ?? query.ObjectId ?? query.objectId,
      policy,
    )?.value ?? null,
    showNearby: normalizeBoolean(query.showNearby),
    bufferDistance: normalizeNearbyDistance(query.bufferDistance, policy),
    userLocation: query.userLocation,
  });
};

export const normalizeRouteQuery = (
  input: unknown,
  policy: BusinessRuntimePolicy = DEFAULT_BUSINESS_RUNTIME_POLICY,
): RouteBusinessQuery => {
  const base = normalizeBusinessQuery(input, policy);
  const query = isRecord(input) ? input : {};
  const routeLevel = normalizeInteger(query.routeLevel, null);
  return Object.freeze({
    ...base,
    showCultureWalkingRoute: query.showCultureWalkingRoute === true,
    showNatureWalkingRoute: query.showNatureWalkingRoute === true,
    routeLevel,
  });
};

export const normalizeNumberingSearchQuery = (
  input: unknown,
  policy: BusinessRuntimePolicy = DEFAULT_BUSINESS_RUNTIME_POLICY,
): NumberingSearchQuery => {
  const query = isRecord(input) ? input : {};
  return Object.freeze({
    districtName: normalizeNullableText(query.DistrictName, policy.maxTextLength),
    neighborhoodName: normalizeNullableText(
      query.NeighborhoodName,
      policy.maxTextLength,
    ),
  });
};

const requiredIdentifier = (
  value: unknown,
  field: string,
  policy: BusinessRuntimePolicy,
): string => {
  const normalized = normalizeLegacyIdentifier(value, policy)?.value;
  if (normalized) return normalized;
  throw new InvalidBusinessInputError(
    'BUSINESS_REQUIRED_IDENTIFIER',
    `${field} alanı zorunludur.`,
    Object.freeze({ field }),
  );
};

export const normalizeTkgmParcelQuery = (
  input: unknown,
  policy: BusinessRuntimePolicy = DEFAULT_BUSINESS_RUNTIME_POLICY,
): TkgmParcelQuery => {
  const query = isRecord(input) ? input : {};
  return Object.freeze({
    district: requiredIdentifier(query.district, 'district', policy),
    neighborhood: requiredIdentifier(query.nbhood ?? query.neighborhood, 'neighborhood', policy),
    cityBlock: requiredIdentifier(query.cityblock ?? query.cityBlock, 'cityBlock', policy),
    parcel: requiredIdentifier(query.parcel, 'parcel', policy),
  });
};

export const normalizeGeographicPoint = (
  input: unknown,
): GeographicPoint | null => {
  if (!isRecord(input)) return null;
  const latitude = normalizeFiniteNumber(input.latitude, null);
  const longitude = normalizeFiniteNumber(input.longitude, null);
  if (latitude === null || longitude === null) return null;
  if (latitude < -90 || latitude > 90) return null;
  if (longitude < -180 || longitude > 180) return null;
  return Object.freeze({ latitude, longitude });
};

export const readEntityIdentifier = (
  input: unknown,
  policy: BusinessRuntimePolicy = DEFAULT_BUSINESS_RUNTIME_POLICY,
): string | null => {
  if (isRecord(input) && isRecord(input.attr)) {
    return normalizeLegacyIdentifier(input.attr.id, policy)?.value ?? null;
  }
  if (isRecord(input)) {
    return normalizeLegacyIdentifier(input.id, policy)?.value ?? null;
  }
  return normalizeLegacyIdentifier(input, policy)?.value ?? null;
};

export const asReadonlyRecord = (
  value: unknown,
): Readonly<Record<string, unknown>> => isRecord(value) ? value : Object.freeze({});

export const readFeatureArray = (
  value: unknown,
): readonly Readonly<Record<string, unknown>>[] => {
  const root = asReadonlyRecord(value);
  const candidate = root.features;
  if (!Array.isArray(candidate)) return Object.freeze([]);
  return Object.freeze(candidate.filter(isRecord).map(item => Object.freeze({ ...item })));
};
