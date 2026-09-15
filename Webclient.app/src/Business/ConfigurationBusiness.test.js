import axios from "axios";
import { AuthBusiness } from "./AuthBusiness";
import { ConfigurationBusiness } from "./ConfigurationBusiness";

jest.mock("axios", () => jest.fn());
jest.mock("./AuthBusiness", () => ({
    AuthBusiness: {
        GetRequestHeaders: jest.fn()
    }
}));

describe("ConfigurationBusiness", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        AuthBusiness.GetRequestHeaders.mockResolvedValue({ Authorization: "Bearer test" });
    });

    test("loads map configuration through the configured API base URL", async () => {
        const response = { isSuccess: true, data: { configValue: "{}" } };
        axios.mockResolvedValue({ data: response });

        await expect(ConfigurationBusiness.GetMapConfiguration()).resolves.toEqual(response);
        expect(axios).toHaveBeenCalledWith(expect.objectContaining({
            method: "get",
            url: expect.stringContaining("/AppSettings/List?key=GisMapConfig"),
            headers: { Authorization: "Bearer test" }
        }));
    });

    test("loads GIS service configuration through the configured API base URL", async () => {
        const response = { isSuccess: true, data: [] };
        axios.mockResolvedValue({ data: response });

        await expect(ConfigurationBusiness.GetConfigServices()).resolves.toEqual(response);
        expect(axios).toHaveBeenCalledWith(expect.objectContaining({
            method: "get",
            url: expect.stringContaining("/Gis/ConfigService/List"),
            headers: { Authorization: "Bearer test" }
        }));
    });

    test("propagates transport failures instead of leaving configuration loading pending", async () => {
        const failure = new Error("network unavailable");
        axios.mockRejectedValue(failure);

        await expect(ConfigurationBusiness.GetMapConfiguration()).rejects.toBe(failure);
    });
});
