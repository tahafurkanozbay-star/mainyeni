import Store from "../Store";
import { MapReducer_ActionTypes } from "../Reducers/MapReducer";
import { GisGraphicsHelper } from "../../Toolbox/GisGraphicsHelper";
import MapManager from "./MapManager";

let mockState;

jest.mock("../Store", () => ({
    __esModule: true,
    default: {
        getState: jest.fn(),
        dispatch: jest.fn()
    }
}));

jest.mock("../Reducers/MapReducer", () => ({
    MapReducer_ActionTypes: {
        SetMapView: "SET_MAP_VIEW_TEST",
        SetMapClickEvent: "SET_CLICK_TEST",
        SetMobileRightClick: "SET_MOBILE_TEST",
        SetGraphics: "SET_GRAPHICS_TEST"
    }
}));

jest.mock("../Reducers/CommonReducer", () => ({
    CommonReducer_ActionTypes: {
        SetConfigurationServices: "SET_SERVICES_TEST",
        SetMapConfiguration: "SET_CONFIG_TEST"
    }
}));

jest.mock("../../Toolbox/GisGraphicsHelper", () => ({
    GisGraphicsHelper: {
        AddGraphics: jest.fn(),
        RemoveGraphics: jest.fn(),
        RemoveAllGraphics: jest.fn()
    }
}));

describe("MapManager GIS state ownership", () => {
    beforeEach(() => {
        mockState = {
            Map: {
                MapView: { id: "map-view" },
                MapClick: null,
                MobileRightClickEnabled: false,
                Graphics: []
            },
            Common: {
                ConfigurationServices: [],
                MapConfiguration: { Centerx: 32.85, Centery: 39.93 }
            }
        };
        jest.clearAllMocks();
        Store.getState.mockImplementation(() => mockState);
        Store.dispatch.mockImplementation(action => {
            if (action.type === "SET_GRAPHICS_TEST") {
                mockState.Map.Graphics = action.payload;
            }
            if (action.type === "SET_MAP_VIEW_TEST") {
                mockState.Map.MapView = action.payload;
            }
            return action;
        });
        MapManager.ClearViewStateBridge();
        MapManager.ClearViewPerformanceMonitor();
    });

    test("exposes current map view and configuration without mutation", () => {
        expect(MapManager.GetMapView()).toBe(mockState.Map.MapView);
        expect(MapManager.GetMapConfiguration()).toEqual({ Centerx: 32.85, Centery: 39.93 });
        expect(MapManager.GetConfigurationServices()).toEqual([]);
    });

    test("dispatches map click state", () => {
        const event = { x: 1, y: 2 };
        MapManager.SetMapClickEvent(event);

        expect(Store.dispatch).toHaveBeenCalledWith({
            type: MapReducer_ActionTypes.SetMapClickEvent,
            payload: event
        });
    });

    test("reads current mobile right click state", () => {
        mockState.Map.MobileRightClickEnabled = true;
        expect(MapManager.GetMobileRightClick()).toBe(true);
    });

    test("registers one shared view-state bridge", () => {
        const bridge = {
            getState: jest.fn(() => ({ mode: "2d", zoom: 12 })),
            setState: jest.fn(next => next)
        };

        expect(MapManager.SetViewStateBridge(bridge)).toBe(bridge);
        expect(MapManager.GetViewStateBridge()).toBe(bridge);
        expect(MapManager.GetViewState()).toEqual({ mode: "2d", zoom: 12 });
    });

    test("forwards view-state updates to the registered bridge", () => {
        const bridge = {
            getState: jest.fn(() => ({ mode: "2d" })),
            setState: jest.fn(() => ({ mode: "3d" }))
        };
        MapManager.SetViewStateBridge(bridge);

        const result = MapManager.SetViewState({ mode: "3d" });

        expect(bridge.setState).toHaveBeenCalledWith({ mode: "3d" });
        expect(result).toEqual({ mode: "3d" });
    });

    test("view-state methods are safe before a bridge exists", () => {
        expect(MapManager.GetViewState()).toBeNull();
        expect(MapManager.SetViewState({ mode: "3d" })).toBeNull();
    });

    test("conditional bridge cleanup does not remove a newer bridge", () => {
        const oldBridge = { id: "old" };
        const newBridge = { id: "new" };
        MapManager.SetViewStateBridge(newBridge);

        expect(MapManager.ClearViewStateBridge(oldBridge)).toBe(false);
        expect(MapManager.GetViewStateBridge()).toBe(newBridge);
    });

    test("conditional bridge cleanup removes the expected bridge", () => {
        const bridge = { id: "active" };
        MapManager.SetViewStateBridge(bridge);

        expect(MapManager.ClearViewStateBridge(bridge)).toBe(true);
        expect(MapManager.GetViewStateBridge()).toBeNull();
    });

    test("registers and exposes view performance snapshot", () => {
        const monitor = {
            snapshot: jest.fn(() => ({ averageUpdatingMs: 42 }))
        };
        MapManager.SetViewPerformanceMonitor(monitor);

        expect(MapManager.GetViewPerformanceSnapshot()).toEqual({ averageUpdatingMs: 42 });
        expect(monitor.snapshot).toHaveBeenCalledTimes(1);
    });

    test("conditional monitor cleanup protects a newer monitor", () => {
        const oldMonitor = { snapshot: jest.fn() };
        const currentMonitor = { snapshot: jest.fn(() => ({ ok: true })) };
        MapManager.SetViewPerformanceMonitor(currentMonitor);

        expect(MapManager.ClearViewPerformanceMonitor(oldMonitor)).toBe(false);
        expect(MapManager.GetViewPerformanceSnapshot()).toEqual({ ok: true });
    });

    test("AddGraphics does not mutate the Redux graphics array in place", () => {
        const existing = { id: "existing" };
        const incoming = { id: "incoming" };
        const originalArray = [existing];
        mockState.Map.Graphics = originalArray;

        const next = MapManager.AddGraphics(incoming);

        expect(next).toEqual([existing, incoming]);
        expect(next).not.toBe(originalArray);
        expect(originalArray).toEqual([existing]);
        expect(GisGraphicsHelper.AddGraphics).toHaveBeenCalledWith(mockState.Map.MapView, incoming);
        expect(Store.dispatch).toHaveBeenCalledWith({
            type: MapReducer_ActionTypes.SetGraphics,
            payload: [existing, incoming]
        });
    });

    test("AddGraphics can append an array without nesting it", () => {
        const a = { id: "a" };
        const b = { id: "b" };

        const next = MapManager.AddGraphics([a, b]);

        expect(next).toEqual([a, b]);
        expect(GisGraphicsHelper.AddGraphics).toHaveBeenCalledWith(mockState.Map.MapView, [a, b]);
    });

    test("AddGraphics ignores null entries inside an array", () => {
        const a = { id: "a" };
        expect(MapManager.AddGraphics([null, a, undefined])).toEqual([a]);
    });

    test("AddGraphics with removePrevious removes only tracked previous graphics", () => {
        const oldA = { id: "old-a" };
        const oldB = { id: "old-b" };
        const incoming = { id: "new" };
        mockState.Map.Graphics = [oldA, oldB];

        const next = MapManager.AddGraphics(incoming, true);

        expect(GisGraphicsHelper.RemoveGraphics).toHaveBeenCalledWith(
            mockState.Map.MapView,
            [oldA, oldB]
        );
        expect(next).toEqual([incoming]);
    });

    test("AddGraphics does not call map helper for an empty value", () => {
        expect(MapManager.AddGraphics(null)).toEqual([]);
        expect(GisGraphicsHelper.AddGraphics).not.toHaveBeenCalled();
    });

    test("RemoveGraphics removes only requested references from store", () => {
        const a = { id: "a" };
        const b = { id: "b" };
        const c = { id: "c" };
        mockState.Map.Graphics = [a, b, c];

        const next = MapManager.RemoveGraphics([a, c]);

        expect(GisGraphicsHelper.RemoveGraphics).toHaveBeenCalledWith(
            mockState.Map.MapView,
            [a, c]
        );
        expect(next).toEqual([b]);
        expect(mockState.Map.Graphics).toEqual([b]);
    });

    test("RemoveGraphics accepts one graphic reference", () => {
        const a = { id: "a" };
        const b = { id: "b" };
        mockState.Map.Graphics = [a, b];

        expect(MapManager.RemoveGraphics(a)).toEqual([b]);
        expect(GisGraphicsHelper.RemoveGraphics).toHaveBeenCalledWith(
            mockState.Map.MapView,
            [a]
        );
    });

    test("RemoveGraphics ignores null removal input", () => {
        const a = { id: "a" };
        mockState.Map.Graphics = [a];

        expect(MapManager.RemoveGraphics(null)).toEqual([a]);
        expect(GisGraphicsHelper.RemoveGraphics).not.toHaveBeenCalled();
        expect(Store.dispatch).not.toHaveBeenCalled();
    });

    test("RemoveAllGraphics clears both map and Redux state", () => {
        mockState.Map.Graphics = [{ id: "a" }, { id: "b" }];

        expect(MapManager.RemoveAllGraphics()).toEqual([]);
        expect(GisGraphicsHelper.RemoveAllGraphics).toHaveBeenCalledWith(mockState.Map.MapView);
        expect(mockState.Map.Graphics).toEqual([]);
    });

    test("graphics helpers tolerate malformed store graphics state", () => {
        mockState.Map.Graphics = null;
        const incoming = { id: "a" };

        expect(MapManager.AddGraphics(incoming)).toEqual([incoming]);
        expect(MapManager.RemoveGraphics(incoming)).toEqual([]);
    });
});
