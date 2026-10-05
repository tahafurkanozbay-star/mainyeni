import type { FeedbackHistoryFilter, FeedbackHistorySnapshot, FeedbackHistorySort } from './feedbackHistoryExperience';

export type FeedbackHistoryControlsViewport = 'phone' | 'tablet' | 'desktop';
export type FeedbackHistoryControlsDensity = 'comfortable' | 'compact';
export type FeedbackHistoryControlsIntent =
  | { readonly type: 'set-filter'; readonly filter: FeedbackHistoryFilter }
  | { readonly type: 'set-sort'; readonly sort: FeedbackHistorySort }
  | { readonly type: 'mark-all-read' }
  | { readonly type: 'clear-read' }
  | { readonly type: 'close' }
  | null;

export interface FeedbackHistoryControlsInput {
  readonly history: FeedbackHistorySnapshot;
  readonly filter: FeedbackHistoryFilter;
  readonly sort: FeedbackHistorySort;
  readonly viewport: FeedbackHistoryControlsViewport;
  readonly coarsePointer?: boolean;
  readonly reducedMotion?: boolean;
  readonly forcedColors?: boolean;
}

export interface FeedbackHistoryControlOption<T extends string> {
  readonly id: string;
  readonly value: T;
  readonly label: string;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly tabIndex: 0 | -1;
}

export interface FeedbackHistoryControlsSnapshot {
  readonly toolbarId: 'feedback-history-controls';
  readonly toolbarLabel: 'Bildirim geçmişi denetimleri';
  readonly filterGroupId: 'feedback-history-filter-group';
  readonly filterGroupLabel: 'Bildirimleri filtrele';
  readonly sortGroupId: 'feedback-history-sort-group';
  readonly sortGroupLabel: 'Bildirimleri sırala';
  readonly summaryId: 'feedback-history-controls-summary';
  readonly placement: 'stacked' | 'inline';
  readonly density: FeedbackHistoryControlsDensity;
  readonly targetSize: 44 | 48;
  readonly motion: 'reduced' | 'standard';
  readonly contrast: 'forced' | 'standard';
  readonly filters: readonly FeedbackHistoryControlOption<FeedbackHistoryFilter>[];
  readonly sorts: readonly FeedbackHistoryControlOption<FeedbackHistorySort>[];
  readonly markAllReadDisabled: boolean;
  readonly clearReadDisabled: boolean;
  readonly summary: string;
}

export interface FeedbackHistoryControlsKeyboardEventLike {
  readonly key: string;
  readonly altKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
  readonly repeat?: boolean;
  readonly defaultPrevented?: boolean;
  readonly isComposing?: boolean;
  readonly target?: unknown;
}

const FILTERS: readonly FeedbackHistoryFilter[] = Object.freeze(['all', 'unread', 'important']);
const SORTS: readonly FeedbackHistorySort[] = Object.freeze(['newest', 'oldest']);
const FILTER_LABELS: Readonly<Record<FeedbackHistoryFilter, string>> = Object.freeze({
  all: 'Tümü',
  unread: 'Okunmamış',
  important: 'Önemli',
});
const SORT_LABELS: Readonly<Record<FeedbackHistorySort, string>> = Object.freeze({
  newest: 'En yeni',
  oldest: 'En eski',
});

const optionId = (kind: 'filter' | 'sort', value: string): string => `feedback-history-${kind}-${value}`;

const editable = (target: unknown): boolean => {
  if (!target || typeof target !== 'object') return false;
  const candidate = target as { readonly tagName?: unknown; readonly isContentEditable?: unknown };
  if (candidate.isContentEditable === true) return true;
  const tag = typeof candidate.tagName === 'string' ? candidate.tagName.toLowerCase() : undefined;
  return tag === 'input' || tag === 'textarea' || tag === 'select';
};

const guarded = (event: FeedbackHistoryControlsKeyboardEventLike): boolean =>
  Boolean(event.defaultPrevented || event.isComposing || event.repeat || event.altKey || event.ctrlKey || event.metaKey || editable(event.target));

export const createFeedbackHistoryControlsSnapshot = (input: FeedbackHistoryControlsInput): FeedbackHistoryControlsSnapshot => {
  const visible = input.history.visibleItems.length;
  const readCount = Math.max(0, visible - input.history.unreadCount);
  const filters = FILTERS.map((filter): FeedbackHistoryControlOption<FeedbackHistoryFilter> => Object.freeze({
    id: optionId('filter', filter),
    value: filter,
    label: FILTER_LABELS[filter],
    selected: input.filter === filter,
    disabled: filter === 'unread' ? input.history.unreadCount === 0 : filter === 'important' ? input.history.importantCount === 0 : false,
    tabIndex: input.filter === filter ? 0 : -1,
  }));
  const sorts = SORTS.map((sort): FeedbackHistoryControlOption<FeedbackHistorySort> => Object.freeze({
    id: optionId('sort', sort),
    value: sort,
    label: SORT_LABELS[sort],
    selected: input.sort === sort,
    disabled: visible < 2,
    tabIndex: input.sort === sort ? 0 : -1,
  }));
  return Object.freeze({
    toolbarId: 'feedback-history-controls',
    toolbarLabel: 'Bildirim geçmişi denetimleri',
    filterGroupId: 'feedback-history-filter-group',
    filterGroupLabel: 'Bildirimleri filtrele',
    sortGroupId: 'feedback-history-sort-group',
    sortGroupLabel: 'Bildirimleri sırala',
    summaryId: 'feedback-history-controls-summary',
    placement: input.viewport === 'phone' ? 'stacked' : 'inline',
    density: input.viewport === 'desktop' ? 'compact' : 'comfortable',
    targetSize: input.coarsePointer ? 48 : 44,
    motion: input.reducedMotion ? 'reduced' : 'standard',
    contrast: input.forcedColors ? 'forced' : 'standard',
    filters: Object.freeze(filters),
    sorts: Object.freeze(sorts),
    markAllReadDisabled: input.history.unreadCount === 0,
    clearReadDisabled: readCount === 0,
    summary: visible === 0 ? 'Gösterilecek bildirim yok.' : `${visible} bildirim gösteriliyor; ${input.history.unreadCount} okunmamış.`,
  });
};

const cycle = <T extends string>(values: readonly T[], current: T, delta: 1 | -1): T => {
  const index = Math.max(0, values.indexOf(current));
  return values[(index + delta + values.length) % values.length] ?? current;
};

export const resolveFeedbackHistoryControlsIntent = (
  event: FeedbackHistoryControlsKeyboardEventLike,
  current: { readonly filter: FeedbackHistoryFilter; readonly sort: FeedbackHistorySort },
): FeedbackHistoryControlsIntent => {
  if (guarded(event)) return null;
  if (event.key === 'Escape' && !event.shiftKey) return { type: 'close' };
  if (event.shiftKey) {
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') return { type: 'set-sort', sort: cycle(SORTS, current.sort, 1) };
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') return { type: 'set-sort', sort: cycle(SORTS, current.sort, -1) };
    if (event.key === 'Home') return { type: 'set-sort', sort: SORTS[0] ?? current.sort };
    if (event.key === 'End') return { type: 'set-sort', sort: SORTS.at(-1) ?? current.sort };
    return null;
  }
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') return { type: 'set-filter', filter: cycle(FILTERS, current.filter, 1) };
  if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') return { type: 'set-filter', filter: cycle(FILTERS, current.filter, -1) };
  if (event.key === 'Home') return { type: 'set-filter', filter: FILTERS[0] ?? current.filter };
  if (event.key === 'End') return { type: 'set-filter', filter: FILTERS.at(-1) ?? current.filter };
  if (event.key.toLocaleLowerCase('tr-TR') === 'r') return { type: 'mark-all-read' };
  if (event.key === 'Delete') return { type: 'clear-read' };
  return null;
};
