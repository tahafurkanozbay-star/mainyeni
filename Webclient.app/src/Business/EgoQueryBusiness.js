import axios from "axios";
import { Constants_ServiceResultType } from "../Core/Constants";
import MapManager from "../Store/Managers/MapManager";
import { ArrayHelper } from "../Toolbox/ArrayHelper";
import { DatetimeHelper } from "../Toolbox/DatetimeHelper";
import { GisQueryHelper } from "../Toolbox/GisQueryHelper";
import { IsNull } from "../Toolbox/ObjectHelper";
import { TextHelper } from "../Toolbox/TextHelper";
import { CommonBusiness } from "./CommonBusiness";
import { AppConfig } from "../Core/AppConfig";
import { AuthBusiness } from "./AuthBusiness";

export const EgoQueryBusiness = {

    GetActiveLines: async () => {

        let _headers = await AuthBusiness.GetRequestHeaders();

        return new Promise((resolve, reject) => {

            let url = AppConfig.Api.BaseUrl + '/Ego/ActiveLines';

            axios({
                method: "get",
                url: url,
                headers: _headers,
            }).then((response) => {

                resolve(response.data);
            }).catch(error => {
                reject({ type: Constants_ServiceResultType.Error, message: error.message })
            });
        });

    },

    GetActiveStops: async () => {

        let _headers = await AuthBusiness.GetRequestHeaders();

        return new Promise((resolve, reject) => {

            let url = AppConfig.Api.BaseUrl + '/Ego/ActiveStops';

            axios({
                method: "get",
                url: url,
                headers: _headers,
            }).then((response) => {

                resolve(response.data);
            }).catch(error => {
                reject({ type: Constants_ServiceResultType.Error, message: error.message })
            });
        });

    },


    GetLineInfo: async (_lineNo) => {

        let _headers = await AuthBusiness.GetRequestHeaders();

        return new Promise((resolve, reject) => {

            let url = AppConfig.Api.BaseUrl + '/Ego/LineInfo/' + _lineNo;

            axios({
                method: "get",
                url: url,
                headers: _headers,
            }).then((response) => {
                resolve(response.data);
            }).catch(error => {
                reject({ type: Constants_ServiceResultType.Error, message: error.message })
            });
        });

    },

}