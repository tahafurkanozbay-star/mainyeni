import { Constants_ServiceResultType } from "../Core/Constants";
import MapManager from "../Store/Managers/MapManager";
import { ArrayHelper } from "../Toolbox/ArrayHelper";
import { GisQueryHelper } from "../Toolbox/GisQueryHelper";
import { IsNull } from "../Toolbox/ObjectHelper";
import { TextHelper } from "../Toolbox/TextHelper";
import { CommonBusiness } from "./CommonBusiness";

const escapeSqlLiteral = value => String(value ?? "").replace(/'/g, "''");

export const FastAccessQueryBusiness = {
    QueryFastAccessService: async (_queryServiceTitle, _query, _returnGeometry) => {
        const queryService = ArrayHelper.Find(MapManager.GetConfigurationServices(), "title", _queryServiceTitle);
        if (queryService == null) {
            return Promise.reject({
                type: Constants_ServiceResultType.Error,
                message: "Servis bulunamadı (" + _queryServiceTitle + ")"
            });
        }

        const options = {
            url: CommonBusiness.GenerateUrl(queryService),
            returnGeometry: _returnGeometry ?? false,
            orderByFields: ["adi"],
            outFields: ["*"]
        };

        let where = "1=1";
        if (_query != null) {
            if (!IsNull(_query.ObjectId)) {
                const objectId = Number(_query.ObjectId);
                if (Number.isFinite(objectId)) where += " AND ObjectId =" + objectId;
            }

            if (!IsNull(_query.name)) {
                const normalizedName = escapeSqlLiteral(TextHelper.RemoveTurkishChars(TextHelper.TurkishToUpper(_query.name)));
                const turkishName = escapeSqlLiteral(TextHelper.TurkishToUpper(_query.name));
                where += " AND (UPPER(adi) LIKE '%" + normalizedName + "%' OR UPPER(adi) LIKE '%" + turkishName + "%')";
            }
        }

        options.where = where;
        if (_query?.showNearby) {
            options.geometry = _query.userLocation;
            options.distance = Number(_query.bufferDistance || 0) * 100;
            options.units = 'meters';
            options.spatialRelationship = 'intersects';
            return GisQueryHelper.ExecuteSpatialQuery(options);
        }

        return GisQueryHelper.ExecuteQuery(options);
    }
};
