import type { NotificationTriageEntry, NotificationTriageSnapshot } from './notificationTriageModel';

export interface NotificationTriageWindowEntry extends NotificationTriageEntry {
  readonly windowPosition: number;
}

export interface NotificationTriageWindow {
  readonly entries: readonly NotificationTriageWindowEntry[];
  readonly start: number;
  readonly end: number;
  readonly limit: number;
  readonly total: number;
  readonly truncatedBefore: number;
  readonly truncatedAfter: number;
  readonly activeVisible: boolean;
  readonly statusText: string;
}

const DEFAULT_LIMIT = 6;
const MIN_LIMIT = 3;
const MAX_LIMIT = 10;

const clampLimit = (value: number | undefined): number => {
  if (!Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.max(MIN_LIMIT, Math.min(MAX_LIMIT, Math.trunc(value ?? DEFAULT_LIMIT)));
};

const resolveStart = (
  total: number,
  activeIndex: number,
  limit: number,
): number => {
  if (total <= limit) return 0;
  const safeActive = activeIndex >= 0 && activeIndex < total ? activeIndex : 0;
  const leading = Math.floor((limit - 1) / 2);
  return Math.max(0, Math.min(total - limit, safeActive - leading));
};

const createStatusText = (
  snapshot: NotificationTriageSnapshot,
  start: number,
  end: number,
): string => {
  if (snapshot.resultCount === 0) return snapshot.announcement;
  if (snapshot.resultCount <= end - start) return snapshot.announcement;
  return `${snapshot.announcement} Hızlı listede ${start + 1}-${end} arası gösteriliyor.`;
};

export const createNotificationTriageWindow = (
  snapshot: NotificationTriageSnapshot,
  limitValue?: number,
): NotificationTriageWindow => {
  const limit = clampLimit(limitValue);
  const start = resolveStart(snapshot.resultCount, snapshot.activeIndex, limit);
  const end = Math.min(snapshot.resultCount, start + limit);
  const entries = Object.freeze(snapshot.entries.slice(start, end).map((entry, index) => Object.freeze({
    ...entry,
    windowPosition: index + 1,
  })));
  const activeVisible = snapshot.activeId === null
    ? entries.length === 0
    : entries.some((entry) => entry.id === snapshot.activeId);

  return Object.freeze({
    entries,
    start,
    end,
    limit,
    total: snapshot.resultCount,
    truncatedBefore: start,
    truncatedAfter: Math.max(0, snapshot.resultCount - end),
    activeVisible,
    statusText: createStatusText(snapshot, start, end),
  });
};

export const notificationTriageWindowFacts = (
  window: NotificationTriageWindow,
): Readonly<Record<string, number | boolean>> => Object.freeze({
  renderCount: window.entries.length,
  totalCount: window.total,
  limit: window.limit,
  truncatedBefore: window.truncatedBefore,
  truncatedAfter: window.truncatedAfter,
  activeVisible: window.activeVisible,
});
