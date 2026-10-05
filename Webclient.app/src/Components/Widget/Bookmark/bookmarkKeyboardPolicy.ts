import type { BookmarkMove } from './bookmarkExperienceModel';

export type BookmarkKeyboardSurface = 'search' | 'collection';
export type BookmarkKeyboardIntent =
  | { readonly kind: 'move'; readonly move: BookmarkMove }
  | { readonly kind: 'activate' }
  | { readonly kind: 'request-delete' }
  | { readonly kind: 'cancel-delete' }
  | { readonly kind: 'focus-search' }
  | { readonly kind: 'clear-search' }
  | { readonly kind: 'none' };

export interface BookmarkKeyboardEventLike {
  readonly key: string;
  readonly altKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
  readonly repeat?: boolean;
  readonly defaultPrevented?: boolean;
  readonly isComposing?: boolean;
}
export interface BookmarkKeyboardContext {
  readonly surface: BookmarkKeyboardSurface;
  readonly resultCount: number;
  readonly hasActiveEntry: boolean;
  readonly hasPendingDelete: boolean;
  readonly hasQuery: boolean;
  readonly busy: boolean;
}
export interface BookmarkKeyboardDecision {
  readonly intent: BookmarkKeyboardIntent;
  readonly preventDefault: boolean;
  readonly announceShortcut: boolean;
}
export interface BookmarkKeyboardShortcut {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly surfaces: readonly BookmarkKeyboardSurface[];
}

const NONE: BookmarkKeyboardDecision = Object.freeze({
  intent: Object.freeze({ kind: 'none' }),
  preventDefault: false,
  announceShortcut: false,
});
const MOVEMENT_BY_KEY: Readonly<Partial<Record<string, BookmarkMove>>> = Object.freeze({
  ArrowDown: 'next',
  ArrowRight: 'next',
  ArrowUp: 'previous',
  ArrowLeft: 'previous',
  Home: 'first',
  End: 'last',
  PageDown: 'page-next',
  PageUp: 'page-previous',
});

export const BOOKMARK_KEYBOARD_SHORTCUTS: readonly BookmarkKeyboardShortcut[] = Object.freeze([
  Object.freeze({ key: 'Arrow keys', label: 'Ok tuşları', description: 'Sonuçlar arasında ileri veya geri gezinir.', surfaces: Object.freeze(['search', 'collection'] as const) }),
  Object.freeze({ key: 'Home / End', label: 'Home / End', description: 'İlk veya son yer işaretine gider.', surfaces: Object.freeze(['search', 'collection'] as const) }),
  Object.freeze({ key: 'PageUp / PageDown', label: 'Page Up / Page Down', description: 'Sonuçlarda bir görünüm sayfası kadar ilerler.', surfaces: Object.freeze(['search', 'collection'] as const) }),
  Object.freeze({ key: 'Enter', label: 'Enter', description: 'Seçili yer işaretini haritada gösterir.', surfaces: Object.freeze(['collection'] as const) }),
  Object.freeze({ key: 'Delete', label: 'Delete', description: 'Seçili kayıt için silme onayını açar; doğrudan silmez.', surfaces: Object.freeze(['collection'] as const) }),
  Object.freeze({ key: 'Escape', label: 'Escape', description: 'Açık silme onayını veya arama metnini güvenli biçimde kapatır.', surfaces: Object.freeze(['search', 'collection'] as const) }),
  Object.freeze({ key: '/', label: '/', description: 'Koleksiyondan arama alanına odaklanır.', surfaces: Object.freeze(['collection'] as const) }),
]);

const decision = (intent: BookmarkKeyboardIntent, preventDefault = true, announceShortcut = false): BookmarkKeyboardDecision => Object.freeze({
  intent: Object.freeze(intent),
  preventDefault,
  announceShortcut,
});
const hasCommandModifier = (event: BookmarkKeyboardEventLike): boolean => event.altKey === true || event.ctrlKey === true || event.metaKey === true;
const isUnsafeToHandle = (event: BookmarkKeyboardEventLike): boolean => event.defaultPrevented === true || event.isComposing === true || event.key === 'Process' || event.key === 'Dead';

const movementDecision = (event: BookmarkKeyboardEventLike, context: BookmarkKeyboardContext): BookmarkKeyboardDecision | null => {
  const move = MOVEMENT_BY_KEY[event.key];
  if (!move || context.resultCount <= 0) return null;
  if (hasCommandModifier(event)) return NONE;
  return decision({ kind: 'move', move });
};

const searchDecision = (event: BookmarkKeyboardEventLike, context: BookmarkKeyboardContext): BookmarkKeyboardDecision => {
  const movement = movementDecision(event, context);
  if (movement) return movement;
  if (event.key === 'Escape' && context.hasQuery && !hasCommandModifier(event)) return decision({ kind: 'clear-search' });
  return NONE;
};

const collectionDecision = (event: BookmarkKeyboardEventLike, context: BookmarkKeyboardContext): BookmarkKeyboardDecision => {
  const movement = movementDecision(event, context);
  if (movement) return movement;
  if (hasCommandModifier(event)) return NONE;
  if (event.key === '/' && !event.shiftKey && !event.repeat) return decision({ kind: 'focus-search' }, true, true);
  if (event.key === 'Escape' && context.hasPendingDelete) return decision({ kind: 'cancel-delete' });
  if (context.busy || !context.hasActiveEntry) return NONE;
  if (event.key === 'Enter' && !event.repeat) return decision({ kind: 'activate' });
  if ((event.key === 'Delete' || event.key === 'Backspace') && !event.repeat) return decision({ kind: 'request-delete' });
  return NONE;
};

export const resolveBookmarkKeyboardIntent = (event: BookmarkKeyboardEventLike, context: BookmarkKeyboardContext): BookmarkKeyboardDecision => {
  if (isUnsafeToHandle(event)) return NONE;
  return context.surface === 'search' ? searchDecision(event, context) : collectionDecision(event, context);
};

export const bookmarkKeyboardAriaShortcuts = (surface: BookmarkKeyboardSurface): string => (
  surface === 'search'
    ? 'ArrowDown ArrowUp Home End PageDown PageUp Escape'
    : 'ArrowDown ArrowUp ArrowLeft ArrowRight Home End PageDown PageUp Enter Delete Escape'
);

export const bookmarkKeyboardHelpText = (): string => (
  'Ok tuşlarıyla gezin; Enter ile haritada göster; Delete ile silme onayını aç; / ile aramaya dön; Escape ile iptal et.'
);
