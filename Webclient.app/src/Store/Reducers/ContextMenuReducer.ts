import {
  CONTEXT_MENU_ACTION_TYPES,
  initialContextMenuState,
  type ContextMenuState,
} from '../contracts';

export const ContextMenuReducer_ActionTypes = CONTEXT_MENU_ACTION_TYPES;

interface UnknownAction {
  readonly type: string;
  readonly payload?: unknown;
}

export const ContextMenuReducer = (
  state: ContextMenuState = initialContextMenuState,
  action: UnknownAction,
): ContextMenuState => {
  switch (action.type) {
    case ContextMenuReducer_ActionTypes.EnableOnLeftClick:
      return { ...state, ActiveOnLeftClick: true };
    case ContextMenuReducer_ActionTypes.DisableOnLeftClick:
      return { ...state, ActiveOnLeftClick: false };
    default:
      return state;
  }
};
