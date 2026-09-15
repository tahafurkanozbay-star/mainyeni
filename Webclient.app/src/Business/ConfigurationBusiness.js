import axios from "axios";
import { AppConfig } from "../Core/AppConfig";
import { Constants_ServiceResultType } from "../Core/Constants";
import { TextHelper } from "../Toolbox/TextHelper";
import { AuthBusiness } from "./AuthBusiness";

export const ConfigurationBusiness = {


    GetMapConfiguration: async () => {

        let _headers = await AuthBusiness.GetRequestHeaders();
        
        let url = AppConfig.Api.BaseUrl + '/AppSettings/List?key=GisMapConfig';

        return new Promise((resolve, reject) => {

            axios({
                method: "get",
                url: url,
                headers: _headers,
            }).then((result) => {

                resolve(result.data);
            });

        });


    },

    GetConfigServices: async () => {

        let _headers = await AuthBusiness.GetRequestHeaders();

        let url = AppConfig.Api.BaseUrl + '/Gis/ConfigService/List';

        return new Promise((resolve, reject) => {

            axios({
                method: "get",
                url: url,
                headers: _headers,
            }).then((result) => {

                resolve(result.data);

            });

        });
    }

};