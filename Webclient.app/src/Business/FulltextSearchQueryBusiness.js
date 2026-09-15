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

const buildTextFilter = (searchText) => {
    if (IsNull(searchText)) return null;
    const lower = escapeSqlLiteral(TextHelper.TurkishToLower(String(searchText).trim()));
    if (!lower) return null;
    const ascii = escapeSqlLiteral(TextHelper.RemoveTurkishChars(lower));
    return `(LOWER(adi) LIKE '%${lower}%' OR LOWER(adi) LIKE '%${ascii}%')`;
};

const appendIdFilter = (predicates, field, value) => {
    if (IsNull(value)) return;
    const normalized = String(value).trim();
    if (!normalized) return;
    predicates.push(`${field} = '${escapeSqlLiteral(normalized)}'`);
};

const createOptions = (service, returnGeometry) => ({
    url: CommonBusiness.GenerateUrl(service),
    returnGeometry: Boolean(returnGeometry),
    orderByFields: ["adi"],
    outFields: ["*"]
});

const execute = async (options, query) => {
    if (query?.showNearby) {
        const distance = Math.max(0, toFiniteNumber(query.bufferDistance) ?? 0);
        return GisQueryHelper.ExecuteSpatialQuery({
            ...options,
            geometry: query.userLocation,
            distance: distance * 100,
            units: "meters",
            spatialRelationship: "intersects"
        });
    }
    return GisQueryHelper.ExecuteQuery(options);
};

export const FulltextSearchQueryBusiness = {
    QueryService: async (_configService, _query = {}, _returnGeometry = false) => {
        const predicates = ["1=1"];
        const textFilter = buildTextFilter(_query.searchText);
        if (textFilter) predicates.push(textFilter);

        const result = await execute(
            {
                ...createOptions(_configService, _returnGeometry),
                where: predicates.join(" AND ")
            },
            _query
        );

        return {
            Title: _configService.searchCategoryTitle,
            Data: result.data
        };
    },

    Search: async (_query = {}, _returnGeometry = false) => {
        const queryServiceTitle = "FullTextSearchQueryUrl";
        const queryService = ArrayHelper.Find(
            MapManager.GetConfigurationServices(),
            "title",
            queryServiceTitle
        );

        if (queryService === null || queryService === undefined) {
            return Promise.reject({
                type: Constants_ServiceResultType.Error,
                message: `Servis bulunamadı (${queryServiceTitle})`
            });
        }

        const predicates = ["1=1"];
        const textFilter = buildTextFilter(_query.searchText);
        if (textFilter) predicates.push(textFilter);

        if (!_query.showNearby) {
            appendIdFilter(predicates, "ilceid", _query.districtId);
            appendIdFilter(predicates, "mahalleid", _query.nbhoodId);
            const id = toFiniteNumber(_query.Id);
            if (id !== null) predicates.push(`id = ${id}`);
        }

        return execute(
            {
                ...createOptions(queryService, _returnGeometry),
                where: predicates.join(" AND ")
            },
            _query
        );
    }
};
