import { describe, expect, it } from 'vitest';
import type { NotificationCenterSnapshot, NotificationItem } from './notificationCenterModel';
import {
  notificationToFeedbackHistoryInput,
  notificationToFeedbackInput,
  notificationToFeedbackViewModel,
  synchronizeNotificationHistory,
} from './feedbackNotificationAdapter';
import { createFeedbackHistorySessionState } from './feedbackHistorySession';

const now = 1_800_000_000_000;

const item = (overrides: Partial<NotificationItem> = {}): NotificationItem => Object.freeze({
  id: 'notice-1',
  title: 'Harita güncellendi',
  message: 'Yeni görünüm hazır.',
  tone: 'info',
  priority: 'normal',
  category: 'Harita',
  dismissible: true,
  sticky: false,
  createdAt: now - 100,
  expiresAt: null,
  dedupeKey: null,
  actions: Object.freeze([]),
  read: false,
  occurrenceCount: 1,
  ...overrides,
});

const snapshot = (items: readonly NotificationItem[]): NotificationCenterSnapshot => Object.freeze({
  items: Object.freeze([...items]),
  unreadCount: items.filter((entry) => !entry.read).length,
  urgentUnreadCount: items.filter((entry) => !entry.read && (entry.priority === 'urgent' || entry.tone === 'error')).length,
  categories: Object.freeze([]),
  announcement: null,
  revision: 1,
});

describe('feedback notification adapter', () => {
  it('maps informational notifications to neutral polite feedback', () => {
    const mapped = notificationToFeedbackInput(item());
    expect(mapped).toMatchObject({
      id: 'notice-1',
      title: 'Harita güncellendi',
      tone: 'neutral',
      priority: 'polite',
      placement: 'toast',
      dismissible: true,
    });
  });

  it.each([
    ['success', 'success'],
    ['warning', 'warning'],
    ['error', 'danger'],
  ] as const)('maps %s tone to %s feedback tone', (sourceTone, expected) => {
    expect(notificationToFeedbackInput(item({ tone: sourceTone })).tone).toBe(expected);
  });

  it('promotes urgent notifications to assertive banner presentation', () => {
    const mapped = notificationToFeedbackInput(item({ priority: 'urgent' }));
    expect(mapped.priority).toBe('assertive');
    expect(mapped.placement).toBe('banner');
  });

  it('promotes error notifications even when source priority is normal', () => {
    const mapped = notificationToFeedbackInput(item({ tone: 'error', priority: 'normal' }));
    expect(mapped.priority).toBe('assertive');
    expect(mapped.placement).toBe('banner');
  });

  it('surfaces the first action as the feedback action label', () => {
    const mapped = notificationToFeedbackInput(item({
      actions: Object.freeze([
        Object.freeze({ id: 'open', label: 'Sonucu aç' }),
        Object.freeze({ id: 'dismiss', label: 'Yoksay' }),
      ]),
    }));
    expect(mapped.actionLabel).toBe('Sonucu aç');
  });

  it('adds bounded repeat information without changing the source item', () => {
    const source = item({ occurrenceCount: 500, message: 'Aynı olay oluştu.' });
    const mapped = notificationToFeedbackInput(source);
    expect(mapped.message).toBe('Aynı olay oluştu. 99 kez tekrarlandı.');
    expect(source.occurrenceCount).toBe(500);
  });

  it('does not add repeat text for the first occurrence', () => {
    expect(notificationToFeedbackInput(item({ occurrenceCount: 1 })).message).toBe('Yeni görünüm hazır.');
  });

  it('creates a sanitized feedback view model through the canonical presentation model', () => {
    const mapped = notificationToFeedbackViewModel(item({
      id: '  unsafe id\u0000 ',
      title: '  Harita\u0000 hazır  ',
      message: '  içerik   hazır  ',
    }), now);
    expect(mapped).not.toBeNull();
    expect(mapped?.id).not.toContain('\u0000');
    expect(mapped?.title).toBe('Harita hazır');
    expect(mapped?.message).toBe('içerik hazır');
  });

  it('preserves source read state in history input', () => {
    const history = notificationToFeedbackHistoryInput(item({ read: true }), now);
    expect(history?.read).toBe(true);
    expect(history?.occurredAt).toBe(now - 100);
  });

  it('rejects expired live notifications from feedback history admission', () => {
    const history = notificationToFeedbackHistoryInput(item({ expiresAt: now - 1 }), now);
    expect(history).toBeNull();
  });

  it('replays source items oldest-first for deterministic bounded history', () => {
    const first = item({ id: 'first', createdAt: now - 300 });
    const second = item({ id: 'second', createdAt: now - 200 });
    const third = item({ id: 'third', createdAt: now - 100 });
    const result = synchronizeNotificationHistory(
      createFeedbackHistorySessionState(now),
      snapshot([third, second, first]),
      now,
    );
    expect(result.acceptedIds).toEqual(['first', 'second', 'third']);
    expect(result.state.history.items.map((entry) => entry.id)).toEqual(['first', 'second', 'third']);
  });

  it('keeps dismissed source items in bounded presentation history', () => {
    const initial = synchronizeNotificationHistory(
      createFeedbackHistorySessionState(now),
      snapshot([item({ id: 'kept' })]),
      now,
    ).state;
    const next = synchronizeNotificationHistory(initial, snapshot([]), now + 10);
    expect(next.state.history.items.map((entry) => entry.id)).toContain('kept');
  });

  it('updates duplicate history items from the live notification state', () => {
    const unread = synchronizeNotificationHistory(
      createFeedbackHistorySessionState(now),
      snapshot([item({ id: 'same', read: false })]),
      now,
    ).state;
    const read = synchronizeNotificationHistory(
      unread,
      snapshot([item({ id: 'same', read: true })]),
      now + 10,
    ).state;
    expect(read.history.items).toHaveLength(1);
    expect(read.history.items[0]?.read).toBe(true);
  });

  it('bounds accumulated history at the canonical fifty-item capacity', () => {
    const items = Array.from({ length: 80 }, (_, index) => item({
      id: `notice-${index}`,
      title: `Bildirim ${index}`,
      createdAt: now - (80 - index),
    })).reverse();
    const result = synchronizeNotificationHistory(
      createFeedbackHistorySessionState(now),
      snapshot(items),
      now,
    );
    expect(result.state.history.items).toHaveLength(50);
    expect(new Set(result.state.history.items.map((entry) => entry.id)).size).toBe(50);
  });

  it('reports feedback items rejected by canonical admission rules', () => {
    const expired = item({ id: 'expired', expiresAt: now - 1 });
    const result = synchronizeNotificationHistory(
      createFeedbackHistorySessionState(now),
      snapshot([expired]),
      now,
    );
    expect(result.acceptedIds).toEqual([]);
    expect(result.rejectedIds).toEqual(['expired']);
  });

  it('returns immutable accepted and rejected id snapshots', () => {
    const result = synchronizeNotificationHistory(
      createFeedbackHistorySessionState(now),
      snapshot([item({ id: 'immutable' })]),
      now,
    );
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.acceptedIds)).toBe(true);
    expect(Object.isFrozen(result.rejectedIds)).toBe(true);
  });
});
