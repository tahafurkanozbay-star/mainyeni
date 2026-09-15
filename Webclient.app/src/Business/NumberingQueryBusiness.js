import { AppConfig } from "../Core/AppConfig";
import { ArrayHelper } from '../Toolbox/ArrayHelper';
import { GisQueryHelper } from "../Toolbox/GisQueryHelper";
import axios from 'axios';
import { CommonBusiness } from './CommonBusiness';
import { TextHelper } from "../Toolbox/TextHelper";
import MapManager from "../Store/Managers/MapManager";
import { Constants_ServiceResultType } from "../Core/Constants";

export const NumberingQueryBusiness = {

    GetDistrictById: async (_id) => {

        return new Promise((resolve, reject) => {

            let servicetitle = "NumberingDistrictQueryUrl";
            let queryService = ArrayHelper.Find(MapManager.GetConfigurationServices(), "title", servicetitle);
            if (queryService == null) {
                reject({ type: Constants_ServiceResultType.Error, message: "Servis bulunamadı (" + servicetitle + ")" })
            };

            let options = {
                returnDistinctValues: false,
                url: CommonBusiness.GenerateUrl(queryService),
                returnGeometry: true,
                orderByFields: ["ad"],
                outFields: ["*"],
                where: "id='" + _id + "'"
            };

            GisQueryHelper.ExecuteQuery(options).then(results => {
                resolve(results);
            });

        });
    },

    GetDistricts: async (_query) => {

        return new Promise((resolve, reject) => {

            let servicetitle = "NumberingDistrictQueryUrl";
            let queryService = ArrayHelper.Find(MapManager.GetConfigurationServices(), "title", servicetitle);
            if (queryService == null) {
                reject({ type: Constants_ServiceResultType.Error, message: "Servis bulunamadı (" + servicetitle + ")" })
            };

            let options = {
                returnDistinctValues: true,
                url: CommonBusiness.GenerateUrl(queryService),
                returnGeometry: false,
                orderByFields: ["ad"],
                outFields: ["id", "ad"],
                where: "1=1"
            };

            if (_query != null) {

                if (_query.DistrictName != null) {
                    options.where += " AND UPPER(ad) LIKE '%" + TextHelper.TurkishToUpper(_query.DistrictName) + "%'";
                }
            }


            GisQueryHelper.ExecuteQuery(options).then(results => {


                if (results == null) {
                    reject({ type: Constants_ServiceResultType.Error, message: "Sonuç bulunamadı" })
                }
                else {
                    results?.data?.sort((a, b) => ArrayHelper.OrderByTurkish(a.attr, b.attr, "ad"));

                    resolve(results);

                }


            });

        });
    },

    /* Mahalle Sorgulama*/
    GetNeighborhoodById: async (_id) => {

        return new Promise((resolve, reject) => {

            let servicetitle = "NumberingNeighborhoodQueryUrl";
            let queryService = ArrayHelper.Find(MapManager.GetConfigurationServices(), "title", servicetitle);
            if (queryService == null) {
                reject({ type: Constants_ServiceResultType.Error, message: "Servis bulunamadı (" + servicetitle + ")" })
            };

            let options = {
                returnDistinctValues: false,
                url: CommonBusiness.GenerateUrl(queryService),
                returnGeometry: true,
                orderByFields: ["ad"],
                outFields: ["*"],
                where: "id='" + _id + "'"
            };
            GisQueryHelper.ExecuteQuery(options).then(results => {
                resolve(results);
            });

        });
    },

    GetAllNeighborhoods: async (_query) => {

        return new Promise((resolve, reject) => {

            let servicetitle = "NumberingNeighborhoodQueryUrl";
            let queryService = ArrayHelper.Find(MapManager.GetConfigurationServices(), "title", servicetitle);
            if (queryService == null) {
                reject({ type: Constants_ServiceResultType.Error, message: "Servis bulunamadı (" + servicetitle + ")" })
            };

            let options = {
                returnDistinctValues: true,
                url: CommonBusiness.GenerateUrl(queryService),
                returnGeometry: false,
                orderByFields: ["ad"],
                outFields: ["id", "ad"],
                where: "1=1"
            };

            if (_query != null) {

                if (_query.NeighborhoodName != null) {
                    options.where += " AND UPPER(ad) LIKE '%" + TextHelper.TurkishToUpper(_query.NeighborhoodName) + "%'";
                }
            }

            GisQueryHelper.ExecuteQuery(options).then(results => {
                if (results == null) {
                    reject({ type: Constants_ServiceResultType.Error, message: "Sonuç bulunamadı" })
                }
                else {
                    results?.data?.sort((a, b) => ArrayHelper.OrderByTurkish(a.attr, b.attr, "ad"));

                    resolve(results);

                }

            });


        });
    },

    /* Mahalle Sorgulama*/
    GetNeighborhoodsOfDistrict: (_districtId) => {

        return new Promise((resolve, reject) => {

            let servicetitle = "NumberingNeighborhoodQueryUrl";
            let queryService = ArrayHelper.Find(MapManager.GetConfigurationServices(), "title", servicetitle);
            if (queryService == null) {
                reject({ type: Constants_ServiceResultType.Error, message: "Servis bulunamadı (" + servicetitle + ")" })
            };

            let options = {
                url: CommonBusiness.GenerateUrl(queryService),
                returnGeometry: true,
                orderByFields: ["ad"],
                outFields: ["*"],
                where: "ilceid='" + _districtId + "'"
            };

            return GisQueryHelper.ExecuteQuery(options).then(_results => {

                if (_results == null) {
                    reject({ type: Constants_ServiceResultType.Error, message: "Sonuç bulunamadı" })
                }
                else {
                    _results?.data?.sort((a, b) => ArrayHelper.OrderByTurkish(a.attr, b.attr, "ad"));

                    resolve(_results);

                }

            });


        });

    },



    GetStreetsByName: async (_name) => {

        return new Promise((resolve, reject) => {


            let servicetitle = "StreetQueryUrl";
            let queryService = ArrayHelper.Find(MapManager.GetConfigurationServices(), "title", servicetitle);
            if (queryService == null) {
                reject({ type: Constants_ServiceResultType.Error, message: "Servis bulunamadı (" + servicetitle + ")" })
            };

            let options = {
                url: CommonBusiness.GenerateUrl(queryService),
                returnGeometry: true,
                orderByFields: ["ad"],
                where: "UPPER(ad) LIKE '%" + TextHelper.TurkishToUpper(_name) + "%'",
                outFields: ["ad", "id"]
            };

            //Yol orta hat sorgulaması
            GisQueryHelper.ExecuteQuery(options).then(_results => {

                if(_results!=null && Array.isArray(_results)){
                    _results?.sort((a, b) => ArrayHelper.OrderByTurkish(a.attr, b.attr, "ad"));
                }
                
                resolve(_results);
            });

        });

    },


    /* Cadde sokak sorgulama */
    GetStreets: async (_neighborhoodId) => {

        return new Promise((resolve, reject) => {

            try {
                let streetCenterLineWay_QueryService = ArrayHelper.Find(MapManager.GetConfigurationServices(), "title", "StreetCenterLineWayUrl");
                let streetCenterLine_QueryService = ArrayHelper.Find(MapManager.GetConfigurationServices(), "title", "StreetCenterLineUrl");

                let where = " mahalleid='" + _neighborhoodId + "'";

                let wayQueryOptions = {
                    url: CommonBusiness.GenerateUrl(streetCenterLineWay_QueryService),
                    returnGeometry: false,
                    outFields: ["id", "yolortahatid"],
                    where: where
                };

                //Yol orta hat yön sorgulaması
                GisQueryHelper.ExecuteQuery(wayQueryOptions).then(wayResult => {

                    let reducedCenterLineResults = wayResult.data?.map(x => "'" + x.attr.yolortahatid + "'");
                    let reducedCenterLineResultsStr = reducedCenterLineResults.join(",");

                    let centerLineQueryOptions = {
                        url: CommonBusiness.GenerateUrl(streetCenterLine_QueryService),
                        returnGeometry: false,
                        orderByFields: ["ad"],
                        returnDistinctValues: true,
                        where: "id IN (" + reducedCenterLineResultsStr + ")",
                        outFields: ["ad", "yolid"]
                    };

                    //Yol orta hat sorgulaması
                    GisQueryHelper.ExecuteQuery(centerLineQueryOptions).then(_results => {

                        if (_results == null) {
                            reject({ type: Constants_ServiceResultType.Error, message: "Sonuç bulunamadı" })
                        }
                        else {
                            _results?.data?.sort((a, b) => ArrayHelper.OrderByTurkish(a.attr, b.attr, "ad"));

                            resolve(_results);

                        }

                    });

                });
            } catch (error) {
                console.log(error);
                resolve(null);
            }

        });


    },

    /*Yollara ait orta hatları getirir*/
    GetStreetCenterLines: async (_streetId) => {

        return new Promise((resolve, reject) => {

            let servicetitle = "StreetCenterLineUrl";
            let queryService = ArrayHelper.Find(MapManager.GetConfigurationServices(), "title", servicetitle);
            if (queryService == null) {
                reject({ type: Constants_ServiceResultType.Error, message: "Servis bulunamadı (" + servicetitle + ")" })
            };

            let queryOptions = {
                url: CommonBusiness.GenerateUrl(queryService),
                returnGeometry: true,
                orderByFields: ["ad"],
                where: "yolid='" + _streetId + "'",
                outFields: ["ad", "id", "yolid"]
            };

            //Yol orta hat sorgulaması
            GisQueryHelper.ExecuteQuery(queryOptions).then(queryResult => {

                queryResult.data.sort((a, b) => ArrayHelper.OrderByTurkish(a.attr, b.attr, "ad"));
                resolve(queryResult.data);

            });
        });

    },

    /*Yol orta hatlara ait yolortahat yönleri getirir*/
    GetStreetWaysofCenterLinesByCenterlineIDs: async (_centerlineIDs) => {

        return new Promise((resolve, reject) => {

            let servicetitle = "StreetCenterLineWayUrl";
            let queryService = ArrayHelper.Find(MapManager.GetConfigurationServices(), "title", servicetitle);
            if (queryService == null) {
                reject({ type: Constants_ServiceResultType.Error, message: "Servis bulunamadı (" + servicetitle + ")" })
            };


            let queryOptions = {
                url: CommonBusiness.GenerateUrl(queryService),
                returnGeometry: false,
                outFields: ["id"],
                where: "yolortahatid IN (" + _centerlineIDs + ")"
            }
            GisQueryHelper.ExecuteQuery(queryOptions).then(queryResults => {
                resolve(queryResults);
            });

        });
    },

    /* yol orta hat yön id lere göre kapıları getirir*/
    GetDoorsByWayIDs: async (_wayIDs) => {


        return new Promise((resolve, reject) => {

            let servicetitle = "DoorQueryUrl";
            let queryService = ArrayHelper.Find(MapManager.GetConfigurationServices(), "title", servicetitle);
            if (queryService == null) {
                reject({ type: Constants_ServiceResultType.Error, message: "Servis bulunamadı (" + servicetitle + ")" })
            };
            let queryOptions = {
                url: CommonBusiness.GenerateUrl(queryService),
                returnGeometry: true,
                orderByFields: "kapino",
                outFields: ["id", "kapino"],
                where: "yolortahatyonid IN (" + _wayIDs + ")"
            }

            GisQueryHelper.ExecuteQuery(queryOptions).then(queryResults => {
                resolve(queryResults);
            });

        });


    },

    /* Kapı sorgulama */
    GetDoors: async (_streetId) => {

        return new Promise((resolve, reject) => {

            NumberingQueryBusiness.GetStreetCenterLines(_streetId).then(centerLinesResult => {


                if (centerLinesResult != null) {

                    let centerlineIDs = centerLinesResult?.map(x => "'" + x.attr.id + "'");

                    NumberingQueryBusiness.GetStreetWaysofCenterLinesByCenterlineIDs(centerlineIDs).then(wayResult => {

                        let wayIDs = wayResult.data?.map(x => "'" + x.attr.id + "'");

                        NumberingQueryBusiness.GetDoorsByWayIDs(wayIDs).then(doorResult => {
                            resolve(doorResult);
                        });
                    });
                }
                else {
                    resolve(null);
                }

            });

        });
    },

    /*ID den kapı bilgisi getirir */
    GetDoorById: async (_doorId) => {

        return new Promise((resolve, reject) => {

            let servicetitle = "DoorQueryUrl";
            let queryService = ArrayHelper.Find(MapManager.GetConfigurationServices(), "title", servicetitle);
            if (queryService == null) {
                reject({ type: Constants_ServiceResultType.Error, message: "Servis bulunamadı (" + servicetitle + ")" })
            };


            let queryOptions = {
                url: CommonBusiness.GenerateUrl(queryService),
                returnGeometry: true,
                outFields: ["*"],
                where: "id='" + _doorId + "'"
            }

            GisQueryHelper.ExecuteQuery(queryOptions).then(queryResults => {
                resolve(queryResults);
            });

        });

    },

    /*tıklanan noktayı bina ile kesiştirir*/
    IntersectBuildingsWithMapPoint: (mapPoint) => {

        return new Promise((resolve, reject) => {
            let servicetitle = "BuildingQueryUrl";
            let queryService = ArrayHelper.Find(MapManager.GetConfigurationServices(), "title", servicetitle);
            if (queryService == null) {
                reject({ type: Constants_ServiceResultType.Error, message: "Servis bulunamadı (" + servicetitle + ")" })
            };


            let options = {
                geometry: mapPoint,
                url: CommonBusiness.GenerateUrl(queryService),
                distance: 1,
                units: 'meters',
                spatialRelationship: 'intersects',
                returnGeometry: true,
                outFields: ["*"],
            };

            return GisQueryHelper.ExecuteSpatialQuery(options).then(_result => resolve(_result));



        });

    },

    /*Binaya ait yapı bilgisini getirir*/
    GetStructureInfoOfBuilding: async (_building) => {

        return new Promise((resolve, reject) => {

            let servicetitle = "StructureQueryUrl";
            let queryService = ArrayHelper.Find(MapManager.GetConfigurationServices(), "title", servicetitle);
            if (queryService == null) {
                reject({ type: Constants_ServiceResultType.Error, message: "Servis bulunamadı (" + servicetitle + ")" })
            };


            let queryOptions = {
                url: CommonBusiness.GenerateUrl(queryService),
                returnGeometry: true,
                outFields: ["*"],
                where: "id='" + _building.attr.id + "'"
            }

            GisQueryHelper.ExecuteQuery(queryOptions).then(queryResults => {
                resolve(queryResults);
            });


        });


    },

    /*Yapıya ait numarataj listesini getirir*/
    GetNumberingInfoOfStructure: async (_structure) => {


        return new Promise((resolve, reject) => {
            let servicetitle = "NumberingInfoQueryUrl";
            let queryService = ArrayHelper.Find(MapManager.GetConfigurationServices(), "title", servicetitle);
            if (queryService == null) {
                reject({ type: Constants_ServiceResultType.Error, message: "Servis bulunamadı (" + servicetitle + ")" })
            };


            let queryOptions = {
                url: CommonBusiness.GenerateUrl(queryService),
                returnGeometry: true,
                outFields: ["*"],
                where: "yapi_id='" + _structure.attr.id + "'"
            }

            GisQueryHelper.ExecuteQuery(queryOptions).then(queryResults => {
                resolve(queryResults);
            });
        });

    },


    /**/
    GetBuildingDocumentCategoryList: () => {

        let list = [
            { Title: "Betonarme Projesi", Id: "betonarmeProjesi" },
            { Title: "Elektrik Proje", Id: "elektrikProje" },
            { Title: "İnşaat Ruhsatı", Id: "insaatRuhsati" },
            { Title: "Isıtma Tesisat", Id: "isitmaTesisat" },
            { Title: "İskan Ruhsatı", Id: "iskanRuhsati" },
            { Title: "Sıhhi Tesisat", Id: "sihhiTesisat" },
            { Title: "Statik Proje", Id: "statikProje" }
        ];
        return list;
    },

    /* Binaya ait doküman listesinin getirir */
    GetBuildingDocumentList: (_building, _category, _callback) => {

        //http://localhost:5304/Common/FileService.svc/GetBuildingDocumentList?
        //buildingId={720A4433-FA55-432F-92B2-247B48EBC446}&category=elektrikProje
        let url = AppConfig.Api.Url + '/Common/FileService.svc/GetBuildingDocuments';
        return axios.get(url, {
            params: {
                buildingId: _building.attr.id,
                category: _category
            }
        }).then(function (response) {

            let result = response.data;

            _callback(result);
        }).catch(function (error) {
            console.log(error);
            _callback(null);
        });
    },

    /* Binaya ait fotoğraf listesinin getirir */
    GetBuildingPhotoList: (_building, _callback) => {

        //http://localhost:5304/Common/FileService.svc/GetBuildingDocumentList?
        //buildingId={720A4433-FA55-432F-92B2-247B48EBC446}&category=elektrikProje
        let url = AppConfig.Api.FileServiceUrl + '/Common/FileService.svc/GetBuildingPhotos';
        return axios.get(url, {
            params: {
                buildingId: _building.attr.id
            }
        }).then(function (response) {

            let result = response.data;

            _callback(result);
        }).catch(function (error) {
            console.log(error);
            _callback(null);
        });
    }
}