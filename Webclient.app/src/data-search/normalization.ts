import type {
  Coordinate,
  DataQualityIssue,
  DataQualitySummary,
  NormalizedRecord,
  RecordAliasSchema,
  RecordNormalizationOptions,
  RecordNormalizationResult,
  UnknownRecord,
} from './contracts';
import { isRecord } from './contracts';

export const DEFAULT_LOCALE = 'tr-TR';
export const DEFAULT_MAX_RECORDS = 100_000;
export const HARD_MAX_RECORDS = 1_000_000;

const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/g;
const COMBINING_MARKS = /[\u0300-\u036f]/g;
const NON_SEARCH_CHARACTERS = /[^a-z0-9]+/g;
const NON_CATEGORY_CHARACTERS = /[^a-z0-9]+/g;
const PHONE_NOISE = /[^0-9+]+/g;

export const DEFAULT_RECORD_SCHEMA: Required<RecordAliasSchema> = Object.freeze({
  id: ['id', 'ID', 'objectid', 'OBJECTID', 'globalid', 'GLOBALID', 'fid', 'FID'],
  title: ['title', 'Title', 'name', 'NAME', 'adi', 'ADI', 'ad', 'AD'],
  category: ['category', 'Category', 'kategori', 'KATEGORI', 'kategoriAdi', 'KATEGORI_ADI'],
  type: ['type', 'Type', 'tur', 'TUR', 'tip', 'TIP', 'typeName', 'TYPE_NAME'],
  address: ['address', 'Address', 'adres', 'ADRES', 'fullAddress', 'FULL_ADDRESS'],
  district: ['district', 'District', 'ilce', 'ILCE', 'ilceAdi', 'ILCE_ADI'],
  neighborhood: ['neighborhood', 'Neighborhood', 'mahalle', 'MAHALLE', 'mahalleAdi', 'MAHALLE_ADI'],
  street: ['street', 'Street', 'yol', 'YOL', 'yolAdi', 'YOL_ADI', 'cadde', 'CADDE'],
  door: ['door', 'Door', 'kapi', 'KAPI', 'kapiNo', 'KAPI_NO', 'doorNumber', 'DOOR_NUMBER'],
  postalCode: ['postalCode', 'postal_code', 'postaKodu', 'POSTA_KODU', 'zip', 'ZIP'],
  phone: ['phone', 'Phone', 'telefon', 'TELEFON', 'tel', 'TEL'],
  url: ['url', 'URL', 'website', 'WEBSITE', 'web', 'WEB'],
  latitude: ['latitude', 'Latitude', 'lat', 'LAT', 'y', 'Y'],
  longitude: ['longitude', 'Longitude', 'lon', 'LON', 'lng', 'LNG', 'x', 'X'],
});

const hasOwn = (value: UnknownRecord, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const asFiniteNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export const normalizeInteger = (
  value: unknown,
  options: { readonly min?: number; readonly max?: number; readonly fallback?: number } = {},
): number => {
  const minimum = options.min ?? Number.MIN_SAFE_INTEGER;
  const maximum = options.max ?? Number.MAX_SAFE_INTEGER;
  const fallback = options.fallback ?? 0;
  const parsed = asFiniteNumber(value);
  if (parsed === null || !Number.isInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
};

export const normalizeText = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  return String(value)
    .normalize('NFKC')
    .replace(CONTROL_CHARACTERS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

export const normalizeSearchText = (value: unknown, locale = DEFAULT_LOCALE): string =>
  normalizeText(value)
    .toLocaleLowerCase(locale)
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .replace(/ı/g, 'i');

export const normalizeSearchToken = (value: unknown): string =>
  normalizeSearchText(value)
    .replace(NON_SEARCH_CHARACTERS, '')
    .trim();

export const tokenizeSearchText = (value: unknown): string[] => {
  const normalized = normalizeSearchText(value)
    .replace(NON_SEARCH_CHARACTERS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return [];
  return Array.from(new Set(normalized.split(' ').filter(Boolean)));
};

export const normalizeCategoryKey = (value: unknown): string =>
  normalizeSearchText(value)
    .replace(NON_CATEGORY_CHARACTERS, '-')
    .replace(/^-+|-+$/g, '');

export const normalizeId = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  const text = normalizeText(value);
  return text || null;
};

export const normalizePhone = (value: unknown): string => {
  const text = normalizeText(value);
  return text ? text.replace(PHONE_NOISE, '') : '';
};

export const normalizePostalCode = (value: unknown): string => {
  const text = normalizeText(value).replace(/\D+/g, '');
  return text.length <= 10 ? text : text.slice(0, 10);
};

export const normalizeUrl = (value: unknown): string => {
  const text = normalizeText(value);
  if (!text) return '';
  try {
    const parsed = new URL(text, 'https://localhost');
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    if (parsed.origin === 'https://localhost' && !/^https?:\/\//i.test(text)) {
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
    return parsed.toString();
  } catch (_error) {
    return '';
  }
};

export const normalizeCoordinateAxis = (value: unknown, axis: 'lat' | 'lon'): number | null => {
  const parsed = asFiniteNumber(value);
  if (parsed === null) return null;
  if (axis === 'lat') return parsed >= -90 && parsed <= 90 ? parsed : null;
  return parsed >= -180 && parsed <= 180 ? parsed : null;
};

export const normalizeCoordinates = (value: unknown): Coordinate | null => {
  if (!value) return null;
  if (Array.isArray(value) && value.length >= 2) {
    const longitude = normalizeCoordinateAxis(value[0], 'lon');
    const latitude = normalizeCoordinateAxis(value[1], 'lat');
    if (latitude !== null && longitude !== null) return { latitude, longitude };
    const reversedLatitude = normalizeCoordinateAxis(value[0], 'lat');
    const reversedLongitude = normalizeCoordinateAxis(value[1], 'lon');
    return reversedLatitude !== null && reversedLongitude !== null
      ? { latitude: reversedLatitude, longitude: reversedLongitude }
      : null;
  }
  if (!isRecord(value)) return null;
  const latitude = normalizeCoordinateAxis(
    value.latitude ?? value.lat ?? value.y ?? value.Y,
    'lat',
  );
  const longitude = normalizeCoordinateAxis(
    value.longitude ?? value.lon ?? value.lng ?? value.x ?? value.X,
    'lon',
  );
  return latitude !== null && longitude !== null ? { latitude, longitude } : null;
};

export const getRecordSources = (value: unknown): readonly UnknownRecord[] => {
  if (!isRecord(value)) return [];
  const sources: UnknownRecord[] = [value];
  const nestedKeys = ['attributes', 'attr', 'properties', 'fields', 'data'];
  for (const key of nestedKeys) {
    const nested = value[key];
    if (isRecord(nested) && nested !== value) sources.push(nested);
  }
  return sources;
};

export interface AliasedValue {
  readonly value: unknown;
  readonly alias: string | null;
  readonly sourceIndex: number;
}

export const readAliasedValue = (
  value: unknown,
  aliases: readonly string[],
  fallback: unknown = null,
): AliasedValue => {
  const sources = getRecordSources(value);
  for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex += 1) {
    const source = sources[sourceIndex];
    if (!source) continue;
    for (const alias of aliases) {
      if (!hasOwn(source, alias)) continue;
      const candidate = source[alias];
      if (candidate !== null && candidate !== undefined && candidate !== '') {
        return { value: candidate, alias, sourceIndex };
      }
    }
  }
  return { value: fallback, alias: null, sourceIndex: -1 };
};

const mergeAliases = (
  custom: readonly string[] | undefined,
  defaults: readonly string[],
): readonly string[] => Array.from(new Set([...(custom ?? []), ...defaults]));

export const compileRecordSchema = (
  schema: RecordAliasSchema | undefined,
): Required<RecordAliasSchema> => ({
  id: mergeAliases(schema?.id, DEFAULT_RECORD_SCHEMA.id),
  title: mergeAliases(schema?.title, DEFAULT_RECORD_SCHEMA.title),
  category: mergeAliases(schema?.category, DEFAULT_RECORD_SCHEMA.category),
  type: mergeAliases(schema?.type, DEFAULT_RECORD_SCHEMA.type),
  address: mergeAliases(schema?.address, DEFAULT_RECORD_SCHEMA.address),
  district: mergeAliases(schema?.district, DEFAULT_RECORD_SCHEMA.district),
  neighborhood: mergeAliases(schema?.neighborhood, DEFAULT_RECORD_SCHEMA.neighborhood),
  street: mergeAliases(schema?.street, DEFAULT_RECORD_SCHEMA.street),
  door: mergeAliases(schema?.door, DEFAULT_RECORD_SCHEMA.door),
  postalCode: mergeAliases(schema?.postalCode, DEFAULT_RECORD_SCHEMA.postalCode),
  phone: mergeAliases(schema?.phone, DEFAULT_RECORD_SCHEMA.phone),
  url: mergeAliases(schema?.url, DEFAULT_RECORD_SCHEMA.url),
  latitude: mergeAliases(schema?.latitude, DEFAULT_RECORD_SCHEMA.latitude),
  longitude: mergeAliases(schema?.longitude, DEFAULT_RECORD_SCHEMA.longitude),
});

const scalarForFingerprint = (value: unknown): string | number | boolean | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  return null;
};

export const stableSerialize = (value: unknown, seen = new WeakSet<object>()): string => {
  const scalar = scalarForFingerprint(value);
  if (scalar !== null || value === null || value === undefined) return JSON.stringify(scalar);
  if (typeof value !== 'object') return JSON.stringify(String(value));
  if (seen.has(value)) return '"[Circular]"';
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map(item => stableSerialize(item, seen)).join(',')}]`;
    }
    const record = value as UnknownRecord;
    const keys = Object.keys(record).sort((left, right) => left.localeCompare(right, 'en'));
    return `{${keys.map(key => `${JSON.stringify(key)}:${stableSerialize(record[key], seen)}`).join(',')}}`;
  } finally {
    seen.delete(value);
  }
};

export const hashFingerprint = (value: unknown): string => {
  const input = stableSerialize(value);
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
};

const buildSearchText = (record: Omit<NormalizedRecord, 'searchText'>): string =>
  normalizeSearchText([
    record.title,
    record.category,
    record.type,
    record.address,
    record.district,
    record.neighborhood,
    record.street,
    record.door,
    record.postalCode,
    record.phone,
  ].filter(Boolean).join(' '));

export const normalizeRecord = (
  source: unknown,
  sourceIndex = 0,
  schemaInput?: RecordAliasSchema,
): NormalizedRecord | null => {
  if (!isRecord(source)) return null;
  const schema = compileRecordSchema(schemaInput);
  const id = normalizeId(readAliasedValue(source, schema.id).value);
  const title = normalizeText(readAliasedValue(source, schema.title).value);
  const category = normalizeText(readAliasedValue(source, schema.category).value);
  const type = normalizeText(readAliasedValue(source, schema.type).value);
  const address = normalizeText(readAliasedValue(source, schema.address).value);
  const district = normalizeText(readAliasedValue(source, schema.district).value);
  const neighborhood = normalizeText(readAliasedValue(source, schema.neighborhood).value);
  const street = normalizeText(readAliasedValue(source, schema.street).value);
  const door = normalizeText(readAliasedValue(source, schema.door).value);
  const postalCode = normalizePostalCode(readAliasedValue(source, schema.postalCode).value);
  const phone = normalizePhone(readAliasedValue(source, schema.phone).value);
  const url = normalizeUrl(readAliasedValue(source, schema.url).value);
  const latitude = readAliasedValue(source, schema.latitude).value;
  const longitude = readAliasedValue(source, schema.longitude).value;
  const coordinates = normalizeCoordinates({ latitude, longitude });
  const fields = Object.freeze({ ...source });
  const fingerprint = hashFingerprint({
    id,
    title: normalizeSearchText(title),
    category: normalizeCategoryKey(category),
    type: normalizeCategoryKey(type),
    address: normalizeSearchText(address),
    district: normalizeSearchText(district),
    neighborhood: normalizeSearchText(neighborhood),
    street: normalizeSearchText(street),
    door: normalizeSearchText(door),
    postalCode,
    coordinates,
  });
  const partial: Omit<NormalizedRecord, 'searchText'> = {
    id,
    title,
    searchTitle: normalizeSearchText(title),
    category,
    categoryKey: normalizeCategoryKey(category),
    type,
    typeKey: normalizeCategoryKey(type),
    address,
    district,
    neighborhood,
    street,
    door,
    postalCode,
    phone,
    url,
    coordinates,
    fields,
    source,
    sourceIndex,
    fingerprint,
  };
  return Object.freeze({ ...partial, searchText: buildSearchText(partial) });
};

export const normalizeRecordCollection = (
  input: unknown,
  options: RecordNormalizationOptions = {},
): RecordNormalizationResult => {
  const source = Array.isArray(input) ? input : [];
  const requestedMax = normalizeInteger(options.maxRecords, {
    min: 1,
    max: HARD_MAX_RECORDS,
    fallback: DEFAULT_MAX_RECORDS,
  });
  const limit = Math.min(source.length, requestedMax);
  const dedupe = options.dedupe !== false;
  const keepInvalid = options.keepInvalid === true;
  const records: NormalizedRecord[] = [];
  const issues: DataQualityIssue[] = [];
  const fingerprints = new Set<string>();
  let duplicateCount = 0;
  let invalidCount = 0;
  let missingIdCount = 0;
  let invalidCoordinateCount = 0;

  for (let index = 0; index < limit; index += 1) {
    const raw = source[index];
    const normalized = normalizeRecord(raw, index, options.schema);
    if (!normalized) {
      invalidCount += 1;
      issues.push({
        code: 'record-not-object',
        severity: 'error',
        recordKey: `index:${index}`,
      });
      continue;
    }
    if (normalized.id === null) {
      missingIdCount += 1;
      issues.push({
        code: 'missing-id',
        severity: 'warning',
        recordKey: normalized.fingerprint,
        field: 'id',
      });
    }
    const sources = getRecordSources(raw);
    const schema = compileRecordSchema(options.schema);
    const rawLat = readAliasedValue(raw, schema.latitude).value;
    const rawLon = readAliasedValue(raw, schema.longitude).value;
    const coordinateWasPresent = rawLat !== null && rawLat !== undefined && rawLat !== ''
      || rawLon !== null && rawLon !== undefined && rawLon !== '';
    if (coordinateWasPresent && normalized.coordinates === null) {
      invalidCoordinateCount += 1;
      issues.push({
        code: 'invalid-coordinate-pair',
        severity: 'warning',
        recordKey: normalized.fingerprint,
        field: 'coordinates',
      });
    }
    if (!sources.length && !keepInvalid) {
      invalidCount += 1;
      continue;
    }
    if (dedupe && fingerprints.has(normalized.fingerprint)) {
      duplicateCount += 1;
      issues.push({
        code: 'duplicate-record',
        severity: 'info',
        recordKey: normalized.fingerprint,
      });
      continue;
    }
    fingerprints.add(normalized.fingerprint);
    records.push(normalized);
  }

  if (source.length > limit) {
    issues.push({
      code: 'record-limit-truncated',
      severity: 'warning',
      detail: `${source.length - limit} record(s) were omitted by the configured record limit.`,
    });
  }

  const quality: DataQualitySummary = Object.freeze({
    inputCount: source.length,
    outputCount: records.length,
    duplicateCount,
    invalidCount,
    missingIdCount,
    invalidCoordinateCount,
    issues: Object.freeze(issues),
  });
  return Object.freeze({ records: Object.freeze(records), quality });
};

export const createDatasetFingerprint = (records: readonly NormalizedRecord[]): string =>
  hashFingerprint(records.map(record => ({
    id: record.id,
    fingerprint: record.fingerprint,
  })));

export const buildFacetCounts = (
  records: readonly NormalizedRecord[],
  field: keyof NormalizedRecord,
): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>();
  for (const record of records) {
    const raw = record[field];
    if (typeof raw !== 'string') continue;
    const value = normalizeText(raw);
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
};

export const createPageInfo = (
  offsetInput: unknown,
  limitInput: unknown,
  count: number,
  total: number,
  defaultLimit = 50,
): import('./contracts').PageInfo => {
  const offset = normalizeInteger(offsetInput, { min: 0, fallback: 0 });
  const limit = normalizeInteger(limitInput, { min: 1, max: 1000, fallback: defaultLimit });
  const nextOffset = offset + count;
  return Object.freeze({
    offset,
    limit,
    count,
    total,
    hasMore: count > 0 && nextOffset < total,
    nextOffset: count > 0 && nextOffset < total ? nextOffset : null,
  });
};
