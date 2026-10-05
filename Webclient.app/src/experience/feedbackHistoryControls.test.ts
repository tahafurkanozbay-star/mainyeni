import { describe, expect, it } from 'vitest';
import { createFeedbackHistorySnapshot, createFeedbackHistoryState, reduceFeedbackHistory } from './feedbackHistoryExperience';
import { createFeedbackViewModel } from './feedbackExperience';
import { createFeedbackHistoryControlsSnapshot, resolveFeedbackHistoryControlsIntent } from './feedbackHistoryControls';

const NOW = 1_800_000_000_000;
const item = (id: string, options: { read?: boolean; danger?: boolean } = {}) => ({
  feedback: createFeedbackViewModel({
    id,
    title: `Bildirim ${id}`,
    tone: options.danger ? 'danger' : 'info',
    priority: options.danger ? 'assertive' : 'polite',
  })!,
  occurredAt: NOW,
  read: options.read,
});

const history = (entries: readonly ReturnType<typeof item>[]) => {
  let state = createFeedbackHistoryState(NOW);
  for (const entry of entries) {
    state = reduceFeedbackHistory(state, { type: 'append', item: entry }, NOW);
    if (entry.read) state = reduceFeedbackHistory(state, { type: 'mark-read', id: entry.feedback.id }, NOW);
  }
  return createFeedbackHistorySnapshot(state);
};

describe('feedbackHistoryControls', () => {
  it('creates deterministic semantic groups and one selected filter tab stop', () => {
    const snapshot = createFeedbackHistoryControlsSnapshot({ history: history([item('a')]), filter: 'all', sort: 'newest', viewport: 'desktop' });
    expect(snapshot.toolbarId).toBe('feedback-history-controls');
    expect(snapshot.filterGroupId).toBe('feedback-history-filter-group');
    expect(snapshot.sortGroupId).toBe('feedback-history-sort-group');
    expect(snapshot.filters.filter(option => option.tabIndex === 0)).toHaveLength(1);
    expect(snapshot.filters.find(option => option.value === 'all')?.selected).toBe(true);
  });

  it('adapts controls for phone and coarse pointers', () => {
    const snapshot = createFeedbackHistoryControlsSnapshot({ history: history([item('a')]), filter: 'all', sort: 'newest', viewport: 'phone', coarsePointer: true });
    expect(snapshot.placement).toBe('stacked');
    expect(snapshot.density).toBe('comfortable');
    expect(snapshot.targetSize).toBe(48);
  });

  it('uses compact inline controls on desktop', () => {
    const snapshot = createFeedbackHistoryControlsSnapshot({ history: history([item('a')]), filter: 'all', sort: 'newest', viewport: 'desktop' });
    expect(snapshot.placement).toBe('inline');
    expect(snapshot.density).toBe('compact');
    expect(snapshot.targetSize).toBe(44);
  });

  it('publishes reduced-motion and forced-color contracts', () => {
    const snapshot = createFeedbackHistoryControlsSnapshot({ history: history([]), filter: 'all', sort: 'newest', viewport: 'tablet', reducedMotion: true, forcedColors: true });
    expect(snapshot.motion).toBe('reduced');
    expect(snapshot.contrast).toBe('forced');
  });

  it('disables unavailable filters without hiding them', () => {
    const snapshot = createFeedbackHistoryControlsSnapshot({ history: history([item('read', { read: true })]), filter: 'all', sort: 'newest', viewport: 'desktop' });
    expect(snapshot.filters.find(option => option.value === 'unread')?.disabled).toBe(true);
    expect(snapshot.filters.find(option => option.value === 'important')?.disabled).toBe(true);
    expect(snapshot.filters).toHaveLength(3);
  });

  it('enables important filtering when danger feedback exists', () => {
    const snapshot = createFeedbackHistoryControlsSnapshot({ history: history([item('danger', { danger: true })]), filter: 'all', sort: 'newest', viewport: 'desktop' });
    expect(snapshot.filters.find(option => option.value === 'important')?.disabled).toBe(false);
  });

  it('disables sorting until at least two items are visible', () => {
    const empty = createFeedbackHistoryControlsSnapshot({ history: history([]), filter: 'all', sort: 'newest', viewport: 'desktop' });
    const single = createFeedbackHistoryControlsSnapshot({ history: history([item('a')]), filter: 'all', sort: 'newest', viewport: 'desktop' });
    const multiple = createFeedbackHistoryControlsSnapshot({ history: history([item('a'), item('b')]), filter: 'all', sort: 'newest', viewport: 'desktop' });
    expect(empty.sorts.every(option => option.disabled)).toBe(true);
    expect(single.sorts.every(option => option.disabled)).toBe(true);
    expect(multiple.sorts.every(option => !option.disabled)).toBe(true);
  });

  it('derives bulk action availability from read state', () => {
    const unread = createFeedbackHistoryControlsSnapshot({ history: history([item('a')]), filter: 'all', sort: 'newest', viewport: 'desktop' });
    const read = createFeedbackHistoryControlsSnapshot({ history: history([item('a', { read: true })]), filter: 'all', sort: 'newest', viewport: 'desktop' });
    expect(unread.markAllReadDisabled).toBe(false);
    expect(unread.clearReadDisabled).toBe(true);
    expect(read.markAllReadDisabled).toBe(true);
    expect(read.clearReadDisabled).toBe(false);
  });

  it('publishes bounded payload-free summaries', () => {
    const empty = createFeedbackHistoryControlsSnapshot({ history: history([]), filter: 'all', sort: 'newest', viewport: 'desktop' });
    const populated = createFeedbackHistoryControlsSnapshot({ history: history([item('a'), item('b', { read: true })]), filter: 'all', sort: 'newest', viewport: 'desktop' });
    expect(empty.summary).toBe('Gösterilecek bildirim yok.');
    expect(populated.summary).toBe('2 bildirim gösteriliyor; 1 okunmamış.');
    expect(populated.summary).not.toContain('Bildirim a');
  });

  it.each([
    ['ArrowRight', 'unread'],
    ['ArrowDown', 'unread'],
    ['ArrowLeft', 'important'],
    ['ArrowUp', 'important'],
    ['Home', 'all'],
    ['End', 'important'],
  ] as const)('maps %s to bounded filter navigation', (key, filter) => {
    expect(resolveFeedbackHistoryControlsIntent({ key }, { filter: 'all', sort: 'newest' })).toEqual({ type: 'set-filter', filter });
  });

  it('cycles filters rather than escaping the bounded group', () => {
    expect(resolveFeedbackHistoryControlsIntent({ key: 'ArrowRight' }, { filter: 'important', sort: 'newest' })).toEqual({ type: 'set-filter', filter: 'all' });
    expect(resolveFeedbackHistoryControlsIntent({ key: 'ArrowLeft' }, { filter: 'all', sort: 'newest' })).toEqual({ type: 'set-filter', filter: 'important' });
  });

  it('uses Shift plus navigation for the sort group', () => {
    expect(resolveFeedbackHistoryControlsIntent({ key: 'ArrowRight', shiftKey: true }, { filter: 'all', sort: 'newest' })).toEqual({ type: 'set-sort', sort: 'oldest' });
    expect(resolveFeedbackHistoryControlsIntent({ key: 'ArrowRight', shiftKey: true }, { filter: 'all', sort: 'oldest' })).toEqual({ type: 'set-sort', sort: 'newest' });
    expect(resolveFeedbackHistoryControlsIntent({ key: 'Home', shiftKey: true }, { filter: 'all', sort: 'oldest' })).toEqual({ type: 'set-sort', sort: 'newest' });
    expect(resolveFeedbackHistoryControlsIntent({ key: 'End', shiftKey: true }, { filter: 'all', sort: 'newest' })).toEqual({ type: 'set-sort', sort: 'oldest' });
  });

  it('maps explicit bulk and close commands', () => {
    expect(resolveFeedbackHistoryControlsIntent({ key: 'r' }, { filter: 'all', sort: 'newest' })).toEqual({ type: 'mark-all-read' });
    expect(resolveFeedbackHistoryControlsIntent({ key: 'R' }, { filter: 'all', sort: 'newest' })).toEqual({ type: 'mark-all-read' });
    expect(resolveFeedbackHistoryControlsIntent({ key: 'Delete' }, { filter: 'all', sort: 'newest' })).toEqual({ type: 'clear-read' });
    expect(resolveFeedbackHistoryControlsIntent({ key: 'Escape' }, { filter: 'all', sort: 'newest' })).toEqual({ type: 'close' });
  });

  it.each([
    { key: 'ArrowDown', target: { tagName: 'INPUT' } },
    { key: 'ArrowDown', target: { tagName: 'textarea' } },
    { key: 'ArrowDown', target: { isContentEditable: true } },
    { key: 'ArrowDown', isComposing: true },
    { key: 'ArrowDown', repeat: true },
    { key: 'ArrowDown', defaultPrevented: true },
    { key: 'ArrowDown', ctrlKey: true },
    { key: 'ArrowDown', altKey: true },
    { key: 'ArrowDown', metaKey: true },
  ])('fails closed for guarded keyboard context %#', event => {
    expect(resolveFeedbackHistoryControlsIntent(event, { filter: 'all', sort: 'newest' })).toBeNull();
  });

  it('does not treat shifted Escape as an unmodified close command', () => {
    expect(resolveFeedbackHistoryControlsIntent({ key: 'Escape', shiftKey: true }, { filter: 'all', sort: 'newest' })).toBeNull();
  });

  it('ignores unrelated keys', () => {
    expect(resolveFeedbackHistoryControlsIntent({ key: 'F9' }, { filter: 'all', sort: 'newest' })).toBeNull();
  });
});