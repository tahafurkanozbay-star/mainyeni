import type { NotificationTriageMove, NotificationTriageSnapshot } from './notificationTriageModel';

export interface NotificationTriageKeyboardEvent {
  readonly key: string;
  readonly altKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
  readonly repeat?: boolean;
  readonly defaultPrevented?: boolean;
  readonly isComposing?: boolean;
  readonly target?: {
    readonly tagName?: string;
    readonly isContentEditable?: boolean;
    readonly role?: string | null;
  } | null;
}

export type NotificationTriageIntent =
  | { readonly type: 'none' }
  | { readonly type: 'focus-search' }
  | { readonly type: 'move'; readonly move: NotificationTriageMove }
  | { readonly type: 'clear-query' }
  | { readonly type: 'mark-active-read'; readonly id: string }
  | { readonly type: 'dismiss-active'; readonly id: string }
  | { readonly type: 'mark-all-read' }
  | { readonly type: 'clear-read' };

export interface NotificationTriageCommandDefinition {
  readonly id: string;
  readonly label: string;
  readonly shortcut: string;
  readonly description: string;
  readonly enabled: boolean;
}

const NONE: NotificationTriageIntent = Object.freeze({ type: 'none' });

const editable = (event: NotificationTriageKeyboardEvent): boolean => {
  const target = event.target;
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName?.toUpperCase();
  return tag === 'INPUT'
    || tag === 'TEXTAREA'
    || tag === 'SELECT'
    || target.role === 'textbox'
    || target.role === 'searchbox'
    || target.role === 'combobox';
};

const plain = (event: NotificationTriageKeyboardEvent): boolean =>
  !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;

const shiftOnly = (event: NotificationTriageKeyboardEvent): boolean =>
  Boolean(event.shiftKey) && !event.altKey && !event.ctrlKey && !event.metaKey;

const active = (snapshot: NotificationTriageSnapshot) =>
  snapshot.activeId ? snapshot.entries.find((entry) => entry.id === snapshot.activeId) : undefined;

export const resolveNotificationTriageIntent = (
  event: NotificationTriageKeyboardEvent,
  snapshot: NotificationTriageSnapshot,
): NotificationTriageIntent => {
  if (event.defaultPrevented || event.isComposing || event.repeat) return NONE;
  const key = event.key;
  const isEditable = editable(event);

  if (key === '/' && !isEditable && plain(event)) return Object.freeze({ type: 'focus-search' });

  if (key === 'Escape' && snapshot.query && !event.altKey && !event.ctrlKey && !event.metaKey) {
    return Object.freeze({ type: 'clear-query' });
  }

  if ((key === 'ArrowDown' || (!isEditable && key.toLowerCase() === 'j')) && plain(event) && snapshot.resultCount > 0) {
    return Object.freeze({ type: 'move', move: 'next' });
  }
  if ((key === 'ArrowUp' || (!isEditable && key.toLowerCase() === 'k')) && plain(event) && snapshot.resultCount > 0) {
    return Object.freeze({ type: 'move', move: 'previous' });
  }
  if (key === 'Home' && !isEditable && plain(event) && snapshot.resultCount > 0) {
    return Object.freeze({ type: 'move', move: 'first' });
  }
  if (key === 'End' && !isEditable && plain(event) && snapshot.resultCount > 0) {
    return Object.freeze({ type: 'move', move: 'last' });
  }
  if (key === 'PageDown' && !isEditable && plain(event) && snapshot.resultCount > 0) {
    return Object.freeze({ type: 'move', move: 'page-next' });
  }
  if (key === 'PageUp' && !isEditable && plain(event) && snapshot.resultCount > 0) {
    return Object.freeze({ type: 'move', move: 'page-previous' });
  }

  if (isEditable) return NONE;

  const selected = active(snapshot);
  if ((key === 'Enter' || key === ' ') && plain(event) && selected && !selected.read) {
    return Object.freeze({ type: 'mark-active-read', id: selected.id });
  }
  if ((key === 'Delete' || key === 'Backspace') && plain(event) && selected?.dismissible) {
    return Object.freeze({ type: 'dismiss-active', id: selected.id });
  }
  if (key.toLowerCase() === 'a' && shiftOnly(event) && snapshot.unreadCount > 0) {
    return Object.freeze({ type: 'mark-all-read' });
  }
  if (key.toLowerCase() === 'c' && shiftOnly(event) && snapshot.totalCount > snapshot.unreadCount) {
    return Object.freeze({ type: 'clear-read' });
  }
  return NONE;
};

export const createNotificationTriageCommandDefinitions = (
  snapshot: NotificationTriageSnapshot,
): readonly NotificationTriageCommandDefinition[] => {
  const selected = active(snapshot);
  return Object.freeze([
    Object.freeze({
      id: 'triage-focus-search',
      label: 'Bildirim aramasına git',
      shortcut: '/',
      description: 'Bildirim merkezindeki hızlı arama alanına odaklanır.',
      enabled: true,
    }),
    Object.freeze({
      id: 'triage-next',
      label: 'Sonraki eşleşme',
      shortcut: '↓ / J',
      description: 'Etkin arama sonucunu bir sonraki bildirime taşır.',
      enabled: snapshot.resultCount > 0,
    }),
    Object.freeze({
      id: 'triage-previous',
      label: 'Önceki eşleşme',
      shortcut: '↑ / K',
      description: 'Etkin arama sonucunu bir önceki bildirime taşır.',
      enabled: snapshot.resultCount > 0,
    }),
    Object.freeze({
      id: 'triage-read',
      label: 'Etkin bildirimi okundu yap',
      shortcut: 'Enter',
      description: 'Etkin ve okunmamış sonucu okundu olarak işaretler.',
      enabled: Boolean(selected && !selected.read),
    }),
    Object.freeze({
      id: 'triage-dismiss',
      label: 'Etkin bildirimi kaldır',
      shortcut: 'Delete',
      description: 'Yalnız kaldırılabilir etkin bildirimi merkezden çıkarır.',
      enabled: Boolean(selected?.dismissible),
    }),
    Object.freeze({
      id: 'triage-mark-all',
      label: 'Tümünü okundu yap',
      shortcut: 'Shift+A',
      description: 'Merkezdeki bütün okunmamış bildirimleri okundu yapar.',
      enabled: snapshot.unreadCount > 0,
    }),
    Object.freeze({
      id: 'triage-clear-read',
      label: 'Okunanları temizle',
      shortcut: 'Shift+C',
      description: 'Kaldırılabilir okunmuş bildirimleri merkezden temizler.',
      enabled: snapshot.totalCount > snapshot.unreadCount,
    }),
  ]);
};
