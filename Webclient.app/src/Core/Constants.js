export const Constants_LoadingStatus = {
    NOT_SUBMITTED: 0,
    LOADING: 1,
    COMPLETED: 2,
    ERROR: 3
}

export const Constants_MessageType = {
    Success: "success",
    Warning: "warning",
    Info: "info",
    Error:"danger"
}

export const Constants_ServiceResultType = {
    Success: 10,
    Error: 20
};

export const Constants_LayerType = {
    MapImageLayer: 0,
    FeatureLayer: 2,
    WMSLayer: 3,
    GeoJSONLayer: 5
}

export const Constants_Symbols = {
    activeFillSymbol: { type: "simple-fill", color: [55, 55, 55, 0.3], outline: { color: "#b0ff5b", width: 3 } },
    polylineSymbol: { type: "simple-line", color: "#b0ff5b", width: 4 },
    pointSymbol: { type: "simple-marker", style: "circle", size: 8, color: [64, 64, 255], outline: { color: "#b0ff5b", width: 4 } },
    polygonSymbol: { type: "simple-fill", color: [255, 255, 255, 0.7], outline: { color: "#b0ff5b", width: 3 } }
}

export const Constants_ConfigKeys={
    BOOKMARKS: "a8s1xiapslcqxefef34jk",
    THEME_CHOICE: "kent-rehberi-theme-choice"
};

export const Constants_UserMesssages={
    LOCATION_ALLOWED:"Konumunuz kullanılıyor",
    LOCATION_REJECTED: "Konumunuz alınamadı, varsayılan konumdan itibaren arama yapılıyor"

}