import axios from "axios";
import { Constants } from "../Core/Constants";
import { Global } from "../Core/Global";
import { IsNull } from "../Core/Toolbox/ObjectHelper";
import { AuthBusiness } from "./AuthBusiness";

export const SettingsBusiness={

    Get:async(_key)=>{

        let _headers = await AuthBusiness.GetRequestHeaders();

        return new Promise((resolve, reject) => {

            let url = Global.API_URL + "/AppSettings/List?key="+_key;

            return axios({
                method: "get",
                url: url,
                headers: _headers
            })
                .then(function (response) {
                    var result = response.data;
                    resolve(result);
                })
                .catch(function (error) {
                    return AuthBusiness.HandleRejection(error);
                });
        });

    },

    Save:async(_config)=>{
        
        let _headers = await AuthBusiness.GetRequestHeaders();

        return new Promise((resolve, reject) => {

            let url = Global.API_URL + "/AppSettings/Save";

            axios({
                method: "post",
                url: url,
                data: JSON.stringify(_config),
                headers: _headers
            })
                .then(function (response) {
                    var result = response.data;
                    resolve(result);
                })
                .catch(function (error) {
                    return AuthBusiness.HandleRejection(error);
                });
        });
    },



    ValidateGisMapConfig:(_config)=>{

        if (IsNull(_config.Centerx)) {
            return { type: Constants.MessageTypes.Error, text: "Lütfen başlangıç merkez noktası X için koordinat giriniz" };
        }
        if (IsNull(_config.Centery)) {
            return { type: Constants.MessageTypes.Error, text: "Lütfen başlangıç merkez noktası Y için koordinat giriniz" };
        }
        if (IsNull(_config.Zoom)) {
            return { type: Constants.MessageTypes.Error, text: "Lütfen zoom değeri giriniz" };
        }
        if (IsNull(_config.DefaultBasemapTitle)) {
            return { type: Constants.MessageTypes.Error, text: "Lütfen altlık harita seçiniz" };
        }

        return {type:"success",text:""};
    },


    ValidateGisTakbisConfig:(_config)=>{

        if (IsNull(_config.ServiceUrl)) {
            return { type: Constants.MessageTypes.Error, text: "Lütfen servis adresi giriniz" };
        }
        if (IsNull(_config.CityId)) {
            return { type: Constants.MessageTypes.Error, text: "Lütfen şehir id giriniz" };
        }
        if (IsNull(_config.ClientUserName)) {
            return { type: Constants.MessageTypes.Error, text: "Lütfen kullanıcı adı giriniz" };
        }
        if (IsNull(_config.ClientPassword)) {
            return { type: Constants.MessageTypes.Error, text: "Lütfen şifre giriniz" };
        }
        if (IsNull(_config.Host)) {
            return { type: Constants.MessageTypes.Error, text: "Lütfen host giriniz" };
        }
        if (IsNull(_config.Token)) {
            return { type: Constants.MessageTypes.Error, text: "Lütfen token giriniz" };
        }

        return {type:"success",text:""};
    },


    ValidateAppConfig:(_config)=>{

        if (IsNull(_config.AppTitle)) {
            return { type: Constants.MessageTypes.Error, text: "Lütfen uygulama başlığını giriniz" };
        }
        return {type:"success",text:""};
    }
};