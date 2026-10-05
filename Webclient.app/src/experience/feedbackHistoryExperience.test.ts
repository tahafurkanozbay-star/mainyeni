import { describe, expect, it } from 'vitest';
import { createFeedbackViewModel } from './feedbackExperience';
import {
  createFeedbackHistorySnapshot,
  createFeedbackHistoryState,
  reduceFeedbackHistory,
  resolveFeedbackHistoryKeyboardIntent,
} from './feedbackHistoryExperience';

const NOW = 2_000_000_000_000;
const feedback = (id: string, tone: 'neutral' | 'warning' | 'danger' = 'neutral') => {
  const model = createFeedbackViewModel({ id, title: `Bildirim ${id}`, tone }, NOW);
  if (!model) throw new Error('fixture rejected');
  return model;
};

const append = (state: ReturnType<typeof createFeedbackHistoryState>, id: string, offset = 0, tone: 'neutral' | 'warning' | 'danger' = 'neutral') => reduceFeedbackHistory(state, {
  type: 'append',
  item: { feedback: feedback(id, tone), occurredAt: NOW + offset },
}, NOW);

describe('feedbackHistoryExperience', () => {
  it('starts with a bounded empty semantic snapshot', () => {
    const snapshot = createFeedbackHistorySnapshot(createFeedbackHistoryState(NOW));
    expect(snapshot.visibleItems).toEqual([]);
    expect(snapshot.activeId).toBeNull();
    expect(snapshot.emptyMessage).toBe('Bildirim geçmişi boş.');
    expect(snapshot.announcement).toBe('Bildirim geçmişi boş.');
  });

  it('appends feedback and reconciles the active item', () => {
    const state = append(createFeedbackHistoryState(NOW), 'one');
    expect(state.items).toHaveLength(1);
    expect(state.activeId).toBe('one');
    expect(state.unreadCount).toBe(1);
  });

  it('deduplicates by canonical feedback id', () => {
    let state = append(createFeedbackHistoryState(NOW), 'same');
    state = reduceFeedbackHistory(state, { type: 'append', item: { feedback: feedback('same', 'warning'), occurredAt: NOW } }, NOW);
    expect(state.items).toHaveLength(1);
    expect(state.items[0]?.tone).toBe('warning');
  });

  it('classifies assertive and warning feedback as important', () => {
    let state = append(createFeedbackHistoryState(NOW), 'normal');
    state = append(state, 'warning', 0, 'warning');
    state = append(state, 'danger', 0, 'danger');
    expect(state.importantCount).toBe(2);
    state = reduceFeedbackHistory(state, { type: 'filter', filter: 'important' }, NOW);
    expect(createFeedbackHistorySnapshot(state).visibleItems.map(item => item.id).sort()).toEqual(['danger', 'warning']);
  });

  it('marks individual and all feedback as read', () => {
    let state = append(createFeedbackHistoryState(NOW), 'a');
    state = append(state, 'b');
    state = reduceFeedbackHistory(state, { type: 'mark-read', id: 'a' }, NOW);
    expect(state.unreadCount).toBe(1);
    state = reduceFeedbackHistory(state, { type: 'mark-all-read' }, NOW);
    expect(state.unreadCount).toBe(0);
    expect(state.items.every(item => item.read)).toBe(true);
  });

  it('filters unread feedback without corrupting source history', () => {
    let state = append(createFeedbackHistoryState(NOW), 'read');
    state = append(state, 'unread');
    state = reduceFeedbackHistory(state, { type: 'mark-read', id: 'read' }, NOW);
    state = reduceFeedbackHistory(state, { type: 'filter', filter: 'unread' }, NOW);
    expect(createFeedbackHistorySnapshot(state).visibleItems.map(item => item.id)).toEqual(['unread']);
    expect(state.items).toHaveLength(2);
  });

  it('publishes filter-specific empty copy', () => {
    let state = append(createFeedbackHistoryState(NOW), 'read');
    state = reduceFeedbackHistory(state, { type: 'mark-all-read' }, NOW);
    state = reduceFeedbackHistory(state, { type: 'filter', filter: 'unread' }, NOW);
    expect(createFeedbackHistorySnapshot(state).emptyMessage).toBe('Okunmamış bildirim yok.');
    state = reduceFeedbackHistory(state, { type: 'filter', filter: 'important' }, NOW);
    expect(createFeedbackHistorySnapshot(state).emptyMessage).toBe('Önemli bildirim yok.');
  });

  it('sorts deterministically by timestamp', () => {
    let state = append(createFeedbackHistoryState(NOW), 'older', -100);
    state = append(state, 'newer', 0);
    expect(createFeedbackHistorySnapshot(state).visibleItems.map(item => item.id)).toEqual(['newer', 'older']);
    state = reduceFeedbackHistory(state, { type: 'sort', sort: 'oldest' }, NOW);
    expect(createFeedbackHistorySnapshot(state).visibleItems.map(item => item.id)).toEqual(['older', 'newer']);
  });

  it('clamps future timestamps instead of retaining future authority', () => {
    const state = reduceFeedbackHistory(createFeedbackHistoryState(NOW), {
      type: 'append', item: { feedback: feedback('future'), occurredAt: NOW + 999_999 },
    }, NOW);
    expect(state.items[0]?.occurredAt).toBe(NOW);
  });

  it('expires history older than seven days', () => {
    const stale = NOW - 7 * 24 * 60 * 60 * 1000 - 1;
    const state = reduceFeedbackHistory(createFeedbackHistoryState(NOW), {
      type: 'append', item: { feedback: feedback('stale'), occurredAt: stale },
    }, NOW);
    expect(state.items).toHaveLength(0);
  });

  it('bounds retained history to fifty entries', () => {
    let state = createFeedbackHistoryState(NOW);
    for (let index = 0; index < 70; index += 1) state = append(state, `item-${index}`, -70 + index);
    expect(state.items).toHaveLength(50);
    expect(state.items[0]?.id).toBe('item-20');
  });

  it('removes a feedback item and reconciles active focus', () => {
    let state = append(createFeedbackHistoryState(NOW), 'a', -1);
    state = append(state, 'b');
    state = reduceFeedbackHistory(state, { type: 'activate', id: 'b' }, NOW);
    state = reduceFeedbackHistory(state, { type: 'remove', id: 'b' }, NOW);
    expect(state.activeId).toBe('a');
  });

  it('clears read feedback while preserving unread entries', () => {
    let state = append(createFeedbackHistoryState(NOW), 'read');
    state = append(state, 'unread');
    state = reduceFeedbackHistory(state, { type: 'mark-read', id: 'read' }, NOW);
    state = reduceFeedbackHistory(state, { type: 'clear-read' }, NOW);
    expect(state.items.map(item => item.id)).toEqual(['unread']);
  });

  it('wraps active keyboard navigation through visible entries', () => {
    let state = append(createFeedbackHistoryState(NOW), 'a', -2);
    state = append(state, 'b', -1);
    state = append(state, 'c');
    state = reduceFeedbackHistory(state, { type: 'first' }, NOW);
    const first = state.activeId;
    state = reduceFeedbackHistory(state, { type: 'move', delta: -1 }, NOW);
    expect(state.activeId).not.toBe(first);
    state = reduceFeedbackHistory(state, { type: 'move', delta: 1 }, NOW);
    expect(state.activeId).toBe(first);
  });

  it('supports explicit first and last navigation', () => {
    let state = append(createFeedbackHistoryState(NOW), 'older', -100);
    state = append(state, 'newer');
    state = reduceFeedbackHistory(state, { type: 'first' }, NOW);
    expect(state.activeId).toBe('newer');
    state = reduceFeedbackHistory(state, { type: 'last' }, NOW);
    expect(state.activeId).toBe('older');
  });

  it('reconciles active item when a filter hides it', () => {
    let state = append(createFeedbackHistoryState(NOW), 'normal');
    state = append(state, 'important', 0, 'warning');
    state = reduceFeedbackHistory(state, { type: 'activate', id: 'normal' }, NOW);
    state = reduceFeedbackHistory(state, { type: 'filter', filter: 'important' }, NOW);
    expect(state.activeId).toBe('important');
  });

  it('reports active index in current visible order', () => {
    let state = append(createFeedbackHistoryState(NOW), 'older', -100);
    state = append(state, 'newer');
    state = reduceFeedbackHistory(state, { type: 'activate', id: 'older' }, NOW);
    expect(createFeedbackHistorySnapshot(state).activeIndex).toBe(1);
  });

  it('maps keyboard navigation and activation intents', () => {
    expect(resolveFeedbackHistoryKeyboardIntent({ key: 'ArrowDown' })).toEqual({ type: 'move', delta: 1 });
    expect(resolveFeedbackHistoryKeyboardIntent({ key: 'ArrowUp' })).toEqual({ type: 'move', delta: -1 });
    expect(resolveFeedbackHistoryKeyboardIntent({ key: 'Home' })).toEqual({ type: 'first' });
    expect(resolveFeedbackHistoryKeyboardIntent({ key: 'End' })).toEqual({ type: 'last' });
    expect(resolveFeedbackHistoryKeyboardIntent({ key: 'Enter' })).toEqual({ type: 'open-active' });
    expect(resolveFeedbackHistoryKeyboardIntent({ key: ' ' })).toEqual({ type: 'open-active' });
    expect(resolveFeedbackHistoryKeyboardIntent({ key: 'Delete' })).toEqual({ type: 'remove-active' });
  });

  it('fails closed for editable, composing, repeat and modified keyboard contexts', () => {
    const events = [
      { key: 'ArrowDown', target: { tagName: 'input' } },
      { key: 'ArrowDown', target: { isContentEditable: true } },
      { key: 'ArrowDown', isComposing: true },
      { key: 'ArrowDown', repeat: true },
      { key: 'ArrowDown', defaultPrevented: true },
      { key: 'ArrowDown', ctrlKey: true },
      { key: 'ArrowDown', altKey: true },
      { key: 'ArrowDown', metaKey: true },
      { key: 'ArrowDown', shiftKey: true },
    ];
    for (const event of events) expect(resolveFeedbackHistoryKeyboardIntent(event)).toBeNull();
  });

  it('ignores unrelated keys', () => {
    expect(resolveFeedbackHistoryKeyboardIntent({ key: 'Tab' })).toBeNull();
    expect(resolveFeedbackHistoryKeyboardIntent({ key: 'F6' })).toBeNull();
  });
});
