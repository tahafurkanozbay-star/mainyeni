import { loadArcgisModule } from "../gis-engine/arcgisModuleRuntime";

const GEODESIC_UTILS_MODULE_ID = "esri/geometry/support/geodesicUtils";

export const GisDistanceUtils = {

    CalculateDistance: async (_point1, _point2) => {
        const geodesicUtils = await loadArcgisModule(GEODESIC_UTILS_MODULE_ID);
        const distanceUnits = "meters";
        const distanceResult = geodesicUtils.geodesicDistance(_point1, _point2, distanceUnits);
        distanceResult.distance = parseFloat(distanceResult.distance).toFixed(2);
        return distanceResult;
    }

};