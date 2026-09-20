import { Constants_ServiceResultType } from '../Core/Constants';
import {
  businessApiRuntime,
  businessDiagnostics,
  businessQueryPlanner,
  businessQueryRuntime,
  businessServiceRegistry,
  compileRequiredPredicatePlan,
  equalsPredicate,
  inPredicate,
  normalizeIdentifierList,
  normalizeNumberingSearchQuery,
  normalizeScalar,
  readEntityIdentifier,
  upperContainsPredicate,
} from './runtime';

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
} as const);

export interface NumberingFeatureResult {
  readonly attr?: Record<string, unknown> | null;
  readonly geometry?: unknown;
}

export interface NumberingServiceResult {
  readonly type?: unknown;
  readonly data?: readonly NumberingFeatureResult[] | null;
  readonly fields?: unknown;
  readonly message?: unknown;
  readonly errorMessage?: unknown;
}

type ServiceResult = NumberingServiceResult;
type RecordWithAttr = NumberingFeatureResult;

export interface NumberingFileRequestOptions {
  readonly signal?: AbortSignal;
  readonly cacheTtlMs?: number;
  readonly timeoutMs?: number;
}

export type NumberingCallback<TResult> = ((value: TResult) => void) | null | undefined;

const emptyResult = (): NumberingServiceResult => Object.freeze({
  type: Constants_ServiceResultType.Success,
  data: Object.freeze([]) as readonly NumberingFeatureResult[],
  fields: Object.freeze([]),
});

const dataArray = (result: unknown): readonly RecordWithAttr[] => {
  if (!result || typeof result !== 'object') return Object.freeze([]);
  const data = (result as ServiceResult).data;
  if (!Array.isArray(data)) return Object.freeze([]);
  return Object.freeze(
    data.filter(
      (item): item is RecordWithAttr =>
        item !== null && typeof item === 'object' && !Array.isArray(item),
    ),
  );
};

const resultType = (result: unknown): number | null => {
  if (!result || typeof result !== 'object') return null;
  const raw = (result as ServiceResult).type;
  return Number.isFinite(raw) ? Number(raw) : null;
};

const fieldText = (
  item: RecordWithAttr,
  field: string,
): string => normalizeScalar(item.attr?.[field]);

const sortResultData = (
  result: unknown,
  field: string | null,
): NumberingServiceResult => {
  if (!field || !result || typeof result !== 'object') {
    return (result && typeof result === 'object' ? result : emptyResult()) as NumberingServiceResult;
  }
  const record = result as { data?: unknown };
  if (!Array.isArray(record.data)) return result as NumberingServiceResult;

  const sorted = [...record.data].sort((left, right) => {
    const leftRecord = left && typeof left === 'object'
      ? left as RecordWithAttr
      : {};
    const rightRecord = right && typeof right === 'object'
      ? right as RecordWithAttr
      : {};
    return fieldText(leftRecord, field).localeCompare(
      fieldText(rightRecord, field),
      'tr-TR',
      { sensitivity: 'base', numeric: true },
    );
  });

  return Object.freeze({
    ...(result as Readonly<Record<string, unknown>>),
    data: Object.freeze(sorted),
  });
};

const executeQuery = async (
  serviceKey: string,
  options: NumberingQueryOptions,
  sortField: string | null = null,
): Promise<NumberingServiceResult> => {
  const orderByFields = Array.isArray(options.orderByFields)
    ? options.orderByFields.filter((value): value is string => typeof value === 'string')
    : [];
  const outFields = Array.isArray(options.outFields)
    ? options.outFields.filter((value): value is string => typeof value === 'string')
    : ['*'];
  const where = typeof options.where === 'string' ? options.where : '1=1';
  const plan = businessQueryPlanner.plan({
    serviceKey,
    returnGeometry: options.returnGeometry === true,
    orderByFields,
    outFields,
    where,
    ...(options.geometry !== undefined
      ? {
        spatial: {
          geometry: options.geometry,
          distance: options.distance ?? options.distanceMeters ?? 0,
          units: 'meters',
          spatialRelationship: 'intersects',
        } as const,
      }
      : {}),
  });
  const rawResult = await businessQueryRuntime.execute(plan);
  const result: NumberingServiceResult = rawResult && typeof rawResult === 'object'
    ? rawResult as NumberingServiceResult
    : emptyResult();
  return sortResultData(result, sortField);
};

const callbackResult = <TResult>(
  callback: NumberingCallback<TResult>,
  value: TResult,
): TResult => {
  if (typeof callback === 'function') callback(value);
  return value;
};

const fileControl = (
  options: NumberingFileRequestOptions = {},
): Readonly<{
  signal?: AbortSignal;
  cacheTtlMs: number;
  timeoutMs?: number;
  cache: true;
  dedupe: boolean;
}> => Object.freeze({
  ...(options.signal ? { signal: options.signal } : {}),
  cacheTtlMs: options.cacheTtlMs ?? 30_000,
  ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  cache: true,
  dedupe: options.signal ? false : true,
});

const idsFrom = (
  result: unknown,
  field: string,
): readonly string[] => normalizeIdentifierList(
  dataArray(result).map(item => item.attr?.[field]),
).values;

const successData = (result: unknown): readonly RecordWithAttr[] =>
  dataArray(result);

export const NumberingQueryBusiness = Object.freeze({
  GetDistrictById: async (id: unknown): Promise<NumberingServiceResult> =>
    executeQuery(SERVICE_TITLES.district, {
      returnGeometry: true,
      orderByFields: ['ad'],
      outFields: ['*'],
      where: compileRequiredPredicatePlan([
        equalsPredicate('id', id),
      ], undefined, '1=0').where,
    }),

  GetDistricts: async (input: unknown = {}): Promise<NumberingServiceResult> => {
    const query = normalizeNumberingSearchQuery(input);
    return executeQuery(SERVICE_TITLES.district, {
      returnDistinctValues: true,
      returnGeometry: false,
      orderByFields: ['ad'],
      outFields: ['id', 'ad'],
      where: compileRequiredPredicatePlan([
        '1=1',
        upperContainsPredicate('ad', query.districtName),
      ]).where,
    }, 'ad');
  },

  GetNeighborhoodById: async (id: unknown): Promise<NumberingServiceResult> =>
    executeQuery(SERVICE_TITLES.neighborhood, {
      returnGeometry: true,
      orderByFields: ['ad'],
      outFields: ['*'],
      where: compileRequiredPredicatePlan([
        equalsPredicate('id', id),
      ], undefined, '1=0').where,
    }),

  GetAllNeighborhoods: async (input: unknown = {}): Promise<NumberingServiceResult> => {
    const query = normalizeNumberingSearchQuery(input);
    return executeQuery(SERVICE_TITLES.neighborhood, {
      returnDistinctValues: true,
      returnGeometry: false,
      orderByFields: ['ad'],
      outFields: ['id', 'ad'],
      where: compileRequiredPredicatePlan([
        '1=1',
        upperContainsPredicate('ad', query.neighborhoodName),
      ]).where,
    }, 'ad');
  },

  GetNeighborhoodsOfDistrict: async (districtId: unknown): Promise<NumberingServiceResult> =>
    executeQuery(SERVICE_TITLES.neighborhood, {
      returnGeometry: true,
      orderByFields: ['ad'],
      outFields: ['*'],
      where: compileRequiredPredicatePlan([
        equalsPredicate('ilceid', districtId),
      ], undefined, '1=0').where,
    }, 'ad'),

  GetStreetsByName: async (name: unknown): Promise<NumberingServiceResult> =>
    executeQuery(SERVICE_TITLES.street, {
      returnGeometry: true,
      orderByFields: ['ad'],
      outFields: ['ad', 'id'],
      where: upperContainsPredicate('ad', name) ?? '1=0',
    }, 'ad'),

  GetStreets: async (neighborhoodId: unknown): Promise<NumberingServiceResult> => {
    const wayResult = await executeQuery(SERVICE_TITLES.streetCenterLineWay, {
      returnGeometry: false,
      outFields: ['id', 'yolortahatid'],
      where: compileRequiredPredicatePlan([
        equalsPredicate('mahalleid', neighborhoodId),
      ], undefined, '1=0').where,
    });

    if (resultType(wayResult) === Constants_ServiceResultType.Error) return wayResult;

    const centerLineIds = idsFrom(wayResult, 'yolortahatid');
    const where = inPredicate('id', centerLineIds);
    if (!where) return emptyResult();

    return executeQuery(SERVICE_TITLES.streetCenterLine, {
      returnGeometry: false,
      orderByFields: ['ad'],
      returnDistinctValues: true,
      where,
      outFields: ['ad', 'yolid'],
    }, 'ad');
  },

  GetStreetCenterLines: async (
    streetId: unknown,
  ): Promise<readonly RecordWithAttr[]> => {
    const result = await executeQuery(SERVICE_TITLES.streetCenterLine, {
      returnGeometry: true,
      orderByFields: ['ad'],
      where: compileRequiredPredicatePlan([
        equalsPredicate('yolid', streetId),
      ], undefined, '1=0').where,
      outFields: ['ad', 'id', 'yolid'],
    }, 'ad');
    return successData(result);
  },

  GetStreetWaysofCenterLinesByCenterlineIDs: async (
    centerlineIds: unknown,
  ): Promise<NumberingServiceResult> => {
    const where = inPredicate('yolortahatid', centerlineIds);
    if (!where) return emptyResult();
    return executeQuery(SERVICE_TITLES.streetCenterLineWay, {
      returnGeometry: false,
      outFields: ['id'],
      where,
    });
  },

  GetDoorsByWayIDs: async (wayIds: unknown): Promise<NumberingServiceResult> => {
    const where = inPredicate('yolortahatyonid', wayIds);
    if (!where) return emptyResult();
    return executeQuery(SERVICE_TITLES.door, {
      returnGeometry: true,
      orderByFields: ['kapino'],
      outFields: ['id', 'kapino'],
      where,
    });
  },

  GetDoors: async (streetId: unknown): Promise<NumberingServiceResult> => {
    const centerLines = await NumberingQueryBusiness.GetStreetCenterLines(streetId);
    const centerLineIds = normalizeIdentifierList(
      centerLines.map(item => item.attr?.id),
    ).values;
    if (centerLineIds.length === 0) return emptyResult();

    const wayResult =
      await NumberingQueryBusiness.GetStreetWaysofCenterLinesByCenterlineIDs(
        centerLineIds,
      );
    if (resultType(wayResult) === Constants_ServiceResultType.Error) return wayResult;

    const wayIds = idsFrom(wayResult, 'id');
    if (wayIds.length === 0) return emptyResult();
    return NumberingQueryBusiness.GetDoorsByWayIDs(wayIds);
  },

  GetDoorById: async (doorId: unknown): Promise<NumberingServiceResult> =>
    executeQuery(SERVICE_TITLES.door, {
      returnGeometry: true,
      outFields: ['*'],
      where: compileRequiredPredicatePlan([
        equalsPredicate('id', doorId),
      ], undefined, '1=0').where,
    }),

  IntersectBuildingsWithMapPoint: async (
    mapPoint: unknown,
  ): Promise<NumberingServiceResult> =>
    executeQuery(SERVICE_TITLES.building, {
      geometry: mapPoint,
      distanceMeters: 1,
      units: 'meters',
      spatialRelationship: 'intersects',
      returnGeometry: true,
      outFields: ['*'],
      where: '1=1',
    }),

  GetStructureInfoOfBuilding: async (
    building: unknown,
  ): Promise<NumberingServiceResult> =>
    executeQuery(SERVICE_TITLES.structure, {
      returnGeometry: true,
      outFields: ['*'],
      where: compileRequiredPredicatePlan([
        equalsPredicate('id', readEntityIdentifier(building)),
      ], undefined, '1=0').where,
    }),

  GetNumberingInfoOfStructure: async (
    structure: unknown,
  ): Promise<NumberingServiceResult> =>
    executeQuery(SERVICE_TITLES.numberingInfo, {
      returnGeometry: true,
      outFields: ['*'],
      where: compileRequiredPredicatePlan([
        equalsPredicate('yapi_id', readEntityIdentifier(structure)),
      ], undefined, '1=0').where,
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

  GetBuildingDocumentList: async <TResult = unknown>(
    building: unknown,
    category: unknown,
    callback?: NumberingCallback<TResult | null>,
    options: NumberingFileRequestOptions = {},
  ): Promise<TResult | null> => {
    const operation = 'business.numbering.documents';
    try {
      const result = await businessApiRuntime.get<TResult>(
        operation,
        '/Common/FileService.svc/GetBuildingDocuments',
        {
          params: {
            buildingId: readEntityIdentifier(building),
            category: normalizeScalar(category),
          },
          control: fileControl(options),
        },
      );
      return callbackResult(callback, result);
    } catch (error) {
      businessDiagnostics.record(operation, 'failure', {
        code: error instanceof Error ? error.name : 'FILE_REQUEST_FAILED',
      });
      return callbackResult(callback, null);
    }
  },

  GetBuildingPhotoList: async <TResult = unknown>(
    building: unknown,
    callback?: NumberingCallback<TResult | null>,
    options: NumberingFileRequestOptions = {},
  ): Promise<TResult | null> => {
    const operation = 'business.numbering.photos';
    try {
      const result = await businessApiRuntime.get<TResult>(
        operation,
        '/Common/FileService.svc/GetBuildingPhotos',
        {
          params: {
            buildingId: readEntityIdentifier(building),
          },
          control: fileControl(options),
        },
      );
      return callbackResult(callback, result);
    } catch (error) {
      businessDiagnostics.record(operation, 'failure', {
        code: error instanceof Error ? error.name : 'FILE_REQUEST_FAILED',
      });
      return callbackResult(callback, null);
    }
  },

  GetServiceUrl: (serviceKey: string): string =>
    businessServiceRegistry.requireUrl(serviceKey),
});
