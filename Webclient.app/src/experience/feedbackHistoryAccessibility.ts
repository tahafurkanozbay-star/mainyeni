import type { FeedbackHistoryFilter, FeedbackHistoryItem, FeedbackHistorySnapshot, FeedbackHistorySort } from './feedbackHistoryExperience';

export type FeedbackHistoryViewport = 'phone' | 'tablet' | 'desktop';
export type FeedbackHistoryFocusTarget = 'trigger' | 'filter' | 'sort' | 'list' | 'active-item' | 'clear-read' | 'close';

export interface FeedbackHistoryAccessibilityInput {
  readonly snapshot: FeedbackHistorySnapshot;
  readonly filter: FeedbackHistoryFilter;
  readonly sort: FeedbackHistorySort;
  readonly viewport: FeedbackHistoryViewport;
  readonly open: boolean;
  readonly coarsePointer?: boolean;
  readonly reducedMotion?: boolean;
  readonly forcedColors?: boolean;
  readonly callerId?: string | null;
}

export interface FeedbackHistoryItemAccessibility {
  readonly id: string;
  readonly semanticId: string;
  readonly labelId: string;
  readonly descriptionId: string;
  readonly positionLabel: string;
  readonly accessibleName: string;
  readonly describedBy: string;
  readonly tabIndex: 0 | -1;
  readonly selected: boolean;
  readonly current: boolean;
  readonly readLabel: string;
  readonly importanceLabel: string | null;
  readonly removeLabel: string;
}

export interface FeedbackHistoryAccessibilityModel {
  readonly regionId: string;
  readonly headingId: string;
  readonly descriptionId: string;
  readonly statusId: string;
  readonly listId: string;
  readonly filterGroupId: string;
  readonly sortGroupId: string;
  readonly placement: 'bottom-sheet' | 'side-panel' | 'floating-panel';
  readonly role: 'dialog';
  readonly modal: boolean;
  readonly labelledBy: string;
  readonly describedBy: string;
  readonly statusRole: 'status';
  readonly statusLive: 'polite';
  readonly statusAtomic: true;
  readonly statusText: string;
  readonly minimumTargetPx: 44 | 48;
  readonly motion: 'reduced' | 'standard';
  readonly forcedColors: boolean;
  readonly restoreFocusTo: string | null;
  readonly items: readonly FeedbackHistoryItemAccessibility[];
  readonly empty: boolean;
  readonly clearReadDisabled: boolean;
  readonly closeLabel: string;
}

const bounded = (value: string, maximum: number): string => {
  let normalized = '';
  for (const character of value.normalize('NFC')) {
    const code = character.charCodeAt(0);
    if (code >= 32 && code !== 127) normalized += character;
  }
  return normalized.replace(/\s+/g, ' ').trim().slice(0, maximum);
};

const semanticToken = (value: string): string => {
  const safe = bounded(value, 72).toLocaleLowerCase('tr-TR');
  let result = '';
  let separator = false;
  for (const character of safe) {
    const accepted = /[a-z0-9]/.test(character);
    if (accepted) {
      result += character;
      separator = false;
    } else if (!separator && result) {
      result += '-';
      separator = true;
    }
  }
  return result.replace(/-+$/g, '') || 'feedback';
};

const placementFor = (viewport: FeedbackHistoryViewport): FeedbackHistoryAccessibilityModel['placement'] => {
  if (viewport === 'phone') return 'bottom-sheet';
  if (viewport === 'tablet') return 'side-panel';
  return 'floating-panel';
};

const itemModel = (
  item: FeedbackHistoryItem,
  index: number,
  total: number,
  activeId: string | null,
): FeedbackHistoryItemAccessibility => {
  const token = semanticToken(item.semanticId || item.id);
  const labelId = `feedback-history-${token}-label`;
  const descriptionId = `feedback-history-${token}-description`;
  const title = bounded(item.title, 120) || 'Bildirim';
  const message = item.message ? bounded(item.message, 240) : '';
  const positionLabel = `${index + 1} / ${total}`;
  const readLabel = item.read ? 'Okundu' : 'Okunmadı';
  const importanceLabel = item.important ? 'Önemli bildirim' : null;
  const detail = [message, readLabel, importanceLabel, positionLabel].filter(Boolean).join('. ');
  return Object.freeze({
    id: item.id,
    semanticId: `feedback-history-${token}`,
    labelId,
    descriptionId,
    positionLabel,
    accessibleName: title,
    describedBy: descriptionId,
    tabIndex: item.id === activeId ? 0 : -1,
    selected: item.id === activeId,
    current: item.id === activeId,
    readLabel,
    importanceLabel,
    removeLabel: `${title} bildirimini geçmişten kaldır`,
    detail,
  } as FeedbackHistoryItemAccessibility & { readonly detail: string });
};

export const createFeedbackHistoryAccessibilityModel = (
  input: FeedbackHistoryAccessibilityInput,
): FeedbackHistoryAccessibilityModel => {
  const regionId = 'feedback-history-region';
  const headingId = 'feedback-history-heading';
  const descriptionId = 'feedback-history-description';
  const statusId = 'feedback-history-status';
  const listId = 'feedback-history-list';
  const filterGroupId = 'feedback-history-filters';
  const sortGroupId = 'feedback-history-sort';
  const items = Object.freeze(input.snapshot.visibleItems.map((item, index) => itemModel(
    item,
    index,
    input.snapshot.visibleItems.length,
    input.snapshot.activeId,
  )));
  const filterText = input.filter === 'unread' ? 'Okunmamış' : input.filter === 'important' ? 'Önemli' : 'Tümü';
  const sortText = input.sort === 'oldest' ? 'eskiden yeniye' : 'yeniden eskiye';
  const announcement = bounded(input.snapshot.announcement, 220);
  const statusText = input.open
    ? bounded(`${filterText} bildirimler, ${sortText}. ${announcement}`, 280)
    : '';
  return Object.freeze({
    regionId,
    headingId,
    descriptionId,
    statusId,
    listId,
    filterGroupId,
    sortGroupId,
    placement: placementFor(input.viewport),
    role: 'dialog',
    modal: input.viewport === 'phone',
    labelledBy: headingId,
    describedBy: descriptionId,
    statusRole: 'status',
    statusLive: 'polite',
    statusAtomic: true,
    statusText,
    minimumTargetPx: input.coarsePointer ? 48 : 44,
    motion: input.reducedMotion ? 'reduced' : 'standard',
    forcedColors: Boolean(input.forcedColors),
    restoreFocusTo: bounded(input.callerId ?? '', 96) || null,
    items,
    empty: items.length === 0,
    clearReadDisabled: input.snapshot.visibleItems.every(item => !item.read),
    closeLabel: 'Bildirim geçmişini kapat',
  });
};

export interface FeedbackHistoryFocusState {
  readonly open: boolean;
  readonly activeId: string | null;
  readonly focusTarget: FeedbackHistoryFocusTarget;
  readonly callerId: string | null;
}

export type FeedbackHistoryFocusAction =
  | { readonly type: 'open'; readonly callerId?: string | null }
  | { readonly type: 'close' }
  | { readonly type: 'sync'; readonly snapshot: FeedbackHistorySnapshot }
  | { readonly type: 'focus'; readonly target: FeedbackHistoryFocusTarget };

export interface FeedbackHistoryFocusTransition {
  readonly state: FeedbackHistoryFocusState;
  readonly focusId: string | null;
  readonly restoreCaller: boolean;
}

export const createFeedbackHistoryFocusState = (): FeedbackHistoryFocusState => Object.freeze({
  open: false,
  activeId: null,
  focusTarget: 'trigger',
  callerId: null,
});

export const reduceFeedbackHistoryFocus = (
  state: FeedbackHistoryFocusState,
  action: FeedbackHistoryFocusAction,
): FeedbackHistoryFocusTransition => {
  if (action.type === 'open') {
    const callerId = bounded(action.callerId ?? '', 96) || null;
    return Object.freeze({
      state: Object.freeze({ ...state, open: true, focusTarget: 'list', callerId }),
      focusId: 'feedback-history-list',
      restoreCaller: false,
    });
  }
  if (action.type === 'close') {
    return Object.freeze({
      state: Object.freeze({ ...state, open: false, activeId: null, focusTarget: 'trigger' }),
      focusId: state.callerId,
      restoreCaller: Boolean(state.callerId),
    });
  }
  if (action.type === 'focus') {
    return Object.freeze({
      state: Object.freeze({ ...state, focusTarget: action.target }),
      focusId: action.target === 'active-item' && state.activeId
        ? `feedback-history-${semanticToken(state.activeId)}`
        : `feedback-history-${action.target}`,
      restoreCaller: false,
    });
  }
  const activeId = action.snapshot.activeId;
  const activeExists = Boolean(activeId && action.snapshot.visibleItems.some(item => item.id === activeId));
  const nextTarget: FeedbackHistoryFocusTarget = action.snapshot.visibleItems.length === 0
    ? 'close'
    : state.focusTarget === 'active-item' || state.focusTarget === 'list'
      ? 'active-item'
      : state.focusTarget;
  return Object.freeze({
    state: Object.freeze({ ...state, activeId: activeExists ? activeId : null, focusTarget: nextTarget }),
    focusId: nextTarget === 'active-item' && activeId ? `feedback-history-${semanticToken(activeId)}` : nextTarget === 'close' ? 'feedback-history-close' : null,
    restoreCaller: false,
  });
};
