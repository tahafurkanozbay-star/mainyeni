import { Constants_ServiceResultType } from '../Core/Constants';
import MapManager from '../Store/Managers/MapManager';
import { GisQueryHelper, type GisQueryOptions } from '../Toolbox/GisQueryHelper';
import { TextHelper } from '../Toolbox/TextHelper';
import { CommonBusiness } from './CommonBusiness';
import {
  type FastAccessQuery,
  type ServiceDescriptor,
  serviceTitle,
  serviceUrl,
} from './contracts';
import {
  buildArcGisEqualsFilter,
  buildArcGisUpperContainsFilter,
  normalizeNearbyDistanceMeters,
} from './querySafety';

export interface EventQuery extends FastAccessQuery {
  readonly Id?: string | number | null;
  readonly startDate?: Date | null;
  readonly endDate?: Date | null;
}

const EVENT_SERVICE_TITLE = 'EventQueryUrl';

const findService = (): ServiceDescriptor | null =>
  MapManager.GetConfigurationServices()
    .find((service) => serviceTitle(service) === EVENT_SERVICE_TITLE) ?? null;

const resolveServiceUrl = (service: ServiceDescriptor): string | null => {
  const generated = CommonBusiness.GenerateUrl?.(service);
  if (typeof generated === 'string' && generated.trim()) return generated.trim();
  return serviceUrl(service);
};

const dateEpoch = (value: Date | null | undefined): number | null => {
  if (!(value instanceof Date)) return null;
  const epoch = value.getTime();
  return Number.isFinite(epoch) ? epoch : null;
};

export const EventQueryBusiness = Object.freeze({
  Query: async (
    query: EventQuery = {},
    returnGeometry = false,
  ) => {
    const queryService = findService();
    if (!queryService) {
      return Promise.reject(Object.freeze({
        type: Constants_ServiceResultType.Error,
        message: `Servis bulunamadı (${EVENT_SERVICE_TITLE})`,
      }));
    }

    const url = resolveServiceUrl(queryService);
    if (!url) {
      return Promise.reject(Object.freeze({
        type: Constants_ServiceResultType.Error,
        message: `Servis adresi bulunamadı (${EVENT_SERVICE_TITLE})`,
      }));
    }

    const options: GisQueryOptions = {
      url,
      returnGeometry,
      orderByFields: Object.freeze(['adi']),
      outFields: Object.freeze(['*']),
      where: '1=1',
    };

    if (query.showNearby) {
      return GisQueryHelper.ExecuteSpatialQuery({
        ...options,
        geometry: query.userLocation,
        distance: normalizeNearbyDistanceMeters(query.bufferDistance, {
          multiplier: 100,
          fallbackMeters: 1,
          maximumMeters: 50_000,
        }),
        units: 'meters',
        spatialRelationship: 'intersects',
      });
    }

    const predicates: string[] = ['1=1'];
    const nameFilter = buildArcGisUpperContainsFilter('adi', query.name, {
      uppercase: (value) => TextHelper.TurkishToUpper(value) ?? value.toUpperCase(),
    });
    if (nameFilter) predicates.push(nameFilter);

    if (query.districtId !== null && query.districtId !== undefined && query.districtId !== '') {
      predicates.push(buildArcGisEqualsFilter('ilceid', query.districtId));
    }
    if (query.nbhoodId !== null && query.nbhoodId !== undefined && query.nbhoodId !== '') {
      predicates.push(buildArcGisEqualsFilter('mahalleid', query.nbhoodId));
    }
    if (query.Id !== null && query.Id !== undefined && query.Id !== '') {
      predicates.push(buildArcGisEqualsFilter('id', query.Id));
    }

    const start = dateEpoch(query.startDate);
    const end = dateEpoch(query.endDate);
    if (start !== null) predicates.push(`baslangictarihi >= ${start}`);
    if (end !== null) predicates.push(`bitistarihi <= ${end}`);

    return GisQueryHelper.ExecuteQuery({
      ...options,
      where: predicates.join(' AND '),
    });
  },
});
