export type NotificationCommandScope = 'all' | 'unread' | 'important';
export type NotificationCommandAction =
  | 'open-center'
  | 'focus-next'
  | 'focus-previous'
  | 'focus-first'
  | 'focus-last'
  | 'mark-active-read'
  | 'mark-all-read'
  | 'clear-read'
  | 'dismiss-active';

export interface NotificationCommandKeyboardEvent {
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

export interface NotificationCommandItem {
  readonly id: string;
  readonly title: string;
  readonly read: boolean;
  readonly important: boolean;
  readonly dismissible: boolean;
}

export interface NotificationCommandSnapshot {
  readonly scope: NotificationCommandScope;
  readonly itemIds: readonly string[];
  readonly activeId: string | null;
  readonly activeIndex: number;
  readonly count: number;
  readonly unreadCount: number;
  readonly importantCount: number;
  readonly canMarkActiveRead: boolean;
  readonly canMarkAllRead: boolean;
  readonly canClearRead: boolean;
  readonly canDismissActive: boolean;
  readonly summary: string;
}

export type NotificationCommandIntent =
  | { readonly type: 'none' }
  | { readonly type: 'open-center' }
  | { readonly type: 'focus'; readonly direction: 'next' | 'previous' | 'first' | 'last' }
  | { readonly type: 'mark-active-read' }
  | { readonly type: 'mark-all-read' }
  | { readonly type: 'clear-read' }
  | { readonly type: 'dismiss-active' };

export interface NotificationCommandDefinition {
  readonly id: string;
  readonly action: NotificationCommandAction;
  readonly label: string;
  readonly description: string;
  readonly shortcut: string;
  readonly enabled: boolean;
}

const EMPTY_INTENT: NotificationCommandIntent = Object.freeze({ type: 'none' });
const MAX_ITEMS = 96;

const normalizeId = (value: string): string => {
  const normalized = value.trim();
  if (!normalized || normalized.length > 96) return '';
  for (let index = 0; index < normalized.length; index += 1) {
    const code = normalized.charCodeAt(index);
    if (code < 32 || code === 127) return '';
  }
  return normalized;
};

const normalizeTitle = (value: string): string => {
  const normalized = value.trim().replace(/\s+/g, ' ');
  return normalized.slice(0, 120);
};

const isEditableTarget = (event: NotificationCommandKeyboardEvent): boolean => {
  const target = event.target;
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tagName = target.tagName?.toUpperCase();
  if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') return true;
  return target.role === 'textbox' || target.role === 'searchbox' || target.role === 'combobox';
};

const eligible = (
  item: NotificationCommandItem,
  scope: NotificationCommandScope,
): boolean => {
  if (scope === 'unread') return !item.read;
  if (scope === 'important') return item.important;
  return true;
};

const sanitizeItems = (
  items: readonly NotificationCommandItem[],
): readonly NotificationCommandItem[] => {
  const result: NotificationCommandItem[] = [];
  const seen = new Set<string>();
  for (const candidate of items) {
    if (result.length >= MAX_ITEMS) break;
    const id = normalizeId(candidate.id);
    if (!id || seen.has(id)) continue;
    const title = normalizeTitle(candidate.title);
    if (!title) continue;
    seen.add(id);
    result.push(Object.freeze({
      id,
      title,
      read: candidate.read === true,
      important: candidate.important === true,
      dismissible: candidate.dismissible === true,
    }));
  }
  return Object.freeze(result);
};

export const createNotificationCommandSnapshot = (
  items: readonly NotificationCommandItem[],
  options: {
    readonly scope?: NotificationCommandScope;
    readonly activeId?: string | null;
  } = {},
): NotificationCommandSnapshot => {
  const scope = options.scope ?? 'all';
  const sanitized = sanitizeItems(items);
  const visible = sanitized.filter((item) => eligible(item, scope));
  const requestedActiveId = normalizeId(options.activeId ?? '');
  const activeIndex = requestedActiveId
    ? visible.findIndex((item) => item.id === requestedActiveId)
    : -1;
  const resolvedIndex = activeIndex >= 0 ? activeIndex : visible.length > 0 ? 0 : -1;
  const active = resolvedIndex >= 0 ? visible[resolvedIndex] : undefined;
  const unreadCount = visible.reduce((count, item) => count + (item.read ? 0 : 1), 0);
  const importantCount = visible.reduce((count, item) => count + (item.important ? 1 : 0), 0);
  const readCount = visible.length - unreadCount;
  return Object.freeze({
    scope,
    itemIds: Object.freeze(visible.map((item) => item.id)),
    activeId: active?.id ?? null,
    activeIndex: resolvedIndex,
    count: visible.length,
    unreadCount,
    importantCount,
    canMarkActiveRead: Boolean(active && !active.read),
    canMarkAllRead: unreadCount > 0,
    canClearRead: readCount > 0,
    canDismissActive: Boolean(active?.dismissible),
    summary: visible.length === 0
      ? 'Bildirim yok.'
      : `${visible.length} bildirim, ${unreadCount} okunmamış, ${importantCount} önemli.`,
  });
};

const hasOnlyShift = (event: NotificationCommandKeyboardEvent): boolean =>
  !event.altKey && !event.ctrlKey && !event.metaKey;

const isPlain = (event: NotificationCommandKeyboardEvent): boolean =>
  !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;

export const resolveNotificationCommandIntent = (
  event: NotificationCommandKeyboardEvent,
  snapshot: NotificationCommandSnapshot,
): NotificationCommandIntent => {
  if (event.defaultPrevented || event.isComposing || event.repeat) return EMPTY_INTENT;
  const key = event.key;

  // Alt+N is a global discovery shortcut and is intentionally allowed from editable fields.
  if (key.toLowerCase() === 'n' && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
    return Object.freeze({ type: 'open-center' });
  }

  if (isEditableTarget(event)) return EMPTY_INTENT;

  if ((key === 'ArrowDown' || key === 'j') && isPlain(event) && snapshot.count > 0) {
    return Object.freeze({ type: 'focus', direction: 'next' });
  }
  if ((key === 'ArrowUp' || key === 'k') && isPlain(event) && snapshot.count > 0) {
    return Object.freeze({ type: 'focus', direction: 'previous' });
  }
  if (key === 'Home' && isPlain(event) && snapshot.count > 0) {
    return Object.freeze({ type: 'focus', direction: 'first' });
  }
  if (key === 'End' && isPlain(event) && snapshot.count > 0) {
    return Object.freeze({ type: 'focus', direction: 'last' });
  }
  if ((key === 'Enter' || key === ' ') && isPlain(event) && snapshot.canMarkActiveRead) {
    return Object.freeze({ type: 'mark-active-read' });
  }
  if (key.toLowerCase() === 'a' && event.shiftKey && hasOnlyShift(event) && snapshot.canMarkAllRead) {
    return Object.freeze({ type: 'mark-all-read' });
  }
  if (key.toLowerCase() === 'c' && event.shiftKey && hasOnlyShift(event) && snapshot.canClearRead) {
    return Object.freeze({ type: 'clear-read' });
  }
  if ((key === 'Delete' || key === 'Backspace') && isPlain(event) && snapshot.canDismissActive) {
    return Object.freeze({ type: 'dismiss-active' });
  }
  return EMPTY_INTENT;
};

export const moveNotificationCommandFocus = (
  snapshot: NotificationCommandSnapshot,
  direction: 'next' | 'previous' | 'first' | 'last',
): string | null => {
  if (snapshot.count === 0) return null;
  if (direction === 'first') return snapshot.itemIds[0] ?? null;
  if (direction === 'last') return snapshot.itemIds[snapshot.itemIds.length - 1] ?? null;
  const current = snapshot.activeIndex >= 0 ? snapshot.activeIndex : 0;
  const next = direction === 'next'
    ? (current + 1) % snapshot.count
    : (current - 1 + snapshot.count) % snapshot.count;
  return snapshot.itemIds[next] ?? null;
};

export const createNotificationCommandDefinitions = (
  snapshot: NotificationCommandSnapshot,
): readonly NotificationCommandDefinition[] => Object.freeze([
  Object.freeze({
    id: 'notification-open-center',
    action: 'open-center' as const,
    label: 'Bildirim merkezini aç',
    description: 'Bildirim geçmişini, filtreleri ve toplu işlemleri açar.',
    shortcut: 'Alt+N',
    enabled: true,
  }),
  Object.freeze({
    id: 'notification-focus-next',
    action: 'focus-next' as const,
    label: 'Sonraki bildirime git',
    description: 'Odaklanan bildirimi aşağı yönde döngüsel ilerletir.',
    shortcut: '↓ / J',
    enabled: snapshot.count > 0,
  }),
  Object.freeze({
    id: 'notification-focus-previous',
    action: 'focus-previous' as const,
    label: 'Önceki bildirime git',
    description: 'Odaklanan bildirimi yukarı yönde döngüsel ilerletir.',
    shortcut: '↑ / K',
    enabled: snapshot.count > 0,
  }),
  Object.freeze({
    id: 'notification-mark-active-read',
    action: 'mark-active-read' as const,
    label: 'Etkin bildirimi okundu yap',
    description: 'Yalnız etkin ve okunmamış bildirimi okundu işaretler.',
    shortcut: 'Enter / Space',
    enabled: snapshot.canMarkActiveRead,
  }),
  Object.freeze({
    id: 'notification-mark-all-read',
    action: 'mark-all-read' as const,
    label: 'Tümünü okundu yap',
    description: 'Görünür okunmamış bildirimleri okundu işaretler.',
    shortcut: 'Shift+A',
    enabled: snapshot.canMarkAllRead,
  }),
  Object.freeze({
    id: 'notification-clear-read',
    action: 'clear-read' as const,
    label: 'Okunanları temizle',
    description: 'Okunmuş bildirimleri geçmişten temizler.',
    shortcut: 'Shift+C',
    enabled: snapshot.canClearRead,
  }),
  Object.freeze({
    id: 'notification-dismiss-active',
    action: 'dismiss-active' as const,
    label: 'Etkin bildirimi kaldır',
    description: 'Yalnız kaldırılabilir etkin bildirimi kapatır.',
    shortcut: 'Delete',
    enabled: snapshot.canDismissActive,
  }),
]);
