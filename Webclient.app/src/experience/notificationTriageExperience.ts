import type {
  NotificationCenterSnapshot,
  NotificationItem,
} from './notificationCenterModel';
import {
  createNotificationCommandSnapshot,
  moveNotificationCommandFocus,
  resolveNotificationCommandIntent,
  type NotificationCommandKeyboardEvent,
  type NotificationCommandScope,
  type NotificationCommandSnapshot,
} from './notificationCommandExperience';

export type NotificationTriageScope = NotificationCommandScope;

export interface NotificationTriageState {
  readonly revision: number;
  readonly expanded: boolean;
  readonly scope: NotificationTriageScope;
  readonly activeId: string | null;
}

export interface NotificationTriageItem {
  readonly id: string;
  readonly semanticId: string;
  readonly title: string;
  readonly message: string;
  readonly category: string;
  readonly tone: NotificationItem['tone'];
  readonly priority: NotificationItem['priority'];
  readonly read: boolean;
  readonly important: boolean;
  readonly dismissible: boolean;
  readonly occurrenceCount: number;
  readonly active: boolean;
  readonly position: number;
  readonly setSize: number;
}

export interface NotificationTriageSnapshot {
  readonly revision: number;
  readonly expanded: boolean;
  readonly scope: NotificationTriageScope;
  readonly activeId: string | null;
  readonly totalCount: number;
  readonly visibleCount: number;
  readonly unreadCount: number;
  readonly importantCount: number;
  readonly previewStart: number;
  readonly previewEnd: number;
  readonly previewLimit: number;
  readonly items: readonly NotificationTriageItem[];
  readonly command: NotificationCommandSnapshot;
  readonly statusText: string;
  readonly emptyText: string | null;
  readonly shouldSurface: boolean;
}

export type NotificationTriageEffect =
  | { readonly type: 'none' }
  | { readonly type: 'open-center' }
  | { readonly type: 'focus'; readonly id: string }
  | { readonly type: 'mark-read'; readonly id: string }
  | { readonly type: 'mark-all-read' }
  | { readonly type: 'clear-read' }
  | { readonly type: 'dismiss'; readonly id: string };

export interface NotificationTriageOptions {
  readonly previewLimit?: number;
}

export interface NotificationTriageScopeOption {
  readonly id: NotificationTriageScope;
  readonly label: string;
  readonly shortLabel: string;
}

const DEFAULT_PREVIEW_LIMIT = 6;
const MIN_PREVIEW_LIMIT = 3;
const MAX_PREVIEW_LIMIT = 8;

export const NOTIFICATION_TRIAGE_SCOPES: readonly NotificationTriageScopeOption[] = Object.freeze([
  Object.freeze({ id: 'all', label: 'Tüm bildirimler', shortLabel: 'Tümü' }),
  Object.freeze({ id: 'unread', label: 'Okunmamış bildirimler', shortLabel: 'Okunmamış' }),
  Object.freeze({ id: 'important', label: 'Önemli bildirimler', shortLabel: 'Önemli' }),
]);

const nextRevision = (revision: number): number =>
  Number.isSafeInteger(revision) && revision >= 0
    ? Math.min(Number.MAX_SAFE_INTEGER, revision + 1)
    : 1;

const clampPreviewLimit = (value: number | undefined): number => {
  if (!Number.isFinite(value)) return DEFAULT_PREVIEW_LIMIT;
  return Math.max(MIN_PREVIEW_LIMIT, Math.min(MAX_PREVIEW_LIMIT, Math.trunc(value ?? DEFAULT_PREVIEW_LIMIT)));
};

const important = (item: NotificationItem): boolean =>
  item.priority === 'urgent' || item.tone === 'warning' || item.tone === 'error';

const commandItems = (snapshot: NotificationCenterSnapshot) => Object.freeze(snapshot.items.map((item) => Object.freeze({
  id: item.id,
  title: item.title,
  read: item.read,
  important: important(item),
  dismissible: item.dismissible,
})));

const semanticToken = (value: string): string => {
  let output = '';
  let separator = false;
  for (const character of value.normalize('NFKD').toLocaleLowerCase('tr-TR')) {
    const codePoint = character.codePointAt(0);
    const accepted = codePoint !== undefined && (
      (codePoint >= 48 && codePoint <= 57)
      || (codePoint >= 97 && codePoint <= 122)
    );
    if (accepted) {
      output += character;
      separator = false;
      continue;
    }
    if (!separator && output) {
      output += '-';
      separator = true;
    }
    if (output.length >= 64) break;
  }
  return output.replace(/-+$/u, '') || 'notification';
};

const windowStart = (
  count: number,
  activeIndex: number,
  limit: number,
): number => {
  if (count <= limit) return 0;
  const safeIndex = Math.max(0, Math.min(count - 1, activeIndex));
  const half = Math.floor(limit / 2);
  return Math.max(0, Math.min(count - limit, safeIndex - half));
};

const statusText = (
  command: NotificationCommandSnapshot,
  previewStart: number,
  previewEnd: number,
): string => {
  if (command.count === 0) {
    if (command.scope === 'unread') return 'Okunmamış bildirim yok.';
    if (command.scope === 'important') return 'Önemli bildirim yok.';
    return 'Bildirim yok.';
  }
  const windowText = command.count > previewEnd - previewStart
    ? ` ${previewStart + 1}-${previewEnd} arası hızlı listede.`
    : '';
  return `${command.summary}${windowText}`;
};

const emptyText = (command: NotificationCommandSnapshot): string | null => {
  if (command.count > 0) return null;
  if (command.scope === 'unread') return 'Tüm bildirimler okundu. İsterseniz tüm bildirimlere dönebilirsiniz.';
  if (command.scope === 'important') return 'Şu anda önemli veya acil bildirim yok.';
  return 'Henüz gösterilecek bir bildirim bulunmuyor.';
};

export const createNotificationTriageState = (): NotificationTriageState => Object.freeze({
  revision: 0,
  expanded: false,
  scope: 'all',
  activeId: null,
});

export const setNotificationTriageExpanded = (
  state: NotificationTriageState,
  expanded: boolean,
): NotificationTriageState => state.expanded === expanded
  ? state
  : Object.freeze({ ...state, revision: nextRevision(state.revision), expanded });

export const toggleNotificationTriage = (
  state: NotificationTriageState,
): NotificationTriageState => setNotificationTriageExpanded(state, !state.expanded);

export const setNotificationTriageScope = (
  state: NotificationTriageState,
  scope: NotificationTriageScope,
): NotificationTriageState => state.scope === scope
  ? state
  : Object.freeze({
    ...state,
    revision: nextRevision(state.revision),
    scope,
    activeId: null,
  });

export const setNotificationTriageActive = (
  state: NotificationTriageState,
  activeId: string | null,
): NotificationTriageState => state.activeId === activeId
  ? state
  : Object.freeze({ ...state, revision: nextRevision(state.revision), activeId });

export const createNotificationTriageSnapshot = (
  notificationSnapshot: NotificationCenterSnapshot,
  state: NotificationTriageState,
  options: NotificationTriageOptions = {},
): NotificationTriageSnapshot => {
  const previewLimit = clampPreviewLimit(options.previewLimit);
  const command = createNotificationCommandSnapshot(commandItems(notificationSnapshot), {
    scope: state.scope,
    activeId: state.activeId,
  });
  const activeIndex = command.activeIndex >= 0 ? command.activeIndex : 0;
  const previewStart = windowStart(command.count, activeIndex, previewLimit);
  const previewEnd = Math.min(command.count, previewStart + previewLimit);
  const itemById = new Map(notificationSnapshot.items.map((item) => [item.id, item] as const));
  const previewIds = command.itemIds.slice(previewStart, previewEnd);
  const items = Object.freeze(previewIds.flatMap((id, index) => {
    const item = itemById.get(id);
    if (!item) return [];
    return [Object.freeze({
      id: item.id,
      semanticId: `experience-notification-triage-${semanticToken(item.id)}`,
      title: item.title,
      message: item.message,
      category: item.category,
      tone: item.tone,
      priority: item.priority,
      read: item.read,
      important: important(item),
      dismissible: item.dismissible,
      occurrenceCount: item.occurrenceCount,
      active: item.id === command.activeId,
      position: previewStart + index + 1,
      setSize: command.count,
    })];
  }));

  return Object.freeze({
    revision: Math.max(notificationSnapshot.revision, state.revision),
    expanded: state.expanded,
    scope: state.scope,
    activeId: command.activeId,
    totalCount: notificationSnapshot.items.length,
    visibleCount: command.count,
    unreadCount: notificationSnapshot.unreadCount,
    importantCount: notificationSnapshot.items.filter(important).length,
    previewStart,
    previewEnd,
    previewLimit,
    items,
    command,
    statusText: statusText(command, previewStart, previewEnd),
    emptyText: emptyText(command),
    shouldSurface: notificationSnapshot.unreadCount > 0 || notificationSnapshot.urgentUnreadCount > 0,
  });
};

export const resolveNotificationTriageEffect = (
  event: NotificationCommandKeyboardEvent,
  snapshot: NotificationTriageSnapshot,
): NotificationTriageEffect => {
  const intent = resolveNotificationCommandIntent(event, snapshot.command);
  switch (intent.type) {
    case 'open-center':
      return Object.freeze({ type: 'open-center' });
    case 'focus': {
      const id = moveNotificationCommandFocus(snapshot.command, intent.direction);
      return id ? Object.freeze({ type: 'focus', id }) : Object.freeze({ type: 'none' });
    }
    case 'mark-active-read':
      return snapshot.command.activeId
        ? Object.freeze({ type: 'mark-read', id: snapshot.command.activeId })
        : Object.freeze({ type: 'none' });
    case 'mark-all-read':
      return Object.freeze({ type: 'mark-all-read' });
    case 'clear-read':
      return Object.freeze({ type: 'clear-read' });
    case 'dismiss-active':
      return snapshot.command.activeId
        ? Object.freeze({ type: 'dismiss', id: snapshot.command.activeId })
        : Object.freeze({ type: 'none' });
    case 'none':
      return Object.freeze({ type: 'none' });
  }
};

export const notificationTriageKeyboardHelp = (snapshot: NotificationTriageSnapshot): readonly string[] => Object.freeze([
  'J / K veya ok tuşları: bildirimler arasında gezin',
  snapshot.command.canMarkActiveRead ? 'Enter / Boşluk: etkin bildirimi okundu yap' : 'Enter / Boşluk: etkin bildirim zaten okundu',
  snapshot.command.canDismissActive ? 'Delete: etkin bildirimi kaldır' : 'Delete: etkin bildirim kaldırılamaz',
  snapshot.command.canMarkAllRead ? 'Shift+A: tümünü okundu yap' : 'Shift+A: okunmamış bildirim yok',
  snapshot.command.canClearRead ? 'Shift+C: okunanları temizle' : 'Shift+C: temizlenecek okunmuş bildirim yok',
]);
