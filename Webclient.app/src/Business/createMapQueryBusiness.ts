import { Constants_ServiceResultType } from '../Core/Constants';
import MapManager from '../Store/Managers/MapManager';
import { GisQueryHelper } from '../Toolbox/GisQueryHelper';
import type {
  ArcGisQueryOptions,
  FastAccessQuery,
  ServiceDescriptor,
} from './contracts';
import {
  asFiniteNumber,
  isRecord,
  normalizeServiceDescriptor,
  serviceTitle,
  serviceUrl,
} from './contracts';

export interface MapQueryInput extends FastAccessQuery {
  readonly Id?: string | number | null;
  readonly startDate?: Date | null;
  readonly endDate?: Date | null;
}

export interface MapQueryBusiness {
  readonly Query: (
    query?: MapQueryInput,
    returnGeometry?: boolean,
  ) => Promise<unknown>;
}

export interface MapQueryBusinessConfig {
  readonly serviceKey: string;
  readonly searchField: string;
  readonly orderByField: string;
  readonly includeDateRange?: boolean;
}

const escapeSqlLiteral = (value: unknown): string =>
  String(value ?? '').replace(/'/g, "''");

const normalizedText = (value: unknown): string =>
  String(value ?? '').trim().toLocaleUpperCase('tr-TR');

const resolveService = (serviceKey: string): ServiceDescriptor | null => {
  const rawServices: unknown = MapManager.GetConfigurationServices?.();
  if (!Array.isArray(rawServices)) return null;

  for (const candidate of rawServices) {
    const service = normalizeServiceDescriptor(candidate);
    if (service && serviceTitle(service) === serviceKey) return service;
  }
  return null;
};

const serviceFailure = (serviceKey: string): Readonly<Record<string, unknown>> =>
  Object.freeze({
    type: Constants_ServiceResultType.Error,
    message: `Servis bulunamadı (${serviceKey})`,
  });

const appendIdentifier = (
  predicates: string[],
  field: string,
  value: unknown,
): void => {
  if (value === null || value === undefined) return;
  const normalized = String(value).trim();
  if (!normalized) return;
  predicates.push(`${field} = '${escapeSqlLiteral(normalized)}'`);
};

const validTimestamp = (value: unknown): number | null => {
  if (!(value instanceof Date)) return null;
  const timestamp = value.getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
};

const createWhere = (
  config: MapQueryBusinessConfig,
  query: MapQueryInput,
): string => {
  const predicates = ['1=1'];
  const name = normalizedText(query.name);
  if (name) {
    predicates.push(
      `UPPER(${config.searchField}) LIKE '%${escapeSqlLiteral(name)}%'`,
    );
  }

  appendIdentifier(predicates, 'ilceid', query.districtId);
  appendIdentifier(predicates, 'mahalleid', query.nbhoodId);
  appendIdentifier(predicates, 'id', query.Id);

  if (config.includeDateRange) {
    const start = validTimestamp(query.startDate);
    const end = validTimestamp(query.endDate);
    if (start !== null) predicates.push(`baslangictarihi >= ${start}`);
    if (end !== null) predicates.push(`bitistarihi <= ${end}`);
  }

  return predicates.join(' AND ');
};

const createOptions = (
  config: MapQueryBusinessConfig,
  service: ServiceDescriptor,
  returnGeometry: boolean,
): ArcGisQueryOptions => {
  const url = serviceUrl(service);
  if (!url) throw serviceFailure(config.serviceKey);

  return {
    url,
    returnGeometry,
    orderByFields: [config.orderByField],
    outFields: ['*'],
    where: '1=1',
  };
};

export const createMapQueryBusiness = (
  config: MapQueryBusinessConfig,
): MapQueryBusiness => Object.freeze({
  Query: async (
    query: MapQueryInput = {},
    returnGeometry = false,
  ): Promise<unknown> => {
    const service = resolveService(config.serviceKey);
    if (!service) throw serviceFailure(config.serviceKey);

    const options = createOptions(config, service, Boolean(returnGeometry));

    if (query.showNearby) {
      const distance = Math.max(0, asFiniteNumber(query.bufferDistance) ?? 0);
      return GisQueryHelper.ExecuteSpatialQuery({
        ...options,
        where: '1=1',
        geometry: query.userLocation,
        distance: distance * 100,
        units: 'meters',
        spatialRelationship: 'intersects',
      });
    }

    return GisQueryHelper.ExecuteQuery({
      ...options,
      where: createWhere(config, query),
    });
  },
});

export const isMapQueryResult = (value: unknown): value is Readonly<Record<string, unknown>> =>
  isRecord(value);
