import { describe, expect, it } from 'vitest';
import type { FeedbackHistoryItem, FeedbackHistoryState } from './feedbackHistoryExperience';
import { createFeedbackHistoryDigest } from './feedbackHistoryDigest';

const NOW = 2_000_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const item = (
  id: string,
  overrides: Partial<FeedbackHistoryItem> = {},
): FeedbackHistoryItem => Object.freeze({
  id,
  semanticId: `feedback-${id}`,
  title: `Bildirim ${id}`,
  message: null,
  tone: 'neutral',
  priority: 'polite',
  occurredAt: NOW - HOUR,
  read: false,
  important: false,
  ...overrides,
});

const state = (
  items: readonly FeedbackHistoryItem[],
  overrides: Partial<FeedbackHistoryState> = {},
): FeedbackHistoryState => Object.freeze({
  items: Object.freeze([...items]),
  filter: 'all',
  sort: 'newest',
  activeId: items[0]?.id ?? null,
  unreadCount: items.filter((entry) => !entry.read).length,
  importantCount: items.filter((entry) => entry.important).length,
  ...overrides,
});

describe('createFeedbackHistoryDigest', () => {
  it('describes an empty workspace as quiet', () => {
    const digest = createFeedbackHistoryDigest(state([]), NOW);
    expect(digest.health).toBe('quiet');
    expect(digest.totalCount).toBe(0);
    expect(digest.unreadCount).toBe(0);
    expect(digest.importantCount).toBe(0);
    expect(digest.dominantTone).toBeNull();
    expect(digest.recommendedFilter).toBe('all');
    expect(digest.latestImportant).toBeNull();
    expect(digest.headline).toBe('Çalışma alanı sakin');
    expect(digest.summary).toContain('bildirim yok');
  });

  it('counts unread and important from items instead of trusting cached state counters', () => {
    const digest = createFeedbackHistoryDigest(state([
      item('a', { important: true, tone: 'warning' }),
      item('b', { important: true, read: true, tone: 'danger' }),
      item('c', { read: true, tone: 'success' }),
    ], { unreadCount: 99, importantCount: 99 }), NOW);
    expect(digest.unreadCount).toBe(1);
    expect(digest.importantCount).toBe(2);
    expect(digest.unreadImportantCount).toBe(1);
  });

  it('counts every supported tone', () => {
    const digest = createFeedbackHistoryDigest(state([
      item('neutral', { tone: 'neutral' }),
      item('success', { tone: 'success' }),
      item('warning', { tone: 'warning', important: true }),
      item('danger', { tone: 'danger', important: true }),
      item('danger-2', { tone: 'danger', important: true }),
    ]), NOW);
    expect(digest.toneCounts).toEqual({
      neutral: 1,
      success: 1,
      warning: 1,
      danger: 2,
    });
    expect(digest.dominantTone).toBe('danger');
  });

  it('uses severity as a deterministic tie breaker for dominant tone', () => {
    const digest = createFeedbackHistoryDigest(state([
      item('neutral', { tone: 'neutral', read: true }),
      item('success', { tone: 'success', read: true }),
      item('warning', { tone: 'warning', important: true, read: true }),
      item('danger', { tone: 'danger', important: true, read: true }),
    ]), NOW);
    expect(digest.dominantTone).toBe('danger');
  });

  it('buckets recent events without relying on wall-clock calendar formatting', () => {
    const digest = createFeedbackHistoryDigest(state([
      item('fresh', { occurredAt: NOW - 2 * MINUTE }),
      item('today', { occurredAt: NOW - 2 * HOUR }),
      item('older', { occurredAt: NOW - 2 * 24 * HOUR }),
    ]), NOW);
    expect(digest.timeCounts).toEqual({ fresh: 1, today: 1, older: 1 });
  });

  it('treats a boundary timestamp as part of the fresh window', () => {
    const digest = createFeedbackHistoryDigest(state([
      item('boundary', { occurredAt: NOW - 15 * MINUTE }),
    ]), NOW);
    expect(digest.timeCounts.fresh).toBe(1);
    expect(digest.timeCounts.today).toBe(0);
  });

  it('allows bounded custom time windows', () => {
    const digest = createFeedbackHistoryDigest(state([
      item('fresh', { occurredAt: NOW - 25 * MINUTE }),
      item('today', { occurredAt: NOW - 3 * HOUR }),
      item('older', { occurredAt: NOW - 8 * HOUR }),
    ]), NOW, {
      freshWindowMs: 30 * MINUTE,
      todayWindowMs: 6 * HOUR,
    });
    expect(digest.timeCounts).toEqual({ fresh: 1, today: 1, older: 1 });
  });

  it('clamps pathological time-window options', () => {
    const digest = createFeedbackHistoryDigest(state([
      item('recent', { occurredAt: NOW - 30_000 }),
    ]), NOW, {
      freshWindowMs: -100,
      todayWindowMs: Number.POSITIVE_INFINITY,
    });
    expect(digest.timeCounts.fresh).toBe(1);
  });

  it('treats future timestamps as zero-age instead of negative duration', () => {
    const digest = createFeedbackHistoryDigest(state([
      item('future', { occurredAt: NOW + HOUR }),
    ]), NOW);
    expect(digest.timeCounts.fresh).toBe(1);
  });

  it('treats non-finite timestamps as older', () => {
    const digest = createFeedbackHistoryDigest(state([
      item('invalid', { occurredAt: Number.NaN }),
    ]), NOW);
    expect(digest.timeCounts.older).toBe(1);
  });

  it('marks a danger event as critical even when read', () => {
    const digest = createFeedbackHistoryDigest(state([
      item('danger', { tone: 'danger', important: true, read: true }),
    ]), NOW);
    expect(digest.health).toBe('critical');
    expect(digest.headline).toBe('Kritik bildirimleri inceleyin');
  });

  it('marks three unread important events as critical', () => {
    const digest = createFeedbackHistoryDigest(state([
      item('one', { tone: 'warning', important: true }),
      item('two', { important: true }),
      item('three', { important: true }),
    ]), NOW);
    expect(digest.unreadImportantCount).toBe(3);
    expect(digest.health).toBe('critical');
  });

  it('marks one unread important event as attention', () => {
    const digest = createFeedbackHistoryDigest(state([
      item('one', { important: true }),
    ]), NOW);
    expect(digest.health).toBe('attention');
    expect(digest.headline).toBe('Önemli bildirimler bekliyor');
  });

  it('marks a warning as attention', () => {
    const digest = createFeedbackHistoryDigest(state([
      item('warning', { tone: 'warning', important: true, read: true }),
    ]), NOW);
    expect(digest.health).toBe('attention');
  });

  it('marks five ordinary unread events as attention', () => {
    const digest = createFeedbackHistoryDigest(state([
      item('1'), item('2'), item('3'), item('4'), item('5'),
    ]), NOW);
    expect(digest.health).toBe('attention');
  });

  it('marks ordinary reviewed events as stable', () => {
    const digest = createFeedbackHistoryDigest(state([
      item('one', { read: true, tone: 'success' }),
      item('two', { read: true, tone: 'neutral' }),
    ]), NOW);
    expect(digest.health).toBe('stable');
    expect(digest.headline).toBe('Bildirimler kontrol altında');
  });

  it('marks a small unread ordinary queue as stable with an informative headline', () => {
    const digest = createFeedbackHistoryDigest(state([
      item('one'), item('two'),
    ]), NOW);
    expect(digest.health).toBe('stable');
    expect(digest.headline).toBe('Yeni bilgilendirmeler var');
  });

  it('recommends important when an unread important event exists', () => {
    const digest = createFeedbackHistoryDigest(state([
      item('important', { important: true }),
      item('ordinary'),
    ]), NOW);
    expect(digest.recommendedFilter).toBe('important');
  });

  it('recommends important when the important backlog is large even if read', () => {
    const digest = createFeedbackHistoryDigest(state([
      item('one', { important: true, read: true }),
      item('two', { important: true, read: true }),
      item('three', { important: true, read: true }),
    ]), NOW);
    expect(digest.recommendedFilter).toBe('important');
  });

  it('recommends unread when no important attention is pending', () => {
    const digest = createFeedbackHistoryDigest(state([
      item('one'),
      item('reviewed', { read: true }),
    ]), NOW);
    expect(digest.recommendedFilter).toBe('unread');
  });

  it('recommends all when there is no pending attention', () => {
    const digest = createFeedbackHistoryDigest(state([
      item('reviewed', { read: true }),
    ]), NOW);
    expect(digest.recommendedFilter).toBe('all');
  });

  it('selects the newest important event without mutating source order', () => {
    const items = Object.freeze([
      item('newer', { important: true, occurredAt: NOW - MINUTE }),
      item('ordinary', { occurredAt: NOW }),
      item('older', { important: true, occurredAt: NOW - HOUR }),
    ]);
    const digest = createFeedbackHistoryDigest(state(items), NOW);
    expect(digest.latestImportant?.id).toBe('newer');
    expect(items.map((entry) => entry.id)).toEqual(['newer', 'ordinary', 'older']);
  });

  it('exposes immutable latest-important data', () => {
    const digest = createFeedbackHistoryDigest(state([
      item('important', { important: true }),
    ]), NOW);
    expect(Object.isFrozen(digest.latestImportant)).toBe(true);
  });

  it('exposes four deterministic metrics', () => {
    const digest = createFeedbackHistoryDigest(state([
      item('fresh-important', { important: true, occurredAt: NOW - MINUTE }),
      item('read', { read: true }),
    ]), NOW);
    expect(digest.metrics.map((metric) => metric.id)).toEqual(['total', 'unread', 'important', 'fresh']);
    expect(digest.metrics.map((metric) => metric.value)).toEqual([2, 1, 1, 1]);
    expect(digest.metrics.find((metric) => metric.id === 'unread')?.filter).toBe('unread');
    expect(digest.metrics.find((metric) => metric.id === 'important')?.filter).toBe('important');
  });

  it('disables empty quick-filter metrics', () => {
    const digest = createFeedbackHistoryDigest(state([
      item('read', { read: true }),
    ]), NOW);
    expect(digest.metrics.find((metric) => metric.id === 'unread')?.actionable).toBe(false);
    expect(digest.metrics.find((metric) => metric.id === 'important')?.actionable).toBe(false);
  });

  it('keeps the all metric actionable when history exists', () => {
    const digest = createFeedbackHistoryDigest(state([
      item('read', { read: true }),
    ]), NOW);
    expect(digest.metrics.find((metric) => metric.id === 'total')?.actionable).toBe(true);
  });

  it('summarizes fresh, unread and important counts in one bounded sentence', () => {
    const digest = createFeedbackHistoryDigest(state([
      item('fresh-important', { important: true, occurredAt: NOW - MINUTE }),
      item('old-unread', { occurredAt: NOW - 2 * HOUR }),
      item('read', { read: true }),
    ]), NOW);
    expect(digest.summary).toBe('3 kayıt, 2 okunmamış, 1 önemli, 1 son 15 dakika içinde.');
    expect(digest.announcement).toContain(digest.headline);
    expect(digest.announcement).toContain(digest.summary);
  });

  it('reports a reviewed, non-important history succinctly', () => {
    const digest = createFeedbackHistoryDigest(state([
      item('one', { read: true }),
      item('two', { read: true, tone: 'success' }),
    ]), NOW);
    expect(digest.summary).toBe('2 bildirim incelendi; bekleyen önemli veya okunmamış kayıt yok.');
  });

  it('freezes the digest and nested summary objects', () => {
    const digest = createFeedbackHistoryDigest(state([
      item('one'),
    ]), NOW);
    expect(Object.isFrozen(digest)).toBe(true);
    expect(Object.isFrozen(digest.toneCounts)).toBe(true);
    expect(Object.isFrozen(digest.timeCounts)).toBe(true);
    expect(Object.isFrozen(digest.metrics)).toBe(true);
    expect(digest.metrics.every((metric) => Object.isFrozen(metric))).toBe(true);
  });

  it('does not mutate source history state', () => {
    const source = state([
      item('a'),
      item('b', { important: true, tone: 'warning' }),
    ]);
    const before = JSON.stringify(source);
    createFeedbackHistoryDigest(source, NOW);
    expect(JSON.stringify(source)).toBe(before);
  });

  it('normalizes an invalid now value deterministically', () => {
    const digest = createFeedbackHistoryDigest(state([
      item('one', { occurredAt: 0 }),
    ]), Number.NaN);
    expect(digest.generatedAt).toBe(0);
    expect(digest.timeCounts.fresh).toBe(1);
  });
});
