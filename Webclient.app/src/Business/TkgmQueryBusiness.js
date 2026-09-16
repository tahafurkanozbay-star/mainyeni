import axios from 'axios';
import { loadModules } from "esri-loader";
import {AppConfig} from "../Core/AppConfig";
import { IsNull } from "../Toolbox/ObjectHelper";
import { AuthBusiness } from "./AuthBusiness";

export const TkgmQueryBusiness = {

    /* Tkgm servisinden ilçeler elde edilir */
    GetDistricts: async (_cityId) => {

        let _headers = await AuthBusiness.GetRequestHeaders();

        return new Promise(resolve => {

            let url = AppConfig.Api.BaseUrl + '/Gis/Tkgm/Districts/'+_cityId

            axios({
                method: "get",
                url: url,
                headers: _headers,
            }).then((response) => {
                

                var data=JSON.parse(response.data);
                resolve(data?.features);

            }).catch(function (error) {

                console.log(error);
                resolve(null);

            });

        });
    },


    /* Tkgm servisinden ilçeye ait mahalle listesi çağırılır*/
    GetNeighborhoodsOfDistrict: async (_districtId) => {
        let _headers = await AuthBusiness.GetRequestHeaders();

        return new Promise(resolve => {

            let url = AppConfig.Api.BaseUrl + '/Gis/Tkgm/Nbhoods/'+_districtId

            axios({
                method: "get",
                url: url,
                headers: _headers,
            }).then((response) => {
                
                var data=JSON.parse(response.data);
                resolve(data?.features);

            }).catch(function (error) {

                console.log(error);
                resolve(null);

            });

        });
    },

    /*mahalle ve adaya göre parsel listesini getirir*/
    GetParcels: async (_query) => {

        let _headers = await AuthBusiness.GetRequestHeaders();

        return new Promise(resolve => {

            let url = AppConfig.Api.BaseUrl + '/Gis/Tkgm/Parcel/'+_query.district+'/'+_query.nbhood+'/'+_query.cityblock+'/'+_query.parcel;


            axios({
                method: "get",
                url: url,
                headers: _headers,
            }).then((response) => {
                
                resolve(JSON.parse(response.data));

            }).catch(function (error) {

                console.log(error);
                resolve(null);

            });

        });
    },




    //Tkgm/TkgmServicev2.svc/GetParcelInfo?adano=101&parselno=36&tapumahalleref=11607&token=SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c
    GetParcelInfo: async (_neighborhoodId, _cityBlockNo, _parcelNo) => {

        
        return new Promise(resolve => {

            if (IsNull(_neighborhoodId) && IsNull(_cityBlockNo) && IsNull(_parcelNo)) {
                resolve(null);
            }

            if (IsNull(_cityBlockNo)) {
                _cityBlockNo = 0;
            }

            let url = AppConfig.Api.Url + '/Tkgm/TkgmServicev2.svc/GetParcelInfo';

            let config = {
            
                params: {
                    mahalleId: _neighborhoodId,
                    adaNo: _cityBlockNo,
                    parselNo: _parcelNo,
                }
            };

            axios.get(url, config)
                .then((response) => {
                    let result = response.data;

                    resolve(result);
                }, (error) => {
                    console.log(error);
                    resolve(null);

                });
        }).catch((reject, ex) => {
            console.log(ex);
            reject(null);
        });
    },

    /* Noktayı tapu parseliyle kesiştirerek, kesişen parsel bilgisini getirir */
    IntersectMapPointWithTkgmParcel: async (_point) => {


        return new Promise((resolve, reject) => {

            let y = _point.latitude;
            let x = _point.longitude;

            let url = 'https://cbsapi.tkgm.gov.tr/megsiswebapi.v3/api/parsel';

            url += '/' + y + '/' + x;

            fetch(url, {
                referrer: ""
            }).then(response => response.json())
                .then((result) => {

                    resolve(result);

                }, (error) => {

                    console.log(error);
                    resolve(null);

                });
        })
    },

    IntersectMapPolygonWithTkgmParcel: async (_geometry) => {

        loadModules(["esri/geometry/support/webMercatorUtils"]).then(([WebMercatorUtils]) => {

            return new Promise((resolve, reject) => {

                let polygonGeometry = WebMercatorUtils.webMercatorToGeographic(_geometry);

                let url = AppConfig.Api.Url + '/Tkgm/TkgmServicev2.svc/GetParcelsInPolygon';

                let polygonRings = polygonGeometry.rings[0].map(x => {
                    return x[0].toFixed(6) + " " + x[1].toFixed(6)
                }).join(",") + "";

                let config = {
                    //headers: headers,
                    params: {
                        polygon: encodeURI(polygonRings),
                        pasifleriGoster: true,
                    }
                };


                axios.get(url, config).then((response) => {

                    let result = response.data;

                    resolve(result);

                }, (error) => {

                    console.log(error);
                    resolve(null);

                });

            });

        });

    }
}