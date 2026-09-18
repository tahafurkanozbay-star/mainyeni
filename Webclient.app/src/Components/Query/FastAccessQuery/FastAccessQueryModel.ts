import {
  Constants_ServiceResultType,
  type ServiceResultType,
} from '../../../Core/Constants';
import type { FastAccessQuery } from '../../../Business/contracts';

export interface FastAccessFilterState {
  readonly name: string;
  readonly districtId: string;
  readonly districtName: string;
  readonly nbhoodId: string;
  readonly nbhoodName: string;
  readonly showMapSelect: boolean;
  readonly showNearby: boolean;
  readonly bufferDistance: number;
  readonly userLocation: unknown;
}

export interface FastAccessLookupOption {
  readonly id: string;
  readonly label: string;
}

export interface FastAccessResultItem {
  readonly objectId: string | number;
  readonly title: string;
  readonly phone: string;
  readonly address: string;
  readonly addressDescription: string;
}

export interface FastAccessDetail {
  readonly raw: Readonly<Record<string, unknown>>;
  readonly geometry: unknown;
  readonly attributes: Readonly<Record<string, unknown>>;
}

export interface FastAccessServiceEnvelope {
  readonly type: ServiceResultType | null;
  readonly data: readonly unknown[];
  readonly message: string | null;
}

export interface FastAccessPage<Item> {
  readonly page: number;
  readonly pageCount: number;
  readonly pageSize: number;
  readonly totalCount: number;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly items: readonly Item[];
}

export const DEFAULT_FAST_ACCESS_QUERY: FastAccessFilterState = Object.freeze({
  name: '',
  districtId: '',
  districtName: '',
  nbhoodId: '',
  nbhoodName: '',
  showMapSelect: false,
  showNearby: false,
  bufferDistance: 20,
  userLocation: null,
});

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const readRecord = (
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | null => {
  const root = asRecord(value);
  if (!root) return null;
  for (const key of keys) {
    const nested = asRecord(root[key]);
    if (nested) return nested;
  }
  return root;
};

export const readFirstValue = (
  record: unknown,
  keys: readonly string[],
  fallback: unknown = null,
): unknown => {
  const root = asRecord(record);
  if (!root) return fallback;
  const sources = [
    root,
    asRecord(root.attr),
    asRecord(root.attributes),
    asRecord(root.properties),
  ].filter((candidate): candidate is Record<string, unknown> => candidate !== null);

  for (const source of sources) {
    for (const key of keys) {
      const value = source[key];
      if (value !== null && value !== undefined && String(value).trim()) return value;
    }
  }
  return fallback;
};

export const normalizeText = (
  value: unknown,
  fallback = '',
  maximumLength = 512,
): string => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return fallback;
  return text.slice(0, Math.max(1, maximumLength));
};

export const normalizeIdentifier = (value: unknown): string | number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = normalizeText(value, '', 128);
  return text || null;
};

const normalizeServiceType = (value: unknown): ServiceResultType | null => {
  const numeric = Number(value);
  if (numeric === Constants_ServiceResultType.Success) return Constants_ServiceResultType.Success;
  if (numeric === Constants_ServiceResultType.Error) return Constants_ServiceResultType.Error;
  return null;
};

export const normalizeFastAccessEnvelope = (
  value: unknown,
): FastAccessServiceEnvelope => {
  const root = asRecord(value);
  if (!root) return { type: null, data: [], message: null };
  const rawData = root.data ?? root.Data;
  const data = Array.isArray(rawData) ? rawData : [];
  const message = normalizeText(root.message ?? root.Message, '', 1000) || null;
  return {
    type: normalizeServiceType(root.type ?? root.Type),
    data,
    message,
  };
};

export const normalizeLookupOptions = (
  value: unknown,
): readonly FastAccessLookupOption[] => {
  const envelope = normalizeFastAccessEnvelope(value);
  if (envelope.type !== Constants_ServiceResultType.Success) return [];

  const deduplicated = new Map<string, FastAccessLookupOption>();
  envelope.data.forEach((item) => {
    const id = normalizeText(
      readFirstValue(item, ['id', 'ID', 'Id', 'objectid', 'OBJECTID']),
      '',
      128,
    );
    const label = normalizeText(
      readFirstValue(item, ['ad', 'AD', 'adi', 'ADI', 'name', 'Name']),
      '',
      256,
    );
    if (!id || !label || deduplicated.has(id)) return;
    deduplicated.set(id, Object.freeze({ id, label }));
  });

  return Object.freeze([...deduplicated.values()].sort((left, right) => (
    left.label.localeCompare(right.label, 'tr-TR', { sensitivity: 'base' })
  )));
};

export const normalizeFastAccessResultItem = (
  value: unknown,
  fallbackIndex = 0,
): FastAccessResultItem | null => {
  const objectId = normalizeIdentifier(readFirstValue(
    value,
    ['objectid', 'OBJECTID', 'ObjectId', 'objectId', 'id', 'ID'],
  ));
  if (objectId === null) return null;

  const title = normalizeText(
    readFirstValue(value, ['adi', 'ADI', 'ad', 'AD', 'Title', 'title']),
    `Kayıt ${fallbackIndex + 1}`,
    300,
  );
  const phone = normalizeText(
    readFirstValue(value, ['telefon', 'TELEFON', 'Phone', 'phone']),
    '',
    100,
  );
  const address = normalizeText(
    readFirstValue(value, ['adres', 'ADRES', 'Address', 'address']),
    'Adres bilgisi bulunmuyor',
    500,
  );
  const addressDescription = normalizeText(
    readFirstValue(
      value,
      ['adres_tarifi', 'ADRES_TARIFI', 'AddressDescription', 'addressDescription'],
    ),
    'Adres tarifi bulunmuyor',
    500,
  );

  return Object.freeze({
    objectId,
    title,
    phone,
    address,
    addressDescription,
  });
};

export const normalizeFastAccessResults = (
  value: unknown,
): readonly FastAccessResultItem[] => {
  const envelope = normalizeFastAccessEnvelope(value);
  if (envelope.type !== Constants_ServiceResultType.Success) return [];

  const deduplicated = new Map<string, FastAccessResultItem>();
  envelope.data.forEach((record, index) => {
    const normalized = normalizeFastAccessResultItem(record, index);
    if (!normalized) return;
    const key = String(normalized.objectId);
    if (!deduplicated.has(key)) deduplicated.set(key, normalized);
  });
  return Object.freeze([...deduplicated.values()]);
};

export const normalizeFastAccessDetail = (
  value: unknown,
): FastAccessDetail | null => {
  const envelope = normalizeFastAccessEnvelope(value);
  if (
    envelope.type !== Constants_ServiceResultType.Success
    || envelope.data.length === 0
  ) {
    return null;
  }

  const first = asRecord(envelope.data[0]);
  if (!first) return null;
  const attributes = readRecord(first, ['attr', 'attributes', 'properties']) ?? {};
  const geometry = first.geometry ?? null;
  return Object.freeze({
    raw: Object.freeze({ ...first }),
    geometry,
    attributes: Object.freeze({ ...attributes }),
  });
};

export const updateFastAccessQuery = (
  state: FastAccessFilterState,
  field: string,
  value: unknown,
): FastAccessFilterState => {
  switch (field) {
    case 'name':
      return { ...state, name: normalizeText(value, '', 160) };
    case 'districtId':
      return { ...state, districtId: normalizeText(value, '', 128) };
    case 'districtName':
      return { ...state, districtName: normalizeText(value, '', 256) };
    case 'nbhoodId':
      return { ...state, nbhoodId: normalizeText(value, '', 128) };
    case 'nbhoodName':
      return { ...state, nbhoodName: normalizeText(value, '', 256) };
    case 'showMapSelect':
      return { ...state, showMapSelect: value === true };
    case 'showNearby':
      return { ...state, showNearby: value === true };
    case 'bufferDistance': {
      const numeric = Number(value);
      return {
        ...state,
        bufferDistance: Number.isFinite(numeric)
          ? Math.max(0, Math.min(100, numeric))
          : state.bufferDistance,
      };
    }
    case 'userLocation':
      return { ...state, userLocation: value };
    default:
      return state;
  }
};

export const toBusinessQuery = (
  query: FastAccessFilterState,
): FastAccessQuery => ({
  name: query.name || null,
  districtId: query.districtId || null,
  nbhoodId: query.nbhoodId || null,
  showNearby: query.showNearby,
  bufferDistance: query.bufferDistance,
  userLocation: query.userLocation,
});

export const createQueryLogDescription = (
  query: FastAccessFilterState,
): string => [
  query.districtName || '-',
  query.nbhoodName || '-',
  query.name || '-',
].join('/');

export const paginateFastAccessResults = <Item>(
  items: readonly Item[],
  page: number,
  pageSize = 20,
): FastAccessPage<Item> => {
  const safePageSize = Math.max(5, Math.min(100, Math.floor(
    Number.isFinite(pageSize) ? pageSize : 20,
  )));
  const totalCount = items.length;
  const pageCount = Math.max(1, Math.ceil(totalCount / safePageSize));
  const safePage = Math.min(
    pageCount,
    Math.max(1, Math.floor(Number.isFinite(page) ? page : 1)),
  );
  const startIndex = (safePage - 1) * safePageSize;
  const endIndex = Math.min(totalCount, startIndex + safePageSize);

  return Object.freeze({
    page: safePage,
    pageCount,
    pageSize: safePageSize,
    totalCount,
    startIndex,
    endIndex,
    items: Object.freeze(items.slice(startIndex, endIndex)),
  });
};

export const fastAccessResultKey = (item: FastAccessResultItem): string =>
  `fast-access:${String(item.objectId)}`;

export const fastAccessResultLabel = (item: FastAccessResultItem): string =>
  [item.title, item.address].filter(Boolean).join(', ');
