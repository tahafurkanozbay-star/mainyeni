import { AppConfig } from '../Core/AppConfig';
import { loadArcgisModule } from '../gis-engine/arcgisModuleRuntime';
import { AuthBusiness } from './AuthBusiness';
import { HttpBusiness } from './HttpBusiness';
import {
  asReadonlyRecord,
  businessDiagnostics,
  normalizeGeographicPoint,
  normalizeLegacyIdentifier,
  normalizeTkgmParcelQuery,
  readFeatureArray,
} from './runtime';

interface PolygonGeometryLike {
  readonly rings?: readonly (readonly (readonly number[])[])[];
}

interface WebMercatorUtilsLike {
  readonly webMercatorToGeographic: (geometry: unknown) => PolygonGeometryLike;
}

const DIRECT_TKGM_PARCEL_BASE = 'https://cbsapi.tkgm.gov.tr/megsiswebapi.v3/api/parsel';
const MAX_POLYGON_POINTS = 5_000;

const recordFailure = (
  operation: string,
  error: unknown,
): void => {
  businessDiagnostics.record(operation, 'failure', {
    code: error instanceof Error ? error.name : 'TKGM_ERROR',
  });
};

const normalizeTkgmPayload = (payload: unknown): unknown => {
  if (typeof payload !== 'string') return payload;
  const text = payload.trim();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    businessDiagnostics.record('business.tkgm.parse', 'failure', {
      code: error instanceof Error ? error.name : 'JSON_PARSE_ERROR',
    });
    return null;
  }
};

const getAuthenticatedTkgmResource = async (
  path: string,
): Promise<unknown> => {
  const headers = await AuthBusiness.GetRequestHeaders();
  const payload = await HttpBusiness.Get<unknown>(
    `${AppConfig.Api.BaseUrl}${path}`,
    { headers },
  );
  return normalizeTkgmPayload(payload);
};

const encodedIdentifier = (
  value: unknown,
): string | null => {
  const normalized = normalizeLegacyIdentifier(value);
  return normalized ? encodeURIComponent(normalized.value) : null;
};

const polygonText = (
  geometry: PolygonGeometryLike,
): string | null => {
  const firstRing = geometry.rings?.[0];
  if (!Array.isArray(firstRing) || firstRing.length < 3) return null;

  const points: string[] = [];
  for (const point of firstRing.slice(0, MAX_POLYGON_POINTS)) {
    if (!Array.isArray(point) || point.length < 2) continue;
    const x = Number(point[0]);
    const y = Number(point[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    points.push(`${x.toFixed(6)} ${y.toFixed(6)}`);
  }
  return points.length >= 3 ? points.join(',') : null;
};

export const TkgmQueryBusiness = Object.freeze({
  GetDistricts: async (cityId: unknown): Promise<readonly Readonly<Record<string, unknown>>[] | null> => {
    const id = encodedIdentifier(cityId);
    if (!id) return null;
    const operation = 'business.tkgm.districts';
    try {
      const data = await getAuthenticatedTkgmResource(`/Gis/Tkgm/Districts/${id}`);
      businessDiagnostics.record(operation, 'success');
      return readFeatureArray(data);
    } catch (error) {
      recordFailure(operation, error);
      return null;
    }
  },

  GetNeighborhoodsOfDistrict: async (
    districtId: unknown,
  ): Promise<readonly Readonly<Record<string, unknown>>[] | null> => {
    const id = encodedIdentifier(districtId);
    if (!id) return null;
    const operation = 'business.tkgm.neighborhoods';
    try {
      const data = await getAuthenticatedTkgmResource(`/Gis/Tkgm/Nbhoods/${id}`);
      businessDiagnostics.record(operation, 'success');
      return readFeatureArray(data);
    } catch (error) {
      recordFailure(operation, error);
      return null;
    }
  },

  GetParcels: async (input: unknown): Promise<unknown> => {
    const operation = 'business.tkgm.parcels';
    try {
      const query = normalizeTkgmParcelQuery(input);
      const path = [
        '/Gis/Tkgm/Parcel',
        encodeURIComponent(query.district),
        encodeURIComponent(query.neighborhood),
        encodeURIComponent(query.cityBlock),
        encodeURIComponent(query.parcel),
      ].join('/');
      const result = await getAuthenticatedTkgmResource(path);
      businessDiagnostics.record(operation, 'success');
      return result;
    } catch (error) {
      recordFailure(operation, error);
      return null;
    }
  },

  GetParcelInfo: async (
    neighborhoodId: unknown,
    cityBlockNo: unknown,
    parcelNo: unknown,
  ): Promise<unknown> => {
    const neighborhood = normalizeLegacyIdentifier(neighborhoodId)?.value ?? null;
    const cityBlock = normalizeLegacyIdentifier(cityBlockNo)?.value ?? '0';
    const parcel = normalizeLegacyIdentifier(parcelNo)?.value ?? null;
    if (!neighborhood && cityBlock === '0' && !parcel) return null;

    const operation = 'business.tkgm.parcel-info';
    try {
      const result = await HttpBusiness.Get<unknown>(
        `${AppConfig.Api.BaseUrl}/Tkgm/TkgmServicev2.svc/GetParcelInfo`,
        {
          params: {
            mahalleId: neighborhood,
            adaNo: cityBlock,
            parselNo: parcel,
          },
        },
      );
      businessDiagnostics.record(operation, 'success');
      return result;
    } catch (error) {
      recordFailure(operation, error);
      return null;
    }
  },

  IntersectMapPointWithTkgmParcel: async (
    pointInput: unknown,
  ): Promise<unknown> => {
    const point = normalizeGeographicPoint(pointInput);
    if (!point) return null;

    const operation = 'business.tkgm.point-intersection';
    try {
      const result = await HttpBusiness.Get<unknown>(
        `${DIRECT_TKGM_PARCEL_BASE}/${point.latitude}/${point.longitude}`,
      );
      businessDiagnostics.record(operation, 'success');
      return result;
    } catch (error) {
      recordFailure(operation, error);
      return null;
    }
  },

  IntersectMapPolygonWithTkgmParcel: async (
    geometryInput: unknown,
  ): Promise<unknown> => {
    const operation = 'business.tkgm.polygon-intersection';
    try {
      const module = await loadArcgisModule(
        'esri/geometry/support/webMercatorUtils',
      ) as WebMercatorUtilsLike;
      const geographic = module.webMercatorToGeographic(geometryInput);
      const polygon = polygonText(geographic);
      if (!polygon) {
        businessDiagnostics.record(operation, 'rejected', {
          code: 'INVALID_POLYGON',
        });
        return null;
      }

      const result = await HttpBusiness.Get<unknown>(
        `${AppConfig.Api.BaseUrl}/Tkgm/TkgmServicev2.svc/GetParcelsInPolygon`,
        {
          params: {
            polygon,
            pasifleriGoster: true,
          },
        },
      );
      businessDiagnostics.record(operation, 'success');
      return result;
    } catch (error) {
      recordFailure(operation, error);
      return null;
    }
  },

  ReadPayloadRecord: (value: unknown): Readonly<Record<string, unknown>> =>
    asReadonlyRecord(normalizeTkgmPayload(value)),
});
