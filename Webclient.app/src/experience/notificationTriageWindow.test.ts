import { describe, expect, it } from 'vitest';
import type { NotificationTriageEntry, NotificationTriageSnapshot } from './notificationTriageModel';
import { createNotificationTriageWindow, notificationTriageWindowFacts } from './notificationTriageWindow';

const entry = (index: number, selected = false): NotificationTriageEntry => Object.freeze({
  id: `n-${index + 1}`,
  title: `Bildirim ${index + 1}`,
  message: '',
  category: 'general',
  tone: 'info',
  read: false,
  important: false,
  urgent: false,
  dismissible: true,
  actionable: false,
  createdAt: 100 - index,
  occurrenceCount: 1,
  position: index + 1,
  setSize: 20,
  selected,
});

const snapshot = (
  count: number,
  activeIndex = count > 0 ? 0 : -1,
): NotificationTriageSnapshot => {
  const entries = Object.freeze(Array.from({ length: count }, (_, index) => entry(index, index === activeIndex)));
  return Object.freeze({
    revision: 1,
    query: '',
    normalizedQuery: '',
    scope: 'all',
    sort: 'newest',
    activeId: activeIndex >= 0 ? entries[activeIndex]?.id ?? null : null,
    activeIndex,
    entries,
    resultCount: count,
    totalCount: count,
    unreadCount: count,
    importantCount: 0,
    urgentCount: 0,
    actionableCount: 0,
    announcement: count === 0 ? 'Henüz bildirim yok.' : `${count} bildirim hızlı erişime hazır.`,
    emptyReason: count === 0 ? 'no-items' : 'none',
  });
};

describe('notificationTriageWindow', () => {
  it('keeps small collections intact', () => {
    const result = createNotificationTriageWindow(snapshot(3));
    expect(result.entries.map((candidate) => candidate.id)).toEqual(['n-1', 'n-2', 'n-3']);
    expect(result).toMatchObject({
      start: 0,
      end: 3,
      limit: 6,
      total: 3,
      truncatedBefore: 0,
      truncatedAfter: 0,
      activeVisible: true,
    });
  });

  it('bounds large collections to the default render budget', () => {
    const result = createNotificationTriageWindow(snapshot(20));
    expect(result.entries).toHaveLength(6);
    expect(result.start).toBe(0);
    expect(result.end).toBe(6);
    expect(result.truncatedAfter).toBe(14);
    expect(result.statusText).toContain('1-6 arası');
  });

  it('centers the window around the active entry', () => {
    const result = createNotificationTriageWindow(snapshot(20, 10));
    expect(result.entries).toHaveLength(6);
    expect(result.start).toBeGreaterThan(0);
    expect(result.entries.some((candidate) => candidate.id === 'n-11')).toBe(true);
    expect(result.activeVisible).toBe(true);
  });

  it('pins the final window to the end for a final active entry', () => {
    const result = createNotificationTriageWindow(snapshot(20, 19));
    expect(result.start).toBe(14);
    expect(result.end).toBe(20);
    expect(result.entries.at(-1)?.id).toBe('n-20');
    expect(result.truncatedAfter).toBe(0);
  });

  it('clamps the render limit to a safe minimum', () => {
    const result = createNotificationTriageWindow(snapshot(20), 1);
    expect(result.limit).toBe(3);
    expect(result.entries).toHaveLength(3);
  });

  it('clamps the render limit to a safe maximum', () => {
    const result = createNotificationTriageWindow(snapshot(20), 99);
    expect(result.limit).toBe(10);
    expect(result.entries).toHaveLength(10);
  });

  it('uses the default limit for non-finite values', () => {
    expect(createNotificationTriageWindow(snapshot(20), Number.NaN).limit).toBe(6);
    expect(createNotificationTriageWindow(snapshot(20), Number.POSITIVE_INFINITY).limit).toBe(6);
  });

  it('preserves full collection positions while adding window positions', () => {
    const result = createNotificationTriageWindow(snapshot(12, 8), 4);
    const active = result.entries.find((candidate) => candidate.id === 'n-9');
    expect(active?.position).toBe(9);
    expect(active?.setSize).toBe(20);
    expect(active?.windowPosition).toBeGreaterThanOrEqual(1);
    expect(active?.windowPosition).toBeLessThanOrEqual(4);
  });

  it('returns a stable empty window', () => {
    const result = createNotificationTriageWindow(snapshot(0));
    expect(result.entries).toEqual([]);
    expect(result).toMatchObject({
      start: 0,
      end: 0,
      total: 0,
      truncatedBefore: 0,
      truncatedAfter: 0,
      activeVisible: true,
      statusText: 'Henüz bildirim yok.',
    });
  });

  it('reports active visibility false for an inconsistent snapshot', () => {
    const source = snapshot(3, 0);
    const inconsistent = Object.freeze({ ...source, activeId: 'missing' });
    expect(createNotificationTriageWindow(inconsistent).activeVisible).toBe(false);
  });

  it('publishes immutable operational facts for diagnostics', () => {
    const result = createNotificationTriageWindow(snapshot(15, 7), 5);
    const facts = notificationTriageWindowFacts(result);
    expect(facts).toEqual({
      renderCount: 5,
      totalCount: 15,
      limit: 5,
      truncatedBefore: result.start,
      truncatedAfter: result.truncatedAfter,
      activeVisible: true,
    });
    expect(Object.isFrozen(facts)).toBe(true);
  });

  it('freezes the returned window and entry collection', () => {
    const result = createNotificationTriageWindow(snapshot(8));
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.entries)).toBe(true);
    expect(Object.isFrozen(result.entries[0])).toBe(true);
  });
});
