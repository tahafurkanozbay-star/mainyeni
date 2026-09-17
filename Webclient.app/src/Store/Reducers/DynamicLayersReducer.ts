import {
  DYNAMIC_LAYER_ACTION_TYPES,
  initialDynamicLayersState,
  type DynamicLayersState,
} from '../contracts';

export const DynamicLayersReducer_ActionTypes = DYNAMIC_LAYER_ACTION_TYPES;

interface UnknownAction {
  readonly type: string;
  readonly payload?: unknown;
}

const asLayerList = (value: unknown): readonly unknown[] =>
  Object.freeze(Array.isArray(value) ? [...value] : []);

export const DynamicLayersReducer = (
  state: DynamicLayersState = initialDynamicLayersState,
  action: UnknownAction,
): DynamicLayersState => {
  switch (action.type) {
    case DynamicLayersReducer_ActionTypes.Set:
    case DynamicLayersReducer_ActionTypes.Replace:
      return { ...state, List: asLayerList(action.payload) };

    case DynamicLayersReducer_ActionTypes.Add:
      return { ...state, List: Object.freeze([...state.List, action.payload]) };

    case DynamicLayersReducer_ActionTypes.Remove: {
      const index = typeof action.payload === 'number' ? Math.trunc(action.payload) : -1;
      if (index < 0 || index >= state.List.length) return state;
      return {
        ...state,
        List: Object.freeze(state.List.filter((_item, itemIndex) => itemIndex !== index)),
      };
    }

    default:
      return state;
  }
};
