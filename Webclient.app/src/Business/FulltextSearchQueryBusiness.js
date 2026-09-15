import { Constants_ServiceResultType } from "../Core/Constants";
import MapManager from "../Store/Managers/MapManager";
import { ArrayHelper } from "../Toolbox/ArrayHelper";
import { GisQueryHelper } from "../Toolbox/GisQueryHelper";
import { IsNull } from "../Toolbox/ObjectHelper";
import { TextHelper } from "../Toolbox/TextHelper";
import { CommonBusiness } from "./CommonBusiness";

export const FulltextSearchQueryBusiness = {

    QueryService:async(_configService, _query, _returnGeometry)=>{

        return new Promise((resolve, reject)=>{

            let options = {
                url: CommonBusiness.GenerateUrl(_configService),
                returnGeometry: _returnGeometry ?? false,
                orderByFields: ["adi"],
                outFields: ["*"]
            };

            let where = "1=1";
            if (!IsNull(_query.searchText)) {
                where += " AND ("
                +" LOWER(adi) LIKE '%" + TextHelper.TurkishToLower(_query.searchText) + "%'"
                +" OR LOWER(adi) LIKE '%" + TextHelper.RemoveTurkishChars(TextHelper.TurkishToLower(_query.searchText)) + "%'"
                +")";
            }


            if (_query.showNearby) {
                options.geometry = _query.userLocation;
                options.distance = _query.bufferDistance * 100;
                options.units = 'meters';
                options.spatialRelationship = 'intersects';
                options.where = where;

                GisQueryHelper.ExecuteSpatialQuery(options).then(_result  => {
                    resolve({
                        Title: _configService.searchCategoryTitle,
                        Data: _result.data
                    })
                });

            }
            else {

                /*
                if (_query != null) {
    
                    if (!IsNull(_query.districtId)) {
                        where += " AND ILCEID = '" + _query.districtId+"'";
                    }
    
                    if (!IsNull(_query.nbhoodId)) {
                        where += " AND MAHALLEID = '" + _query.nbhoodId+"'";
                    }

                    if (!IsNull(_query.Id)) {
                        where += " AND ID = '" + _query.Id+"'";
                    }
                }
                */

                options.where = where;

                GisQueryHelper.ExecuteQuery(options).then(_result => {
                    resolve({
                        Title: _configService.searchCategoryTitle,
                        Data: _result.data
                    })
                });
            }

         

        });

    },


    Search: async (_query, _returnGeometry) => {

        return new Promise((resolve, reject) => {

            const queryServiceTitle = "FullTextSearchQueryUrl";
            let queryService = ArrayHelper.Find(MapManager.GetConfigurationServices(), "title", queryServiceTitle);
            if (queryService == null) {
                reject({ type: Constants_ServiceResultType.Error, message: "Servis bulunamadı (" + queryServiceTitle + ")" })
            };

            let options = {
                url: CommonBusiness.GenerateUrl(queryService),
                returnGeometry: _returnGeometry ?? false,
                orderByFields: ["adi"],
                outFields: ["*"]
            };

            let where = "1=1";
            if (!IsNull(_query.searchText)) {
                where += " AND ("
                    + " LOWER(adi) LIKE '%" + TextHelper.TurkishToLower(_query.searchText) + "%'"
                    + " OR LOWER(adi) LIKE '%" + TextHelper.RemoveTurkishChars(TextHelper.TurkishToLower(_query.searchText)) + "%'"
                    + ")";
            }


            if (_query.showNearby) {
                options.geometry = _query.userLocation;
                options.distance = _query.bufferDistance * 100;
                options.units = 'meters';
                options.spatialRelationship = 'intersects';
                options.where = where;

                GisQueryHelper.ExecuteSpatialQuery(options).then(_result => {
                    resolve(_result)
                });

            }
            else {

                if (_query != null) {

                    if (!IsNull(_query.districtId)) {
                        where += " AND ilceid = '" + _query.districtId + "'";
                    }

                    if (!IsNull(_query.nbhoodId)) {
                        where += " AND mahalleid = '" + _query.nbhoodId + "'";
                    }

                    if (!IsNull(_query.Id)) {
                        where += " AND id = " + _query.Id;
                    }
                }


                options.where = where;

                GisQueryHelper.ExecuteQuery(options).then(_result => {
                    resolve(_result)
                });
            }


        });

    }
}