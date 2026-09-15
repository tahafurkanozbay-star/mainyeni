import { Constants_ServiceResultType } from "../Core/Constants";
import MapManager from "../Store/Managers/MapManager";
import { ArrayHelper } from "../Toolbox/ArrayHelper";
import { GisQueryHelper } from "../Toolbox/GisQueryHelper";
import { IsNull } from "../Toolbox/ObjectHelper";
import { TextHelper } from "../Toolbox/TextHelper";
import { CommonBusiness } from "./CommonBusiness";

const escapeSqlLiteral = (value) => String(value ?? "").replace(/'/g, "''");

const toFiniteNumber = (value) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
};

const buildNameFilter = (name) => {
    if (IsNull(name)) return null;

    const normalized = escapeSqlLiteral(TextHelper.TurkishToUpper(String(name).trim()));
    if (!normalized) return null;

    const ascii = escapeSqlLiteral(TextHelper.RemoveTurkishChars(normalized));
    return `(UPPER(adi) LIKE '%${ascii}%' OR UPPER(adi) LIKE '%${normalized}%')`;
};

export const FastAccessQueryBusiness = {
    QueryFastAccessService: async (_queryServiceTitle, _query = {}, _returnGeometry = false) => {
        const queryService = ArrayHelper.Find(
            MapManager.GetConfigurationServices(),
            "title",
            _queryServiceTitle
        );

        if (queryService == null) {
            return Promise.reject({
                type: Constants_ServiceResultType.Error,
                message: `Servis bulunamadı (${_queryServiceTitle})`
            });
        }

        const options = {
            url: CommonBusiness.GenerateUrl(queryService),
            returnGeometry: Boolean(_returnGeometry),
            orderByFields: ["adi"],
            outFields: ["*"]
        };

        const predicates = ["1=1"];
        const objectId = toFiniteNumber(_query?.ObjectId);
        if (objectId !== null) {
            predicates.push(`ObjectId = ${objectId}`);
        }

        const nameFilter = buildNameFilter(_query?.name);
        if (nameFilter) {
            predicates.push(nameFilter);
        }

        options.where = predicates.join(" AND ");

        if (_query?.showNearby) {
            const bufferDistance = Math.max(0, toFiniteNumber(_query.bufferDistance) ?? 0);
            options.geometry = _query.userLocation;
            options.distance = bufferDistance * 100;
            options.units = "meters";
            options.spatialRelationship = "intersects";
            return GisQueryHelper.ExecuteSpatialQuery(options);
        }

        return GisQueryHelper.ExecuteQuery(options);
    }
};
