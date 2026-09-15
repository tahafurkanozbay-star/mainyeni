import { Constants_ServiceResultType } from "../Core/Constants";
import MapManager from "../Store/Managers/MapManager";
import { ArrayHelper } from "../Toolbox/ArrayHelper";
import { GisQueryHelper } from "../Toolbox/GisQueryHelper";
import { IsNull } from "../Toolbox/ObjectHelper";
import { TextHelper } from "../Toolbox/TextHelper";
import { CommonBusiness } from "./CommonBusiness";
import { loadModules } from "esri-loader";

export const FastAccessQueryBusiness = {
    
    QueryFastAccessService: async (_queryServiceTitle, _query, _returnGeometry) => {
         
        return new Promise((resolve, reject) => {


            let queryService = ArrayHelper.Find(MapManager.GetConfigurationServices(), "title", _queryServiceTitle);
            
            if (queryService == null) {
                reject({ type: Constants_ServiceResultType.Error, message: "Servis bulunamadı (" + _queryServiceTitle + ")" })
            };



             




            let options = {
                url: CommonBusiness.GenerateUrl(queryService),
                returnGeometry: _returnGeometry ?? false,
                orderByFields: ["adi"],
                outFields: ["*"]
            };

            let where = "1=1";
         
            if (_query != null) {   


                if (!IsNull(_query.ObjectId)) {
                    where += " AND ObjectId =" + _query.ObjectId;
                }

                if (!IsNull(_query.name)) {
                    where += " AND "
                    +"(UPPER(adi) LIKE '%" + TextHelper.RemoveTurkishChars(TextHelper.TurkishToUpper(_query.name)) + "%'"
                    +" OR UPPER(adi) LIKE '%" + TextHelper.TurkishToUpper(_query.name) + "%' )";
                }
            }
            

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

                GisQueryHelper.ExecuteQuery(options).then(results => {
                    resolve(results);
                });
            }
           


            
        });
      

    }


};