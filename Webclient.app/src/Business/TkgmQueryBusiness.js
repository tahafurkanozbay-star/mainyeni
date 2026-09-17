import { loadArcgisModule } from "../gis-engine/arcgisModuleRuntime";
import { AppConfig } from "../Core/AppConfig";
import { IsNull } from "../Toolbox/ObjectHelper";
import { AuthBusiness } from "./AuthBusiness";
import { HttpBusiness } from "./HttpBusiness";

const normalizeTkgmPayload = payload => {
    if (typeof payload !== "string") return payload;
    return JSON.parse(payload);
};

const getAuthenticatedTkgmResource = async path => {
    const headers = await AuthBusiness.GetRequestHeaders();
    const payload = await HttpBusiness.Get(AppConfig.Api.BaseUrl + path, { headers });
    return normalizeTkgmPayload(payload);
};

export const TkgmQueryBusiness = {
    /* Tkgm servisinden ilçeler elde edilir */
    GetDistricts: async _cityId => {
        try {
            const data = await getAuthenticatedTkgmResource('/Gis/Tkgm/Districts/' + encodeURIComponent(_cityId));
            return data?.features;
        } catch (error) {
            console.log(error);
            return null;
        }
    },

    /* Tkgm servisinden ilçeye ait mahalle listesi çağırılır */
    GetNeighborhoodsOfDistrict: async _districtId => {
        try {
            const data = await getAuthenticatedTkgmResource('/Gis/Tkgm/Nbhoods/' + encodeURIComponent(_districtId));
            return data?.features;
        } catch (error) {
            console.log(error);
            return null;
        }
    },

    /* mahalle ve adaya göre parsel listesini getirir */
    GetParcels: async _query => {
        try {
            return await getAuthenticatedTkgmResource(
                '/Gis/Tkgm/Parcel/' +
                encodeURIComponent(_query.district) + '/' +
                encodeURIComponent(_query.nbhood) + '/' +
                encodeURIComponent(_query.cityblock) + '/' +
                encodeURIComponent(_query.parcel)
            );
        } catch (error) {
            console.log(error);
            return null;
        }
    },

    GetParcelInfo: async (_neighborhoodId, _cityBlockNo, _parcelNo) => {
        if (IsNull(_neighborhoodId) && IsNull(_cityBlockNo) && IsNull(_parcelNo)) return null;

        try {
            return await HttpBusiness.Get(AppConfig.Api.Url + '/Tkgm/TkgmServicev2.svc/GetParcelInfo', {
                params: {
                    mahalleId: _neighborhoodId,
                    adaNo: IsNull(_cityBlockNo) ? 0 : _cityBlockNo,
                    parselNo: _parcelNo,
                }
            });
        } catch (error) {
            console.log(error);
            return null;
        }
    },

    /* Noktayı tapu parseliyle kesiştirerek, kesişen parsel bilgisini getirir */
    IntersectMapPointWithTkgmParcel: async _point => {
        try {
            const y = _point.latitude;
            const x = _point.longitude;
            return await HttpBusiness.Get(`https://cbsapi.tkgm.gov.tr/megsiswebapi.v3/api/parsel/${y}/${x}`);
        } catch (error) {
            console.log(error);
            return null;
        }
    },

    IntersectMapPolygonWithTkgmParcel: async _geometry => {
        const WebMercatorUtils = await loadArcgisModule("esri/geometry/support/webMercatorUtils");
        const polygonGeometry = WebMercatorUtils.webMercatorToGeographic(_geometry);
        const polygonRings = polygonGeometry.rings[0]
            .map(point => `${point[0].toFixed(6)} ${point[1].toFixed(6)}`)
            .join(",");

        try {
            return await HttpBusiness.Get(AppConfig.Api.Url + '/Tkgm/TkgmServicev2.svc/GetParcelsInPolygon', {
                params: {
                    polygon: polygonRings,
                    pasifleriGoster: true,
                }
            });
        } catch (error) {
            console.log(error);
            return null;
        }
    }
};