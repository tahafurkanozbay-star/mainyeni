import { AppError } from "../platform/errors/appError";
import { apiClient } from "../platform/http/httpClient";

const ensureServiceResult = (result) => {
    if (result && typeof result.isSuccess === "boolean") return result;
    throw new AppError("Geçersiz API yanıtı.", {
        code: "INVALID_RESPONSE",
        retryable: false
    });
};

const publicBootstrapOptions = (options = {}) => ({
    ...options,
    cache: true,
    dedupe: !options.signal,
    cacheTtlMs: options.cacheTtlMs ?? 120000
});

export const ConfigurationBusiness = {
    GetMapConfiguration: async (options = {}) => {
        const result = await apiClient.get("/AppSettings/List", {
            ...publicBootstrapOptions(options),
            params: { key: "GisMapConfig" }
        });
        return ensureServiceResult(result);
    },

    GetConfigServices: async (options = {}) => {
        const result = await apiClient.get(
            "/Gis/ConfigService/List",
            publicBootstrapOptions(options)
        );
        return ensureServiceResult(result);
    }
};
