import {
  DEFAULT_QUERY_POLICY,
  type CompiledQuery,
  type FastAccessQuery,
  type NormalizedFastAccessQuery,
  type QueryFingerprintInput,
  type QueryPolicy,
  asFiniteNumber,
  normalizeString,
} from './contracts';

const TURKISH_LOCALE = 'tr-TR';
const COMBINING_MARK_PATTERN = /[\u0300-\u036f]/gu;
const SQL_WILDCARD_PATTERN = /[%_]/gu;
const MAX_FINGERPRINT_LENGTH = 1024;

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const normalizeInteger = (
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const numeric = asFiniteNumber(value);
  if (numeric === null) return fallback;
  return Math.trunc(clamp(numeric, minimum, maximum));
};

export const createQueryPolicy = (overrides: Partial<QueryPolicy> = {}): Readonly<QueryPolicy> => Object.freeze({
  maxWhereLength: normalizeInteger(overrides.maxWhereLength, DEFAULT_QUERY_POLICY.maxWhereLength, 128, 32000),
  maxNameLength: normalizeInteger(overrides.maxNameLength, DEFAULT_QUERY_POLICY.maxNameLength, 8, 1024),
  maxIdLength: normalizeInteger(overrides.maxIdLength, DEFAULT_QUERY_POLICY.maxIdLength, 8, 256),
  minNearbyDistance: clamp(
    asFiniteNumber(overrides.minNearbyDistance) ?? DEFAULT_QUERY_POLICY.minNearbyDistance,
    0,
    100000,
  ),
  maxNearbyDistance: clamp(
    asFiniteNumber(overrides.maxNearbyDistance) ?? DEFAULT_QUERY_POLICY.maxNearbyDistance,
    1,
    100000,
  ),
  defaultTimeoutMs: normalizeInteger(
    overrides.defaultTimeoutMs,
    DEFAULT_QUERY_POLICY.defaultTimeoutMs,
    250,
    DEFAULT_QUERY_POLICY.maxTimeoutMs,
  ),
  maxTimeoutMs: normalizeInteger(
    overrides.maxTimeoutMs,
    DEFAULT_QUERY_POLICY.maxTimeoutMs,
    1000,
    600000,
  ),
  defaultCacheTtlMs: normalizeInteger(
    overrides.defaultCacheTtlMs,
    DEFAULT_QUERY_POLICY.defaultCacheTtlMs,
    0,
    DEFAULT_QUERY_POLICY.maxCacheTtlMs,
  ),
  maxCacheTtlMs: normalizeInteger(
    overrides.maxCacheTtlMs,
    DEFAULT_QUERY_POLICY.maxCacheTtlMs,
    0,
    3600000,
  ),
});

export const stripControlCharacters = (value: string): string => {
  let cleaned = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) continue;
    cleaned += value[index] ?? '';
  }
  return cleaned;
};

export const normalizeBusinessText = (value: unknown, maximumLength = 256): string | null => {
  const text = normalizeString(value, maximumLength);
  if (!text) return null;
  const cleaned = stripControlCharacters(text).replace(/\s+/gu, ' ').trim();
  return cleaned.length > 0 ? cleaned.slice(0, maximumLength) : null;
};

export const turkishUpper = (value: unknown, maximumLength = 256): string =>
  (normalizeBusinessText(value, maximumLength) ?? '').toLocaleUpperCase(TURKISH_LOCALE);

export const removeTurkishCharacters = (value: string): string => value
  .normalize('NFD')
  .replace(COMBINING_MARK_PATTERN, '')
  .replace(/ı/gu, 'i')
  .replace(/İ/gu, 'I')
  .replace(/ş/gu, 's')
  .replace(/Ş/gu, 'S')
  .replace(/ğ/gu, 'g')
  .replace(/Ğ/gu, 'G')
  .replace(/ç/gu, 'c')
  .replace(/Ç/gu, 'C')
  .replace(/ö/gu, 'o')
  .replace(/Ö/gu, 'O')
  .replace(/ü/gu, 'u')
  .replace(/Ü/gu, 'U');

export const escapeSqlLiteral = (value: unknown, maximumLength = 512): string =>
  (normalizeBusinessText(value, maximumLength) ?? '').replace(/'/gu, "''");

export const escapeSqlLikeLiteral = (value: unknown, maximumLength = 512): string =>
  escapeSqlLiteral(value, maximumLength).replace(SQL_WILDCARD_PATTERN, (token) => `[${token}]`);

export const normalizeIdentifier = (value: unknown, maximumLength: number): string | null =>
  normalizeBusinessText(value, maximumLength);

export const normalizeObjectId = (value: unknown): number | null => {
  const numeric = asFiniteNumber(value);
  if (numeric === null || numeric < 0) return null;
  const integer = Math.trunc(numeric);
  return Number.isSafeInteger(integer) ? integer : null;
};

export const normalizeDistance = (value: unknown, policy: QueryPolicy): number => {
  const numeric = asFiniteNumber(value) ?? policy.minNearbyDistance;
  return clamp(numeric, policy.minNearbyDistance, policy.maxNearbyDistance);
};

export const normalizeFastAccessQuery = (
  value: FastAccessQuery | null | undefined,
  policy: QueryPolicy = DEFAULT_QUERY_POLICY,
): NormalizedFastAccessQuery => {
  const query = value ?? {};
  return Object.freeze({
    objectId: normalizeObjectId(query.ObjectId ?? query.objectId),
    name: normalizeBusinessText(query.name, policy.maxNameLength),
    districtId: normalizeIdentifier(query.districtId, policy.maxIdLength),
    neighborhoodId: normalizeIdentifier(query.nbhoodId, policy.maxIdLength),
    showNearby: query.showNearby === true,
    bufferDistance: normalizeDistance(query.bufferDistance, policy),
    userLocation: query.userLocation ?? null,
  });
};

export const buildNamePredicate = (
  value: string | null,
  policy: QueryPolicy = DEFAULT_QUERY_POLICY,
): string | null => {
  if (!value) return null;
  const upper = turkishUpper(value, policy.maxNameLength);
  if (!upper) return null;
  const normalized = escapeSqlLikeLiteral(upper, policy.maxNameLength);
  const ascii = escapeSqlLikeLiteral(removeTurkishCharacters(upper), policy.maxNameLength);
  if (!ascii && !normalized) return null;
  if (ascii === normalized) return `UPPER(adi) LIKE '%${normalized}%'`;
  return `(UPPER(adi) LIKE '%${ascii}%' OR UPPER(adi) LIKE '%${normalized}%')`;
};

export const buildIdentifierPredicate = (
  fieldName: string,
  value: string | null,
  policy: QueryPolicy = DEFAULT_QUERY_POLICY,
): string | null => {
  if (!value) return null;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(fieldName)) return null;
  const literal = escapeSqlLiteral(value, policy.maxIdLength);
  return literal ? `${fieldName} = '${literal}'` : null;
};

const compactPredicates = (values: readonly (string | null | undefined)[]): readonly string[] =>
  Object.freeze(values.filter((value): value is string => typeof value === 'string' && value.length > 0));

export const buildWhereClause = (
  query: NormalizedFastAccessQuery,
  policy: QueryPolicy = DEFAULT_QUERY_POLICY,
): string => {
  const predicates: (string | null)[] = ['1=1'];
  if (query.objectId !== null) predicates.push(`ObjectId = ${query.objectId}`);
  predicates.push(buildNamePredicate(query.name, policy));
  if (!query.showNearby) {
    predicates.push(buildIdentifierPredicate('ilceid', query.districtId, policy));
    predicates.push(buildIdentifierPredicate('mahalleid', query.neighborhoodId, policy));
  }
  const where = compactPredicates(predicates).join(' AND ');
  return where.length <= policy.maxWhereLength ? where : where.slice(0, policy.maxWhereLength);
};

const stableScalar = (value: unknown): string => {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return JSON.stringify(String(value));
};

const stableValue = (value: unknown, depth = 0): string => {
  if (depth > 6) return '"[depth]"';
  if (Array.isArray(value)) return `[${value.map((item) => stableValue(item, depth + 1)).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableValue(item, depth + 1)}`).join(',')}}`;
  }
  return stableScalar(value);
};

const hashString = (value: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

export const createQueryFingerprint = (input: QueryFingerprintInput): string => {
  const serialized = stableValue({
    serviceKey: input.serviceKey,
    query: input.query,
    returnGeometry: input.returnGeometry,
  }).slice(0, MAX_FINGERPRINT_LENGTH);
  return `bq-${hashString(serialized)}`;
};

export const compileFastAccessQuery = (
  serviceKey: string,
  value: FastAccessQuery | null | undefined,
  returnGeometry = false,
  policy: QueryPolicy = DEFAULT_QUERY_POLICY,
): CompiledQuery => {
  const query = normalizeFastAccessQuery(value, policy);
  const where = buildWhereClause(query, policy);
  const fingerprint = createQueryFingerprint({ serviceKey, query, returnGeometry: Boolean(returnGeometry) });
  if (!query.showNearby) return Object.freeze({ where, spatial: false, fingerprint });
  return Object.freeze({
    where,
    spatial: true,
    geometry: query.userLocation,
    distance: query.bufferDistance * 100,
    units: 'meters' as const,
    spatialRelationship: 'intersects' as const,
    fingerprint,
  });
};

export const validateServiceUrl = (value: unknown): string | null => {
  const text = normalizeBusinessText(value, 2048);
  if (!text) return null;
  try {
    const base = typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : 'https://local.invalid';
    const url = new URL(text, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    return text;
  } catch {
    return null;
  }
};

export const normalizeTimeoutMs = (value: unknown, policy: QueryPolicy = DEFAULT_QUERY_POLICY): number =>
  normalizeInteger(value, policy.defaultTimeoutMs, 250, policy.maxTimeoutMs);

export const normalizeCacheTtlMs = (value: unknown, policy: QueryPolicy = DEFAULT_QUERY_POLICY): number =>
  normalizeInteger(value, policy.defaultCacheTtlMs, 0, policy.maxCacheTtlMs);

export interface PaginationRequest { readonly offset?: number; readonly limit?: number }
export interface NormalizedPagination { readonly offset: number; readonly limit: number }

export const normalizePagination = (
  value: PaginationRequest | null | undefined,
  defaults: Readonly<NormalizedPagination> = { offset: 0, limit: 100 },
): NormalizedPagination => Object.freeze({
  offset: normalizeInteger(value?.offset, defaults.offset, 0, 1000000),
  limit: normalizeInteger(value?.limit, defaults.limit, 1, 2000),
});

export const objectIdPredicate = (values: readonly unknown[]): string | null => {
  const ids = [...new Set(values.map(normalizeObjectId).filter((value): value is number => value !== null))]
    .sort((left, right) => left - right);
  return ids.length > 0 ? `ObjectId IN (${ids.join(',')})` : null;
};

export const combinePredicates = (...predicates: readonly (string | null | undefined)[]): string =>
  compactPredicates(predicates).join(' AND ') || '1=1';

export const queryIsLocationBound = (query: FastAccessQuery | null | undefined): boolean => query?.showNearby === true;
