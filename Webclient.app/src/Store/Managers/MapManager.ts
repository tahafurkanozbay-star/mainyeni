import { GisGraphicsHelper } from '../../Toolbox/GisGraphicsHelper';
import { CommonReducer_ActionTypes } from '../Reducers/CommonReducer';
import { MapReducer_ActionTypes } from '../Reducers/MapReducer';
import Store from '../Store';
import type { ServiceDescriptor, UnknownRecord } from '../../Business/contracts';
import type { ViewPerformanceMonitor, ViewStateBridge } from '../contracts';

let viewStateBridge: ViewStateBridge | null = null;
let viewPerformanceMonitor: ViewPerformanceMonitor | null = null;

const getGraphics = (): readonly unknown[] => {
  const graphics = Store.getState()?.Map?.Graphics;
  return Array.isArray(graphics) ? graphics : Object.freeze([]);
};

const setGraphics = (graphics: readonly unknown[]): void => {
  Store.dispatch({
    type: MapReducer_ActionTypes.SetGraphics,
    payload: Array.isArray(graphics) ? [...graphics] : [],
  });
};

const toGraphicArray = (value: unknown): readonly unknown[] => {
  if (Array.isArray(value)) return value.filter(Boolean);
  return value ? [value] : [];
};

export const MapManager = Object.freeze({
  GetMapView: (): unknown => Store.getState().Map.MapView,

  GetMapClickEvent: (): ((event: unknown) => void) => Store.getState().Map.MapClick,

  SetMapClickEvent: (event: (event: unknown) => void): void => {
    Store.dispatch({ type: MapReducer_ActionTypes.SetMapClickEvent, payload: event });
  },

  SetMobileRightClick: (value: boolean): void => {
    Store.dispatch({ type: MapReducer_ActionTypes.SetMobileRightClick, payload: Boolean(value) });
  },

  GetMobileRightClick: (): boolean => Store.getState().Map.MobileRightClickEnabled,

  SetConfigurationServices: (config: readonly ServiceDescriptor[] | null): void => {
    Store.dispatch({ type: CommonReducer_ActionTypes.SetConfigurationServices, payload: config });
  },

  GetConfigurationServices: (): readonly ServiceDescriptor[] => {
    const services = Store.getState().Common.ConfigurationServices;
    return Array.isArray(services) ? services : Object.freeze([]);
  },

  SetMapConfiguration: (config: UnknownRecord | null): void => {
    Store.dispatch({ type: CommonReducer_ActionTypes.SetMapConfiguration, payload: config });
  },

  GetMapConfiguration: (): UnknownRecord | null => Store.getState().Common.MapConfiguration,

  SetViewStateBridge: (bridge: ViewStateBridge | null | undefined): ViewStateBridge | null => {
    viewStateBridge = bridge ?? null;
    return viewStateBridge;
  },

  GetViewStateBridge: (): ViewStateBridge | null => viewStateBridge,

  ClearViewStateBridge: (expectedBridge?: ViewStateBridge | null): boolean => {
    if (expectedBridge && viewStateBridge !== expectedBridge) return false;
    viewStateBridge = null;
    return true;
  },

  GetViewState: (): unknown => viewStateBridge?.getState?.() ?? null,

  SetViewState: (next: unknown): unknown => viewStateBridge?.setState?.(next) ?? null,

  SetViewPerformanceMonitor: (
    monitor: ViewPerformanceMonitor | null | undefined,
  ): ViewPerformanceMonitor | null => {
    viewPerformanceMonitor = monitor ?? null;
    return viewPerformanceMonitor;
  },

  GetViewPerformanceSnapshot: (): unknown => viewPerformanceMonitor?.snapshot?.() ?? null,

  ClearViewPerformanceMonitor: (expectedMonitor?: ViewPerformanceMonitor | null): boolean => {
    if (expectedMonitor && viewPerformanceMonitor !== expectedMonitor) return false;
    viewPerformanceMonitor = null;
    return true;
  },

  AddGraphics: (graphic: unknown, removePrevious = false): readonly unknown[] => {
    const mapView = MapManager.GetMapView();
    const current = getGraphics();

    if (removePrevious && current.length > 0) {
      GisGraphicsHelper.RemoveGraphics(mapView, current);
    }

    const next = removePrevious ? [] : [...current];
    const adding = toGraphicArray(graphic);
    next.push(...adding);

    if (adding.length > 0) GisGraphicsHelper.AddGraphics(mapView, Array.isArray(graphic) ? adding : graphic);
    const frozen = Object.freeze(next);
    setGraphics(frozen);
    return frozen;
  },

  RemoveGraphics: (graphics: unknown): readonly unknown[] => {
    const mapView = MapManager.GetMapView();
    const removing = new Set(toGraphicArray(graphics));
    if (removing.size === 0) return getGraphics();

    GisGraphicsHelper.RemoveGraphics(mapView, [...removing]);
    const next = Object.freeze(getGraphics().filter((graphic) => !removing.has(graphic)));
    setGraphics(next);
    return next;
  },

  RemoveAllGraphics: (): readonly unknown[] => {
    const mapView = MapManager.GetMapView();
    GisGraphicsHelper.RemoveAllGraphics(mapView);
    const next = Object.freeze([]) as readonly unknown[];
    setGraphics(next);
    return next;
  },
});

export default MapManager;
