import { useEffect, useMemo, useReducer } from "react";
import { DebugHelper } from "../../Toolbox/DebugHelper";
import { CommonReducer_ActionTypes } from "../Reducers/CommonReducer";
import { MapReducer_ActionTypes } from "../Reducers/MapReducer";
import Store from "../Store";
import { LoggingBusiness } from "../../Business/LoggingBusiness";

const noop = () => {};

const callSafely = (callback) => {
    try {
        callback?.();
    } catch (error) {
        DebugHelper.Log(error);
    }
};

const schedule = (callback) => {
    if (typeof queueMicrotask === "function") queueMicrotask(callback);
    else Promise.resolve().then(callback);
};

export const createWindowManager = (requestRender = noop) => {
    let messageTimer = null;

    const getWindowList = () => Store.getState().Common.WindowList || [];
    const getWindow = (windowid) => getWindowList().find(item => item.id === windowid);
    const refresh = () => requestRender();

    const manager = {
        RegisterPlaceholder: (windowid, defaults = {}) => {
            if (!windowid || getWindow(windowid)) return false;

            Store.dispatch({
                type: CommonReducer_ActionTypes.RegisterWindow,
                payload: {
                    id: windowid,
                    ref: null,
                    visible: Boolean(defaults.visible),
                    minimized: Boolean(defaults.minimized),
                    query: defaults.query ?? {},
                    lazy: true
                }
            });
            return true;
        },

        RegisterWindow: (windowRef) => {
            const current = windowRef?.current;
            if (!current?.id) return false;

            const existing = getWindow(current.id);
            Store.dispatch({
                type: CommonReducer_ActionTypes.RegisterWindow,
                payload: {
                    id: current.id,
                    ref: windowRef,
                    visible: existing?.visible ?? Boolean(current.visible),
                    minimized: existing?.minimized ?? Boolean(current.minimized),
                    query: existing?.query ?? {},
                    lazy: false
                }
            });

            if (existing?.visible && existing.ref !== windowRef && current.OnShow) {
                schedule(() => callSafely(current.OnShow));
            }
            return true;
        },

        UnregisterWindow: (windowid, windowRef = null) => {
            const existing = getWindow(windowid);
            if (!existing) return false;
            if (windowRef && existing.ref && existing.ref !== windowRef) return false;

            Store.dispatch({
                type: CommonReducer_ActionTypes.RemoveWindow,
                payload: { windowid }
            });
            return true;
        },

        ToggleWindow: (windowid, query) => {
            const target = getWindow(windowid);
            if (!target) return false;
            return target.visible ? manager.HideWindow(windowid) : manager.ShowWindow(windowid, query);
        },

        ShowWindow: (windowid, query = {}) => {
            const target = getWindow(windowid);
            if (!target) {
                DebugHelper.Log(`Window not registered: ${windowid}`);
                return false;
            }

            callSafely(() => LoggingBusiness.CreateClientLog("Pencere Aç", windowid));

            getWindowList().forEach(item => {
                if (item.id !== windowid && item.visible) callSafely(item.ref?.current?.OnClose);
            });

            Store.dispatch({
                type: CommonReducer_ActionTypes.ActivateWindow,
                payload: { windowid, query: query ?? {} }
            });

            callSafely(target.ref?.current?.OnShow);
            refresh();
            return true;
        },

        GetQueryParams: (windowid) => getWindow(windowid)?.query,

        HideWindow: (windowid) => {
            const target = getWindow(windowid);
            if (!target) return false;

            callSafely(target.ref?.current?.OnClose);
            Store.dispatch({
                type: CommonReducer_ActionTypes.SetWindowVisibility,
                payload: { windowid, visible: false, query: {} }
            });
            refresh();
            return true;
        },

        ToggleMinimiseWindow: (windowid) => {
            const target = getWindow(windowid);
            if (!target) return false;

            Store.dispatch({
                type: CommonReducer_ActionTypes.SetWindowMinimized,
                payload: { windowid, minimized: !target.minimized }
            });
            refresh();
            return true;
        },

        IsVisible: (windowid) => Boolean(getWindow(windowid)?.visible),
        IsMinimized: (windowid) => Boolean(getWindow(windowid)?.minimized),
        GetMessage: () => Store.getState().Common.Message,

        ShowMessage: (type, text, durationSeconds = 5) => {
            if (messageTimer) clearTimeout(messageTimer);

            Store.dispatch({
                type: CommonReducer_ActionTypes.SetMessage,
                payload: {
                    messageType: type,
                    messageText: text
                }
            });
            refresh();

            messageTimer = setTimeout(() => {
                manager.RemoveMessage();
            }, Math.max(0, durationSeconds) * 1000);
        },

        RemoveMessage: () => {
            if (messageTimer) {
                clearTimeout(messageTimer);
                messageTimer = null;
            }
            Store.dispatch({ type: CommonReducer_ActionTypes.SetMessage, payload: null });
            refresh();
        },

        SetMapUpdating: (value) => {
            if (Store.getState().Map.IsUpdating === value) return;
            Store.dispatch({ type: MapReducer_ActionTypes.SetMapUpdating, payload: value });
            refresh();
        },

        GetMapUpdating: () => Boolean(Store.getState().Map.IsUpdating),

        Dispose: () => {
            if (messageTimer) clearTimeout(messageTimer);
            messageTimer = null;
        }
    };

    return manager;
};

// Backward-compatible factory for non-React callers. React components should use useWindowManager.
export const WindowManager = () => createWindowManager();

export const useWindowManager = () => {
    const [, forceRender] = useReducer(value => value + 1, 0);
    const manager = useMemo(() => createWindowManager(forceRender), [forceRender]);

    useEffect(() => () => manager.Dispose(), [manager]);
    return manager;
};
