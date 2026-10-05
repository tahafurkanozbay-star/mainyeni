import type {
  FeedbackHistoryFilter,
  FeedbackHistoryItem,
  FeedbackHistoryState,
} from './feedbackHistoryExperience';
import type { FeedbackTone } from './feedbackExperience';

export type FeedbackHistoryHealth = 'quiet' | 'stable' | 'attention' | 'critical';
export type FeedbackHistoryTimeBucket = 'fresh' | 'today' | 'older';

export interface FeedbackHistoryToneCounts {
  readonly neutral: number;
  readonly success: number;
  readonly warning: number;
  readonly danger: number;
}

export interface FeedbackHistoryTimeCounts {
  readonly fresh: number;
  readonly today: number;
  readonly older: number;
}

export interface FeedbackHistoryDigestMetric {
  readonly id: 'total' | 'unread' | 'important' | 'fresh';
  readonly label: string;
  readonly value: number;
  readonly filter: FeedbackHistoryFilter;
  readonly actionable: boolean;
  readonly emphasized: boolean;
}

export interface FeedbackHistoryDigestLatestImportant {
  readonly id: string;
  readonly title: string;
  readonly tone: FeedbackTone;
  readonly occurredAt: number;
  readonly read: boolean;
}

export interface FeedbackHistoryDigest {
  readonly generatedAt: number;
  readonly totalCount: number;
  readonly unreadCount: number;
  readonly importantCount: number;
  readonly unreadImportantCount: number;
  readonly toneCounts: FeedbackHistoryToneCounts;
  readonly timeCounts: FeedbackHistoryTimeCounts;
  readonly dominantTone: FeedbackTone | null;
  readonly health: FeedbackHistoryHealth;
  readonly recommendedFilter: FeedbackHistoryFilter;
  readonly latestImportant: FeedbackHistoryDigestLatestImportant | null;
  readonly headline: string;
  readonly summary: string;
  readonly announcement: string;
  readonly metrics: readonly FeedbackHistoryDigestMetric[];
}

export interface FeedbackHistoryDigestOptions {
  readonly freshWindowMs?: number;
  readonly todayWindowMs?: number;
}

const MINUTE_MS = 60_000;
const DEFAULT_FRESH_WINDOW_MS = 15 * MINUTE_MS;
const DEFAULT_TODAY_WINDOW_MS = 24 * 60 * MINUTE_MS;
const MIN_WINDOW_MS = MINUTE_MS;
const MAX_WINDOW_MS = 7 * 24 * 60 * MINUTE_MS;

const safeNow = (value: number): number =>
  Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;

const boundedWindow = (value: number | undefined, fallback: number): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(MIN_WINDOW_MS, Math.min(MAX_WINDOW_MS, Math.trunc(value ?? fallback)));
};

const itemAge = (item: FeedbackHistoryItem, now: number): number => {
  if (!Number.isFinite(item.occurredAt)) return Number.POSITIVE_INFINITY;
  return Math.max(0, now - Math.max(0, Math.trunc(item.occurredAt)));
};

const timeBucketFor = (
  item: FeedbackHistoryItem,
  now: number,
  freshWindowMs: number,
  todayWindowMs: number,
): FeedbackHistoryTimeBucket => {
  const age = itemAge(item, now);
  if (age <= freshWindowMs) return 'fresh';
  if (age <= todayWindowMs) return 'today';
  return 'older';
};

const countTones = (items: readonly FeedbackHistoryItem[]): FeedbackHistoryToneCounts => {
  let neutral = 0;
  let success = 0;
  let warning = 0;
  let danger = 0;

  for (const item of items) {
    switch (item.tone) {
      case 'success': success += 1; break;
      case 'warning': warning += 1; break;
      case 'danger': danger += 1; break;
      default: neutral += 1; break;
    }
  }

  return Object.freeze({ neutral, success, warning, danger });
};

const countTimes = (
  items: readonly FeedbackHistoryItem[],
  now: number,
  freshWindowMs: number,
  todayWindowMs: number,
): FeedbackHistoryTimeCounts => {
  let fresh = 0;
  let today = 0;
  let older = 0;

  for (const item of items) {
    switch (timeBucketFor(item, now, freshWindowMs, todayWindowMs)) {
      case 'fresh': fresh += 1; break;
      case 'today': today += 1; break;
      case 'older': older += 1; break;
    }
  }

  return Object.freeze({ fresh, today, older });
};

const dominantToneFor = (counts: FeedbackHistoryToneCounts): FeedbackTone | null => {
  const ranked: readonly [FeedbackTone, number, number][] = [
    ['danger', counts.danger, 4],
    ['warning', counts.warning, 3],
    ['success', counts.success, 2],
    ['neutral', counts.neutral, 1],
  ];
  let winner: FeedbackTone | null = null;
  let winnerCount = 0;
  let winnerPriority = 0;

  for (const [tone, count, priority] of ranked) {
    if (count > winnerCount || (count === winnerCount && count > 0 && priority > winnerPriority)) {
      winner = tone;
      winnerCount = count;
      winnerPriority = priority;
    }
  }
  return winner;
};

const healthFor = (
  totalCount: number,
  unreadCount: number,
  unreadImportantCount: number,
  tones: FeedbackHistoryToneCounts,
): FeedbackHistoryHealth => {
  if (totalCount === 0) return 'quiet';
  if (tones.danger > 0 || unreadImportantCount >= 3) return 'critical';
  if (tones.warning > 0 || unreadImportantCount > 0 || unreadCount >= 5) return 'attention';
  return 'stable';
};

const recommendedFilterFor = (
  unreadCount: number,
  importantCount: number,
  unreadImportantCount: number,
): FeedbackHistoryFilter => {
  if (unreadImportantCount > 0 || importantCount >= 3) return 'important';
  if (unreadCount > 0) return 'unread';
  return 'all';
};

const latestImportantFor = (
  items: readonly FeedbackHistoryItem[],
): FeedbackHistoryDigestLatestImportant | null => {
  let latest: FeedbackHistoryItem | null = null;
  for (const item of items) {
    if (!item.important) continue;
    if (!latest || item.occurredAt > latest.occurredAt) latest = item;
  }
  return latest ? Object.freeze({
    id: latest.id,
    title: latest.title,
    tone: latest.tone,
    occurredAt: latest.occurredAt,
    read: latest.read,
  }) : null;
};

const headlineFor = (
  health: FeedbackHistoryHealth,
  unreadCount: number,
  unreadImportantCount: number,
): string => {
  switch (health) {
    case 'quiet': return 'Çalışma alanı sakin';
    case 'stable': return unreadCount > 0 ? 'Yeni bilgilendirmeler var' : 'Bildirimler kontrol altında';
    case 'attention': return unreadImportantCount > 0 ? 'Önemli bildirimler bekliyor' : 'Dikkat gerektiren bildirimler var';
    case 'critical': return 'Kritik bildirimleri inceleyin';
  }
};

const summaryFor = (
  totalCount: number,
  unreadCount: number,
  importantCount: number,
  freshCount: number,
): string => {
  if (totalCount === 0) return 'Son yedi günlük çalışma alanı geçmişinde bildirim yok.';
  if (unreadCount === 0 && importantCount === 0) {
    return `${totalCount} bildirim incelendi; bekleyen önemli veya okunmamış kayıt yok.`;
  }
  const parts = [`${totalCount} kayıt`];
  if (unreadCount > 0) parts.push(`${unreadCount} okunmamış`);
  if (importantCount > 0) parts.push(`${importantCount} önemli`);
  if (freshCount > 0) parts.push(`${freshCount} son 15 dakika içinde`);
  return `${parts.join(', ')}.`;
};

const metricsFor = (
  totalCount: number,
  unreadCount: number,
  importantCount: number,
  freshCount: number,
): readonly FeedbackHistoryDigestMetric[] => Object.freeze([
  Object.freeze({
    id: 'total',
    label: 'Toplam',
    value: totalCount,
    filter: 'all' as const,
    actionable: totalCount > 0,
    emphasized: false,
  }),
  Object.freeze({
    id: 'unread',
    label: 'Okunmamış',
    value: unreadCount,
    filter: 'unread' as const,
    actionable: unreadCount > 0,
    emphasized: unreadCount > 0,
  }),
  Object.freeze({
    id: 'important',
    label: 'Önemli',
    value: importantCount,
    filter: 'important' as const,
    actionable: importantCount > 0,
    emphasized: importantCount > 0,
  }),
  Object.freeze({
    id: 'fresh',
    label: 'Yeni',
    value: freshCount,
    filter: 'all' as const,
    actionable: freshCount > 0,
    emphasized: false,
  }),
]);

export const createFeedbackHistoryDigest = (
  state: FeedbackHistoryState,
  now = Date.now(),
  options: FeedbackHistoryDigestOptions = {},
): FeedbackHistoryDigest => {
  const generatedAt = safeNow(now);
  const freshWindowMs = boundedWindow(options.freshWindowMs, DEFAULT_FRESH_WINDOW_MS);
  const todayWindowMs = Math.max(
    freshWindowMs,
    boundedWindow(options.todayWindowMs, DEFAULT_TODAY_WINDOW_MS),
  );
  const items = state.items;
  const totalCount = items.length;
  let unreadCount = 0;
  let importantCount = 0;
  let unreadImportantCount = 0;

  for (const item of items) {
    if (!item.read) unreadCount += 1;
    if (item.important) {
      importantCount += 1;
      if (!item.read) unreadImportantCount += 1;
    }
  }

  const toneCounts = countTones(items);
  const timeCounts = countTimes(items, generatedAt, freshWindowMs, todayWindowMs);
  const dominantTone = dominantToneFor(toneCounts);
  const health = healthFor(totalCount, unreadCount, unreadImportantCount, toneCounts);
  const recommendedFilter = recommendedFilterFor(unreadCount, importantCount, unreadImportantCount);
  const latestImportant = latestImportantFor(items);
  const headline = headlineFor(health, unreadCount, unreadImportantCount);
  const summary = summaryFor(totalCount, unreadCount, importantCount, timeCounts.fresh);

  return Object.freeze({
    generatedAt,
    totalCount,
    unreadCount,
    importantCount,
    unreadImportantCount,
    toneCounts,
    timeCounts,
    dominantTone,
    health,
    recommendedFilter,
    latestImportant,
    headline,
    summary,
    announcement: `${headline}. ${summary}`,
    metrics: metricsFor(totalCount, unreadCount, importantCount, timeCounts.fresh),
  });
};
