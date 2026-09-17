import type { ServiceDescriptor, UnknownRecord } from '../Business/contracts';

export interface WindowRegistration {
  readonly id: string;
  readonly title?: string;
  readonly ref?: unknown;
  readonly visible?: boolean;
  readonly minimized?: boolean;
  readonly query?: UnknownRecord | null;
  readonly component?: unknown;
  readonly order?: number;
  readonly [key: string]: unknown;
}

export interface WindowCommandPayload {
  readonly windowid?: string;
  readonly visible?: boolean;
  readonly minimized?: boolean;
  readonly query?: UnknownRecord | null;
}

export interface MessageState {
  readonly Type?: string | number;
  readonly Data?: unknown;
  readonly Message?: string;
  readonly type?: string | number;
  readonly data?: unknown;
  readonly message?: string;
  readonly messageType?: string | number;
  readonly messageText?: string;
}

export interface CommonState {
  readonly BigPopupLinkRef: HTMLLinkElement | null;
  readonly WindowList: readonly WindowRegistration[];
  readonly ModuleSelectBarVisible: boolean;
  readonly MapConfiguration: UnknownRecord | null;
  readonly ConfigurationServices: readonly ServiceDescriptor[] | null;
  readonly Message: MessageState | null;
}

export interface MapState {
  readonly MapView: unknown;
  readonly IsUpdating: boolean;
  readonly Graphics: readonly unknown[];
  readonly MapClick: (event: unknown) => void;
  readonly MobileRightClickEnabled: boolean;
}

export interface ContextMenuState {
  readonly ActiveOnLeftClick: boolean;
}

export interface DynamicLayersState {
  readonly List: readonly unknown[];
}

export interface RootState {
  readonly DynamicLayers: DynamicLayersState;
  readonly ContextMenu: ContextMenuState;
  readonly Map: MapState;
  readonly Common: CommonState;
}

export const COMMON_ACTION_TYPES = Object.freeze({
  SetModuleSelectBarVisible: 'CommonReducer/SetModuleSelectBarVisible',
  RegisterWindow: 'CommonReducer/RegisterWindow',
  RemoveWindow: 'CommonReducer/RemoveWindow',
  ActivateWindow: 'CommonReducer/ActivateWindow',
  SetBigPopupLinkRef: 'CommonReducer/SetBigPopupLinkRef',
  SetWindowVisibility: 'CommonReducer/SetWindowVisibility',
  SetWindowMinimized: 'CommonReducer/SetWindowMinimized',
  SetConfigurationServices: 'CommonReducer/SetConfigurationServices',
  SetMapConfiguration: 'CommonReducer/SetMapConfiguration',
  SetMessage: 'CommonReducer/SetMessage',
} as const);

export const MAP_ACTION_TYPES = Object.freeze({
  SetMapView: 'MapReducer/SetMapView',
  SetGraphics: 'MapReducer/SetGraphics',
  SetMapUpdating: 'MapReducer/SetMapUpdating',
  SetMapClickEvent: 'MapReducer/SetMapClickEvent',
  SetMobileRightClick: 'MapReducer/SetMobileRightClick',
} as const);

export const CONTEXT_MENU_ACTION_TYPES = Object.freeze({
  EnableOnLeftClick: 'ActiveOnLeftClick/Enable',
  DisableOnLeftClick: 'ActiveOnLeftClick/Disable',
} as const);

export const DYNAMIC_LAYER_ACTION_TYPES = Object.freeze({
  Set: 'DynamicLayersReducer/Set',
  Add: 'DynamicLayersReducer/Add',
  Remove: 'DynamicLayersReducer/Remove',
  Replace: 'DynamicLayersReducer/Replace',
} as const);

export type CommonAction =
  | { readonly type: typeof COMMON_ACTION_TYPES.SetModuleSelectBarVisible; readonly payload: boolean }
  | { readonly type: typeof COMMON_ACTION_TYPES.RegisterWindow; readonly payload: WindowRegistration }
  | { readonly type: typeof COMMON_ACTION_TYPES.RemoveWindow; readonly payload: WindowCommandPayload }
  | { readonly type: typeof COMMON_ACTION_TYPES.ActivateWindow; readonly payload: WindowCommandPayload }
  | { readonly type: typeof COMMON_ACTION_TYPES.SetBigPopupLinkRef; readonly payload: HTMLLinkElement | null }
  | { readonly type: typeof COMMON_ACTION_TYPES.SetWindowVisibility; readonly payload: WindowCommandPayload }
  | { readonly type: typeof COMMON_ACTION_TYPES.SetWindowMinimized; readonly payload: WindowCommandPayload }
  | { readonly type: typeof COMMON_ACTION_TYPES.SetConfigurationServices; readonly payload: readonly ServiceDescriptor[] | null }
  | { readonly type: typeof COMMON_ACTION_TYPES.SetMapConfiguration; readonly payload: UnknownRecord | null }
  | { readonly type: typeof COMMON_ACTION_TYPES.SetMessage; readonly payload: MessageState | null }
  | { readonly type: string; readonly payload?: unknown };

export type MapAction =
  | { readonly type: typeof MAP_ACTION_TYPES.SetMapView; readonly payload: unknown }
  | { readonly type: typeof MAP_ACTION_TYPES.SetGraphics; readonly payload: readonly unknown[] }
  | { readonly type: typeof MAP_ACTION_TYPES.SetMapUpdating; readonly payload: boolean }
  | { readonly type: typeof MAP_ACTION_TYPES.SetMapClickEvent; readonly payload: (event: unknown) => void }
  | { readonly type: typeof MAP_ACTION_TYPES.SetMobileRightClick; readonly payload: boolean }
  | { readonly type: string; readonly payload?: unknown };

export type ContextMenuAction =
  | { readonly type: typeof CONTEXT_MENU_ACTION_TYPES.EnableOnLeftClick }
  | { readonly type: typeof CONTEXT_MENU_ACTION_TYPES.DisableOnLeftClick }
  | { readonly type: string; readonly payload?: unknown };

export type DynamicLayersAction =
  | { readonly type: typeof DYNAMIC_LAYER_ACTION_TYPES.Set; readonly payload: readonly unknown[] }
  | { readonly type: typeof DYNAMIC_LAYER_ACTION_TYPES.Add; readonly payload: unknown }
  | { readonly type: typeof DYNAMIC_LAYER_ACTION_TYPES.Remove; readonly payload: number }
  | { readonly type: typeof DYNAMIC_LAYER_ACTION_TYPES.Replace; readonly payload: readonly unknown[] }
  | { readonly type: string; readonly payload?: unknown };

export interface ViewStateBridge {
  readonly getState?: () => unknown;
  readonly setState?: (next: unknown) => unknown;
}

export interface ViewPerformanceMonitor {
  readonly snapshot?: () => unknown;
}

export interface MapViewLike {
  readonly map?: {
    readonly add?: (layer: unknown) => void;
    readonly remove?: (layer: unknown) => void;
  };
  readonly graphics?: unknown;
  readonly goTo?: (...args: readonly unknown[]) => Promise<unknown> | unknown;
  readonly [key: string]: unknown;
}

export interface StoreLike {
  readonly getState: () => RootState;
  readonly dispatch: (action: CommonAction | MapAction | ContextMenuAction | DynamicLayersAction) => unknown;
  readonly subscribe: (listener: () => void) => () => void;
}

export const initialCommonState: CommonState = Object.freeze({
  BigPopupLinkRef: null,
  WindowList: Object.freeze([]),
  ModuleSelectBarVisible: false,
  MapConfiguration: null,
  ConfigurationServices: null,
  Message: null,
});

export const initialMapState: MapState = Object.freeze({
  MapView: null,
  IsUpdating: false,
  Graphics: Object.freeze([]),
  MapClick: (_event: unknown) => undefined,
  MobileRightClickEnabled: false,
});

export const initialContextMenuState: ContextMenuState = Object.freeze({
  ActiveOnLeftClick: false,
});

export const initialDynamicLayersState: DynamicLayersState = Object.freeze({
  List: Object.freeze([]),
});

export const normalizeWindowRegistration = (value: WindowRegistration): WindowRegistration => Object.freeze({
  ...value,
  id: String(value.id),
  ref: value.ref ?? null,
  visible: value.visible ?? false,
  minimized: value.minimized ?? false,
  query: value.query ?? null,
});

export const upsertWindowRegistration = (
  windows: readonly WindowRegistration[],
  incoming: WindowRegistration | null | undefined,
): readonly WindowRegistration[] => {
  if (!incoming?.id) return windows;
  const index = windows.findIndex((item) => item.id === incoming.id);
  if (index < 0) return Object.freeze([...windows, normalizeWindowRegistration(incoming)]);

  const current = windows[index];
  if (!current) return windows;
  const next = normalizeWindowRegistration({
    ...current,
    ...incoming,
    ref: incoming.ref ?? current.ref ?? null,
    visible: incoming.visible ?? current.visible ?? false,
    minimized: incoming.minimized ?? current.minimized ?? false,
    query: incoming.query === undefined ? (current.query ?? null) : incoming.query,
  });
  return Object.freeze(windows.map((item, itemIndex) => itemIndex === index ? next : item));
};
