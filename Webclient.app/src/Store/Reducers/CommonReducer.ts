import type { ServiceDescriptor, UnknownRecord } from '../../Business/contracts';
import {
  COMMON_ACTION_TYPES,
  initialCommonState,
  upsertWindowRegistration,
  type CommonState,
  type MessageState,
  type WindowCommandPayload,
  type WindowRegistration,
} from '../contracts';

export const CommonReducer_ActionTypes = COMMON_ACTION_TYPES;
export { initialCommonState };

interface UnknownAction {
  readonly type: string;
  readonly payload?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isLinkElement = (value: unknown): value is HTMLLinkElement => {
  if (typeof HTMLLinkElement !== 'undefined') return value instanceof HTMLLinkElement;
  return isRecord(value)
    && String(value.tagName ?? '').toUpperCase() === 'LINK'
    && typeof value.remove === 'function';
};

const asWindowCommand = (value: unknown): WindowCommandPayload => {
  if (!isRecord(value)) return Object.freeze({});
  return Object.freeze({
    ...(typeof value.windowid === 'string' ? { windowid: value.windowid } : {}),
    ...(typeof value.visible === 'boolean' ? { visible: value.visible } : {}),
    ...(typeof value.minimized === 'boolean' ? { minimized: value.minimized } : {}),
    ...(value.query === undefined ? {} : { query: isRecord(value.query) ? value.query as UnknownRecord : null }),
  });
};

const asWindowRegistration = (value: unknown): WindowRegistration | null => {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id.trim()) return null;
  return value as WindowRegistration;
};

const asServices = (value: unknown): readonly ServiceDescriptor[] | null => {
  if (value === null) return null;
  if (!Array.isArray(value)) return null;
  return Object.freeze(value.filter(isRecord).map((item) => Object.freeze(item) as ServiceDescriptor));
};

export const CommonReducer = (
  state: CommonState = initialCommonState,
  action: UnknownAction,
): CommonState => {
  switch (action.type) {
    case CommonReducer_ActionTypes.SetBigPopupLinkRef:
      return { ...state, BigPopupLinkRef: isLinkElement(action.payload) ? action.payload : null };

    case CommonReducer_ActionTypes.SetModuleSelectBarVisible:
      return { ...state, ModuleSelectBarVisible: action.payload === true };

    case CommonReducer_ActionTypes.RegisterWindow: {
      const incoming = asWindowRegistration(action.payload);
      if (!incoming) return state;
      return { ...state, WindowList: upsertWindowRegistration(state.WindowList, incoming) };
    }

    case CommonReducer_ActionTypes.RemoveWindow: {
      const payload = asWindowCommand(action.payload);
      if (!payload.windowid) return state;
      return {
        ...state,
        WindowList: Object.freeze(state.WindowList.filter((item) => item.id !== payload.windowid)),
      };
    }

    case CommonReducer_ActionTypes.ActivateWindow: {
      const payload = asWindowCommand(action.payload);
      const windowid = payload.windowid;
      if (!windowid || !state.WindowList.some((item) => item.id === windowid)) return state;
      return {
        ...state,
        WindowList: Object.freeze(state.WindowList.map((item) => Object.freeze({
          ...item,
          visible: item.id === windowid,
          query: item.id === windowid ? (payload.query ?? {}) : item.query,
        }))),
      };
    }

    case CommonReducer_ActionTypes.SetWindowVisibility: {
      const payload = asWindowCommand(action.payload);
      if (!payload.windowid) return state;
      return {
        ...state,
        WindowList: Object.freeze(state.WindowList.map((item) => item.id === payload.windowid
          ? Object.freeze({
            ...item,
            visible: payload.visible === true,
            query: payload.query === undefined ? item.query : payload.query,
          })
          : item)),
      };
    }

    case CommonReducer_ActionTypes.SetWindowMinimized: {
      const payload = asWindowCommand(action.payload);
      if (!payload.windowid) return state;
      return {
        ...state,
        WindowList: Object.freeze(state.WindowList.map((item) => item.id === payload.windowid
          ? Object.freeze({ ...item, minimized: payload.minimized === true })
          : item)),
      };
    }

    case CommonReducer_ActionTypes.SetMapConfiguration:
      return { ...state, MapConfiguration: isRecord(action.payload) ? action.payload as UnknownRecord : null };

    case CommonReducer_ActionTypes.SetConfigurationServices:
      return { ...state, ConfigurationServices: asServices(action.payload) };

    case CommonReducer_ActionTypes.SetMessage:
      return { ...state, Message: isRecord(action.payload) ? action.payload as MessageState : null };

    default:
      return state;
  }
};
