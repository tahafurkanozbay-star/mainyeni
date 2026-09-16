import { GisGraphicsHelper } from "../../Toolbox/GisGraphicsHelper";
import { CommonReducer_ActionTypes } from "../Reducers/CommonReducer";
import { MapReducer_ActionTypes } from "../Reducers/MapReducer";
import Store from "../Store";

let viewStateBridge = null;
let viewPerformanceMonitor = null;

const getGraphics = () => {
    const graphics = Store.getState()?.Map?.Graphics;
    return Array.isArray(graphics) ? graphics : [];
};

const setGraphics = (graphics) => {
    Store.dispatch({
        type: MapReducer_ActionTypes.SetGraphics,
        payload: Array.isArray(graphics) ? graphics : []
    });
};

export const MapManager = {
    GetMapView: () => Store.getState().Map.MapView,

    GetMapClickEvent: () => Store.getState().Map.MapClick,

    SetMapClickEvent: (_event) => {
        Store.dispatch({
            type: MapReducer_ActionTypes.SetMapClickEvent,
            payload: _event
        });
    },

    SetMobileRightClick: (_value) => {
        Store.dispatch({
            type: MapReducer_ActionTypes.SetMobileRightClick,
            payload: _value
        });
    },

    GetMobileRightClick: () => Store.getState().Map.MobileRightClickEnabled,

    SetConfigurationServices: (_config) => {
        Store.dispatch({
            type: CommonReducer_ActionTypes.SetConfigurationServices,
            payload: _config
        });
    },

    GetConfigurationServices: () => Store.getState().Common.ConfigurationServices,

    SetMapConfiguration: (_config) => {
        Store.dispatch({
            type: CommonReducer_ActionTypes.SetMapConfiguration,
            payload: _config
        });
    },

    GetMapConfiguration: () => Store.getState().Common.MapConfiguration,

    SetViewStateBridge: (bridge) => {
        viewStateBridge = bridge || null;
        return viewStateBridge;
    },

    GetViewStateBridge: () => viewStateBridge,

    ClearViewStateBridge: (expectedBridge) => {
        if (expectedBridge && viewStateBridge !== expectedBridge) return false;
        viewStateBridge = null;
        return true;
    },

    GetViewState: () => viewStateBridge?.getState?.() || null,

    SetViewState: (next) => viewStateBridge?.setState?.(next) || null,

    SetViewPerformanceMonitor: (monitor) => {
        viewPerformanceMonitor = monitor || null;
        return viewPerformanceMonitor;
    },

    GetViewPerformanceSnapshot: () => viewPerformanceMonitor?.snapshot?.() || null,

    ClearViewPerformanceMonitor: (expectedMonitor) => {
        if (expectedMonitor && viewPerformanceMonitor !== expectedMonitor) return false;
        viewPerformanceMonitor = null;
        return true;
    },

    AddGraphics: (_graphic, _removePrevious = false) => {
        const mapView = MapManager.GetMapView();
        const current = getGraphics();

        if (_removePrevious && current.length) {
            GisGraphicsHelper.RemoveGraphics(mapView, current);
        }

        const next = _removePrevious ? [] : [...current];
        if (Array.isArray(_graphic)) next.push(..._graphic.filter(Boolean));
        else if (_graphic) next.push(_graphic);

        if (_graphic) GisGraphicsHelper.AddGraphics(mapView, _graphic);
        setGraphics(next);
        return next;
    },

    RemoveGraphics: (_graphics) => {
        const mapView = MapManager.GetMapView();
        const removing = new Set(
            (Array.isArray(_graphics) ? _graphics : [_graphics]).filter(Boolean)
        );
        if (!removing.size) return getGraphics();

        GisGraphicsHelper.RemoveGraphics(mapView, [...removing]);
        const next = getGraphics().filter((graphic) => !removing.has(graphic));
        setGraphics(next);
        return next;
    },

    RemoveAllGraphics: () => {
        const mapView = MapManager.GetMapView();
        GisGraphicsHelper.RemoveAllGraphics(mapView);
        setGraphics([]);
        return [];
    }
};

export default MapManager;
