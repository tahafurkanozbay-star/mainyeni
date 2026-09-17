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
      return { ...state, MapView: action.payload ?? null };

    case MapReducer_ActionTypes.SetGraphics:
      return {
        ...state,
        Graphics: Object.freeze(Array.isArray(action.payload) ? [...action.payload] : []),
      };

    case MapReducer_ActionTypes.SetMapUpdating:
      return { ...state, IsUpdating: action.payload === true };

    case MapReducer_ActionTypes.SetMapClickEvent:
      return {
        ...state,
        MapClick: typeof action.payload === 'function'
          ? action.payload as (event: unknown) => void
          : state.MapClick,
      };

    case MapReducer_ActionTypes.SetMobileRightClick:
      return { ...state, MobileRightClickEnabled: action.payload === true };

    default:
      return state;
  }
};
