const initialState = {

    MapView: null,
    IsUpdating: false,
    Graphics: [],
    MapClick: (event) => { },
    MobileRightClickEnabled: false
}

export const MapReducer_ActionTypes = {
    SetMapView: "MapReducer/SetMapView",
    SetGraphics: "MapReducer/SetGraphics",
    SetMapUpdating: "MapReducer/SetMapUpdating",
    SetMapClickEvent: "MapReducer/SetMapClickEvent",
    SetMobileRightClick: "MapReducer/SetMobileRightClick",
}

export const MapReducer = (state = initialState, action) => {
    switch (action.type) {

        case MapReducer_ActionTypes.SetMapView:
            return { ...state, MapView: action.payload };

        case MapReducer_ActionTypes.SetGraphics:
            return { ...state, Graphics: action.payload }

        case MapReducer_ActionTypes.SetMapUpdating:
            return { ...state, IsUpdating: action.payload }

        case MapReducer_ActionTypes.SetMapClickEvent:
            return { ...state, MapClick: action.payload }

        case MapReducer_ActionTypes.SetMobileRightClick:
            return { ...state, MobileRightClickEnabled: action.payload }

        default:
            return state
    }
}