import { describe, expect, it } from 'vitest';
import { createFeedbackViewModel } from './feedbackExperience';
import { createFeedbackAccessibilitySnapshot, moveFeedbackAccessibilityFocus, reconcileFeedbackAccessibility, resolveFeedbackAccessibilityIntent } from './feedbackAccessibilityController';

const item = (id: string, options: { action?: boolean; dismissible?: boolean; danger?: boolean; message?: string } = {}) => createFeedbackViewModel({
  id,
  title: `Bildirim ${id}`,
  message: options.message ?? 'İşlem sonucu hazır.',
  actionLabel: options.action ? 'Görüntüle' : null,
  dismissible: options.dismissible ?? true,
  tone: options.danger ? 'danger' : 'neutral',
})!;

describe('feedback accessibility lifecycle', () => {
  it('creates bounded semantic contracts and responsive placement', () => {
    const snapshot = createFeedbackAccessibilitySnapshot({ items: [item('a', { action: true })], viewport: 'phone', coarsePointer: true, reducedMotion: true, forcedColors: true });
    expect(snapshot.regionRole).toBe('region');
    expect(snapshot.placement).toBe('bottom-sheet');
    expect(snapshot.targetSize).toBe(48);
    expect(snapshot.motion).toBe('reduced');
    expect(snapshot.contrast).toBe('forced');
    expect(snapshot.items[0].ariaLabelledBy).toContain('-title');
    expect(snapshot.items[0].ariaDescribedBy).toContain('-message');
    expect(snapshot.items[0].actionTabIndex).toBe(0);
  });

  it('keeps assertive danger semantics', () => {
    const snapshot = createFeedbackAccessibilitySnapshot({ items: [item('danger', { danger: true })], viewport: 'desktop' });
    expect(snapshot.items[0].role).toBe('alert');
    expect(snapshot.items[0].ariaLive).toBe('assertive');
    expect(snapshot.items[0].ariaAtomic).toBe(true);
  });

  it('admits at most five presentation items', () => {
    const items = Array.from({ length: 20 }, (_, index) => item(String(index)));
    const snapshot = createFeedbackAccessibilitySnapshot({ items, viewport: 'desktop' });
    expect(snapshot.items).toHaveLength(5);
    expect(snapshot.items.map((entry) => entry.id)).toEqual(['15', '16', '17', '18', '19']);
  });

  it('gives exactly one actionable roving tab stop', () => {
    const snapshot = createFeedbackAccessibilitySnapshot({ items: [item('a', { action: true }), item('b'), item('c', { action: true })], viewport: 'desktop' });
    const stops = snapshot.items.flatMap((entry) => [entry.actionTabIndex, entry.dismissTabIndex]).filter((value) => value === 0);
    expect(stops).toHaveLength(1);
    expect(snapshot.activeFeedbackId).toBe('c');
  });

  it('moves focus cyclically across actionable feedback', () => {
    const snapshot = createFeedbackAccessibilitySnapshot({ items: [item('a', { action: true }), item('b'), item('c', { action: true })], viewport: 'desktop', activeFeedbackId: 'a' });
    const next = moveFeedbackAccessibilityFocus(snapshot, 'next');
    expect(next.activeFeedbackId).toBe('b');
    expect(next.focusId).toContain('dismiss');
    const previous = moveFeedbackAccessibilityFocus(next, 'previous');
    expect(previous.activeFeedbackId).toBe('a');
    expect(previous.focusId).toContain('action');
  });

  it('supports first and last navigation', () => {
    const snapshot = createFeedbackAccessibilitySnapshot({ items: [item('a'), item('b'), item('c')], viewport: 'desktop', activeFeedbackId: 'b' });
    expect(moveFeedbackAccessibilityFocus(snapshot, 'first').activeFeedbackId).toBe('a');
    expect(moveFeedbackAccessibilityFocus(snapshot, 'last').activeFeedbackId).toBe('c');
  });

  it.each([
    ['ArrowRight', 'next'], ['ArrowDown', 'next'], ['ArrowLeft', 'previous'], ['ArrowUp', 'previous'], ['Home', 'first'], ['End', 'last'],
  ] as const)('maps %s to %s navigation', (key, direction) => {
    const snapshot = createFeedbackAccessibilitySnapshot({ items: [item('a')], viewport: 'desktop' });
    expect(resolveFeedbackAccessibilityIntent({ key }, snapshot)).toEqual({ type: 'move', direction });
  });

  it('maps Enter and Space to the active action', () => {
    const snapshot = createFeedbackAccessibilitySnapshot({ items: [item('a', { action: true })], viewport: 'desktop' });
    expect(resolveFeedbackAccessibilityIntent({ key: 'Enter' }, snapshot)).toEqual({ type: 'invoke-action', feedbackId: 'a' });
    expect(resolveFeedbackAccessibilityIntent({ key: ' ' }, snapshot)).toEqual({ type: 'invoke-action', feedbackId: 'a' });
  });

  it('maps Escape to dismissal when feedback is active', () => {
    const snapshot = createFeedbackAccessibilitySnapshot({ items: [item('a')], viewport: 'desktop' });
    expect(resolveFeedbackAccessibilityIntent({ key: 'Escape' }, snapshot)).toEqual({ type: 'dismiss', feedbackId: 'a' });
  });

  it('fails closed for editable, composing, repeated and modified events', () => {
    const snapshot = createFeedbackAccessibilitySnapshot({ items: [item('a')], viewport: 'desktop' });
    expect(resolveFeedbackAccessibilityIntent({ key: 'Escape', target: { tagName: 'INPUT' } }, snapshot)).toBeNull();
    expect(resolveFeedbackAccessibilityIntent({ key: 'Escape', target: { isContentEditable: true } }, snapshot)).toBeNull();
    expect(resolveFeedbackAccessibilityIntent({ key: 'Escape', isComposing: true }, snapshot)).toBeNull();
    expect(resolveFeedbackAccessibilityIntent({ key: 'Escape', repeat: true }, snapshot)).toBeNull();
    expect(resolveFeedbackAccessibilityIntent({ key: 'Escape', defaultPrevented: true }, snapshot)).toBeNull();
    expect(resolveFeedbackAccessibilityIntent({ key: 'Escape', ctrlKey: true }, snapshot)).toBeNull();
    expect(resolveFeedbackAccessibilityIntent({ key: 'Escape', altKey: true }, snapshot)).toBeNull();
    expect(resolveFeedbackAccessibilityIntent({ key: 'Escape', metaKey: true }, snapshot)).toBeNull();
  });

  it('reconciles removed active feedback to a surviving actionable item', () => {
    const previous = createFeedbackAccessibilitySnapshot({ items: [item('a'), item('b', { action: true })], viewport: 'desktop', activeFeedbackId: 'a' });
    const next = reconcileFeedbackAccessibility(previous, { items: [item('b', { action: true })], viewport: 'desktop' });
    expect(next.activeFeedbackId).toBe('b');
    expect(next.focusTarget).toBe('latest-action');
    expect(next.focusId).toContain('action');
  });

  it('restores caller focus after the final feedback closes', () => {
    const previous = createFeedbackAccessibilitySnapshot({ items: [item('a')], viewport: 'desktop' });
    const next = reconcileFeedbackAccessibility(previous, { items: [], viewport: 'desktop', returnFocusId: 'map toolbar trigger' });
    expect(next.focusTarget).toBe('return-target');
    expect(next.focusId).toBe('map-toolbar-trigger');
    expect(next.announcement).toBe('Bildirimler kapatıldı.');
  });

  it('bounds and sanitizes announcements', () => {
    const hostile = `${'x'.repeat(400)}\u0000<script>`;
    const snapshot = createFeedbackAccessibilitySnapshot({ items: [item('a', { message: hostile })], viewport: 'tablet' });
    expect(snapshot.announcement!.length).toBeLessThanOrEqual(240);
    expect(snapshot.announcement).not.toContain('\u0000');
  });

  it('uses desktop floating placement and baseline targets by default', () => {
    const snapshot = createFeedbackAccessibilitySnapshot({ items: [item('a')], viewport: 'desktop' });
    expect(snapshot.placement).toBe('floating-stack');
    expect(snapshot.targetSize).toBe(44);
    expect(snapshot.motion).toBe('standard');
    expect(snapshot.contrast).toBe('standard');
  });

  it('falls back to the region when no actionable items remain', () => {
    const inert = createFeedbackViewModel({ id: 'inert', title: 'Bilgi', dismissible: false })!;
    const snapshot = createFeedbackAccessibilitySnapshot({ items: [inert], viewport: 'desktop' });
    const moved = moveFeedbackAccessibilityFocus(snapshot, 'next');
    expect(moved.focusTarget).toBe('region');
    expect(moved.focusId).toBe(snapshot.regionId);
  });
});
