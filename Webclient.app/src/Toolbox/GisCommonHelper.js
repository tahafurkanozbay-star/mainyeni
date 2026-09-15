import { loadModules } from "esri-loader";

export const GisDistanceUtils = {

    CalculateDistance: async (_point1, _point2) => {

        return new Promise((resolve, reject) => {

            loadModules(["esri/geometry/support/geodesicUtils"])
                .then(([geodesicUtils]) => {

                    var distanceUnits = "meters";
                    var distanceResult = geodesicUtils.geodesicDistance(_point1, _point2, distanceUnits);
                    distanceResult.distance = parseFloat(distanceResult.distance).toFixed(2);
                    resolve(distanceResult);

                });

        });
    }

};
