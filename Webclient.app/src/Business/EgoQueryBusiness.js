import { AppConfig } from "../Core/AppConfig";
import { Constants_ServiceResultType } from "../Core/Constants";
import { AuthBusiness } from "./AuthBusiness";
import { HttpBusiness } from "./HttpBusiness";

const getEgoResource = async path => {
    const headers = await AuthBusiness.GetRequestHeaders();
    try {
        return await HttpBusiness.Get(AppConfig.Api.BaseUrl + path, { headers });
    } catch (error) {
        return Promise.reject({ type: Constants_ServiceResultType.Error, message: error.message });
    }
};

export const EgoQueryBusiness = {
    GetActiveLines: () => getEgoResource('/Ego/ActiveLines'),
    GetActiveStops: () => getEgoResource('/Ego/ActiveStops'),
    GetLineInfo: lineNo => getEgoResource('/Ego/LineInfo/' + encodeURIComponent(lineNo))
};
