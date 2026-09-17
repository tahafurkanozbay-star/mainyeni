import { AppConfig } from "../Core/AppConfig";
import { IsNull } from "../Toolbox/ObjectHelper";
import { TextHelper } from "../Toolbox/TextHelper";
import { AuthBusiness } from "./AuthBusiness";
import { FastAccessQueryBusiness } from "./FastAccessQueryBusiness";
import { HttpBusiness } from "./HttpBusiness";

export const PodQueryBusiness = {
    Query: (_query, _returnGeometry) => FastAccessQueryBusiness.QueryFastAccessService("PharmacyQueryUrl", _query, _returnGeometry),

    QueryPodOnDuty: async (_query = {}) => {
        const headers = await AuthBusiness.GetRequestHeaders();
        const responseData = await HttpBusiness.Get(AppConfig.Api.BaseUrl + "/Pod/List/", { headers });
        let results = responseData.data;
        if (!IsNull(_query.name)) {
            const name = TextHelper.TurkishToLower(_query.name);
            results = results.filter(item => TextHelper.TurkishToLower(item.title).includes(name));
        }
        return { ...responseData, data: results };
    }
};
