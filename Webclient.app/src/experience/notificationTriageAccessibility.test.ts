import { describe, expect, it } from 'vitest';
import {
  notificationTriageAnnouncement,
  notificationTriageItemAriaLabel,
  notificationTriageSemanticIds,
  resolveNotificationTriageAccessibilityIntent,
  resolveNotificationTriagePresentation,
} from './notificationTriageAccessibility';

describe('notification triage accessibility authority', () => {
  it('uses a modal bottom sheet on phone viewports', () => {
    expect(resolveNotificationTriagePresentation({ width: 390, height: 844 })).toMatchObject({
      surface: 'sheet',
      modal: true,
      placement: 'bottom',
      minimumTargetPx: 44,
    });
  });

  it('uses a non-modal side panel on tablet viewports', () => {
    expect(resolveNotificationTriagePresentation({ width: 820, height: 1180 })).toMatchObject({
      surface: 'panel',
      modal: false,
      placement: 'side',
    });
  });

  it('uses a floating surface on desktop viewports', () => {
    expect(resolveNotificationTriagePresentation({ width: 1440, height: 900 })).toMatchObject({
      surface: 'floating',
      modal: false,
      placement: 'overlay',
    });
  });

  it('raises touch targets for coarse pointers', () => {
    expect(resolveNotificationTriagePresentation({ width: 800, height: 600, coarsePointer: true }).minimumTargetPx).toBe(48);
  });

  it('preserves reduced motion and forced color preferences', () => {
    expect(resolveNotificationTriagePresentation({
      width: 1280,
      height: 720,
      reducedMotion: true,
      forcedColors: true,
    })).toMatchObject({ motion: 'reduced', forcedColors: true });
  });

  it('repairs invalid dimensions without producing an unbounded row budget', () => {
    const presentation = resolveNotificationTriagePresentation({ width: Number.NaN, height: Number.POSITIVE_INFINITY });
    expect(presentation.maxVisibleItems).toBeGreaterThanOrEqual(3);
    expect(presentation.maxVisibleItems).toBeLessThanOrEqual(12);
  });

  it('bounds visible rows on extremely tall screens', () => {
    expect(resolveNotificationTriagePresentation({ width: 1920, height: 100000 }).maxVisibleItems).toBe(12);
  });

  it('maps Escape to close with focus restoration', () => {
    expect(resolveNotificationTriageAccessibilityIntent({ key: 'Escape' })).toEqual({
      type: 'close',
      restoreFocus: true,
    });
  });

  it('allows Escape from editable controls', () => {
    expect(resolveNotificationTriageAccessibilityIntent({ key: 'Escape', editable: true }).type).toBe('close');
  });

  it('maps Home and End to deterministic list boundaries', () => {
    expect(resolveNotificationTriageAccessibilityIntent({ key: 'Home' })).toEqual({ type: 'focus', target: 'first-item' });
    expect(resolveNotificationTriageAccessibilityIntent({ key: 'End' })).toEqual({ type: 'focus', target: 'last-item' });
  });

  it('maps numeric scope accelerators without modifiers', () => {
    expect(resolveNotificationTriageAccessibilityIntent({ key: '1' })).toEqual({ type: 'focus', target: 'scope-all' });
    expect(resolveNotificationTriageAccessibilityIntent({ key: '2' })).toEqual({ type: 'focus', target: 'scope-unread' });
    expect(resolveNotificationTriageAccessibilityIntent({ key: '3' })).toEqual({ type: 'focus', target: 'scope-important' });
  });

  it('maps Enter and Space to activation', () => {
    expect(resolveNotificationTriageAccessibilityIntent({ key: 'Enter' }).type).toBe('activate');
    expect(resolveNotificationTriageAccessibilityIntent({ key: ' ' }).type).toBe('activate');
  });

  it('does not hijack editable controls for non-dismissal commands', () => {
    expect(resolveNotificationTriageAccessibilityIntent({ key: 'Home', editable: true }).type).toBe('none');
    expect(resolveNotificationTriageAccessibilityIntent({ key: 'Enter', editable: true }).type).toBe('none');
  });

  it('rejects composing, repeated and already-handled events', () => {
    expect(resolveNotificationTriageAccessibilityIntent({ key: 'Escape', isComposing: true }).type).toBe('none');
    expect(resolveNotificationTriageAccessibilityIntent({ key: 'Escape', repeat: true }).type).toBe('none');
    expect(resolveNotificationTriageAccessibilityIntent({ key: 'Escape', defaultPrevented: true }).type).toBe('none');
  });

  it('rejects conflicting modifiers', () => {
    expect(resolveNotificationTriageAccessibilityIntent({ key: 'Home', altKey: true }).type).toBe('none');
    expect(resolveNotificationTriageAccessibilityIntent({ key: 'Home', ctrlKey: true }).type).toBe('none');
    expect(resolveNotificationTriageAccessibilityIntent({ key: 'Home', metaKey: true }).type).toBe('none');
  });

  it('creates deterministic bounded semantic ids', () => {
    const ids = notificationTriageSemanticIds('  Main Panel / İstanbul  ');
    expect(ids.regionId).toBe('notification-triage-main-panel-stanbul-region');
    expect(ids.headingId).toBe('notification-triage-main-panel-stanbul-heading');
    expect(ids.listId).toBe('notification-triage-main-panel-stanbul-list');
  });

  it('falls back when semantic id input contains only unsafe characters', () => {
    expect(notificationTriageSemanticIds('\u0000 / ').regionId).toBe('notification-triage-default-region');
  });

  it('keeps generated semantic ids bounded for hostile input', () => {
    const ids = notificationTriageSemanticIds('a'.repeat(1000));
    expect(ids.regionId.length).toBeLessThan(90);
    expect(ids.regionId).not.toContain(' '.repeat(2));
  });

  it('announces empty state tersely', () => {
    expect(notificationTriageAnnouncement({ total: 0, visible: 0, unread: 0, important: 0, scope: 'all' })).toBe('Bildirim yok.');
  });

  it('announces scoped counts without exposing item payloads', () => {
    expect(notificationTriageAnnouncement({ total: 8, visible: 3, unread: 3, important: 1, scope: 'unread' }))
      .toBe('okunmamış bildirimler: 3 görünür, 8 toplam, 3 okunmamış, 1 önemli.');
  });

  it('clamps hostile announcement counts', () => {
    const message = notificationTriageAnnouncement({
      total: 100000,
      visible: 50000,
      unread: Number.NaN,
      important: -10,
      scope: 'important',
    });
    expect(message).toBe('önemli bildirimler: 999 görünür, 999 toplam, 0 okunmamış, 0 önemli.');
  });

  it('builds concise item labels with read and importance state', () => {
    expect(notificationTriageItemAriaLabel({
      title: 'Katman güncellendi',
      read: false,
      important: true,
      position: 2,
      setSize: 7,
    })).toBe('Katman güncellendi, okunmamış, önemli, 2/7');
  });

  it('sanitizes item labels and bounds positional metadata', () => {
    const label = notificationTriageItemAriaLabel({
      title: `\u0000 ${'A'.repeat(500)}`,
      read: true,
      important: false,
      position: 500,
      setSize: 500,
    });
    expect(label).toContain('okundu');
    expect(label).toContain('96/96');
    expect(label.length).toBeLessThan(160);
  });

  it('provides a title fallback for empty labels', () => {
    expect(notificationTriageItemAriaLabel({
      title: '\u0000',
      read: false,
      important: false,
      position: 0,
      setSize: 0,
    })).toBe('Başlıksız bildirim, okunmamış, 1/1');
  });
});
