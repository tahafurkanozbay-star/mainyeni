import type { RefObject } from 'react';
import type {
  QueryWindowManagerLike,
} from './CommonQueryWindowTools';
import type {
  GeometryLike,
} from './QueryInteractionRuntime';

export type UnknownRecord = Record<string, unknown>;
export type QueryIdentifier = string | number;

export interface ManagedQueryWindowHandle {
  readonly id: string;
  readonly visible: boolean;
  readonly minimized: boolean;
  readonly OnShow: () => void | Promise<void>;
  readonly OnClose: () => void;
}

export interface ManagedQueryWindowManager extends QueryWindowManagerLike {
  readonly RegisterWindow: (ref: unknown) => void;
  readonly UnregisterWindow?: (windowId: string, ref: unknown) => void;
  readonly ShowWindow: (windowId: string, query?: unknown) => void;
  readonly GetQueryParams: (windowId: string) => UnknownRecord | null | undefined;
  readonly IsVisible: (windowId: string) => boolean;
}

export interface QueryServiceResult<T> {
  readonly type?: unknown;
  readonly data?: readonly T[] | null;
  readonly message?: unknown;
  readonly errorMessage?: unknown;
}

export interface QueryOption {
  readonly id: string;
  readonly label: string;
}

export interface QueryMapLike<TLayer = unknown> {
  readonly add?: (layer: TLayer) => unknown;
  readonly remove?: (layer: TLayer) => unknown;
}

export interface QueryMapViewLike<TLayer = unknown> {
  readonly map?: QueryMapLike<TLayer> | null;
  readonly width?: number;
  readonly height?: number;
  readonly zoom?: number;
  readonly goTo?: (
    target: unknown,
    options?: Readonly<Record<string, unknown>>,
  ) => Promise<unknown> | unknown;
}

export interface QueryLayerEnvelope<TLayer = unknown> {
  readonly layerObj?: TLayer | null;
}

export interface QueryFeatureLike extends UnknownRecord {
  readonly attr?: UnknownRecord | null;
  readonly attributes?: UnknownRecord | null;
  readonly properties?: UnknownRecord | null;
  readonly geometry?: GeometryLike | null;
}

export const isUnknownRecord = (value: unknown): value is UnknownRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const normalizeQueryText = (
  value: unknown,
  fallback = '',
): string => {
  if (typeof value !== 'string' && typeof value !== 'number') return fallback;
  const normalized = String(value).replace(/\s+/g, ' ').trim();
  return normalized || fallback;
};

export const normalizeQueryIdentifier = (
  value: unknown,
): QueryIdentifier | null => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'string') {
    const normalized = value.trim();
    return normalized ? normalized : null;
  }

  return null;
};

export const normalizeQueryIdentifierString = (
  value: unknown,
): string => {
  const normalized = normalizeQueryIdentifier(value);
  return normalized === null ? '' : String(normalized);
};

export const readQueryField = (
  record: UnknownRecord | null | undefined,
  keys: readonly string[],
): unknown => {
  if (!record) return undefined;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      const value = record[key];
      if (value !== undefined && value !== null) return value;
    }
  }
  return undefined;
};

export const readNestedQueryField = (
  record: QueryFeatureLike | null | undefined,
  keys: readonly string[],
): unknown => {
  if (!record) return undefined;

  const direct = readQueryField(record, keys);
  if (direct !== undefined && direct !== null) return direct;

  const attributeValue = readQueryField(
    isUnknownRecord(record.attr) ? record.attr : undefined,
    keys,
  );
  if (attributeValue !== undefined && attributeValue !== null) return attributeValue;

  const attributesValue = readQueryField(
    isUnknownRecord(record.attributes) ? record.attributes : undefined,
    keys,
  );
  if (attributesValue !== undefined && attributesValue !== null) return attributesValue;

  return readQueryField(
    isUnknownRecord(record.properties) ? record.properties : undefined,
    keys,
  );
};

export const normalizeQueryOption = (
  value: unknown,
): QueryOption | null => {
  if (!isUnknownRecord(value)) return null;
  const source = isUnknownRecord(value.properties)
    ? value.properties
    : isUnknownRecord(value.attr)
      ? value.attr
      : value;

  const id = normalizeQueryIdentifierString(
    readQueryField(source, ['id', 'Id', 'ID', 'objectid', 'ObjectId']),
  );
  if (!id) return null;

  const label = normalizeQueryText(
    readQueryField(source, ['text', 'Text', 'ad', 'Ad', 'name', 'Name', 'title', 'Title']),
    id,
  );

  return Object.freeze({ id, label });
};

export const normalizeQueryOptions = (
  values: unknown,
): readonly QueryOption[] => {
  if (!Array.isArray(values)) return [];

  const seen = new Set<string>();
  const options: QueryOption[] = [];
  for (const value of values) {
    const option = normalizeQueryOption(value);
    if (!option || seen.has(option.id)) continue;
    seen.add(option.id);
    options.push(option);
  }
  return options;
};

export const getQueryServiceMessage = (
  result: unknown,
  fallback: string,
): string => {
  if (!isUnknownRecord(result)) return fallback;
  return normalizeQueryText(
    result.message ?? result.errorMessage,
    fallback,
  );
};

export const normalizeQueryServiceData = <T>(
  result: QueryServiceResult<T> | null | undefined,
): readonly T[] => Array.isArray(result?.data) ? result.data : [];

export const createWindowRefToken = (
  ref: RefObject<ManagedQueryWindowHandle | null> | unknown,
): unknown => ref;
