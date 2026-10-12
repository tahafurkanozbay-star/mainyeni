import type {
  WindowWorkspaceMove,
  WindowWorkspaceSnapshot,
} from './windowWorkspaceModel';

export type WindowWorkspaceKeyboardIntent =
  | { readonly kind: 'none' }
  | { readonly kind: 'open-dock' }
  | { readonly kind: 'close-dock' }
  | { readonly kind: 'clear-query' }
  | { readonly kind: 'move'; readonly move: WindowWorkspaceMove }
  | { readonly kind: 'activate'; readonly windowId: string }
  | { readonly kind: 'focus-search' };

export interface WindowWorkspaceKeyboardEventLike {
  readonly key: string;
  readonly code?: string;
  readonly altKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
  readonly repeat?: boolean;
  readonly defaultPrevented?: boolean;
  readonly isComposing?: boolean;
  readonly target?: EventTarget | null;
  readonly nativeEvent?: Readonly<{ isComposing?: boolean }>;
}

export interface WindowWorkspaceKeyboardContext {
  readonly open: boolean;
  readonly snapshot: WindowWorkspaceSnapshot;
  readonly source: 'global' | 'search' | 'entry';
  readonly currentWindowId?: string | null;
}

export interface WindowWorkspaceKeyboardPolicy {
  readonly shortcutLabel: string;
  readonly ariaKeyShortcut: string;
  readonly evaluate: (
    event: WindowWorkspaceKeyboardEventLike,
    context: WindowWorkspaceKeyboardContext,
  ) => WindowWorkspaceKeyboardIntent;
}

export const WINDOW_WORKSPACE_SHORTCUT_LABEL = 'Alt+W';
export const WINDOW_WORKSPACE_ARIA_SHORTCUT = 'Alt+W';

const MOVES: Readonly<Partial<Record<string, WindowWorkspaceMove>>> = Object.freeze({
  ArrowDown: 'next',
  ArrowUp: 'previous',
  Home: 'first',
  End: 'last',
  PageDown: 'page-next',
  PageUp: 'page-previous',
});

const normalizeKey = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const isCompositionEvent = (event: WindowWorkspaceKeyboardEventLike): boolean =>
  event.isComposing === true
  || event.nativeEvent?.isComposing === true
  || event.key === 'Process'
  || event.key === 'Dead';

const isEditableTarget = (target: EventTarget | null | undefined): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName.toLowerCase();
  if (tag === 'textarea' || tag === 'select') return true;
  if (tag !== 'input') return false;
  const input = target as HTMLInputElement;
  const type = (input.type || 'text').toLowerCase();
  return !['button', 'checkbox', 'radio', 'range', 'color', 'file', 'submit', 'reset'].includes(type);
};

const hasCommandModifier = (event: WindowWorkspaceKeyboardEventLike): boolean =>
  event.ctrlKey === true || event.metaKey === true;

const isGlobalShortcut = (event: WindowWorkspaceKeyboardEventLike): boolean => {
  const key = normalizeKey(event.key).toLocaleLowerCase('tr-TR');
  return key === 'w'
    && event.altKey === true
    && event.ctrlKey !== true
    && event.metaKey !== true
    && event.shiftKey !== true;
};

const selectedWindowId = (
  snapshot: WindowWorkspaceSnapshot,
  preferred: string | null | undefined,
): string | null => {
  if (preferred && snapshot.entries.some((entry) => entry.id === preferred)) return preferred;
  return snapshot.activeEntryId;
};

export const evaluateWindowWorkspaceKeyboard = (
  event: WindowWorkspaceKeyboardEventLike,
  context: WindowWorkspaceKeyboardContext,
): WindowWorkspaceKeyboardIntent => {
  if (event.defaultPrevented || isCompositionEvent(event)) return { kind: 'none' };
  const key = normalizeKey(event.key);
  if (!key) return { kind: 'none' };

  if (context.source === 'global') {
    if (!isGlobalShortcut(event)) return { kind: 'none' };
    if (event.repeat || isEditableTarget(event.target)) return { kind: 'none' };
    return context.open ? { kind: 'close-dock' } : { kind: 'open-dock' };
  }

  if (event.altKey || hasCommandModifier(event)) return { kind: 'none' };

  if (key === 'Escape') {
    if (context.snapshot.query) return { kind: 'clear-query' };
    return { kind: 'close-dock' };
  }

  if (context.source === 'entry' && key === '/') {
    if (event.repeat) return { kind: 'none' };
    return { kind: 'focus-search' };
  }

  const move = MOVES[key];
  if (move) {
    if (context.snapshot.resultCount === 0) return { kind: 'none' };
    return { kind: 'move', move };
  }

  if (key === 'Enter' || key === ' ') {
    if (event.repeat) return { kind: 'none' };
    const windowId = selectedWindowId(context.snapshot, context.currentWindowId);
    return windowId ? { kind: 'activate', windowId } : { kind: 'none' };
  }

  return { kind: 'none' };
};

export const createWindowWorkspaceKeyboardPolicy = (): WindowWorkspaceKeyboardPolicy =>
  Object.freeze({
    shortcutLabel: WINDOW_WORKSPACE_SHORTCUT_LABEL,
    ariaKeyShortcut: WINDOW_WORKSPACE_ARIA_SHORTCUT,
    evaluate: evaluateWindowWorkspaceKeyboard,
  });

export const windowWorkspaceKeyboardHelp = Object.freeze({
  search: 'Aşağı ve yukarı oklarıyla pencere seçin; Home ve End ile listenin başına veya sonuna gidin; Enter ile açın.',
  entry: 'Ok tuşlarıyla pencereler arasında ilerleyin; Enter ile açın; eğik çizgi tuşuyla aramaya dönün.',
  global: `${WINDOW_WORKSPACE_SHORTCUT_LABEL} ile pencere değiştiriciyi açıp kapatabilirsiniz.`,
});
