import { NumberingQueryBusiness } from "./NumberingQueryBusiness";
import { GisQueryHelper } from "../Toolbox/GisQueryHelper";
import MapManager from "../Store/Managers/MapManager";
import { CommonBusiness } from "./CommonBusiness";
import { apiClient } from "../platform/http/httpClient";
import { Constants_ServiceResultType } from "../Core/Constants";

jest.mock("../Toolbox/GisQueryHelper", () => ({
    GisQueryHelper: {
        ExecuteQuery: jest.fn(),
        ExecuteSpatialQuery: jest.fn()
    }
}));

jest.mock("../Store/Managers/MapManager", () => ({
    __esModule: true,
    default: {
        GetConfigurationServices: jest.fn()
    }
}));

jest.mock("./CommonBusiness", () => ({
    CommonBusiness: {
        GenerateUrl: jest.fn()
    }
}));

jest.mock("../platform/http/httpClient", () => ({
    apiClient: {
        get: jest.fn()
    }
}));

const success = (data = []) => ({
    type: Constants_ServiceResultType.Success,
    data,
    fields: []
});

const service = (title) => ({ title, url: `/gis/${title}` });

const ALL_SERVICES = [
    "NumberingDistrictQueryUrl",
    "NumberingNeighborhoodQueryUrl",
    "StreetQueryUrl",
    "StreetCenterLineUrl",
    "StreetCenterLineWayUrl",
    "DoorQueryUrl",
    "BuildingQueryUrl",
    "StructureQueryUrl",
    "NumberingInfoQueryUrl"
].map(service);

describe("NumberingQueryBusiness address hardening", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        MapManager.GetConfigurationServices.mockReturnValue(ALL_SERVICES);
        CommonBusiness.GenerateUrl.mockImplementation((item) => item.url);
        GisQueryHelper.ExecuteQuery.mockResolvedValue(success());
        GisQueryHelper.ExecuteSpatialQuery.mockResolvedValue(success());
    });

    test("escapes SQL literals in direct address identifiers", async () => {
        await NumberingQueryBusiness.GetDistrictById("A'B");

        expect(GisQueryHelper.ExecuteQuery).toHaveBeenCalledWith(expect.objectContaining({
            where: "id='A''B'"
        }));
    });

    test("escapes Turkish text search literals instead of concatenating raw input", async () => {
        await NumberingQueryBusiness.GetDistricts({ DistrictName: "o'connor" });

        expect(GisQueryHelper.ExecuteQuery).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.stringContaining("O''CONNOR")
        }));
    });

    test("returns an empty result without issuing an invalid IN query when a neighborhood has no centerlines", async () => {
        GisQueryHelper.ExecuteQuery.mockResolvedValueOnce(success([]));

        const result = await NumberingQueryBusiness.GetStreets("nb-1");

        expect(result).toEqual(success([]));
        expect(GisQueryHelper.ExecuteQuery).toHaveBeenCalledTimes(1);
    });

    test("builds escaped IN filters from raw ids and sorts the returned street data", async () => {
        GisQueryHelper.ExecuteQuery
            .mockResolvedValueOnce(success([
                { attr: { yolortahatid: "center'2" } },
                { attr: { yolortahatid: "center-1" } }
            ]))
            .mockResolvedValueOnce(success([
                { attr: { ad: "Ziya", yolid: "2" } },
                { attr: { ad: "Atatürk", yolid: "1" } }
            ]));

        const result = await NumberingQueryBusiness.GetStreets("nb-1");

        expect(GisQueryHelper.ExecuteQuery).toHaveBeenNthCalledWith(2, expect.objectContaining({
            where: "id IN ('center''2','center-1')"
        }));
        expect(result.data.map((item) => item.attr.ad)).toEqual(["Atatürk", "Ziya"]);
    });

    test("accepts legacy pre-quoted id arrays but owns SQL quoting centrally", async () => {
        await NumberingQueryBusiness.GetStreetWaysofCenterLinesByCenterlineIDs(["'abc'", "def"]);

        expect(GisQueryHelper.ExecuteQuery).toHaveBeenCalledWith(expect.objectContaining({
            where: "yolortahatid IN ('abc','def')"
        }));
    });

    test("does not call the door service when the street has no centerline records", async () => {
        GisQueryHelper.ExecuteQuery.mockResolvedValueOnce(success([]));

        const result = await NumberingQueryBusiness.GetDoors("street-1");

        expect(result).toEqual(success([]));
        expect(GisQueryHelper.ExecuteQuery).toHaveBeenCalledTimes(1);
    });

    test("uses the same-origin platform client with bounded cache and dedupe for building documents", async () => {
        const documents = [{ id: 1 }];
        const callback = jest.fn();
        apiClient.get.mockResolvedValue(documents);

        await expect(NumberingQueryBusiness.GetBuildingDocumentList(
            { attr: { id: "building-1" } },
            "elektrikProje",
            callback
        )).resolves.toEqual(documents);

        expect(apiClient.get).toHaveBeenCalledWith(
            "/Common/FileService.svc/GetBuildingDocuments",
            expect.objectContaining({
                params: { buildingId: "building-1", category: "elektrikProje" },
                cache: true,
                dedupe: true,
                cacheTtlMs: 30000
            })
        );
        expect(callback).toHaveBeenCalledWith(documents);
    });

    test("forwards abort signals and disables dedupe for cancellable building photo requests", async () => {
        const controller = new AbortController();
        apiClient.get.mockResolvedValue([]);

        await NumberingQueryBusiness.GetBuildingPhotoList(
            { attr: { id: "building-2" } },
            null,
            { signal: controller.signal, cacheTtlMs: 5000 }
        );

        expect(apiClient.get).toHaveBeenCalledWith(
            "/Common/FileService.svc/GetBuildingPhotos",
            expect.objectContaining({
                signal: controller.signal,
                cache: true,
                dedupe: false,
                cacheTtlMs: 5000,
                params: { buildingId: "building-2" }
            })
        );
    });

    test("keeps the legacy callback contract on normalized file-service failures", async () => {
        const callback = jest.fn();
        apiClient.get.mockRejectedValue(new Error("network"));

        await expect(NumberingQueryBusiness.GetBuildingPhotoList(
            { attr: { id: "building-3" } },
            callback
        )).resolves.toBeNull();
        expect(callback).toHaveBeenCalledWith(null);
    });

    test("fails deterministically when a configured numbering service is missing", async () => {
        MapManager.GetConfigurationServices.mockReturnValue([]);

        await expect(NumberingQueryBusiness.GetDoorById("door-1")).rejects.toMatchObject({
            type: Constants_ServiceResultType.Error,
            message: "Servis bulunamadı (DoorQueryUrl)"
        });
        expect(GisQueryHelper.ExecuteQuery).not.toHaveBeenCalled();
    });
});
