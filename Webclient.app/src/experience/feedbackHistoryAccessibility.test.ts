import { describe, expect, it } from 'vitest';
import { createFeedbackHistoryState, createFeedbackHistorySnapshot, reduceFeedbackHistory } from './feedbackHistoryExperience';
import { createFeedbackHistoryAccessibilityModel, createFeedbackHistoryFocusState, reduceFeedbackHistoryFocus } from './feedbackHistoryAccessibility';
import type { FeedbackViewModel } from './feedbackExperience';

const now = 1_800_000_000_000;
const feedback = (id: string, title = `Bildirim ${id}`, read = false): { feedback: FeedbackViewModel; occurredAt: number; read: boolean } => ({
  feedback: Object.freeze({
    id,
    semanticId: id,
    title,
    message: 'Harita işlemi tamamlandı.',
    tone: id === 'warning' ? 'warning' : 'info',
    priority: id === 'warning' ? 'assertive' : 'polite',
    role: id === 'warning' ? 'alert' : 'status',
    live: id === 'warning' ? 'assertive' : 'polite',
    atomic: true,
    dismissible: true,
    expiresAt: null,
  }),
  occurredAt: now,
  read,
});

const history = () => {
  let state = createFeedbackHistoryState(now);
  state = reduceFeedbackHistory(state, { type: 'append', item: feedback('first') }, now);
  state = reduceFeedbackHistory(state, { type: 'append', item: feedback('warning', 'Dikkat', true) }, now);
  return state;
};

describe('feedback history accessibility', () => {
  it('creates deterministic dialog, live region and roving item semantics', () => {
    const state = history();
    const snapshot = createFeedbackHistorySnapshot(state);
    const model = createFeedbackHistoryAccessibilityModel({ snapshot, filter: state.filter, sort: state.sort, viewport: 'desktop', open: true });
    expect(model.role).toBe('dialog');
    expect(model.modal).toBe(false);
    expect(model.labelledBy).toBe('feedback-history-heading');
    expect(model.statusRole).toBe('status');
    expect(model.statusLive).toBe('polite');
    expect(model.statusAtomic).toBe(true);
    expect(model.items.filter(item => item.tabIndex === 0)).toHaveLength(1);
    expect(model.items[0]?.positionLabel).toBe('1 / 2');
    expect(model.minimumTargetPx).toBe(44);
  });

  it('uses bottom-sheet modal semantics and coarse pointer targets on phone', () => {
    const state = history();
    const model = createFeedbackHistoryAccessibilityModel({ snapshot: createFeedbackHistorySnapshot(state), filter: 'all', sort: 'newest', viewport: 'phone', open: true, coarsePointer: true, reducedMotion: true, forcedColors: true });
    expect(model.placement).toBe('bottom-sheet');
    expect(model.modal).toBe(true);
    expect(model.minimumTargetPx).toBe(48);
    expect(model.motion).toBe('reduced');
    expect(model.forcedColors).toBe(true);
  });

  it('keeps tablet history in a bounded side panel', () => {
    const state = history();
    const model = createFeedbackHistoryAccessibilityModel({ snapshot: createFeedbackHistorySnapshot(state), filter: 'all', sort: 'oldest', viewport: 'tablet', open: true });
    expect(model.placement).toBe('side-panel');
    expect(model.statusText).toContain('eskiden yeniye');
  });

  it('does not announce a closed history surface', () => {
    const state = history();
    const model = createFeedbackHistoryAccessibilityModel({ snapshot: createFeedbackHistorySnapshot(state), filter: 'all', sort: 'newest', viewport: 'desktop', open: false });
    expect(model.statusText).toBe('');
  });

  it('marks clear-read disabled when no visible item is read', () => {
    let state = createFeedbackHistoryState(now);
    state = reduceFeedbackHistory(state, { type: 'append', item: feedback('only') }, now);
    const model = createFeedbackHistoryAccessibilityModel({ snapshot: createFeedbackHistorySnapshot(state), filter: 'all', sort: 'newest', viewport: 'desktop', open: true });
    expect(model.clearReadDisabled).toBe(true);
  });

  it('bounds hostile caller identifiers and preserves focus restoration intent', () => {
    const state = history();
    const callerId = `  map\u0000-trigger-${'x'.repeat(200)}  `;
    const model = createFeedbackHistoryAccessibilityModel({ snapshot: createFeedbackHistorySnapshot(state), filter: 'all', sort: 'newest', viewport: 'desktop', open: true, callerId });
    expect(model.restoreFocusTo).not.toContain('\u0000');
    expect(model.restoreFocusTo?.length).toBeLessThanOrEqual(96);
  });

  it('moves focus into the list on open and restores caller on close', () => {
    const initial = createFeedbackHistoryFocusState();
    const opened = reduceFeedbackHistoryFocus(initial, { type: 'open', callerId: 'map-trigger' });
    expect(opened.focusId).toBe('feedback-history-list');
    expect(opened.state.open).toBe(true);
    const closed = reduceFeedbackHistoryFocus(opened.state, { type: 'close' });
    expect(closed.restoreCaller).toBe(true);
    expect(closed.focusId).toBe('map-trigger');
  });

  it('reconciles active focus when filtering removes the previous item', () => {
    let state = history();
    const focus = reduceFeedbackHistoryFocus(createFeedbackHistoryFocusState(), { type: 'open', callerId: 'trigger' });
    const synced = reduceFeedbackHistoryFocus(focus.state, { type: 'sync', snapshot: createFeedbackHistorySnapshot(state) });
    expect(synced.state.activeId).not.toBeNull();
    state = reduceFeedbackHistory(state, { type: 'filter', filter: 'unread' }, now);
    const reconciled = reduceFeedbackHistoryFocus(synced.state, { type: 'sync', snapshot: createFeedbackHistorySnapshot(state) });
    expect(reconciled.state.activeId).toBe(state.activeId);
    expect(reconciled.focusId).toContain('feedback-history-');
  });

  it('moves focus to close when the visible collection becomes empty', () => {
    let state = createFeedbackHistoryState(now);
    const focus = reduceFeedbackHistoryFocus(createFeedbackHistoryFocusState(), { type: 'open', callerId: 'trigger' });
    state = reduceFeedbackHistory(state, { type: 'filter', filter: 'unread' }, now);
    const reconciled = reduceFeedbackHistoryFocus(focus.state, { type: 'sync', snapshot: createFeedbackHistorySnapshot(state) });
    expect(reconciled.state.focusTarget).toBe('close');
    expect(reconciled.focusId).toBe('feedback-history-close');
  });

  it('sanitizes hostile titles before accessible-name composition', () => {
    let state = createFeedbackHistoryState(now);
    state = reduceFeedbackHistory(state, { type: 'append', item: feedback('hostile', `  Tehlike\u0007 ${'A'.repeat(200)}  `) }, now);
    const model = createFeedbackHistoryAccessibilityModel({ snapshot: createFeedbackHistorySnapshot(state), filter: 'all', sort: 'newest', viewport: 'desktop', open: true });
    expect(model.items[0]?.accessibleName).not.toContain('\u0007');
    expect(model.items[0]?.accessibleName.length).toBeLessThanOrEqual(120);
  });
});
