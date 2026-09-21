import { Constants } from "../Core/Constants";
import { IsNull } from "../Core/Toolbox/ObjectHelper";
import { adminApiGet, adminApiPost } from "../runtime/adminApiClient";

export const SettingsBusiness={

    Get:async(_key)=>{
        return adminApiGet("/AppSettings/List", {
            query: { key: _key }
        });
    },

    Save:async(_config)=>{
        return adminApiPost("/AppSettings/Save", _config);
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