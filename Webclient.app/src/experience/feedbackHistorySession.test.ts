import { describe, expect, it } from 'vitest';
import type { FeedbackViewModel } from './feedbackExperience';
import {
  createFeedbackHistorySessionState,
  createFeedbackHistorySessionView,
  reduceFeedbackHistorySession,
} from './feedbackHistorySession';

const NOW = 1_800_000_000_000;

const feedback = (
  id: string,
  overrides: Partial<FeedbackViewModel> = {},
): FeedbackViewModel => Object.freeze({
  id,
  semanticId: `feedback-${id}`,
  title: `Bildirim ${id}`,
  message: `Açıklama ${id}`,
  tone: 'info',
  priority: 'polite',
  role: 'status',
  live: 'polite',
  atomic: true,
  dismissible: true,
  action: null,
  expiresAt: null,
  ...overrides,
});

const append = (
  state: ReturnType<typeof createFeedbackHistorySessionState>,
  id: string,
  occurredAt = NOW,
  overrides: Partial<FeedbackViewModel> = {},
) => reduceFeedbackHistorySession(state, {
  type: 'append',
  item: { feedback: feedback(id, overrides), occurredAt },
}, NOW).state;

describe('feedbackHistorySession', () => {
  it('starts closed with bounded deterministic semantic ids', () => {
    const state = createFeedbackHistorySessionState(NOW);
    const view = createFeedbackHistorySessionView(state);
    expect(view.open).toBe(false);
    expect(view.headingId).toBe('feedback-history-heading');
    expect(view.listId).toBe('feedback-history-list');
    expect(view.statusId).toBe('feedback-history-status');
    expect(view.closeButtonId).toBe('feedback-history-close');
    expect(view.restoreFocusId).toBeNull();
    expect(view.history.visibleItems).toEqual([]);
  });

  it('opens and focuses the close control when history is empty', () => {
    const result = reduceFeedbackHistorySession(createFeedbackHistorySessionState(NOW), {
      type: 'open',
      callerId: 'Header Alerts',
    }, NOW);
    expect(result.state.open).toBe(true);
    expect(result.state.callerId).toBe('header-alerts');
    expect(result.effect).toEqual({ type: 'focus', targetId: 'feedback-history-close' });
    expect(result.state.lastAnnouncement).toBe('Bildirim geçmişi açıldı.');
  });

  it('sanitizes hostile caller ids before storing focus authority', () => {
    const hostile = `  <script>\u0000ALERT(1)</script> ${'x'.repeat(200)}  `;
    const result = reduceFeedbackHistorySession(createFeedbackHistorySessionState(NOW), {
      type: 'open',
      callerId: hostile,
    }, NOW);
    expect(result.state.callerId).not.toContain('<');
    expect(result.state.callerId).not.toContain('>');
    expect(result.state.callerId).not.toContain('\u0000');
    expect(result.state.callerId!.length).toBeLessThanOrEqual(96);
  });

  it('uses a deterministic caller fallback for blank hostile ids', () => {
    const result = reduceFeedbackHistorySession(createFeedbackHistorySessionState(NOW), {
      type: 'open',
      callerId: '\u0000\u0001   ',
    }, NOW);
    expect(result.state.callerId).toBe('feedback-history-trigger');
  });

  it('focuses the active item when opening non-empty history', () => {
    let state = createFeedbackHistorySessionState(NOW);
    state = append(state, 'alpha');
    const result = reduceFeedbackHistorySession(state, { type: 'open', callerId: 'trigger' }, NOW);
    expect(result.effect).toEqual({ type: 'focus', targetId: 'feedback-history-item-alpha' });
  });

  it('restores caller focus when closing', () => {
    const opened = reduceFeedbackHistorySession(createFeedbackHistorySessionState(NOW), {
      type: 'open', callerId: 'notification-button',
    }, NOW).state;
    const closed = reduceFeedbackHistorySession(opened, { type: 'close' }, NOW);
    expect(closed.state.open).toBe(false);
    expect(closed.effect).toEqual({ type: 'restore-focus', targetId: 'notification-button' });
  });

  it('does nothing when close is requested while already closed', () => {
    const state = createFeedbackHistorySessionState(NOW);
    const closed = reduceFeedbackHistorySession(state, { type: 'close' }, NOW);
    expect(closed.state).toBe(state);
    expect(closed.effect).toEqual({ type: 'none' });
  });

  it('preserves bounded history retention through append commands', () => {
    let state = createFeedbackHistorySessionState(NOW);
    for (let index = 0; index < 60; index += 1) {
      state = append(state, `item-${index}`, NOW - index);
    }
    expect(state.history.items).toHaveLength(50);
  });

  it('does not admit stale history items', () => {
    const state = append(createFeedbackHistorySessionState(NOW), 'stale', NOW - 8 * 24 * 60 * 60 * 1000);
    expect(state.history.items).toHaveLength(0);
  });

  it('announces filter results without unbounded payload text', () => {
    let state = createFeedbackHistorySessionState(NOW);
    state = append(state, 'read');
    state = reduceFeedbackHistorySession(state, { type: 'mark-all-read' }, NOW).state;
    const result = reduceFeedbackHistorySession(state, { type: 'filter', filter: 'unread' }, NOW);
    expect(result.effect).toEqual({ type: 'announce', message: 'Okunmamış bildirim yok.' });
    expect(result.state.lastAnnouncement.length).toBeLessThanOrEqual(240);
  });

  it('announces deterministic sort direction', () => {
    let state = createFeedbackHistorySessionState(NOW);
    state = append(state, 'one', NOW - 100);
    state = append(state, 'two', NOW);
    const result = reduceFeedbackHistorySession(state, { type: 'sort', sort: 'oldest' }, NOW);
    expect(result.effect).toEqual({ type: 'announce', message: '2 bildirim eskiden yeniye sıralandı.' });
    expect(result.view.history.visibleItems.map(item => item.id)).toEqual(['one', 'two']);
  });

  it('marks only the active item read', () => {
    let state = createFeedbackHistorySessionState(NOW);
    state = append(state, 'one', NOW - 1);
    state = append(state, 'two', NOW);
    const result = reduceFeedbackHistorySession(state, { type: 'mark-active-read' }, NOW);
    expect(result.state.history.items.find(item => item.id === 'two')?.read).toBe(true);
    expect(result.state.history.items.find(item => item.id === 'one')?.read).toBe(false);
    expect(result.effect.type).toBe('announce');
  });

  it('is inert when mark-active-read has no active item', () => {
    const state = createFeedbackHistorySessionState(NOW);
    const result = reduceFeedbackHistorySession(state, { type: 'mark-active-read' }, NOW);
    expect(result.state).toBe(state);
    expect(result.effect).toEqual({ type: 'none' });
  });

  it('marks all items read and reconciles unread filter', () => {
    let state = createFeedbackHistorySessionState(NOW);
    state = append(state, 'one');
    state = append(state, 'two');
    state = reduceFeedbackHistorySession(state, { type: 'filter', filter: 'unread' }, NOW).state;
    const result = reduceFeedbackHistorySession(state, { type: 'mark-all-read' }, NOW);
    expect(result.state.history.unreadCount).toBe(0);
    expect(result.view.history.visibleItems).toEqual([]);
  });

  it('removes active and focuses reconciled next item', () => {
    let state = createFeedbackHistorySessionState(NOW);
    state = append(state, 'one', NOW - 1);
    state = append(state, 'two', NOW);
    const result = reduceFeedbackHistorySession(state, { type: 'remove-active' }, NOW);
    expect(result.state.history.items.map(item => item.id)).toEqual(['one']);
    expect(result.effect).toEqual({ type: 'focus', targetId: 'feedback-history-item-one' });
  });

  it('focuses close after removing the final item', () => {
    let state = createFeedbackHistorySessionState(NOW);
    state = append(state, 'only');
    const result = reduceFeedbackHistorySession(state, { type: 'remove-active' }, NOW);
    expect(result.effect).toEqual({ type: 'focus', targetId: 'feedback-history-close' });
    expect(result.view.history.emptyMessage).toBe('Bildirim geçmişi boş.');
  });

  it('clears read items while preserving unread items', () => {
    let state = createFeedbackHistorySessionState(NOW);
    state = append(state, 'read', NOW - 1);
    state = reduceFeedbackHistorySession(state, { type: 'mark-active-read' }, NOW).state;
    state = append(state, 'unread', NOW);
    const result = reduceFeedbackHistorySession(state, { type: 'clear-read' }, NOW);
    expect(result.state.history.items.map(item => item.id)).toEqual(['unread']);
    expect(result.effect.type).toBe('announce');
  });

  it('ignores keyboard commands while closed', () => {
    const state = append(createFeedbackHistorySessionState(NOW), 'one');
    const result = reduceFeedbackHistorySession(state, { type: 'keyboard', event: { key: 'ArrowDown' } }, NOW);
    expect(result.state).toBe(state);
    expect(result.effect).toEqual({ type: 'none' });
  });

  it('moves roving focus with ArrowDown while open', () => {
    let state = createFeedbackHistorySessionState(NOW);
    state = append(state, 'one', NOW - 2);
    state = append(state, 'two', NOW - 1);
    state = append(state, 'three', NOW);
    state = reduceFeedbackHistorySession(state, { type: 'open' }, NOW).state;
    const result = reduceFeedbackHistorySession(state, { type: 'keyboard', event: { key: 'ArrowDown' } }, NOW);
    expect(result.state.history.activeId).toBe('two');
    expect(result.effect).toEqual({ type: 'focus', targetId: 'feedback-history-item-two' });
  });

  it('wraps roving focus with ArrowUp', () => {
    let state = createFeedbackHistorySessionState(NOW);
    state = append(state, 'one', NOW - 1);
    state = append(state, 'two', NOW);
    state = reduceFeedbackHistorySession(state, { type: 'open' }, NOW).state;
    const result = reduceFeedbackHistorySession(state, { type: 'keyboard', event: { key: 'ArrowUp' } }, NOW);
    expect(result.state.history.activeId).toBe('one');
  });

  it('moves to deterministic first and last items', () => {
    let state = createFeedbackHistorySessionState(NOW);
    state = append(state, 'oldest', NOW - 100);
    state = append(state, 'newest', NOW);
    state = reduceFeedbackHistorySession(state, { type: 'open' }, NOW).state;
    const last = reduceFeedbackHistorySession(state, { type: 'keyboard', event: { key: 'End' } }, NOW);
    expect(last.state.history.activeId).toBe('oldest');
    const first = reduceFeedbackHistorySession(last.state, { type: 'keyboard', event: { key: 'Home' } }, NOW);
    expect(first.state.history.activeId).toBe('newest');
  });

  it('emits open-item for Enter without mutating history', () => {
    let state = append(createFeedbackHistorySessionState(NOW), 'one');
    state = reduceFeedbackHistorySession(state, { type: 'open' }, NOW).state;
    const result = reduceFeedbackHistorySession(state, { type: 'keyboard', event: { key: 'Enter' } }, NOW);
    expect(result.effect).toEqual({ type: 'open-item', id: 'one' });
    expect(result.state).toBe(state);
  });

  it('emits open-item for Space without mutating history', () => {
    let state = append(createFeedbackHistorySessionState(NOW), 'one');
    state = reduceFeedbackHistorySession(state, { type: 'open' }, NOW).state;
    const result = reduceFeedbackHistorySession(state, { type: 'keyboard', event: { key: ' ' } }, NOW);
    expect(result.effect).toEqual({ type: 'open-item', id: 'one' });
  });

  it('removes active with Delete and reconciles focus', () => {
    let state = append(createFeedbackHistorySessionState(NOW), 'one');
    state = reduceFeedbackHistorySession(state, { type: 'open' }, NOW).state;
    const result = reduceFeedbackHistorySession(state, { type: 'keyboard', event: { key: 'Delete' } }, NOW);
    expect(result.state.history.items).toEqual([]);
    expect(result.effect).toEqual({ type: 'focus', targetId: 'feedback-history-close' });
  });

  it('closes with Escape and restores focus', () => {
    let state = reduceFeedbackHistorySession(createFeedbackHistorySessionState(NOW), {
      type: 'open', callerId: 'bell',
    }, NOW).state;
    const result = reduceFeedbackHistorySession(state, { type: 'keyboard', event: { key: 'Escape' } }, NOW);
    expect(result.state.open).toBe(false);
    expect(result.effect).toEqual({ type: 'restore-focus', targetId: 'bell' });
  });

  it.each([
    { key: 'Escape', isComposing: true },
    { key: 'Escape', repeat: true },
    { key: 'Escape', defaultPrevented: true },
    { key: 'Escape', ctrlKey: true },
    { key: 'Escape', metaKey: true },
    { key: 'Escape', altKey: true },
  ])('does not close for guarded Escape context %#', event => {
    const state = reduceFeedbackHistorySession(createFeedbackHistorySessionState(NOW), { type: 'open' }, NOW).state;
    const result = reduceFeedbackHistorySession(state, { type: 'keyboard', event }, NOW);
    expect(result.state.open).toBe(true);
  });

  it.each([
    { key: 'ArrowDown', isComposing: true },
    { key: 'ArrowDown', repeat: true },
    { key: 'ArrowDown', defaultPrevented: true },
    { key: 'ArrowDown', shiftKey: true },
    { key: 'ArrowDown', target: { tagName: 'INPUT' } },
    { key: 'ArrowDown', target: { tagName: 'textarea' } },
    { key: 'ArrowDown', target: { isContentEditable: true } },
  ])('keeps navigation inert for editable or guarded keyboard context %#', event => {
    let state = createFeedbackHistorySessionState(NOW);
    state = append(state, 'one', NOW - 1);
    state = append(state, 'two', NOW);
    state = reduceFeedbackHistorySession(state, { type: 'open' }, NOW).state;
    const active = state.history.activeId;
    const result = reduceFeedbackHistorySession(state, { type: 'keyboard', event }, NOW);
    expect(result.state.history.activeId).toBe(active);
    expect(result.effect).toEqual({ type: 'none' });
  });

  it('keeps revision monotonic across meaningful transitions', () => {
    let state = createFeedbackHistorySessionState(NOW);
    const revisions = [state.revision];
    state = append(state, 'one'); revisions.push(state.revision);
    state = reduceFeedbackHistorySession(state, { type: 'open' }, NOW).state; revisions.push(state.revision);
    state = reduceFeedbackHistorySession(state, { type: 'filter', filter: 'important' }, NOW).state; revisions.push(state.revision);
    state = reduceFeedbackHistorySession(state, { type: 'close' }, NOW).state; revisions.push(state.revision);
    expect(revisions).toEqual([...revisions].sort((a, b) => a - b));
    expect(new Set(revisions).size).toBe(revisions.length);
  });

  it('classifies assertive danger feedback as important through the session', () => {
    let state = createFeedbackHistorySessionState(NOW);
    state = append(state, 'danger', NOW, { tone: 'danger', priority: 'assertive', role: 'alert', live: 'assertive' });
    const result = reduceFeedbackHistorySession(state, { type: 'filter', filter: 'important' }, NOW);
    expect(result.view.history.visibleItems.map(item => item.id)).toEqual(['danger']);
    expect(result.view.history.importantCount).toBe(1);
  });

  it('deduplicates repeated ids without growing session history', () => {
    let state = createFeedbackHistorySessionState(NOW);
    state = append(state, 'same', NOW - 100);
    state = append(state, 'same', NOW);
    expect(state.history.items).toHaveLength(1);
    expect(state.history.items[0]?.occurredAt).toBe(NOW);
  });

  it('clamps future timestamps without leaking future ordering authority', () => {
    const state = append(createFeedbackHistorySessionState(NOW), 'future', NOW + 99_999_999);
    expect(state.history.items[0]?.occurredAt).toBe(NOW);
  });
});