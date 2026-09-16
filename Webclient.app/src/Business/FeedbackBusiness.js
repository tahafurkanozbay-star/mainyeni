import axios from "../platform/http/legacyHttpClient";
import { AppConfig } from "../Core/AppConfig";
import { AuthBusiness } from "./AuthBusiness";

export const FeedbackBusiness={

    SendFeedBack:async (formData) => {
        
        let _headers = await AuthBusiness.GetRequestHeaders();

        let config = {
            method: 'post',
            url: AppConfig.Api.BaseUrl + '/Feedback/Save',
            headers: _headers,
            data: formData,
        };
    
        return new Promise((resolve) => {
    
            return axios(config)
                .then(function (response) {
    
                    let result = response.data;
                    resolve(result);
                }).catch(function () {
                    resolve(null);
                });
    
        });
    },

    GetFeedbackTypes :() => {

        return [
            { id: 1, name: "Uygulama hakkında görüş ve tavsiye" },
            { id: 2, name: "Adres sorunu bildirme" },
            { id: 3, name: "Veri sorunu bildirme" },
        ];
    }
}
