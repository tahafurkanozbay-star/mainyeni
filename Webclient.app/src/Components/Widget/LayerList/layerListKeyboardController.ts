import type { LayerListExperienceModel, LayerListVisibleRow } from './layerListExperienceModel';

export type LayerListKeyboardIntent =
  | 'none'
  | 'move-next'
  | 'move-previous'
  | 'move-first'
  | 'move-last'
  | 'move-page-next'
  | 'move-page-previous'
  | 'move-parent'
  | 'move-first-child'
  | 'toggle-expand'
  | 'toggle-visibility'
  | 'focus-search'
  | 'clear-query';

export interface LayerListKeyboardEventLike {
  readonly key: string;
  readonly code?: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
  readonly repeat?: boolean;
  readonly defaultPrevented?: boolean;
  readonly isComposing?: boolean;
}

export interface LayerListKeyboardDecision {
  readonly intent: LayerListKeyboardIntent;
  readonly handled: boolean;
  readonly preventDefault: boolean;
}

export interface LayerListKeyboardControllerOptions {
  readonly pageSize?: number;
}

const NAVIGATION_KEYS = new Set([
  'ArrowDown',
  'ArrowUp',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageDown',
  'PageUp',
]);

const EDITABLE_TAGS = new Set(['input', 'textarea', 'select']);

export const isLayerListEditableTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return EDITABLE_TAGS.has(target.tagName.toLowerCase());
};

export const evaluateLayerListKeyboardEvent = (
  event: LayerListKeyboardEventLike,
  activeRow: LayerListVisibleRow | null,
  hasQuery: boolean,
): LayerListKeyboardDecision => {
  if (event.defaultPrevented || event.isComposing) {
    return Object.freeze({ intent: 'none', handled: false, preventDefault: false });
  }

  if (event.ctrlKey || event.metaKey || event.altKey) {
    return Object.freeze({ intent: 'none', handled: false, preventDefault: false });
  }

  if (event.key === '/' && !event.repeat) {
    return Object.freeze({ intent: 'focus-search', handled: true, preventDefault: true });
  }

  if (event.key === 'Escape' && hasQuery) {
    return Object.freeze({ intent: 'clear-query', handled: true, preventDefault: true });
  }

  if (NAVIGATION_KEYS.has(event.key)) {
    switch (event.key) {
      case 'ArrowDown':
        return Object.freeze({ intent: 'move-next', handled: true, preventDefault: true });
      case 'ArrowUp':
        return Object.freeze({ intent: 'move-previous', handled: true, preventDefault: true });
      case 'ArrowLeft':
        return Object.freeze({ intent: 'move-parent', handled: true, preventDefault: true });
      case 'ArrowRight':
        return Object.freeze({ intent: 'move-first-child', handled: true, preventDefault: true });
      case 'Home':
        return Object.freeze({ intent: 'move-first', handled: true, preventDefault: true });
      case 'End':
        return Object.freeze({ intent: 'move-last', handled: true, preventDefault: true });
      case 'PageDown':
        return Object.freeze({ intent: 'move-page-next', handled: true, preventDefault: true });
      case 'PageUp':
        return Object.freeze({ intent: 'move-page-previous', handled: true, preventDefault: true });
    }
  }

  if (!activeRow || activeRow.disabled) {
    return Object.freeze({ intent: 'none', handled: false, preventDefault: false });
  }

  if ((event.key === 'Enter' || event.key === ' ') && !event.repeat) {
    return Object.freeze({
      intent: activeRow.kind === 'group' ? 'toggle-expand' : 'toggle-visibility',
      handled: true,
      preventDefault: true,
    });
  }

  return Object.freeze({ intent: 'none', handled: false, preventDefault: false });
};

export interface LayerListKeyboardController {
  readonly handleKeyDown: (
    event: KeyboardEvent,
    activeRow: LayerListVisibleRow | null,
    hasQuery: boolean,
  ) => LayerListKeyboardIntent;
}

export const createLayerListKeyboardController = (
  model: LayerListExperienceModel,
  focusSearch: () => void,
  onToggleVisibility: (row: LayerListVisibleRow) => void,
): LayerListKeyboardController => ({
  handleKeyDown(event, activeRow, hasQuery) {
    if (isLayerListEditableTarget(event.target) && event.key !== 'Escape') return 'none';
    const decision = evaluateLayerListKeyboardEvent(event, activeRow, hasQuery);
    if (!decision.handled) return 'none';
    if (decision.preventDefault) event.preventDefault();

    switch (decision.intent) {
      case 'move-next': model.moveActive('next'); break;
      case 'move-previous': model.moveActive('previous'); break;
      case 'move-first': model.moveActive('first'); break;
      case 'move-last': model.moveActive('last'); break;
      case 'move-page-next': model.moveActive('page-next'); break;
      case 'move-page-previous': model.moveActive('page-previous'); break;
      case 'move-parent': model.moveActive('parent'); break;
      case 'move-first-child': model.moveActive('first-child'); break;
      case 'toggle-expand':
        if (activeRow?.kind === 'group') model.toggleGroup(activeRow.groupId);
        break;
      case 'toggle-visibility':
        if (activeRow?.kind === 'layer') onToggleVisibility(activeRow);
        break;
      case 'focus-search': focusSearch(); break;
      case 'clear-query': model.clearQuery(); break;
      case 'none': break;
    }
    return decision.intent;
  },
});
