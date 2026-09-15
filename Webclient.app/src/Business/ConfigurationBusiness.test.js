import { ConfigurationBusiness } from "./ConfigurationBusiness";
import { apiClient } from "../platform/http/httpClient";

jest.mock("../platform/http/httpClient", () => ({
    apiClient: {
        get: jest.fn()
    }
}));

describe("ConfigurationBusiness platform integration", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test("loads map configuration through the same-origin platform client with bounded cache", async () => {
        const response = { isSuccess: true, data: { configValue: "{}" } };
        apiClient.get.mockResolvedValue(response);

        await expect(ConfigurationBusiness.GetMapConfiguration()).resolves.toEqual(response);
        expect(apiClient.get).toHaveBeenCalledWith("/AppSettings/List", expect.objectContaining({
            params: { key: "GisMapConfig" },
            cache: true,
            dedupe: true,
            cacheTtlMs: 120000
        }));
    });

    test("forwards abort signals and disables request deduplication for cancellable bootstrap calls", async () => {
        const controller = new AbortController();
        const response = { isSuccess: true, data: [] };
        apiClient.get.mockResolvedValue(response);

        await ConfigurationBusiness.GetConfigServices({ signal: controller.signal, cacheTtlMs: 5000 });

        expect(apiClient.get).toHaveBeenCalledWith("/Gis/ConfigService/List", expect.objectContaining({
            signal: controller.signal,
            cache: true,
            dedupe: false,
            cacheTtlMs: 5000
        }));
    });

    test("rejects malformed service envelopes instead of accepting ambiguous configuration data", async () => {
        apiClient.get.mockResolvedValue({ data: [] });

        await expect(ConfigurationBusiness.GetConfigServices()).rejects.toMatchObject({
            name: "AppError",
            code: "INVALID_RESPONSE",
            retryable: false
        });
    });

    test("propagates normalized platform transport failures", async () => {
        const failure = Object.assign(new Error("Ağ bağlantısı kurulamadı."), { code: "NETWORK_ERROR" });
        apiClient.get.mockRejectedValue(failure);

        await expect(ConfigurationBusiness.GetMapConfiguration()).rejects.toBe(failure);
    });
});
