import { ArrayHelper } from "../Toolbox/ArrayHelper";
import { GisQueryHelper } from "../Toolbox/GisQueryHelper";
import { TextHelper } from "../Toolbox/TextHelper";
import MapManager from "../Store/Managers/MapManager";
import { Constants_ServiceResultType } from "../Core/Constants";
import { apiClient } from "../platform/http/httpClient";
import { CommonBusiness } from "./CommonBusiness";

const SERVICE_TITLES = Object.freeze({
    district: "NumberingDistrictQueryUrl",
    neighborhood: "NumberingNeighborhoodQueryUrl",
    street: "StreetQueryUrl",
    streetCenterLine: "StreetCenterLineUrl",
    streetCenterLineWay: "StreetCenterLineWayUrl",
    door: "DoorQueryUrl",
    building: "BuildingQueryUrl",
    structure: "StructureQueryUrl",
    numberingInfo: "NumberingInfoQueryUrl"
});

const escapeSqlLiteral = (value) => String(value ?? "").replace(/'/g, "''");

const normalizeScalar = (value) => String(value ?? "").trim();

const normalizeLegacyIdentifier = (value) => {
    let normalized = normalizeScalar(value?.attr?.id ?? value);
    if (normalized.length >= 2 && normalized.startsWith("'") && normalized.endsWith("'")) {
        normalized = normalized.slice(1, -1);
    }
    return normalized;
};

const hasIdentifier = (value) =>
    value !== null && value !== undefined && normalizeScalar(value) !== "";

const quoteSqlLiteral = (value) => `'${escapeSqlLiteral(normalizeLegacyIdentifier(value))}'`;

const normalizeIdentifierList = (values) => {
    const source = Array.isArray(values)
        ? values
        : (values === null || values === undefined || values === "" ? [] : String(values).split(","));

    return source
        .map(normalizeLegacyIdentifier)
        .filter(Boolean);
};

const buildInFilter = (field, values) => {
    const normalized = normalizeIdentifierList(values);
    if (!normalized.length) return null;
    return `${field} IN (${normalized.map(quoteSqlLiteral).join(",")})`;
};

const buildEqualsFilter = (field, value) => `${field}=${quoteSqlLiteral(value)}`;

const buildUpperContainsFilter = (field, value) => {
    const normalized = normalizeScalar(value);
    if (!normalized) return null;
    return `UPPER(${field}) LIKE '%${escapeSqlLiteral(TextHelper.TurkishToUpper(normalized))}%'`;
};

const emptyResult = () => ({
    type: Constants_ServiceResultType.Success,
    data: [],
    fields: []
});

const serviceError = (title) => ({
    type: Constants_ServiceResultType.Error,
    message: `Servis bulunamadı (${title})`
});

const getService = (title) => {
    const service = ArrayHelper.Find(MapManager.GetConfigurationServices(), "title", title);
    if (service === null || service === undefined) throw serviceError(title);
    return service;
};

const createOptions = (title, options = {}) => ({
    url: CommonBusiness.GenerateUrl(getService(title)),
    returnGeometry: false,
    outFields: ["*"],
    ...options
});

const sortData = (result, field) => {
    if (Array.isArray(result?.data) && field) {
        result.data.sort((a, b) => ArrayHelper.OrderByTurkish(a.attr, b.attr, field));
    }
    return result ?? emptyResult();
};

const executeQuery = async (title, options, sortField = null) => {
    const result = await GisQueryHelper.ExecuteQuery(createOptions(title, options));
    return sortData(result, sortField);
};

const readEntityId = (entity) => normalizeLegacyIdentifier(entity?.attr?.id ?? entity?.id ?? entity);

const fileRequestOptions = (options = {}) => ({
    ...options,
    cache: true,
    dedupe: !options.signal,
    cacheTtlMs: options.cacheTtlMs ?? 30000
});

const returnWithCallback = (callback, value) => {
    if (typeof callback === "function") callback(value);
    return value;
};

export const NumberingQueryBusiness = {
    GetDistrictById: async (_id) => executeQuery(SERVICE_TITLES.district, {
        returnDistinctValues: false,
        returnGeometry: true,
        orderByFields: ["ad"],
        outFields: ["*"],
        where: buildEqualsFilter("id", _id)
    }),

    GetDistricts: async (_query = {}) => {
        const predicates = ["1=1"];
        const nameFilter = buildUpperContainsFilter("ad", _query?.DistrictName);
        if (nameFilter) predicates.push(nameFilter);

        return executeQuery(SERVICE_TITLES.district, {
            returnDistinctValues: true,
            returnGeometry: false,
            orderByFields: ["ad"],
            outFields: ["id", "ad"],
            where: predicates.join(" AND ")
        }, "ad");
    },

    GetNeighborhoodById: async (_id) => executeQuery(SERVICE_TITLES.neighborhood, {
        returnDistinctValues: false,
        returnGeometry: true,
        orderByFields: ["ad"],
        outFields: ["*"],
        where: buildEqualsFilter("id", _id)
    }),

    GetAllNeighborhoods: async (_query = {}) => {
        const predicates = ["1=1"];
        const nameFilter = buildUpperContainsFilter("ad", _query?.NeighborhoodName);
        if (nameFilter) predicates.push(nameFilter);

        return executeQuery(SERVICE_TITLES.neighborhood, {
            returnDistinctValues: true,
            returnGeometry: false,
            orderByFields: ["ad"],
            outFields: ["id", "ad"],
            where: predicates.join(" AND ")
        }, "ad");
    },

    GetNeighborhoodsOfDistrict: async (_districtId) => executeQuery(SERVICE_TITLES.neighborhood, {
        returnGeometry: true,
        orderByFields: ["ad"],
        outFields: ["*"],
        where: buildEqualsFilter("ilceid", _districtId)
    }, "ad"),

    GetStreetsByName: async (_name) => {
        const nameFilter = buildUpperContainsFilter("ad", _name);
        return executeQuery(SERVICE_TITLES.street, {
            returnGeometry: true,
            orderByFields: ["ad"],
            where: nameFilter ?? "1=0",
            outFields: ["ad", "id"]
        }, "ad");
    },

    GetStreets: async (_neighborhoodId) => {
        const wayResult = await executeQuery(SERVICE_TITLES.streetCenterLineWay, {
            returnGeometry: false,
            outFields: ["id", "yolortahatid"],
            where: buildEqualsFilter("mahalleid", _neighborhoodId)
        });

        if (wayResult?.type === Constants_ServiceResultType.Error) return wayResult;

        const centerLineIds = (wayResult?.data ?? [])
            .map((item) => item?.attr?.yolortahatid)
            .filter(hasIdentifier);
        const centerLineFilter = buildInFilter("id", centerLineIds);
        if (!centerLineFilter) return emptyResult();

        return executeQuery(SERVICE_TITLES.streetCenterLine, {
            returnGeometry: false,
            orderByFields: ["ad"],
            returnDistinctValues: true,
            where: centerLineFilter,
            outFields: ["ad", "yolid"]
        }, "ad");
    },

    GetStreetCenterLines: async (_streetId) => {
        const result = await executeQuery(SERVICE_TITLES.streetCenterLine, {
            returnGeometry: true,
            orderByFields: ["ad"],
            where: buildEqualsFilter("yolid", _streetId),
            outFields: ["ad", "id", "yolid"]
        }, "ad");
        return result?.data ?? [];
    },

    GetStreetWaysofCenterLinesByCenterlineIDs: async (_centerlineIDs) => {
        const where = buildInFilter("yolortahatid", _centerlineIDs);
        if (!where) return emptyResult();
        return executeQuery(SERVICE_TITLES.streetCenterLineWay, {
            returnGeometry: false,
            outFields: ["id"],
            where
        });
    },

    GetDoorsByWayIDs: async (_wayIDs) => {
        const where = buildInFilter("yolortahatyonid", _wayIDs);
        if (!where) return emptyResult();
        return executeQuery(SERVICE_TITLES.door, {
            returnGeometry: true,
            orderByFields: ["kapino"],
            outFields: ["id", "kapino"],
            where
        });
    },

    GetDoors: async (_streetId) => {
        const centerLines = await NumberingQueryBusiness.GetStreetCenterLines(_streetId);
        const centerLineIds = centerLines.map((item) => item?.attr?.id).filter(hasIdentifier);
        if (!centerLineIds.length) return emptyResult();

        const wayResult = await NumberingQueryBusiness.GetStreetWaysofCenterLinesByCenterlineIDs(centerLineIds);
        if (wayResult?.type === Constants_ServiceResultType.Error) return wayResult;

        const wayIds = (wayResult?.data ?? []).map((item) => item?.attr?.id).filter(hasIdentifier);
        if (!wayIds.length) return emptyResult();
        return NumberingQueryBusiness.GetDoorsByWayIDs(wayIds);
    },

    GetDoorById: async (_doorId) => executeQuery(SERVICE_TITLES.door, {
        returnGeometry: true,
        outFields: ["*"],
        where: buildEqualsFilter("id", _doorId)
    }),

    IntersectBuildingsWithMapPoint: async (mapPoint) => GisQueryHelper.ExecuteSpatialQuery(
        createOptions(SERVICE_TITLES.building, {
            geometry: mapPoint,
            distance: 1,
            units: "meters",
            spatialRelationship: "intersects",
            returnGeometry: true,
            outFields: ["*"]
        })
    ),

    GetStructureInfoOfBuilding: async (_building) => executeQuery(SERVICE_TITLES.structure, {
        returnGeometry: true,
        outFields: ["*"],
        where: buildEqualsFilter("id", readEntityId(_building))
    }),

    GetNumberingInfoOfStructure: async (_structure) => executeQuery(SERVICE_TITLES.numberingInfo, {
        returnGeometry: true,
        outFields: ["*"],
        where: buildEqualsFilter("yapi_id", readEntityId(_structure))
    }),

    GetBuildingDocumentCategoryList: () => [
        { Title: "Betonarme Projesi", Id: "betonarmeProjesi" },
        { Title: "Elektrik Proje", Id: "elektrikProje" },
        { Title: "İnşaat Ruhsatı", Id: "insaatRuhsati" },
        { Title: "Isıtma Tesisat", Id: "isitmaTesisat" },
        { Title: "İskan Ruhsatı", Id: "iskanRuhsati" },
        { Title: "Sıhhi Tesisat", Id: "sihhiTesisat" },
        { Title: "Statik Proje", Id: "statikProje" }
    ],

    GetBuildingDocumentList: async (_building, _category, _callback, options = {}) => {
        try {
            const result = await apiClient.get("/Common/FileService.svc/GetBuildingDocuments", {
                ...fileRequestOptions(options),
                params: {
                    buildingId: readEntityId(_building),
                    category: normalizeScalar(_category)
                }
            });
            return returnWithCallback(_callback, result);
        } catch (_error) {
            return returnWithCallback(_callback, null);
        }
    },

    GetBuildingPhotoList: async (_building, _callback, options = {}) => {
        try {
            const result = await apiClient.get("/Common/FileService.svc/GetBuildingPhotos", {
                ...fileRequestOptions(options),
                params: { buildingId: readEntityId(_building) }
            });
            return returnWithCallback(_callback, result);
        } catch (_error) {
            return returnWithCallback(_callback, null);
        }
    }
};
