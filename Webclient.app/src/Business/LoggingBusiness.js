import axios from 'axios';
import {AppConfig} from "../Core/AppConfig";
import { AuthBusiness } from "./AuthBusiness";

export const LoggingBusiness = {

    CreateClientLog: async (_logType, _description) => {
        
        let _headers = await AuthBusiness.GetRequestHeaders();

        return new Promise((resolve, reject)=>{

            //let _url = AppConfig.Api.BaseUrl + '/ClientLog/Create';
            let _url = AppConfig.Api.BaseUrl + '/cl/c';
        
            let log=new FormData();
            log.append("logType",_logType);
            log.append("description",JSON.stringify(_description));
          
            let config = {
                method: 'post',
                url: _url,
                headers: _headers,
                data: log
            };
            axios(config)
                .then(function (response) {resolve(response);})
                .catch(function (error) {reject(error);});

        });
        
    }
};