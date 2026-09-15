export const Constants_LoadingStatus = {
    NOT_SUBMITTED: 0,
    LOADING: 1,
    COMPLETED: 2
}

export const Constants_ServiceResultType = {
    Success: 10,
    Error: 20
};

export const Constants_LayerType = {
    MapImageLayer: "0",
    FeatureLayer: "2",
    WMSLayer: "3"
}

export const Constants_EditingSymbols = {

    activeFillSymbol: {
        type: "simple-fill", // autocasts as new SimpleFillSymbol()
        color: [55, 55, 55, 0.3],
        outline: {
            color: "#b0ff5b",
            width: 3
        }
    },

    polylineSymbol: {
        type: "simple-line",
        color: "#b0ff5b",
        width: 4
    },

    pointSymbol: {
        type: "simple-marker",
        style: "circle",
        size: 8,
        color: [255, 255, 255],
        outline: {
            color: "#b0ff5b",
            width: 2
        }
    },

    polygonSymbol: {
        type: "simple-fill", // autocasts as new SimpleFillSymbol()
        color: [255, 255, 255, 0.7],
        outline: {
            // autocasts as new SimpleLineSymbol()
            color: "#b0ff5b",
            width: 3
        }
    }
}
