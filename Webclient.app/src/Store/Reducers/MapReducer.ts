import {
  MAP_ACTION_TYPES,
  initialMapState,
  type MapState,
} from '../contracts';

export const MapReducer_ActionTypes = MAP_ACTION_TYPES;

interface UnknownAction {
  readonly type: string;
  readonly payload?: unknown;
}

export const MapReducer = (
  state: MapState = initialMapState,
  action: UnknownAction,
): MapState => {
  switch (action.type) {
    case MapReducer_ActionTypes.SetMapView:
      return {
        ...state,
        MapView: action.payload ?? null,
        LastMapClickEvent: action.payload != null && state.MapView === action.payload
          ? state.LastMapClickEvent ?? null
          : null,
      };

    case MapReducer_ActionTypes.SetGraphics:
      return {
        ...state,
        Graphics: Object.freeze(Array.isArray(action.payload) ? [...action.payload] : []),
      };

    case MapReducer_ActionTypes.SetMapUpdating:
      return { ...state, IsUpdating: action.payload === true };

    case MapReducer_ActionTypes.SetMapClickEvent: {
      if (typeof action.payload === 'function') return { ...state, MapClick: action.payload as (event: unknown) => void, LastMapClickEvent: null };
      if (action.payload === null) return { ...state, LastMapClickEvent: null };
      if (!action.payload || typeof action.payload !== 'object' || Array.isArray(action.payload)) return state;
      const event = action.payload as { x?: unknown; y?: unknown; mapPoint?: unknown };
      if (!event.mapPoint || typeof event.mapPoint !== 'object' || Array.isArray(event.mapPoint)) return state;
      // Retain only the click intent; DOM pointer events and view internals do
      // not belong in the selection state. The callback contract stays intact.
      const selection = Object.freeze({
        ...(typeof event.x === 'number' && Number.isFinite(event.x) ? { x: event.x } : {}),
        ...(typeof event.y === 'number' && Number.isFinite(event.y) ? { y: event.y } : {}),
        mapPoint: event.mapPoint,
      });
      return { ...state, LastMapClickEvent: selection };
    }

    case MapReducer_ActionTypes.SetMobileRightClick:
      return { ...state, MobileRightClickEnabled: action.payload === true };

    default:
      return state;
  }
};
