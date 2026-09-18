import MapManager from '../Store/Managers/MapManager';
import { Constants_ServiceResultType } from '../Core/Constants';
import { apiClient } from '../platform/http/httpClient';
import {
  GisQueryHelper,
  type GisQueryOptions,
} from '../Toolbox/GisQueryHelper';
import { TextHelper } from '../Toolbox/TextHelper';
import { CommonBusiness } from './CommonBusiness';
import {
  type ServiceDescriptor,
  serviceTitle,
  serviceUrl,
} from './contracts';
import {
  emptyLegacyGisSuccess,
  isLegacyGisFailure,
  legacyAttribute,
  legacyResultData,
  type LegacyGisResult,
  type LegacyQueryDataItem,
} from './legacyServiceContracts';
import {
  buildArcGisEqualsFilter,
  buildArcGisInFilter,
  buildArcGisUpperContainsFilter,
  hasQueryIdentifier,
  normalizeLegacyIdentifier,
  normalizeQueryText,
} from './querySafety';

const SERVICE_TITLES = Object.freeze({
  district: 'NumberingDistrictQueryUrl',
  neighborhood: 'NumberingNeighborhoodQueryUrl',
  street: 'StreetQueryUrl',
  streetCenterLine: 'StreetCenterLineUrl',
  streetCenterLineWay: 'StreetCenterLineWayUrl',
  door: 'DoorQueryUrl',
  building: 'BuildingQueryUrl',
  structure: 'StructureQueryUrl',
  numberingInfo: 'NumberingInfoQueryUrl',
});

interface DistrictQuery {
  readonly DistrictName?: unknown;
}

interface NeighborhoodQuery {
  readonly NeighborhoodName?: unknown;
}

interface FileRequestOptions {
  readonly signal?: AbortSignal;
  readonly cacheTtlMs?: number;
  readonly [key: string]: unknown;
}

type LegacyCallback = ((value: unknown) => void) | null | undefined;

const turkishCollator = new Intl.Collator('tr-TR', {
  sensitivity: 'base',
  numeric: true,
});

const serviceError = (title: string): Readonly<Record<string, unknown>> => Object.freeze({
  type: Constants_ServiceResultType.Error,
  message: `Servis bulunamadı (${title})`,
});

const getService = (title: string): ServiceDescriptor => {
  const service = MapManager.GetConfigurationServices()
    .find((candidate) => serviceTitle(candidate) === title);
  if (!service) throw serviceError(title);
  return service;
};

const resolveUrl = (service: ServiceDescriptor): string => {
  const generated = CommonBusiness.GenerateUrl?.(service);
  const resolved = typeof generated === 'string' && generated.trim()
    ? generated.trim()
    : serviceUrl(service);
  if (!resolved) throw serviceError(serviceTitle(service) ?? 'unknown');
  return resolved;
};

const createOptions = (
  title: string,
  patch: Partial<GisQueryOptions> = {},
): GisQueryOptions => ({
  url: resolveUrl(getService(title)),
  returnGeometry: false,
  outFields: Object.freeze(['*']),
  ...patch,
});

const sortData = (
  result: LegacyGisResult,
  field: string | null,
): LegacyGisResult => {
  if (!field || result.type !== Constants_ServiceResultType.Success || !Array.isArray(result.data)) {
    return result;
  }
  const sorted = [...result.data].sort((left, right) =>
    turkishCollator.compare(
      normalizeQueryText(legacyAttribute(left, field), 512),
      normalizeQueryText(legacyAttribute(right, field), 512),
    ));
  return Object.freeze({
    ...result,
    data: Object.freeze(sorted),
  });
};

const executeQuery = async (
  title: string,
  options: Partial<GisQueryOptions>,
  sortField: string | null = null,
): Promise<LegacyGisResult> => {
  const result = await GisQueryHelper.ExecuteQuery(createOptions(title, options));
  return sortData(result, sortField);
};

const readEntityId = (entity: unknown): string => normalizeLegacyIdentifier(entity);

const fileRequestOptions = (
  options: FileRequestOptions = {},
): Readonly<Record<string, unknown>> => Object.freeze({
  ...options,
  cache: true,
  dedupe: !options.signal,
  cacheTtlMs: options.cacheTtlMs ?? 30_000,
});

const returnWithCallback = (
  callback: LegacyCallback,
  value: unknown,
): unknown => {
  if (typeof callback === 'function') callback(value);
  return value;
};

const valuesFrom = (
  result: LegacyGisResult,
  field: string,
): readonly unknown[] => legacyResultData(result)
  .map((item) => legacyAttribute(item, field))
  .filter(hasQueryIdentifier);

export const NumberingQueryBusiness = Object.freeze({
  GetDistrictById: async (id: unknown): Promise<LegacyGisResult> =>
    executeQuery(SERVICE_TITLES.district, {
      returnDistinctValues: false,
      returnGeometry: true,
      orderByFields: Object.freeze(['ad']),
      outFields: Object.freeze(['*']),
      where: buildArcGisEqualsFilter('id', id),
    }),

  GetDistricts: async (
    query: DistrictQuery = {},
  ): Promise<LegacyGisResult> => {
    const predicates = ['1=1'];
    const nameFilter = buildArcGisUpperContainsFilter('ad', query.DistrictName, {
      uppercase: (value) => TextHelper.TurkishToUpper(value) ?? value.toUpperCase(),
    });
    if (nameFilter) predicates.push(nameFilter);

    return executeQuery(SERVICE_TITLES.district, {
      returnDistinctValues: true,
      returnGeometry: false,
      orderByFields: Object.freeze(['ad']),
      outFields: Object.freeze(['id', 'ad']),
      where: predicates.join(' AND '),
    }, 'ad');
  },

  GetNeighborhoodById: async (id: unknown): Promise<LegacyGisResult> =>
    executeQuery(SERVICE_TITLES.neighborhood, {
      returnDistinctValues: false,
      returnGeometry: true,
      orderByFields: Object.freeze(['ad']),
      outFields: Object.freeze(['*']),
      where: buildArcGisEqualsFilter('id', id),
    }),

  GetAllNeighborhoods: async (
    query: NeighborhoodQuery = {},
  ): Promise<LegacyGisResult> => {
    const predicates = ['1=1'];
    const nameFilter = buildArcGisUpperContainsFilter('ad', query.NeighborhoodName, {
      uppercase: (value) => TextHelper.TurkishToUpper(value) ?? value.toUpperCase(),
    });
    if (nameFilter) predicates.push(nameFilter);

    return executeQuery(SERVICE_TITLES.neighborhood, {
      returnDistinctValues: true,
      returnGeometry: false,
      orderByFields: Object.freeze(['ad']),
      outFields: Object.freeze(['id', 'ad']),
      where: predicates.join(' AND '),
    }, 'ad');
  },

  GetNeighborhoodsOfDistrict: async (
    districtId: unknown,
  ): Promise<LegacyGisResult> => executeQuery(SERVICE_TITLES.neighborhood, {
    returnGeometry: true,
    orderByFields: Object.freeze(['ad']),
    outFields: Object.freeze(['*']),
    where: buildArcGisEqualsFilter('ilceid', districtId),
  }, 'ad'),

  GetStreetsByName: async (
    name: unknown,
  ): Promise<LegacyGisResult> => {
    const nameFilter = buildArcGisUpperContainsFilter('ad', name, {
      uppercase: (value) => TextHelper.TurkishToUpper(value) ?? value.toUpperCase(),
    });
    return executeQuery(SERVICE_TITLES.street, {
      returnGeometry: true,
      orderByFields: Object.freeze(['ad']),
      where: nameFilter ?? '1=0',
      outFields: Object.freeze(['ad', 'id']),
    }, 'ad');
  },

  GetStreets: async (
    neighborhoodId: unknown,
  ): Promise<LegacyGisResult> => {
    const wayResult = await executeQuery(SERVICE_TITLES.streetCenterLineWay, {
      returnGeometry: false,
      outFields: Object.freeze(['id', 'yolortahatid']),
      where: buildArcGisEqualsFilter('mahalleid', neighborhoodId),
    });
    if (isLegacyGisFailure(wayResult)) return wayResult;

    const centerLineFilter = buildArcGisInFilter(
      'id',
      valuesFrom(wayResult, 'yolortahatid'),
    );
    if (!centerLineFilter) return emptyLegacyGisSuccess();

    return executeQuery(SERVICE_TITLES.streetCenterLine, {
      returnGeometry: false,
      orderByFields: Object.freeze(['ad']),
      returnDistinctValues: true,
      where: centerLineFilter,
      outFields: Object.freeze(['ad', 'yolid']),
    }, 'ad');
  },

  GetStreetCenterLines: async (
    streetId: unknown,
  ): Promise<readonly LegacyQueryDataItem[]> => {
    const result = await executeQuery(SERVICE_TITLES.streetCenterLine, {
      returnGeometry: true,
      orderByFields: Object.freeze(['ad']),
      where: buildArcGisEqualsFilter('yolid', streetId),
      outFields: Object.freeze(['ad', 'id', 'yolid']),
    }, 'ad');
    return legacyResultData(result);
  },

  GetStreetWaysofCenterLinesByCenterlineIDs: async (
    centerlineIDs: unknown,
  ): Promise<LegacyGisResult> => {
    const where = buildArcGisInFilter('yolortahatid', centerlineIDs);
    if (!where) return emptyLegacyGisSuccess();
    return executeQuery(SERVICE_TITLES.streetCenterLineWay, {
      returnGeometry: false,
      outFields: Object.freeze(['id']),
      where,
    });
  },

  GetDoorsByWayIDs: async (
    wayIDs: unknown,
  ): Promise<LegacyGisResult> => {
    const where = buildArcGisInFilter('yolortahatyonid', wayIDs);
    if (!where) return emptyLegacyGisSuccess();
    return executeQuery(SERVICE_TITLES.door, {
      returnGeometry: true,
      orderByFields: Object.freeze(['kapino']),
      outFields: Object.freeze(['id', 'kapino']),
      where,
    });
  },

  GetDoors: async (
    streetId: unknown,
  ): Promise<LegacyGisResult> => {
    const centerLines = await NumberingQueryBusiness.GetStreetCenterLines(streetId);
    const centerLineIds = centerLines
      .map((item) => legacyAttribute(item, 'id'))
      .filter(hasQueryIdentifier);
    if (centerLineIds.length === 0) return emptyLegacyGisSuccess();

    const wayResult = await NumberingQueryBusiness
      .GetStreetWaysofCenterLinesByCenterlineIDs(centerLineIds);
    if (isLegacyGisFailure(wayResult)) return wayResult;

    const wayIds = valuesFrom(wayResult, 'id');
    if (wayIds.length === 0) return emptyLegacyGisSuccess();
    return NumberingQueryBusiness.GetDoorsByWayIDs(wayIds);
  },

  GetDoorById: async (doorId: unknown): Promise<LegacyGisResult> =>
    executeQuery(SERVICE_TITLES.door, {
      returnGeometry: true,
      outFields: Object.freeze(['*']),
      where: buildArcGisEqualsFilter('id', doorId),
    }),

  IntersectBuildingsWithMapPoint: async (
    mapPoint: unknown,
  ): Promise<LegacyGisResult> => GisQueryHelper.ExecuteSpatialQuery(
    createOptions(SERVICE_TITLES.building, {
      geometry: mapPoint,
      distance: 1,
      units: 'meters',
      spatialRelationship: 'intersects',
      returnGeometry: true,
      outFields: Object.freeze(['*']),
    }),
  ),

  GetStructureInfoOfBuilding: async (
    building: unknown,
  ): Promise<LegacyGisResult> => executeQuery(SERVICE_TITLES.structure, {
    returnGeometry: true,
    outFields: Object.freeze(['*']),
    where: buildArcGisEqualsFilter('id', readEntityId(building)),
  }),

  GetNumberingInfoOfStructure: async (
    structure: unknown,
  ): Promise<LegacyGisResult> => executeQuery(SERVICE_TITLES.numberingInfo, {
    returnGeometry: true,
    outFields: Object.freeze(['*']),
    where: buildArcGisEqualsFilter('yapi_id', readEntityId(structure)),
  }),

  GetBuildingDocumentCategoryList: () => Object.freeze([
    Object.freeze({ Title: 'Betonarme Projesi', Id: 'betonarmeProjesi' }),
    Object.freeze({ Title: 'Elektrik Proje', Id: 'elektrikProje' }),
    Object.freeze({ Title: 'İnşaat Ruhsatı', Id: 'insaatRuhsati' }),
    Object.freeze({ Title: 'Isıtma Tesisat', Id: 'isitmaTesisat' }),
    Object.freeze({ Title: 'İskan Ruhsatı', Id: 'iskanRuhsati' }),
    Object.freeze({ Title: 'Sıhhi Tesisat', Id: 'sihhiTesisat' }),
    Object.freeze({ Title: 'Statik Proje', Id: 'statikProje' }),
  ]),

  GetBuildingDocumentList: async (
    building: unknown,
    category: unknown,
    callback?: LegacyCallback,
    options: FileRequestOptions = {},
  ): Promise<unknown> => {
    try {
      const result = await apiClient.get(
        '/Common/FileService.svc/GetBuildingDocuments',
        {
          ...fileRequestOptions(options),
          params: {
            buildingId: readEntityId(building),
            category: normalizeQueryText(category, 120),
          },
        },
      );
      return returnWithCallback(callback, result);
    } catch {
      return returnWithCallback(callback, null);
    }
  },

  GetBuildingPhotoList: async (
    building: unknown,
    callback?: LegacyCallback,
    options: FileRequestOptions = {},
  ): Promise<unknown> => {
    try {
      const result = await apiClient.get(
        '/Common/FileService.svc/GetBuildingPhotos',
        {
          ...fileRequestOptions(options),
          params: { buildingId: readEntityId(building) },
        },
      );
      return returnWithCallback(callback, result);
    } catch {
      return returnWithCallback(callback, null);
    }
  },
});
