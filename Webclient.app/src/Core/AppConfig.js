export const AppConfig={
    App:{
        Title1: "Ankara Büyükşehir Belediyesi",
        Title2: "Kent Rehberi",
        Version: process.env.REACT_APP_VERSION,
        EsriApiVersion: process.env.REACT_APP_ESRI_API_VERSION,
        IsFullVersion: true
    },

    Api:{
        BaseUrl: process.env.REACT_APP_API_URL,
        TkgmCityId:process.env.REACT_APP_TKGM_CITY_ID
    },

    Keys:{
        LocalStorageKey: "3453-5948-1928-3885"
    }
}