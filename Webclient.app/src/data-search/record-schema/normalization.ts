import {
  normalizeCoordinates,
  normalizeFiniteNumber,
  normalizeId,
  normalizeSearchText,
  normalizeText,
} from '../../Toolbox/DataIntegrityHelper';
import {
  isPlainObject,
  type AliasedValue,
  type FieldNormalizeOptions,
  type FieldType,
  type RecordSource,
  type UnknownRecord,
} from './contracts';

export const SOURCE_CONTAINERS = Object.freeze([
  'root',
  'attr',
  'attributes',
  'properties',
] as const);

export const FIELD_TYPES = Object.freeze({
  Text: 'text',
  Id: 'id',
  Integer: 'integer',
  Number: 'number',
  Boolean: 'boolean',
  Category: 'category',
  Latitude: 'latitude',
  Longitude: 'longitude',
  Url: 'url',
  Phone: 'phone',
} as const satisfies Record<string, FieldType>);

export const DEFAULT_FIELD_ALIASES: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    id: ['id', 'Id', 'ID', 'objectid', 'ObjectId', 'OBJECTID', 'objectId', 'globalid', 'GlobalId', 'GLOBALID'],
    title: ['title', 'Title', 'name', 'Name', 'NAME', 'ad', 'Ad', 'AD', 'adi', 'Adi', 'ADI'],
    category: ['category', 'Category', 'CATEGORY', 'kategori', 'Kategori', 'KATEGORI', 'tur', 'Tur', 'TUR'],
    type: ['type', 'Type', 'TYPE', 'tip', 'Tip', 'TIP', 'turu', 'Turu', 'TURU'],
    address: ['address', 'Address', 'ADDRESS', 'adres', 'Adres', 'ADRES', 'acik_adres', 'ACIK_ADRES', 'acikAdres'],
    district: ['district', 'District', 'ilce', 'Ilce', 'ILCE', 'ilce_adi', 'ILCE_ADI', 'ilceAdi'],
    neighborhood: ['neighborhood', 'Neighborhood', 'mahalle', 'Mahalle', 'MAHALLE', 'mahalle_adi', 'MAHALLE_ADI', 'mahalleAdi', '_MAHALLE_ADI'],
    street: ['street', 'Street', 'sokak', 'Sokak', 'SOKAK', 'cadde', 'Cadde', 'CADDE', 'yol', 'YOL', 'yol_adi', 'YOL_ADI', 'yolAdi'],
    door: ['door', 'Door', 'doorNo', 'doorNumber', 'kapino', 'kapiNo', 'KAPINO', 'KAPI_NO'],
    phone: ['phone', 'Phone', 'PHONE', 'telefon', 'Telefon', 'TELEFON', 'tel', 'TEL'],
    latitude: ['latitude', 'Latitude', 'LATITUDE', 'lat', 'Lat', 'LAT', 'y', 'Y'],
    longitude: ['longitude', 'Longitude', 'LONGITUDE', 'lon', 'Lon', 'LON', 'lng', 'Lng', 'LNG', 'x', 'X'],
    url: ['url', 'Url', 'URL', 'web', 'Web', 'website', 'Website', 'WEB_SITE'],
  });

const isNil = (value: unknown): value is null | undefined =>
  value === null || value === undefined;

export const getRecordSources = (record: unknown): RecordSource[] => {
  if (!isPlainObject(record)) return [];
  const sources: RecordSource[] = [{ name: 'root', value: record }];

  for (const name of ['attr', 'attributes', 'properties'] as const) {
    const candidate = record[name];
    if (isPlainObject(candidate)) {
      sources.push({ name, value: candidate });
    }
  }

  return sources;
};

export const readAliasedValue = (
  record: unknown,
  aliases: readonly string[] = [],
  fallback: unknown = null,
): AliasedValue => {
  for (const source of getRecordSources(record)) {
    for (const alias of aliases) {
      const value = source.value[alias];
      if (!isNil(value) && value !== '') {
        return {
          value,
          alias,
          source: source.name,
        };
      }
    }
  }

  return {
    value: fallback,
    alias: null,
    source: null,
  };
};

export const normalizeBoolean = (
  value: unknown,
  fallback: boolean | null = null,
): boolean | null => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
    return fallback;
  }

  const normalized = normalizeSearchText(value);
  if (['true', '1', 'evet', 'yes', 'aktif'].includes(normalized)) return true;
  if (['false', '0', 'hayir', 'no', 'pasif'].includes(normalized)) return false;
  return fallback;
};

export const normalizePhone = (value: unknown): string => {
  const text = normalizeText(value);
  if (!text) return '';
  const leadingPlus = text.startsWith('+') ? '+' : '';
  const digits = text.replace(/\D/g, '');
  return digits ? `${leadingPlus}${digits}` : '';
};

export const normalizeSafeHttpUrl = (value: unknown): string => {
  const text = normalizeText(value);
  if (!text) return '';

  try {
    const parsed = new URL(text, 'https://localhost.invalid');
    if (!/^https?:$/i.test(parsed.protocol)) return '';
    if (!/^https?:\/\//i.test(text)) return text;
    return parsed.toString();
  } catch {
    return '';
  }
};

export const normalizeFieldValue = (
  value: unknown,
  type: FieldType,
  options: FieldNormalizeOptions = {},
): unknown => {
  switch (type) {
    case FIELD_TYPES.Id:
      return normalizeId(value);
    case FIELD_TYPES.Integer: {
      const number = normalizeFiniteNumber(value, null);
      return number !== null && Number.isInteger(number) ? number : null;
    }
    case FIELD_TYPES.Number:
      return normalizeFiniteNumber(value, null);
    case FIELD_TYPES.Boolean:
      return normalizeBoolean(
        value,
        typeof options.fallback === 'boolean' || options.fallback === null
          ? options.fallback
          : null,
      );
    case FIELD_TYPES.Category:
      return normalizeText(value);
    case FIELD_TYPES.Latitude: {
      const coordinates = normalizeCoordinates({ latitude: value, longitude: 0 });
      return coordinates?.latitude ?? null;
    }
    case FIELD_TYPES.Longitude: {
      const coordinates = normalizeCoordinates({ latitude: 0, longitude: value });
      return coordinates?.longitude ?? null;
    }
    case FIELD_TYPES.Url:
      return normalizeSafeHttpUrl(value);
    case FIELD_TYPES.Phone:
      return normalizePhone(value);
    case FIELD_TYPES.Text:
    default:
      return normalizeText(value, options);
  }
};

export const createEmptyRecord = (): UnknownRecord => ({});
