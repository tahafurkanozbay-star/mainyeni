import { runtimeConfig } from "../platform/config/runtimeConfig";

export const AppConfig = {
    App: {
        Title1: "Ankara Büyükşehir Belediyesi",
        Title2: "Kent Rehberi",
        Version: runtimeConfig.release,
        EsriApiVersion: runtimeConfig.esriApiVersion || "4.21",
        IsFullVersion: true
    },

    Api: {
        // Kept as a compatibility facade for legacy modules. New code should use
        // the platform apiClient/runtimeConfig boundary directly.
        BaseUrl: runtimeConfig.apiBaseUrl,
        TkgmCityId: process.env.REACT_APP_TKGM_CITY_ID
    },

    Keys: {
        LocalStorageKey: "3453-5948-1928-3885"
    }
};
