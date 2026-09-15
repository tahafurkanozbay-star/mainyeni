import { apiClient } from "../platform/http/httpClient";
import { AppError } from "../platform/errors/appError";

const ensureServiceResult = (result) => {
    if (result && typeof result.isSuccess === "boolean") return result;
    throw new AppError("Geçersiz API yanıtı.", { code: "INVALID_RESPONSE", retryable: false });
};

export const ConfigurationBusiness = {
    GetMapConfiguration: async (options = {}) => {
        const result = await apiClient.get("/AppSettings/List", {
            ...options,
            params: { key: "GisMapConfig" },
            cacheTtlMs: options.cacheTtlMs ?? 120000
        });
        return ensureServiceResult(result);
    },

    GetConfigServices: async (options = {}) => {
        const result = await apiClient.get("/Gis/ConfigService/List", {
            ...options,
            cacheTtlMs: options.cacheTtlMs ?? 120000
        });
        return ensureServiceResult(result);
    }
};
