import { Constants_ServiceResultType } from "../Core/Constants";
import MapManager from "../Store/Managers/MapManager";
import { ArrayHelper } from "../Toolbox/ArrayHelper";
import { GisQueryHelper } from "../Toolbox/GisQueryHelper";
import { IsNull } from "../Toolbox/ObjectHelper";
import { TextHelper } from "../Toolbox/TextHelper";
import { CommonBusiness } from "./CommonBusiness";

export const TransitRouteQueryBusiness={

    Query:async(_query, _returnGeometry)=>{

        return new Promise((resolve, reject) => {

            const queryServiceTitle="TransitRouteQueryUrl";
            let queryService = ArrayHelper.Find(MapManager.GetConfigurationServices(), "title", queryServiceTitle);
            if (queryService == null) {
                reject({ type: Constants_ServiceResultType.Error, message: "Servis bulunamadı (" + queryServiceTitle + ")" })
            };

            let options = {
                url: CommonBusiness.GenerateUrl(queryService),
                returnGeometry: _returnGeometry ?? false,
                orderByFields: ["id"],
                outFields: ["*"]
            };

            let where = "1=1";


            if (_query.showNearby) {
                options.geometry = _query.userLocation;
                options.distance = _query.bufferDistance * 100;
                options.units = 'meters';
                options.spatialRelationship = 'intersects';
                options.where = where;

                GisQueryHelper.ExecuteSpatialQuery(options).then(results  => {
                    resolve(results);
                });

            }
            else {

                options.where = where;
                if (_query != null) {

                    if (!IsNull(_query.name)) {
                        options.where += " AND UPPER(id) LIKE '%" + TextHelper.TurkishToUpper(_query.name) + "%'";
                    }
    
                    if (!IsNull(_query.districtId)) {
                        options.where += " AND ilceid = '" + _query.districtId+"'";
                    }
    
                    if (!IsNull(_query.nbhoodId)) {
                        options.where += " AND mahalleid = '" + _query.nbhoodId+"'";
                    }

                    if (!IsNull(_query.Id)) {
                        options.where += " AND id = '" + _query.Id+"'";
                    }
                }

                GisQueryHelper.ExecuteQuery(options).then(results => {
                    resolve(results);
                });
            }


        });

    }
}