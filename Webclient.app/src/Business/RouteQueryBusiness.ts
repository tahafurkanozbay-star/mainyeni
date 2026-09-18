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
  buildArcGisIntegerEqualsFilter,
  buildArcGisUpperContainsFilter,
  normalizeNearbyDistanceMeters,
} from './querySafety';

export interface RouteQuery extends FastAccessQuery {
  readonly Id?: string | number | null;
  readonly routeLevel?: string | number | null;
  readonly showCultureWalkingRoute?: boolean;
  readonly showNatureWalkingRoute?: boolean;
}

const ROUTE_SERVICE_TITLE = 'RouteQueryUrl';

const findService = (): ServiceDescriptor | null =>
  MapManager.GetConfigurationServices()
    .find((service) => serviceTitle(service) === ROUTE_SERVICE_TITLE) ?? null;

const resolveServiceUrl = (service: ServiceDescriptor): string | null => {
  const generated = CommonBusiness.GenerateUrl?.(service);
  if (typeof generated === 'string' && generated.trim()) return generated.trim();
  return serviceUrl(service);
};

export const RouteQueryBusiness = Object.freeze({
  Query: async (
    query: RouteQuery = {},
    returnGeometry = false,
  ) => {
    const queryService = findService();
    if (!queryService) {
      return Promise.reject(Object.freeze({
        type: Constants_ServiceResultType.Error,
        message: `Servis bulunamadı (${ROUTE_SERVICE_TITLE})`,
      }));
    }

    const url = resolveServiceUrl(queryService);
    if (!url) {
      return Promise.reject(Object.freeze({
        type: Constants_ServiceResultType.Error,
        message: `Servis adresi bulunamadı (${ROUTE_SERVICE_TITLE})`,
      }));
    }

    const base: GisQueryOptions = {
      url,
      returnGeometry,
      orderByFields: Object.freeze(['adi']),
      outFields: Object.freeze(['*']),
      where: '(tip=1 or tip=2)',
    };

    if (query.showNearby) {
      return GisQueryHelper.ExecuteSpatialQuery({
        ...base,
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

    const predicates: string[] = ['(tip=1 or tip=2)'];
    const nameFilter = buildArcGisUpperContainsFilter('adi', query.name, {
      uppercase: (value) => TextHelper.TurkishToUpper(value) ?? value.toUpperCase(),
    });
    if (nameFilter) predicates.push(nameFilter);

    if (query.districtId !== null && query.districtId !== undefined && query.districtId !== '') {
      predicates.push(buildArcGisEqualsFilter('ilceid', query.districtId));
    }

    const hasRouteId = query.Id !== null && query.Id !== undefined && query.Id !== '';
    if (!query.showCultureWalkingRoute && !hasRouteId) predicates.push('tip <> 1');
    if (!query.showNatureWalkingRoute && !hasRouteId) predicates.push('tip <> 2');

    if (query.routeLevel !== null && query.routeLevel !== undefined && query.routeLevel !== '') {
      const level = buildArcGisIntegerEqualsFilter(
        'zorlukderecesi',
        query.routeLevel,
        { maximumDigits: 3 },
      );
      if (level) predicates.push(level);
    }

    if (hasRouteId) {
      const objectId = buildArcGisIntegerEqualsFilter(
        'objectid',
        query.Id,
        { maximumDigits: 15 },
      );
      if (objectId) predicates.push(objectId);
      else predicates.push('1=0');
    }

    return GisQueryHelper.ExecuteQuery({
      ...base,
      where: predicates.join(' AND '),
    });
  },
});
