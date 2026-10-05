import type { FeedbackPriority, FeedbackTone, FeedbackViewModel } from './feedbackExperience';

export type FeedbackHistoryFilter = 'all' | 'unread' | 'important';
export type FeedbackHistorySort = 'newest' | 'oldest';

export interface FeedbackHistoryInput {
  readonly feedback: FeedbackViewModel;
  readonly occurredAt: number;
  readonly read?: boolean;
}

export interface FeedbackHistoryItem {
  readonly id: string;
  readonly semanticId: string;
  readonly title: string;
  readonly message: string | null;
  readonly tone: FeedbackTone;
  readonly priority: FeedbackPriority;
  readonly occurredAt: number;
  readonly read: boolean;
  readonly important: boolean;
}

export interface FeedbackHistoryState {
  readonly items: readonly FeedbackHistoryItem[];
  readonly filter: FeedbackHistoryFilter;
  readonly sort: FeedbackHistorySort;
  readonly activeId: string | null;
  readonly unreadCount: number;
  readonly importantCount: number;
}

export interface FeedbackHistorySnapshot {
  readonly visibleItems: readonly FeedbackHistoryItem[];
  readonly activeId: string | null;
  readonly activeIndex: number | null;
  readonly unreadCount: number;
  readonly importantCount: number;
  readonly announcement: string;
  readonly emptyMessage: string | null;
}

export type FeedbackHistoryAction =
  | { readonly type: 'append'; readonly item: FeedbackHistoryInput }
  | { readonly type: 'mark-read'; readonly id: string }
  | { readonly type: 'mark-all-read' }
  | { readonly type: 'remove'; readonly id: string }
  | { readonly type: 'clear-read' }
  | { readonly type: 'filter'; readonly filter: FeedbackHistoryFilter }
  | { readonly type: 'sort'; readonly sort: FeedbackHistorySort }
  | { readonly type: 'activate'; readonly id: string | null }
  | { readonly type: 'move'; readonly delta: number }
  | { readonly type: 'first' }
  | { readonly type: 'last' };

const MAX_HISTORY = 50;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const validTimestamp = (value: number, now: number): number => {
  if (!Number.isFinite(value)) return now;
  return Math.max(0, Math.min(now, Math.trunc(value)));
};

const toHistoryItem = (input: FeedbackHistoryInput, now: number): FeedbackHistoryItem => Object.freeze({
  id: input.feedback.id,
  semanticId: input.feedback.semanticId,
  title: input.feedback.title,
  message: input.feedback.message,
  tone: input.feedback.tone,
  priority: input.feedback.priority,
  occurredAt: validTimestamp(input.occurredAt, now),
  read: Boolean(input.read),
  important: input.feedback.priority === 'assertive' || input.feedback.tone === 'danger' || input.feedback.tone === 'warning',
});

const admitted = (item: FeedbackHistoryItem, now: number): boolean =>
  Boolean(item.id && item.title) && now - item.occurredAt <= MAX_AGE_MS;

const visibleFor = (state: FeedbackHistoryState): readonly FeedbackHistoryItem[] => {
  const filtered = state.items.filter(item => {
    if (state.filter === 'unread') return !item.read;
    if (state.filter === 'important') return item.important;
    return true;
  });
  const direction = state.sort === 'newest' ? -1 : 1;
  return Object.freeze([...filtered].sort((left, right) => {
    const byTime = (left.occurredAt - right.occurredAt) * direction;
    return byTime || left.id.localeCompare(right.id, 'tr-TR') * direction;
  }));
};

const counts = (items: readonly FeedbackHistoryItem[]) => ({
  unreadCount: items.filter(item => !item.read).length,
  importantCount: items.filter(item => item.important).length,
});

const reconcileActive = (state: FeedbackHistoryState): FeedbackHistoryState => {
  const visible = visibleFor(state);
  const activeId = state.activeId && visible.some(item => item.id === state.activeId)
    ? state.activeId
    : visible[0]?.id ?? null;
  return activeId === state.activeId ? state : Object.freeze({ ...state, activeId });
};

const normalizeState = (state: FeedbackHistoryState, now: number): FeedbackHistoryState => {
  const unique = new Map<string, FeedbackHistoryItem>();
  for (const item of state.items) {
    if (admitted(item, now)) unique.set(item.id, item);
  }
  const items = Object.freeze([...unique.values()].slice(-MAX_HISTORY));
  const nextCounts = counts(items);
  return reconcileActive(Object.freeze({
    ...state,
    items,
    ...nextCounts,
  }));
};

export const createFeedbackHistoryState = (now = Date.now()): FeedbackHistoryState => normalizeState(Object.freeze({
  items: Object.freeze([]),
  filter: 'all',
  sort: 'newest',
  activeId: null,
  unreadCount: 0,
  importantCount: 0,
}), now);

export const reduceFeedbackHistory = (
  state: FeedbackHistoryState,
  action: FeedbackHistoryAction,
  now = Date.now(),
): FeedbackHistoryState => {
  const current = normalizeState(state, now);
  let next: FeedbackHistoryState = current;

  switch (action.type) {
    case 'append': {
      const incoming = toHistoryItem(action.item, now);
      if (!admitted(incoming, now)) return current;
      const withoutDuplicate = current.items.filter(item => item.id !== incoming.id);
      next = Object.freeze({ ...current, items: Object.freeze([...withoutDuplicate, incoming]) });
      break;
    }
    case 'mark-read':
      next = Object.freeze({ ...current, items: Object.freeze(current.items.map(item => item.id === action.id && !item.read ? Object.freeze({ ...item, read: true }) : item)) });
      break;
    case 'mark-all-read':
      next = Object.freeze({ ...current, items: Object.freeze(current.items.map(item => item.read ? item : Object.freeze({ ...item, read: true }))) });
      break;
    case 'remove':
      next = Object.freeze({ ...current, items: Object.freeze(current.items.filter(item => item.id !== action.id)) });
      break;
    case 'clear-read':
      next = Object.freeze({ ...current, items: Object.freeze(current.items.filter(item => !item.read)) });
      break;
    case 'filter':
      next = Object.freeze({ ...current, filter: action.filter });
      break;
    case 'sort':
      next = Object.freeze({ ...current, sort: action.sort });
      break;
    case 'activate':
      next = Object.freeze({ ...current, activeId: action.id });
      break;
    case 'move': {
      const visible = visibleFor(current);
      if (visible.length === 0) return current;
      const index = Math.max(0, visible.findIndex(item => item.id === current.activeId));
      const target = (index + Math.trunc(action.delta) + visible.length) % visible.length;
      next = Object.freeze({ ...current, activeId: visible[target]?.id ?? null });
      break;
    }
    case 'first': {
      const first = visibleFor(current)[0];
      next = Object.freeze({ ...current, activeId: first?.id ?? null });
      break;
    }
    case 'last': {
      const visible = visibleFor(current);
      next = Object.freeze({ ...current, activeId: visible.at(-1)?.id ?? null });
      break;
    }
  }
  return normalizeState(next, now);
};

export const createFeedbackHistorySnapshot = (state: FeedbackHistoryState): FeedbackHistorySnapshot => {
  const visibleItems = visibleFor(state);
  const activeIndex = state.activeId ? visibleItems.findIndex(item => item.id === state.activeId) : -1;
  const emptyMessage = visibleItems.length === 0
    ? state.filter === 'unread'
      ? 'Okunmamış bildirim yok.'
      : state.filter === 'important'
        ? 'Önemli bildirim yok.'
        : 'Bildirim geçmişi boş.'
    : null;
  const announcement = visibleItems.length === 0
    ? emptyMessage ?? ''
    : `${visibleItems.length} bildirim gösteriliyor. ${state.unreadCount} okunmamış.`;
  return Object.freeze({
    visibleItems,
    activeId: state.activeId,
    activeIndex: activeIndex >= 0 ? activeIndex : null,
    unreadCount: state.unreadCount,
    importantCount: state.importantCount,
    announcement,
    emptyMessage,
  });
};

export interface FeedbackHistoryKeyboardEventLike {
  readonly key: string;
  readonly altKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
  readonly repeat?: boolean;
  readonly defaultPrevented?: boolean;
  readonly isComposing?: boolean;
  readonly target?: { readonly tagName?: string; readonly isContentEditable?: boolean } | null;
}

export type FeedbackHistoryKeyboardIntent =
  | { readonly type: 'move'; readonly delta: 1 | -1 }
  | { readonly type: 'first' }
  | { readonly type: 'last' }
  | { readonly type: 'open-active' }
  | { readonly type: 'remove-active' }
  | null;

const editable = (target: FeedbackHistoryKeyboardEventLike['target']): boolean => {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName?.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select';
};

export const resolveFeedbackHistoryKeyboardIntent = (event: FeedbackHistoryKeyboardEventLike): FeedbackHistoryKeyboardIntent => {
  if (event.defaultPrevented || event.isComposing || event.repeat || editable(event.target) || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  if (event.key === 'ArrowDown') return { type: 'move', delta: 1 };
  if (event.key === 'ArrowUp') return { type: 'move', delta: -1 };
  if (event.key === 'Home') return { type: 'first' };
  if (event.key === 'End') return { type: 'last' };
  if (event.key === 'Enter' || event.key === ' ') return { type: 'open-active' };
  if (event.key === 'Delete') return { type: 'remove-active' };
  return null;
};
