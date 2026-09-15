export const initialCommonState = {
    BigPopupLinkRef: null,
    WindowList: [],
    ModuleSelectBarVisible: false,
    MapConfiguration: null,
    ConfigurationServices: null,
    Message: null
};

export const CommonReducer_ActionTypes = {
    SetModuleSelectBarVisible: "CommonReducer/SetModuleSelectBarVisible",
    RegisterWindow: "CommonReducer/RegisterWindow",
    RemoveWindow: "CommonReducer/RemoveWindow",
    ActivateWindow: "CommonReducer/ActivateWindow",
    SetBigPopupLinkRef: "CommonReducer/SetBigPopupLinkRef",
    SetWindowVisibility: "CommonReducer/SetWindowVisibility",
    SetWindowMinimized: "CommonReducer/SetWindowMinimized",
    SetConfigurationServices: "CommonReducer/SetConfigurationServices",
    SetMapConfiguration: "CommonReducer/SetMapConfiguration",
    SetMessage: "CommonReducer/SetMessage"
};

const upsertWindow = (windows, incoming) => {
    if (!incoming?.id) return windows;

    const index = windows.findIndex(item => item.id === incoming.id);
    if (index < 0) return [...windows, incoming];

    const current = windows[index];
    const next = {
        ...current,
        ...incoming,
        ref: incoming.ref || current.ref || null,
        visible: incoming.visible ?? current.visible ?? false,
        minimized: incoming.minimized ?? current.minimized ?? false,
        query: incoming.query === undefined ? current.query : incoming.query
    };

    return windows.map((item, itemIndex) => itemIndex === index ? next : item);
};

export const CommonReducer = (state = initialCommonState, action) => {
    switch (action.type) {
        case CommonReducer_ActionTypes.SetBigPopupLinkRef:
            return { ...state, BigPopupLinkRef: action.payload };

        case CommonReducer_ActionTypes.SetModuleSelectBarVisible:
            return { ...state, ModuleSelectBarVisible: action.payload };

        case CommonReducer_ActionTypes.RegisterWindow:
            return { ...state, WindowList: upsertWindow(state.WindowList, action.payload) };

        case CommonReducer_ActionTypes.RemoveWindow:
            return {
                ...state,
                WindowList: state.WindowList.filter(item => item.id !== action.payload?.windowid)
            };

        case CommonReducer_ActionTypes.ActivateWindow: {
            const windowid = action.payload?.windowid;
            if (!windowid || !state.WindowList.some(item => item.id === windowid)) return state;

            return {
                ...state,
                WindowList: state.WindowList.map(item => ({
                    ...item,
                    visible: item.id === windowid,
                    query: item.id === windowid ? (action.payload?.query ?? {}) : item.query
                }))
            };
        }

        case CommonReducer_ActionTypes.SetWindowVisibility:
            return {
                ...state,
                WindowList: state.WindowList.map(item => item.id === action.payload?.windowid
                    ? {
                        ...item,
                        visible: Boolean(action.payload?.visible),
                        query: action.payload?.query === undefined ? item.query : action.payload.query
                    }
                    : item)
            };

        case CommonReducer_ActionTypes.SetWindowMinimized:
            return {
                ...state,
                WindowList: state.WindowList.map(item => item.id === action.payload?.windowid
                    ? { ...item, minimized: Boolean(action.payload?.minimized) }
                    : item)
            };

        case CommonReducer_ActionTypes.SetMapConfiguration:
            return { ...state, MapConfiguration: action.payload };

        case CommonReducer_ActionTypes.SetConfigurationServices:
            return { ...state, ConfigurationServices: action.payload };

        case CommonReducer_ActionTypes.SetMessage:
            return { ...state, Message: action.payload };

        default:
            return state;
    }
};
