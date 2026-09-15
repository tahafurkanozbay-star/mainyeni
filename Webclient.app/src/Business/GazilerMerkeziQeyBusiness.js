import { Constants_ServiceResultType } from "../Core/Constants";
import MapManager from "../Store/Managers/MapManager";
import { ArrayHelper } from "../Toolbox/ArrayHelper";
import { GisQueryHelper } from "../Toolbox/GisQueryHelper";
import { IsNull } from "../Toolbox/ObjectHelper";
import { TextHelper } from "../Toolbox/TextHelper";
import { CommonBusiness } from "./CommonBusiness";
import { FastAccessQueryBusiness } from "./FastAccessQueryBusiness";

export const GazilerMerkeziQeyBusiness={

    Query:async(_query, _returnGeometry)=>{
        return FastAccessQueryBusiness.QueryFastAccessService("YeniGazilerMerkeziQeyUrl",_query,_returnGeometry);
    }
}