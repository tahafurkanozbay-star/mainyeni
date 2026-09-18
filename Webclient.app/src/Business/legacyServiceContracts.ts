import {
  type ArcGisField,
  type UnknownRecord,
  isRecord,
} from './contracts';

export interface LegacyQueryDataItem<TAttributes extends UnknownRecord = UnknownRecord> {
  readonly attr: TAttributes | null;
  readonly geometry: unknown;
}

export interface LegacyQueryPage {
  readonly offset: number;
  readonly count: number;
  readonly hasMore: boolean;
  readonly nextOffset: number | null;
  readonly pages?: number;
  readonly pageSize?: number;
  readonly maxRecords?: number;
  readonly truncated?: boolean;
}

export interface LegacyGisSuccess<TAttributes extends UnknownRecord = UnknownRecord> {
  readonly type: 10;
  readonly data: readonly LegacyQueryDataItem<TAttributes>[];
  readonly fields: readonly ArcGisField[];
  readonly exceededTransferLimit?: boolean;
  readonly geometryType?: unknown;
  readonly spatialReference?: unknown;
  readonly page?: LegacyQueryPage | null;
  readonly count?: number;
}

export interface LegacyGisCountSuccess {
  readonly type: 10;
  readonly data: number;
  readonly count: number;
  readonly fields: readonly ArcGisField[];
  readonly exceededTransferLimit: false;
  readonly page: null;
}

export interface LegacyGisFailure {
  readonly type: 20;
  readonly error: unknown;
  readonly data: null;
  readonly fields: null;
}

export type LegacyGisResult<TAttributes extends UnknownRecord = UnknownRecord> =
  | LegacyGisSuccess<TAttributes>
  | LegacyGisCountSuccess
  | LegacyGisFailure;

export interface MutableLegacyGisSuccess<TAttributes extends UnknownRecord = UnknownRecord> {
  type: 10;
  data: LegacyQueryDataItem<TAttributes>[];
  fields: ArcGisField[];
  exceededTransferLimit?: boolean;
  geometryType?: unknown;
  spatialReference?: unknown;
  page?: LegacyQueryPage | null;
  count?: number;
}

export const isLegacyGisSuccess = <TAttributes extends UnknownRecord = UnknownRecord>(
  value: unknown,
): value is LegacyGisSuccess<TAttributes> | LegacyGisCountSuccess =>
  isRecord(value) && value.type === 10;

export const isLegacyGisFailure = (value: unknown): value is LegacyGisFailure =>
  isRecord(value) && value.type === 20;

export const legacyResultData = <TAttributes extends UnknownRecord = UnknownRecord>(
  value: unknown,
): readonly LegacyQueryDataItem<TAttributes>[] => {
  if (!isLegacyGisSuccess<TAttributes>(value)) return Object.freeze([]);
  return Array.isArray(value.data)
    ? Object.freeze([...value.data])
    : Object.freeze([]);
};

export const legacyItemAttributes = <TAttributes extends UnknownRecord = UnknownRecord>(
  value: unknown,
): TAttributes | null => {
  if (!isRecord(value) || !isRecord(value.attr)) return null;
  return value.attr as TAttributes;
};

export const legacyAttribute = (
  value: unknown,
  field: string,
): unknown => legacyItemAttributes(value)?.[field];

export const emptyLegacyGisSuccess = (): LegacyGisSuccess => Object.freeze({
  type: 10,
  data: Object.freeze([]),
  fields: Object.freeze([]),
  exceededTransferLimit: false,
  page: Object.freeze({
    offset: 0,
    count: 0,
    hasMore: false,
    nextOffset: null,
  }),
});

export const legacyServiceError = (
  message: string,
  code = 'SERVICE_ERROR',
): Readonly<Record<string, unknown>> => Object.freeze({
  type: 20,
  message: message.slice(0, 500),
  code: code.slice(0, 80),
});
