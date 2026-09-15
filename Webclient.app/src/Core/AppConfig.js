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
        BaseUrl: runtimeConfig.apiBaseUrl,
        TkgmCityId: runtimeConfig.tkgmCityId
    },

    Keys: {
        LocalStorageKey: "3453-5948-1928-3885"
    }
};
