import { useState } from "react";
import { DebugHelper } from "../../Toolbox/DebugHelper";
import { TextHelper } from "../../Toolbox/TextHelper";
import { CommonReducer_ActionTypes } from "../Reducers/CommonReducer";
import { MapReducer_ActionTypes } from "../Reducers/MapReducer";
import Store from "../Store";
import { LoggingBusiness } from "../../Business/LoggingBusiness";

export const WindowManager = () => {

    const [x, setX] = useState();
    
    let obj = {};

    obj.RegisterWindow = (_windowRef) => {

        Store.dispatch(
            {
                type: CommonReducer_ActionTypes.RegisterWindow,
                payload: {
                    id: _windowRef.current.id,
                    ref: _windowRef,
                    visible: _windowRef?.current.visible,
                    minimized: _windowRef?.current.minimized
                }
            }
        );
    };


    obj.ToggleWindow = (_windowid) => {

        let windowList = Store.getState().Common.WindowList;

        const window = windowList.find(x => x.id == _windowid);
        if (window != null) {

            if (window.visible) {
                obj.HideWindow(_windowid);
            }
            else {
                obj.ShowWindow(_windowid);
            }
        }
    };

    obj.ShowWindow = (_windowid,query) => {

        //Tıklanan pencere loglaması
        LoggingBusiness.CreateClientLog("Pencere Aç", _windowid);

        let windowList = Store.getState().Common.WindowList;

        const window = windowList.find(x => x.id == _windowid);

        if (window != null) {
            windowList.forEach(_windowItem => {

                if (_windowItem.id != _windowid) {

                    if (_windowItem.visible) {
                        try {
                            _windowItem.ref.current.OnClose();
                        } catch (ex) { DebugHelper.Log(ex) }
                    }

                    _windowItem.visible = false;
                }
            });
            
            window.query = query
            window.visible = true;
            try { window.ref.current.OnShow() } catch (ex) { DebugHelper.Log(ex) }

            Store.dispatch(
                {
                    type: CommonReducer_ActionTypes.SetWindowVisibility,
                    payload: { windowid: _windowid, visible: true, query:query }
                }
            )
            setX(TextHelper.CreateRandomNumber());
        }

    };

    obj.GetQueryParams = (_windowid) => {
        let windowList = Store.getState().Common.WindowList;
        const window = windowList.find(x => x.id == _windowid);
        return window?.query;
    };



    obj.HideWindow = (_windowid) => {

        let windowList = Store.getState().Common.WindowList;
        const window = windowList.find(x => x.id == _windowid);
        window.visible = true;
        window.query = {}
        try {
            window.ref.current.OnClose();
        } catch (ex) { DebugHelper.Log(ex) }


        Store.dispatch(
            {
                type: CommonReducer_ActionTypes.SetWindowVisibility,
                payload: { windowid: _windowid, visible: false, query:{} }
            }
        );
        setX(TextHelper.CreateRandomNumber());

    };

    obj.ToggleMinimiseWindow = (_windowid) => {

        let windowList = Store.getState().Common.WindowList;
        const window = windowList.find(x => x.id == _windowid);

        const _minimized = !window.minimized
        window.minimized = _minimized;

        Store.dispatch(
            {
                type: CommonReducer_ActionTypes.SetWindowMinimized,
                payload: { windowid: _windowid, minimized: _minimized }
            }
        );
        setX(TextHelper.CreateRandomNumber());

    };

    obj.IsVisible = (_windowid) => {
        let windowList = Store.getState().Common.WindowList;
        const window = windowList.find(x => x.id == _windowid);
        return window?.visible;
    };

    obj.IsMinimized = (_windowid) => {
        let windowList = Store.getState().Common.WindowList;
        const window = windowList.find(x => x.id == _windowid);
        return window?.minimized;
    }


    obj.GetMessage = () => {
        return Store.getState().Common.Message;
    };


    obj.ShowMessage = (_type, _text, _durationSeconds = 5) => {
        Store.dispatch({
            type: CommonReducer_ActionTypes.SetMessage,
            payload: {
                messageType: _type,
                messageText: _text
            }
        });
        setX(TextHelper.CreateRandomNumber());
        setTimeout(() => {
            obj.RemoveMessage();
        }, _durationSeconds * 1000);
    };

    obj.RemoveMessage = () => {
        Store.dispatch({
            type: CommonReducer_ActionTypes.SetMessage,
            payload: null
        });
        setX(TextHelper.CreateRandomNumber());
    };


    obj.SetMapUpdating = (_value) => {
        Store.dispatch({
            type: MapReducer_ActionTypes.SetMapUpdating,
            payload: _value
        });
        setX(TextHelper.CreateRandomNumber());
    };

    obj.GetMapUpdating = () => {
        return Store.getState().Map.IsUpdating;
    };

    return obj;
}