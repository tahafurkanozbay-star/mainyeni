import axios from "axios";
import { AppConfig } from "../Core/AppConfig";
import { Constants_ServiceResultType } from "../Core/Constants";
import { AuthBusiness } from "./AuthBusiness";

const getEgoResource = async path => {
    const headers = await AuthBusiness.GetRequestHeaders();
    try {
        const response = await axios({ method: "get", url: AppConfig.Api.BaseUrl + path, headers });
        return response.data;
    } catch (error) {
        return Promise.reject({ type: Constants_ServiceResultType.Error, message: error.message });
    }
};

export const EgoQueryBusiness = {
    GetActiveLines: () => getEgoResource('/Ego/ActiveLines'),
    GetActiveStops: () => getEgoResource('/Ego/ActiveStops'),
    GetLineInfo: lineNo => getEgoResource('/Ego/LineInfo/' + encodeURIComponent(lineNo))
};
