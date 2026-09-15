import axios from "axios";
import { AppConfig } from "../Core/AppConfig";
import { Constants_ServiceResultType } from "../Core/Constants";
import MapManager from "../Store/Managers/MapManager";
import { ArrayHelper } from "../Toolbox/ArrayHelper";
import { GisQueryHelper } from "../Toolbox/GisQueryHelper";
import { IsNull } from "../Toolbox/ObjectHelper";
import { TextHelper } from "../Toolbox/TextHelper";
import { CommonBusiness } from "./CommonBusiness";
import { FastAccessQueryBusiness } from "./FastAccessQueryBusiness";
import { AuthBusiness } from "./AuthBusiness";

export const PodQueryBusiness = {

    Query:async(_query, _returnGeometry)=>{
        return FastAccessQueryBusiness.QueryFastAccessService("PharmacyQueryUrl",_query,_returnGeometry);
    },

    QueryPodOnDuty: async (_query) => {

        let _headers = await AuthBusiness.GetRequestHeaders();
        
        return new Promise((resolve, reject) => {

            //let url = AppConfig.Api.BaseUrl + '/Ext/PodService.svc/List';

            let url=AppConfig.Api.BaseUrl+ "/Pod/List/";

      
            axios({
                method: "get",
                url: url,
                headers: _headers,
            }).then((res) => {

                    let results=res.data.data;
                    
                    if(!IsNull(_query.name)){
                        
                        let _name=TextHelper.TurkishToLower(_query.name);
                        results=results.filter(x=> TextHelper.TurkishToLower(x.title).includes(_name));
                    }

                    res.data.data=results;
                    resolve(res.data);
                    
                })
                .catch(err => {
                    resolve(err);
                })

        });
    }
};