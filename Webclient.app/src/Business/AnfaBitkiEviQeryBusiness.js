import { Constants_ServiceResultType } from "../Core/Constants";
import MapManager from "../Store/Managers/MapManager";
import { ArrayHelper } from "../Toolbox/ArrayHelper";
import { GisQueryHelper } from "../Toolbox/GisQueryHelper";
import { IsNull } from "../Toolbox/ObjectHelper";
import { TextHelper } from "../Toolbox/TextHelper";
import { CommonBusiness } from "./CommonBusiness";
import { FastAccessQueryBusiness } from "./FastAccessQueryBusiness";

export const AnfaBitkiEviQeryBusiness={

    Query:async(_query, _returnGeometry)=>{
        return FastAccessQueryBusiness.QueryFastAccessService("YeniAnfaBitkiEviQeryUrl",_query,_returnGeometry);
    }
}