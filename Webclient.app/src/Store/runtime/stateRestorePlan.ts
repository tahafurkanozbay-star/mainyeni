import type {
  CommonAction,
  ContextMenuAction,
  MapAction,
  RootState,
  WindowRegistration,
} from '../contracts';
import {
  COMMON_ACTION_TYPES,
  CONTEXT_MENU_ACTION_TYPES,
  MAP_ACTION_TYPES,
} from '../contracts';
import type { SafeJsonValue, StoreStateProjection } from './contracts';

export type StoreRestoreAction = CommonAction | MapAction | ContextMenuAction;

export interface StoreRestorePlan {
  readonly schemaVersion: 1;
  readonly actions: readonly StoreRestoreAction[];
  readonly skippedWindows: number;
  readonly truncated: boolean;
}

const isSafeRecord = (value: SafeJsonValue | null): value is Readonly<Record<string, SafeJsonValue>> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const currentWindow = (
  state: RootState,
  windowId: string,
): WindowRegistration | null =>
  state.Common.WindowList.find((item) => item.id === windowId) ?? null;

export const planStoreSnapshotRestore = (
  snapshot: StoreStateProjection,
  current: RootState,
  maxActions = 256,
): StoreRestorePlan => {
  const safeMax = Number.isFinite(maxActions)
    ? Math.min(10_000, Math.max(1, Math.trunc(maxActions)))
    : 256;
  const actions: StoreRestoreAction[] = [];
  let skippedWindows = 0;
  let truncated = false;

  const push = (action: StoreRestoreAction): void => {
    if (actions.length >= safeMax) {
      truncated = true;
      return;
    }
    actions.push(action);
  };

  if (snapshot.common.moduleSelectBarVisible !== current.Common.ModuleSelectBarVisible) {
    push({
      type: COMMON_ACTION_TYPES.SetModuleSelectBarVisible,
      payload: snapshot.common.moduleSelectBarVisible,
    });
  }

  for (const saved of snapshot.common.windows) {
    const existing = currentWindow(current, saved.id);
    if (!existing) {
      skippedWindows += 1;
      continue;
    }

    if (existing.visible !== saved.visible) {
      push({
        type: COMMON_ACTION_TYPES.SetWindowVisibility,
        payload: {
          windowid: saved.id,
          visible: saved.visible,
          query: isSafeRecord(saved.query) ? saved.query : null,
        },
      });
    }
    if (existing.minimized !== saved.minimized) {
      push({
        type: COMMON_ACTION_TYPES.SetWindowMinimized,
        payload: {
          windowid: saved.id,
          minimized: saved.minimized,
        },
      });
    }
  }

  if (snapshot.map.mobileRightClickEnabled !== current.Map.MobileRightClickEnabled) {
    push({
      type: MAP_ACTION_TYPES.SetMobileRightClick,
      payload: snapshot.map.mobileRightClickEnabled,
    });
  }

  if (snapshot.contextMenu.activeOnLeftClick !== current.ContextMenu.ActiveOnLeftClick) {
    push({
      type: snapshot.contextMenu.activeOnLeftClick
        ? CONTEXT_MENU_ACTION_TYPES.EnableOnLeftClick
        : CONTEXT_MENU_ACTION_TYPES.DisableOnLeftClick,
    });
  }

  return Object.freeze({
    schemaVersion: 1,
    actions: Object.freeze(actions),
    skippedWindows,
    truncated,
  });
};
