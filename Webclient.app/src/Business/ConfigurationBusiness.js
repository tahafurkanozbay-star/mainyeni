import axios from "axios";
import { AppConfig } from "../Core/AppConfig";
import { AuthBusiness } from "./AuthBusiness";

const get = async path => {
    const headers = await AuthBusiness.GetRequestHeaders();
    const result = await axios({
        method: "get",
        url: AppConfig.Api.BaseUrl + path,
        headers
    });
    return result.data;
};

export const ConfigurationBusiness = {
    GetMapConfiguration: () => get('/AppSettings/List?key=GisMapConfig'),
    GetConfigServices: () => get('/Gis/ConfigService/List')
};
