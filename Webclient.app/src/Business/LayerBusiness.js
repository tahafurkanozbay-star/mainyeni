import axios from 'axios';
import {AppConfig} from "../Core/AppConfig";
import { AuthBusiness } from "./AuthBusiness";

export const LayerBusiness = {

    /* Katmanlar için kullanıcı yetkilerini alır */
    GetLayers: async () => {

        let _headers = await AuthBusiness.GetRequestHeaders();

        return new Promise(resolve => {

            let url = AppConfig.Api.BaseUrl + '/Gis/Layer/ListGrouped';

           axios({
                method: "get",
                url: url,
                headers: _headers,
            }).then((response) => {

                let result = response.data;
                resolve(result);

            }).catch(function (error) {

                console.log(error);
                resolve(null);

            });

        });
    }


}
