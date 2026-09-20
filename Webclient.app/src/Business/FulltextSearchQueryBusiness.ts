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

export interface FulltextSearchQuery extends FastAccessQuery {
  readonly searchText?: unknown;
  readonly Id?: string | number | null;
}

const escapeSqlLiteral = (value: unknown): string =>
  String(value ?? '').replace(/'/g, "''");

const normalizeSearchText = (value: unknown): string =>
  String(value ?? '').trim().toLocaleLowerCase('tr-TR');

const asciiFold = (value: string): string => value
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/ı/g, 'i');

const buildTextFilter = (searchText: unknown): string | null => {
  const lower = escapeSqlLiteral(normalizeSearchText(searchText));
  if (!lower) return null;
  const ascii = escapeSqlLiteral(asciiFold(lower));
  return `(LOWER(adi) LIKE '%${lower}%' OR LOWER(adi) LIKE '%${ascii}%')`;
};

const appendIdFilter = (
  predicates: string[],
  field: string,
  value: unknown,
): void => {
  if (value === null || value === undefined) return;
  const normalized = String(value).trim();
  if (!normalized) return;
  predicates.push(`${field} = '${escapeSqlLiteral(normalized)}'`);
};

const resolveService = (serviceKey: string): ServiceDescriptor | null => {
  const rawServices: unknown = MapManager.GetConfigurationServices?.();
  if (!Array.isArray(rawServices)) return null;

  for (const candidate of rawServices) {
    const service = normalizeServiceDescriptor(candidate);
    if (service && serviceTitle(service) === serviceKey) return service;
  }
  return null;
};

const createOptions = (
  service: ServiceDescriptor,
  returnGeometry: boolean,
): ArcGisQueryOptions => ({
  url: serviceUrl(service) ?? '',
  returnGeometry,
  orderByFields: ['adi'],
  outFields: ['*'],
});

const execute = async (
  options: ArcGisQueryOptions,
  query: FulltextSearchQuery,
): Promise<unknown> => {
  if (query.showNearby) {
    const distance = Math.max(0, asFiniteNumber(query.bufferDistance) ?? 0);
    return GisQueryHelper.ExecuteSpatialQuery({
      ...options,
      geometry: query.userLocation,
      distance: distance * 100,
      units: 'meters',
      spatialRelationship: 'intersects',
    });
  }
  return GisQueryHelper.ExecuteQuery(options);
};

const serviceFailure = (serviceKey: string): Readonly<Record<string, unknown>> =>
  Object.freeze({
    type: Constants_ServiceResultType.Error,
    message: `Servis bulunamadı (${serviceKey})`,
  });

export const FulltextSearchQueryBusiness = Object.freeze({
  QueryService: async (
    configService: unknown,
    query: FulltextSearchQuery = {},
    returnGeometry = false,
  ): Promise<Readonly<Record<string, unknown>>> => {
    const service = normalizeServiceDescriptor(configService);
    if (!service) throw serviceFailure('FullTextSearchQueryUrl');

    const predicates = ['1=1'];
    const textFilter = buildTextFilter(query.searchText);
    if (textFilter) predicates.push(textFilter);

    const result = await execute(
      {
        ...createOptions(service, returnGeometry),
        where: predicates.join(' AND '),
      },
      query,
    );

    return Object.freeze({
      Title: isRecord(configService) ? configService.searchCategoryTitle : undefined,
      Data: isRecord(result) ? result.data : undefined,
    });
  },

  Search: async (
    query: FulltextSearchQuery = {},
    returnGeometry = false,
  ): Promise<unknown> => {
    const serviceKey = 'FullTextSearchQueryUrl';
    const service = resolveService(serviceKey);
    if (!service) throw serviceFailure(serviceKey);

    const predicates = ['1=1'];
    const textFilter = buildTextFilter(query.searchText);
    if (textFilter) predicates.push(textFilter);

    if (!query.showNearby) {
      appendIdFilter(predicates, 'ilceid', query.districtId);
      appendIdFilter(predicates, 'mahalleid', query.nbhoodId);
      const id = asFiniteNumber(query.Id);
      if (id !== null) predicates.push(`id = ${id}`);
    }

    return execute(
      {
        ...createOptions(service, returnGeometry),
        where: predicates.join(' AND '),
      },
      query,
    );
  },
});
