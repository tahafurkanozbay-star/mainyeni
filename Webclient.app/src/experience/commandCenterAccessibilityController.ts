import {
  type CommandCenterInputModality,
  type CommandCenterInteractionModel,
  type CommandCenterState,
} from './commandCenterInteractionModel';

export interface CommandCenterKeyboardEventLike {
  readonly key: string;
  readonly altKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
  readonly defaultPrevented?: boolean;
  readonly isComposing?: boolean;
  preventDefault(): void;
}

export interface CommandCenterOptionPresentation {
  readonly commandId: string;
  readonly domId: string;
  readonly label: string;
  readonly group: string;
  readonly description: string;
  readonly active: boolean;
  readonly position: number;
  readonly setSize: number;
  readonly tabIndex: -1;
  readonly ariaSelected: boolean;
}

export interface CommandCenterAccessibilitySnapshot {
  readonly open: boolean;
  readonly query: string;
  readonly inputId: string;
  readonly listboxId: string;
  readonly statusId: string;
  readonly activeDescendant: string | null;
  readonly activePosition: number | null;
  readonly resultCount: number;
  readonly announcement: string;
  readonly options: readonly CommandCenterOptionPresentation[];
}

export type CommandCenterControllerIntent =
  | { readonly type: 'none' }
  | { readonly type: 'execute'; readonly commandId: string }
  | { readonly type: 'closed' };

export interface CommandCenterControllerResult {
  readonly handled: boolean;
  readonly intent: CommandCenterControllerIntent;
  readonly state: CommandCenterState;
  readonly snapshot: CommandCenterAccessibilitySnapshot;
}

export interface CommandCenterAccessibilityController {
  readonly idPrefix: string;
  snapshot(): CommandCenterAccessibilitySnapshot;
  open(modality?: CommandCenterInputModality): CommandCenterControllerResult;
  close(modality?: CommandCenterInputModality): CommandCenterControllerResult;
  query(value: string, modality?: CommandCenterInputModality): CommandCenterControllerResult;
  activate(commandId: string, modality?: CommandCenterInputModality): CommandCenterControllerResult;
  handleKey(event: CommandCenterKeyboardEventLike): CommandCenterControllerResult;
}

const normalizePrefix = (value: string): string => {
  const normalized = String(value ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  return normalized || 'kr-command';
};

const optionDomId = (prefix: string, commandId: string): string =>
  `${prefix}-item-${commandId}`;

const buildSnapshot = (
  model: CommandCenterInteractionModel,
  prefix: string,
): CommandCenterAccessibilitySnapshot => {
  const state = model.getState();
  const setSize = state.matches.length;
  const options = Object.freeze(state.matches.map((match, index) => Object.freeze({
    commandId: match.item.id,
    domId: optionDomId(prefix, match.item.id),
    label: match.item.label,
    group: match.item.group,
    description: match.item.description,
    active: match.item.id === state.activeId,
    position: index + 1,
    setSize,
    tabIndex: -1 as const,
    ariaSelected: match.item.id === state.activeId,
  })));
  const activeIndex = state.activeId
    ? state.matches.findIndex(match => match.item.id === state.activeId)
    : -1;

  return Object.freeze({
    open: state.open,
    query: state.query,
    inputId: `${prefix}-input`,
    listboxId: `${prefix}-results`,
    statusId: `${prefix}-status`,
    activeDescendant: state.activeId
      ? optionDomId(prefix, state.activeId)
      : null,
    activePosition: activeIndex >= 0 ? activeIndex + 1 : null,
    resultCount: setSize,
    announcement: state.announcement,
    options,
  });
};

const noneIntent: CommandCenterControllerIntent = Object.freeze({ type: 'none' });
const closedIntent: CommandCenterControllerIntent = Object.freeze({ type: 'closed' });

const resultFor = (
  model: CommandCenterInteractionModel,
  prefix: string,
  handled: boolean,
  intent: CommandCenterControllerIntent = noneIntent,
): CommandCenterControllerResult => Object.freeze({
  handled,
  intent,
  state: model.getState(),
  snapshot: buildSnapshot(model, prefix),
});

const hasNavigationModifier = (event: CommandCenterKeyboardEventLike): boolean => Boolean(
  event.altKey || event.ctrlKey || event.metaKey || event.shiftKey,
);

const shouldIgnoreKeyboardEvent = (
  event: CommandCenterKeyboardEventLike,
): boolean => Boolean(
  event.defaultPrevented
  || event.isComposing
  || event.key === 'Dead'
  || event.key === 'Process',
);

export const createCommandCenterAccessibilityController = (
  model: CommandCenterInteractionModel,
  idPrefix = 'kr-command',
): CommandCenterAccessibilityController => {
  const prefix = normalizePrefix(idPrefix);

  const transition = (
    action: Parameters<CommandCenterInteractionModel['dispatch']>[0],
    handled = true,
    intent: CommandCenterControllerIntent = noneIntent,
  ): CommandCenterControllerResult => {
    model.dispatch(action);
    return resultFor(model, prefix, handled, intent);
  };

  const handleKey = (
    event: CommandCenterKeyboardEventLike,
  ): CommandCenterControllerResult => {
    if (shouldIgnoreKeyboardEvent(event)) return resultFor(model, prefix, false);

    const key = event.key;
    if (key === 'Escape' && !hasNavigationModifier(event)) {
      if (!model.getState().open) return resultFor(model, prefix, false);
      event.preventDefault();
      model.dispatch({ type: 'close', modality: 'keyboard' });
      return resultFor(model, prefix, true, closedIntent);
    }

    if (hasNavigationModifier(event)) return resultFor(model, prefix, false);

    switch (key) {
      case 'ArrowDown':
        event.preventDefault();
        return transition({ type: 'move', delta: 1, modality: 'keyboard' });
      case 'ArrowUp':
        event.preventDefault();
        return transition({ type: 'move', delta: -1, modality: 'keyboard' });
      case 'Home':
        event.preventDefault();
        return transition({ type: 'first', modality: 'keyboard' });
      case 'End':
        event.preventDefault();
        return transition({ type: 'last', modality: 'keyboard' });
      case 'PageDown':
        event.preventDefault();
        return transition({ type: 'page-forward', modality: 'keyboard' });
      case 'PageUp':
        event.preventDefault();
        return transition({ type: 'page-backward', modality: 'keyboard' });
      case 'Enter': {
        const active = model.getActiveMatch();
        if (!model.canExecuteActive() || !active) {
          return resultFor(model, prefix, false);
        }
        event.preventDefault();
        return resultFor(model, prefix, true, Object.freeze({
          type: 'execute',
          commandId: active.item.id,
        }));
      }
      default:
        return resultFor(model, prefix, false);
    }
  };

  return Object.freeze({
    idPrefix: prefix,
    snapshot: () => buildSnapshot(model, prefix),
    open: (modality: CommandCenterInputModality = 'programmatic') => transition({
      type: 'open',
      modality,
    }),
    close: (modality: CommandCenterInputModality = 'programmatic') => {
      if (!model.getState().open) return resultFor(model, prefix, false);
      return transition({ type: 'close', modality }, true, closedIntent);
    },
    query: (
      value: string,
      modality: CommandCenterInputModality = 'keyboard',
    ) => transition({ type: 'query', value, modality }),
    activate: (
      commandId: string,
      modality: CommandCenterInputModality = 'pointer',
    ) => transition({ type: 'activate', id: commandId, modality }),
    handleKey,
  });
};