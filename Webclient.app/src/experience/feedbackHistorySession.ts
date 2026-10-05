import {
  createFeedbackHistorySnapshot,
  createFeedbackHistoryState,
  reduceFeedbackHistory,
  resolveFeedbackHistoryKeyboardIntent,
  type FeedbackHistoryAction,
  type FeedbackHistoryFilter,
  type FeedbackHistoryInput,
  type FeedbackHistorySnapshot,
  type FeedbackHistorySort,
  type FeedbackHistoryState,
  type FeedbackHistoryKeyboardEventLike,
} from './feedbackHistoryExperience';

export type FeedbackHistorySessionCommand =
  | { readonly type: 'open'; readonly callerId?: string | null }
  | { readonly type: 'close' }
  | { readonly type: 'append'; readonly item: FeedbackHistoryInput }
  | { readonly type: 'filter'; readonly filter: FeedbackHistoryFilter }
  | { readonly type: 'sort'; readonly sort: FeedbackHistorySort }
  | { readonly type: 'mark-active-read' }
  | { readonly type: 'mark-all-read' }
  | { readonly type: 'remove-active' }
  | { readonly type: 'clear-read' }
  | { readonly type: 'keyboard'; readonly event: FeedbackHistoryKeyboardEventLike };

export type FeedbackHistorySessionEffect =
  | { readonly type: 'none' }
  | { readonly type: 'focus'; readonly targetId: string }
  | { readonly type: 'restore-focus'; readonly targetId: string }
  | { readonly type: 'open-item'; readonly id: string }
  | { readonly type: 'announce'; readonly message: string };

export interface FeedbackHistorySessionState {
  readonly open: boolean;
  readonly callerId: string | null;
  readonly history: FeedbackHistoryState;
  readonly revision: number;
  readonly lastAnnouncement: string;
}

export interface FeedbackHistorySessionView {
  readonly open: boolean;
  readonly history: FeedbackHistorySnapshot;
  readonly revision: number;
  readonly headingId: string;
  readonly listId: string;
  readonly statusId: string;
  readonly closeButtonId: string;
  readonly restoreFocusId: string | null;
}

export interface FeedbackHistorySessionResult {
  readonly state: FeedbackHistorySessionState;
  readonly view: FeedbackHistorySessionView;
  readonly effect: FeedbackHistorySessionEffect;
}

const MAX_ID_LENGTH = 96;
const MAX_ANNOUNCEMENT_LENGTH = 240;
const DEFAULT_CALLER_ID = 'feedback-history-trigger';

const stripControlCharacters = (value: string): string => {
  let result = '';
  for (const character of value) {
    const code = character.charCodeAt(0);
    if ((code >= 32 && code !== 127) || character === '\t') result += character;
  }
  return result;
};

const boundedText = (value: string, limit: number): string =>
  stripControlCharacters(value).replace(/\s+/g, ' ').trim().slice(0, limit);

const safeDomId = (value: string | null | undefined, fallback: string): string => {
  const normalized = boundedText(value ?? '', MAX_ID_LENGTH)
    .toLocaleLowerCase('tr-TR')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
};

const announce = (message: string): string => boundedText(message, MAX_ANNOUNCEMENT_LENGTH);

const nextRevision = (revision: number): number =>
  Number.isSafeInteger(revision) && revision >= 0 ? Math.min(Number.MAX_SAFE_INTEGER, revision + 1) : 1;

const viewFor = (state: FeedbackHistorySessionState): FeedbackHistorySessionView => Object.freeze({
  open: state.open,
  history: createFeedbackHistorySnapshot(state.history),
  revision: state.revision,
  headingId: 'feedback-history-heading',
  listId: 'feedback-history-list',
  statusId: 'feedback-history-status',
  closeButtonId: 'feedback-history-close',
  restoreFocusId: state.callerId,
});

const result = (
  state: FeedbackHistorySessionState,
  effect: FeedbackHistorySessionEffect = Object.freeze({ type: 'none' }),
): FeedbackHistorySessionResult => Object.freeze({ state, view: viewFor(state), effect });

const mutateHistory = (
  state: FeedbackHistorySessionState,
  action: FeedbackHistoryAction,
  now: number,
  announcement?: string,
): FeedbackHistorySessionState => {
  const history = reduceFeedbackHistory(state.history, action, now);
  if (history === state.history && !announcement) return state;
  return Object.freeze({
    ...state,
    history,
    revision: nextRevision(state.revision),
    lastAnnouncement: announcement ? announce(announcement) : state.lastAnnouncement,
  });
};

export const createFeedbackHistorySessionState = (now = Date.now()): FeedbackHistorySessionState => Object.freeze({
  open: false,
  callerId: null,
  history: createFeedbackHistoryState(now),
  revision: 0,
  lastAnnouncement: '',
});

export const createFeedbackHistorySessionView = viewFor;

export const reduceFeedbackHistorySession = (
  state: FeedbackHistorySessionState,
  command: FeedbackHistorySessionCommand,
  now = Date.now(),
): FeedbackHistorySessionResult => {
  switch (command.type) {
    case 'open': {
      const callerId = safeDomId(command.callerId, DEFAULT_CALLER_ID);
      const history = reduceFeedbackHistory(state.history, { type: 'first' }, now);
      const next = Object.freeze({
        ...state,
        open: true,
        callerId,
        history,
        revision: nextRevision(state.revision),
        lastAnnouncement: announce('Bildirim geçmişi açıldı.'),
      });
      const snapshot = createFeedbackHistorySnapshot(next.history);
      const targetId = snapshot.activeId ? `feedback-history-item-${safeDomId(snapshot.activeId, 'active')}` : 'feedback-history-close';
      return result(next, Object.freeze({ type: 'focus', targetId }));
    }
    case 'close': {
      if (!state.open) return result(state);
      const restoreTarget = state.callerId ?? DEFAULT_CALLER_ID;
      const next = Object.freeze({
        ...state,
        open: false,
        revision: nextRevision(state.revision),
        lastAnnouncement: announce('Bildirim geçmişi kapatıldı.'),
      });
      return result(next, Object.freeze({ type: 'restore-focus', targetId: restoreTarget }));
    }
    case 'append': {
      const next = mutateHistory(state, { type: 'append', item: command.item }, now);
      return result(next);
    }
    case 'filter': {
      const next = mutateHistory(state, { type: 'filter', filter: command.filter }, now);
      const snapshot = createFeedbackHistorySnapshot(next.history);
      const message = snapshot.emptyMessage ?? snapshot.announcement;
      const announced = Object.freeze({ ...next, lastAnnouncement: announce(message) });
      return result(announced, Object.freeze({ type: 'announce', message: announced.lastAnnouncement }));
    }
    case 'sort': {
      const next = mutateHistory(state, { type: 'sort', sort: command.sort }, now);
      const snapshot = createFeedbackHistorySnapshot(next.history);
      const message = announce(`${snapshot.visibleItems.length} bildirim ${command.sort === 'newest' ? 'yeniden eskiye' : 'eskiden yeniye'} sıralandı.`);
      const announced = Object.freeze({ ...next, lastAnnouncement: message });
      return result(announced, Object.freeze({ type: 'announce', message }));
    }
    case 'mark-active-read': {
      const activeId = state.history.activeId;
      if (!activeId) return result(state);
      const next = mutateHistory(state, { type: 'mark-read', id: activeId }, now, 'Bildirim okundu olarak işaretlendi.');
      return result(next, Object.freeze({ type: 'announce', message: next.lastAnnouncement }));
    }
    case 'mark-all-read': {
      const next = mutateHistory(state, { type: 'mark-all-read' }, now, 'Tüm bildirimler okundu olarak işaretlendi.');
      return result(next, Object.freeze({ type: 'announce', message: next.lastAnnouncement }));
    }
    case 'remove-active': {
      const activeId = state.history.activeId;
      if (!activeId) return result(state);
      const next = mutateHistory(state, { type: 'remove', id: activeId }, now, 'Bildirim geçmişten kaldırıldı.');
      const snapshot = createFeedbackHistorySnapshot(next.history);
      const targetId = snapshot.activeId ? `feedback-history-item-${safeDomId(snapshot.activeId, 'active')}` : 'feedback-history-close';
      return result(next, Object.freeze({ type: 'focus', targetId }));
    }
    case 'clear-read': {
      const next = mutateHistory(state, { type: 'clear-read' }, now, 'Okunmuş bildirimler temizlendi.');
      return result(next, Object.freeze({ type: 'announce', message: next.lastAnnouncement }));
    }
    case 'keyboard': {
      if (!state.open) return result(state);
      if (command.event.key === 'Escape' && !command.event.defaultPrevented && !command.event.isComposing && !command.event.repeat && !command.event.altKey && !command.event.ctrlKey && !command.event.metaKey) {
        return reduceFeedbackHistorySession(state, { type: 'close' }, now);
      }
      const intent = resolveFeedbackHistoryKeyboardIntent(command.event);
      if (!intent) return result(state);
      if (intent.type === 'open-active') {
        const activeId = state.history.activeId;
        return activeId ? result(state, Object.freeze({ type: 'open-item', id: activeId })) : result(state);
      }
      if (intent.type === 'remove-active') return reduceFeedbackHistorySession(state, { type: 'remove-active' }, now);
      const action: FeedbackHistoryAction = intent.type === 'move'
        ? { type: 'move', delta: intent.delta }
        : intent.type === 'first'
          ? { type: 'first' }
          : { type: 'last' };
      const next = mutateHistory(state, action, now);
      const snapshot = createFeedbackHistorySnapshot(next.history);
      const targetId = snapshot.activeId ? `feedback-history-item-${safeDomId(snapshot.activeId, 'active')}` : 'feedback-history-close';
      return result(next, Object.freeze({ type: 'focus', targetId }));
    }
  }
};