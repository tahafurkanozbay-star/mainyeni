import { loadArcgisModule } from '../gis-engine/arcgisModuleRuntime';
import type { ArcGisGeometryLike } from '../gis-engine/contracts';

const GEODESIC_UTILS_MODULE_ID = 'esri/geometry/support/geodesicUtils';
const DISTANCE_UNITS = 'meters';

interface RawDistanceResult {
  readonly distance: string | number;
  readonly [key: string]: unknown;
}
interface GeodesicUtilsModule {
  readonly geodesicDistance: (
    point1: ArcGisGeometryLike,
    point2: ArcGisGeometryLike,
    units: typeof DISTANCE_UNITS,
  ) => RawDistanceResult;
}
export interface GisDistanceResult extends Omit<RawDistanceResult, 'distance'> {
  readonly distance: string;
}

export const normalizeDistanceResult = (result: RawDistanceResult): GisDistanceResult => {
  const parsed = Number.parseFloat(String(result.distance));
  if (!Number.isFinite(parsed)) throw new TypeError('ArcGIS geodesic distance must be finite.');
  return Object.freeze({ ...result, distance: parsed.toFixed(2) });
};

export const GisDistanceUtils = Object.freeze({
  async CalculateDistance(point1: ArcGisGeometryLike, point2: ArcGisGeometryLike): Promise<GisDistanceResult> {
    const module = await loadArcgisModule<GeodesicUtilsModule>(GEODESIC_UTILS_MODULE_ID);
    return normalizeDistanceResult(module.geodesicDistance(point1, point2, DISTANCE_UNITS));
  },
});
