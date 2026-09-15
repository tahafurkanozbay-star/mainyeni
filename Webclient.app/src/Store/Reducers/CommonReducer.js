import { unstable_renderSubtreeIntoContainer } from "react-dom";

const initialState = {
    BigPopupLinkRef:null,
    WindowList: [],
    ModuleSelectBarVisible: false,
    MapConfiguration: null,
    ConfigurationServices: null,

    Message: null
}

export const CommonReducer_ActionTypes = {
    SetModuleSelectBarVisible: "CommonReducer/SetModuleSelectBarVisible",

    RegisterWindow: "CommonReducer/RegisterWindow",

    SetBigPopupLinkRef: "CommonReducer/SetBigPopupLinkRef",
    SetWindowVisibility: "CommonReducer/SetWindowVisibility",
    SetWindowMinimized: "CommonReducer/SetWindowMinimized",
    SetConfigurationServices: "CommonReducer/SetConfigurationServices",
    SetMapConfiguration: "CommonReducer/SetMapConfiguration",
    SetMessage: "CommonReducer/SetMessage",
}

export const CommonReducer = (state = initialState, action) => {

    let windowList = [...state.WindowList];

    switch (action.type) {

        case CommonReducer_ActionTypes.SetBigPopupLinkRef:
            return { ...state, BigPopupLinkRef: action.payload };

        case CommonReducer_ActionTypes.SetModuleSelectBarVisible:
            return { ...state, ModuleSelectBarVisible: action.payload };

        case CommonReducer_ActionTypes.RegisterWindow:
            windowList.push(action.payload);
            return { ...state, WindowList: windowList };

        case CommonReducer_ActionTypes.SetWindowVisibility:
            let index= windowList.findIndex(x => x.id == action.payload.windowid);
            windowList[index].visible=action.payload.visible;
            return { ...state, WindowList: windowList };

        case CommonReducer_ActionTypes.SetWindowMinimized:
            let _index= windowList.findIndex(x => x.id == action.payload.windowid);
            windowList[_index].minimized=action.payload.minimized;
            return { ...state, WindowList: windowList };

        case CommonReducer_ActionTypes.SetMapConfiguration:
            return { ...state, MapConfiguration: action.payload };

        case CommonReducer_ActionTypes.SetConfigurationServices:
            return { ...state, ConfigurationServices: action.payload };

        case CommonReducer_ActionTypes.SetMessage:
            return { ...state, Message: action.payload };

        default:
            return state
    }
}