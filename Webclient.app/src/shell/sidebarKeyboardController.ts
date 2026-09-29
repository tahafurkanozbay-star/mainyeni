import type { SidebarNavigationModel } from './sidebarNavigationModel';

export interface SidebarKeyboardEventLike {
  readonly key: string;
  readonly altKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
  readonly isComposing?: boolean;
}

export type SidebarKeyboardFocusTarget =
  | { readonly kind: 'active-item'; readonly windowId: string }
  | { readonly kind: 'search' }
  | { readonly kind: 'group'; readonly groupId: string }
  | null;

export interface SidebarKeyboardResult {
  readonly handled: boolean;
  readonly focus: SidebarKeyboardFocusTarget;
  readonly activateWindowId: string | null;
}

export interface SidebarKeyboardControllerOptions {
  readonly model: Pick<
    SidebarNavigationModel,
    | 'getSnapshot'
    | 'moveActive'
    | 'moveActiveByPage'
    | 'focusFirst'
    | 'focusLast'
    | 'clearQuery'
    | 'setCollapsed'
  >;
  readonly groupIds: readonly string[];
  readonly pageSize?: number;
}

export interface SidebarKeyboardController {
  readonly handleServiceKey: (event: SidebarKeyboardEventLike) => SidebarKeyboardResult;
  readonly handleSearchKey: (event: SidebarKeyboardEventLike) => SidebarKeyboardResult;
  readonly handleGroupKey: (event: SidebarKeyboardEventLike, currentGroupId: string) => SidebarKeyboardResult;
}

const unhandled = (): SidebarKeyboardResult => Object.freeze({
  handled: false,
  focus: null,
  activateWindowId: null,
});

const handled = (
  focus: SidebarKeyboardFocusTarget = null,
  activateWindowId: string | null = null,
): SidebarKeyboardResult => Object.freeze({ handled: true, focus, activateWindowId });

const hasCommandModifier = (event: SidebarKeyboardEventLike): boolean =>
  Boolean(event.altKey || event.ctrlKey || event.metaKey);

const clampPageSize = (value: number | undefined): number => {
  if (value === undefined || !Number.isFinite(value)) return 6;
  return Math.min(24, Math.max(1, Math.trunc(value)));
};

const focusForActive = (model: SidebarKeyboardControllerOptions['model']): SidebarKeyboardFocusTarget => {
  const activeItemId = model.getSnapshot().activeItemId;
  return activeItemId === null ? null : Object.freeze({ kind: 'active-item' as const, windowId: activeItemId });
};

export const createSidebarKeyboardController = (
  options: SidebarKeyboardControllerOptions,
): SidebarKeyboardController => {
  if (!options || !options.model || !Array.isArray(options.groupIds)) {
    throw new TypeError('Sidebar keyboard controller requires a model and group ids.');
  }

  const groupIds: readonly string[] = Object.freeze(options.groupIds.map((value) => {
    if (typeof value !== 'string' || !value.trim()) throw new TypeError('Sidebar keyboard group ids must be non-empty strings.');
    return value.trim();
  }));
  if (new Set(groupIds).size !== groupIds.length) throw new Error('Sidebar keyboard group ids must be unique.');
  const pageSize = clampPageSize(options.pageSize);
  const { model } = options;

  const handleServiceKey = (event: SidebarKeyboardEventLike): SidebarKeyboardResult => {
    if (!event || typeof event.key !== 'string') return unhandled();
    if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return unhandled();

    switch (event.key) {
      case 'ArrowDown':
        model.moveActive(1);
        return handled(focusForActive(model));
      case 'ArrowUp':
        model.moveActive(-1);
        return handled(focusForActive(model));
      case 'Home':
        model.focusFirst();
        return handled(focusForActive(model));
      case 'End':
        model.focusLast();
        return handled(focusForActive(model));
      case 'PageDown':
        model.moveActiveByPage(1, pageSize);
        return handled(focusForActive(model));
      case 'PageUp':
        model.moveActiveByPage(-1, pageSize);
        return handled(focusForActive(model));
      case 'Enter':
      case ' ':
      case 'Spacebar': {
        const activeItemId = model.getSnapshot().activeItemId;
        return activeItemId === null ? handled() : handled(null, activeItemId);
      }
      case 'Escape': {
        const snapshot = model.getSnapshot();
        if (snapshot.query) {
          model.clearQuery();
          return handled(Object.freeze({ kind: 'search' as const }));
        }
        model.setCollapsed(true);
        return handled(Object.freeze({ kind: 'search' as const }));
      }
      default:
        return unhandled();
    }
  };

  const handleSearchKey = (event: SidebarKeyboardEventLike): SidebarKeyboardResult => {
    if (!event || typeof event.key !== 'string') return unhandled();
    if (event.isComposing) return unhandled();

    if (event.key === 'ArrowDown' && !hasCommandModifier(event)) {
      model.focusFirst();
      return handled(focusForActive(model));
    }
    if (event.key === 'ArrowUp' && !hasCommandModifier(event)) {
      model.focusLast();
      return handled(focusForActive(model));
    }
    if (event.key === 'Escape' && !hasCommandModifier(event)) {
      if (model.getSnapshot().query) model.clearQuery();
      return handled(Object.freeze({ kind: 'search' as const }));
    }
    if (event.key === 'Home' && (event.ctrlKey || event.metaKey) && !event.altKey) {
      model.focusFirst();
      return handled(focusForActive(model));
    }
    if (event.key === 'End' && (event.ctrlKey || event.metaKey) && !event.altKey) {
      model.focusLast();
      return handled(focusForActive(model));
    }
    return unhandled();
  };

  const handleGroupKey = (
    event: SidebarKeyboardEventLike,
    currentGroupId: string,
  ): SidebarKeyboardResult => {
    if (!event || typeof event.key !== 'string' || event.isComposing || hasCommandModifier(event)) return unhandled();
    const currentIndex = groupIds.indexOf(currentGroupId);
    if (currentIndex < 0 || groupIds.length === 0) return unhandled();

    let nextIndex: number | null = null;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        nextIndex = (currentIndex + 1) % groupIds.length;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        nextIndex = (currentIndex - 1 + groupIds.length) % groupIds.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = groupIds.length - 1;
        break;
      default:
        return unhandled();
    }

    const groupId = groupIds[nextIndex];
    return groupId === undefined
      ? unhandled()
      : handled(Object.freeze({ kind: 'group' as const, groupId }));
  };

  return Object.freeze({ handleServiceKey, handleSearchKey, handleGroupKey });
};
