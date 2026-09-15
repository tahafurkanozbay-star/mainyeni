import { Constants_ServiceResultType } from "../Core/Constants";
import MapManager from "../Store/Managers/MapManager";
import { ArrayHelper } from "../Toolbox/ArrayHelper";
import { GisQueryHelper } from "../Toolbox/GisQueryHelper";
import { IsNull } from "../Toolbox/ObjectHelper";
import { TextHelper } from "../Toolbox/TextHelper";
import { CommonBusiness } from "./CommonBusiness";

const escapeSqlLiteral = value => String(value ?? "").replace(/'/g, "''");

export const EventQueryBusiness = {
    Query: async (_query = {}, _returnGeometry) => {
        const queryServiceTitle = "EventQueryUrl";
        const queryService = ArrayHelper.Find(MapManager.GetConfigurationServices(), "title", queryServiceTitle);
        if (queryService == null) {
            return Promise.reject({ type: Constants_ServiceResultType.Error, message: "Servis bulunamadı (" + queryServiceTitle + ")" });
        }

        const options = {
            url: CommonBusiness.GenerateUrl(queryService),
            returnGeometry: _returnGeometry ?? false,
            orderByFields: ["adi"],
            outFields: ["*"],
            where: "1=1"
        };

        if (_query.showNearby) {
            options.geometry = _query.userLocation;
            options.distance = Number(_query.bufferDistance || 0) * 100;
            options.units = 'meters';
            options.spatialRelationship = 'intersects';
            return GisQueryHelper.ExecuteSpatialQuery(options);
        }

        if (!IsNull(_query.name)) options.where += " AND UPPER(adi) LIKE '%" + escapeSqlLiteral(TextHelper.TurkishToUpper(_query.name)) + "%'";
        if (!IsNull(_query.districtId)) options.where += " AND ilceid = '" + escapeSqlLiteral(_query.districtId) + "'";
        if (!IsNull(_query.nbhoodId)) options.where += " AND mahalleid = '" + escapeSqlLiteral(_query.nbhoodId) + "'";
        if (!IsNull(_query.Id)) options.where += " AND id = '" + escapeSqlLiteral(_query.Id) + "'";
        if (!IsNull(_query.startDate)) options.where += " AND baslangictarihi >= " + _query.startDate.getTime();
        if (!IsNull(_query.endDate)) options.where += " AND bitistarihi <= " + _query.endDate.getTime();
        return GisQueryHelper.ExecuteQuery(options);
    }
};
