import { describe, expect, it } from 'vitest';
import {
  applyResultBulkSelection,
  createResultSelectionToolbarFacts,
  normalizeResultSelectionSnapshot,
  reconcileResultSelection,
  resolveResultSelectionScope,
  selectResultRange,
} from './ArcGisResultSelectionExperiencePolicy';

const ids = (...values: string[]) => values;

const createSnapshot = (overrides: Parameters<typeof normalizeResultSelectionSnapshot>[0] = {}) => normalizeResultSelectionSnapshot({
  resultIds: ids('a', 'b', 'c', 'd', 'e', 'f'),
  visibleIds: ids('a', 'b', 'c', 'd'),
  pageIds: ids('a', 'b', 'c'),
  selectedIds: [],
  focusedId: 'a',
  anchorId: 'a',
  ...overrides,
});

describe('ArcGisResultSelectionExperiencePolicy', () => {
  it('normalizes result, visible and page ids without duplicates', () => {
    const snapshot = normalizeResultSelectionSnapshot({
      resultIds: [' a ', 'b', 'b', '', 'c'],
      visibleIds: ['b', 'missing', 'b', 'c'],
      pageIds: ['c', 'a', 'missing'],
    });
    expect(snapshot.resultIds).toEqual(['a', 'b', 'c']);
    expect(snapshot.visibleIds).toEqual(['b', 'c']);
    expect(snapshot.pageIds).toEqual(['c', 'a']);
  });

  it('strips control characters and bounds identifiers', () => {
    const longId = `x${'y'.repeat(300)}`;
    const snapshot = normalizeResultSelectionSnapshot({
      resultIds: ['a\u0000b', longId],
      visibleIds: ['ab'],
    });
    expect(snapshot.resultIds[0]).toBe('ab');
    expect(snapshot.resultIds[1]).toHaveLength(120);
    expect(snapshot.visibleIds).toEqual(['ab']);
  });

  it('retains only selected ids that exist in the result set', () => {
    const snapshot = createSnapshot({ selectedIds: ['a', 'missing', 'c', 'a'] });
    expect(snapshot.selectedIds).toEqual(['a', 'c']);
    expect(snapshot.selectedCount).toBe(2);
  });

  it('bounds selection capacity to the configured maximum', () => {
    const snapshot = createSnapshot({ selectedIds: ['a', 'b', 'c', 'd'], maxSelection: 2 });
    expect(snapshot.selectedIds).toEqual(['a', 'b']);
    expect(snapshot.maxSelection).toBe(2);
    expect(snapshot.capacityRemaining).toBe(0);
  });

  it('clamps hostile max-selection values', () => {
    expect(createSnapshot({ maxSelection: 0 }).maxSelection).toBe(1);
    expect(createSnapshot({ maxSelection: 99_999 }).maxSelection).toBe(5_000);
    expect(createSnapshot({ maxSelection: Number.NaN }).maxSelection).toBe(1_000);
  });

  it('normalizes focus and anchor against loaded results', () => {
    const snapshot = createSnapshot({ focusedId: 'missing', anchorId: 'e' });
    expect(snapshot.focusedId).toBeNull();
    expect(snapshot.anchorId).toBe('e');
  });

  it('computes none, partial and all coverage per selection scope', () => {
    expect(createSnapshot().visibleCoverage).toBe('none');
    expect(createSnapshot({ selectedIds: ['a'] }).visibleCoverage).toBe('partial');
    expect(createSnapshot({ selectedIds: ['a', 'b', 'c', 'd'] }).visibleCoverage).toBe('all');
    expect(createSnapshot({ selectedIds: ['a', 'b', 'c'] }).pageCoverage).toBe('all');
    expect(createSnapshot({ selectedIds: ['a', 'b', 'c', 'd', 'e', 'f'] }).loadedCoverage).toBe('all');
  });

  it('resolves explicit visible, page and loaded scopes', () => {
    const snapshot = createSnapshot();
    expect(resolveResultSelectionScope(snapshot, 'visible')).toEqual(['a', 'b', 'c', 'd']);
    expect(resolveResultSelectionScope(snapshot, 'page')).toEqual(['a', 'b', 'c']);
    expect(resolveResultSelectionScope(snapshot, 'loaded')).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('selects all visible results and preserves deterministic result order', () => {
    const transition = applyResultBulkSelection(createSnapshot({ selectedIds: ['e'] }), 'select', 'visible');
    expect(transition.next.selectedIds).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(transition.changedCount).toBe(4);
    expect(transition.selectedCount).toBe(5);
    expect(transition.announcement).toContain('4 görünür sonuç seçildi');
  });

  it('selects only the current page when requested', () => {
    const transition = applyResultBulkSelection(createSnapshot(), 'select', 'page');
    expect(transition.next.selectedIds).toEqual(['a', 'b', 'c']);
    expect(transition.next.pageCoverage).toBe('all');
    expect(transition.next.visibleCoverage).toBe('partial');
  });

  it('deselects only ids inside the requested scope', () => {
    const transition = applyResultBulkSelection(
      createSnapshot({ selectedIds: ['a', 'b', 'c', 'd', 'e'] }),
      'deselect',
      'page',
    );
    expect(transition.next.selectedIds).toEqual(['d', 'e']);
    expect(transition.changedCount).toBe(3);
    expect(transition.announcement).toContain('seçimden çıkarıldı');
  });

  it('toggles scope membership without disturbing selections outside the scope', () => {
    const transition = applyResultBulkSelection(
      createSnapshot({ selectedIds: ['a', 'c', 'e'] }),
      'toggle',
      'page',
    );
    expect(transition.next.selectedIds).toEqual(['b', 'e']);
    expect(transition.changedCount).toBe(3);
  });

  it('inverts visible membership', () => {
    const transition = applyResultBulkSelection(
      createSnapshot({ selectedIds: ['a', 'c', 'e'] }),
      'invert',
      'visible',
    );
    expect(transition.next.selectedIds).toEqual(['b', 'd', 'e']);
    expect(transition.changedCount).toBe(4);
  });

  it('clears every selection regardless of requested scope', () => {
    const transition = applyResultBulkSelection(
      createSnapshot({ selectedIds: ['a', 'c', 'e'] }),
      'clear',
      'page',
    );
    expect(transition.next.selectedIds).toEqual([]);
    expect(transition.changedCount).toBe(3);
    expect(transition.next.anchorId).toBeNull();
    expect(transition.announcement).toBe('Tüm sonuç seçimleri temizlendi.');
  });

  it('announces a no-op clear action accurately', () => {
    const transition = applyResultBulkSelection(createSnapshot(), 'clear', 'loaded');
    expect(transition.changedCount).toBe(0);
    expect(transition.announcement).toBe('Temizlenecek sonuç seçimi yok.');
  });

  it('respects selection capacity when bulk selecting loaded results', () => {
    const transition = applyResultBulkSelection(createSnapshot({ maxSelection: 3 }), 'select', 'loaded');
    expect(transition.next.selectedIds).toEqual(['a', 'b', 'c']);
    expect(transition.truncated).toBe(true);
    expect(transition.announcement).toContain('Seçim sınırı 3 sonuçta durduruldu');
  });

  it('does not report truncation when the scope already fits', () => {
    const transition = applyResultBulkSelection(createSnapshot({ maxSelection: 4 }), 'select', 'visible');
    expect(transition.truncated).toBe(false);
    expect(transition.next.selectedCount).toBe(4);
  });

  it('keeps current focus when applying a bulk command', () => {
    const transition = applyResultBulkSelection(createSnapshot({ focusedId: 'c' }), 'select', 'page');
    expect(transition.focusTarget).toBe('c');
    expect(transition.next.focusedId).toBe('c');
  });

  it('falls back to the first scoped id when focus is absent', () => {
    const transition = applyResultBulkSelection(createSnapshot({ focusedId: null }), 'select', 'page');
    expect(transition.focusTarget).toBe('a');
    expect(transition.next.focusedId).toBe('a');
  });

  it('selects an anchored contiguous range', () => {
    const transition = selectResultRange(createSnapshot({ anchorId: 'b', focusedId: 'b' }), 'e');
    expect(transition.next.selectedIds).toEqual(['b', 'c', 'd', 'e']);
    expect(transition.next.anchorId).toBe('b');
    expect(transition.next.focusedId).toBe('e');
    expect(transition.changedCount).toBe(4);
  });

  it('supports reverse anchored ranges', () => {
    const transition = selectResultRange(createSnapshot({ anchorId: 'e', focusedId: 'e' }), 'b');
    expect(transition.next.selectedIds).toEqual(['b', 'c', 'd', 'e']);
    expect(transition.focusTarget).toBe('b');
  });

  it('supports additive range selection', () => {
    const transition = selectResultRange(
      createSnapshot({ selectedIds: ['f'], anchorId: 'b', focusedId: 'b' }),
      'd',
      true,
    );
    expect(transition.next.selectedIds).toEqual(['b', 'c', 'd', 'f']);
  });

  it('uses focus as a range anchor when an explicit anchor is absent', () => {
    const transition = selectResultRange(createSnapshot({ anchorId: null, focusedId: 'c' }), 'e');
    expect(transition.next.selectedIds).toEqual(['c', 'd', 'e']);
    expect(transition.next.anchorId).toBe('c');
  });

  it('uses the target as an anchor when both focus and anchor are absent', () => {
    const transition = selectResultRange(createSnapshot({ anchorId: null, focusedId: null }), 'd');
    expect(transition.next.selectedIds).toEqual(['d']);
    expect(transition.next.anchorId).toBe('d');
  });

  it('bounds range selection by maxSelection', () => {
    const transition = selectResultRange(createSnapshot({ anchorId: 'a', maxSelection: 2 }), 'f');
    expect(transition.next.selectedIds).toEqual(['a', 'b']);
    expect(transition.truncated).toBe(true);
    expect(transition.announcement).toContain('Seçim sınırına ulaşıldı');
  });

  it('rejects a range target that is not loaded', () => {
    const snapshot = createSnapshot({ selectedIds: ['a'] });
    const transition = selectResultRange(snapshot, 'missing');
    expect(transition.next).toBe(snapshot);
    expect(transition.changedCount).toBe(0);
    expect(transition.announcement).toBe('Aralık seçimi uygulanamadı.');
  });

  it('reconciles selection after result refresh', () => {
    const result = reconcileResultSelection(
      createSnapshot({ selectedIds: ['a', 'c', 'e'], focusedId: 'e', anchorId: 'c' }),
      ['a', 'b', 'c', 'd'],
      ['a', 'b', 'c'],
      ['a', 'b'],
    );
    expect(result.next.selectedIds).toEqual(['a', 'c']);
    expect(result.removedSelectionCount).toBe(1);
    expect(result.next.focusedId).toBe('a');
    expect(result.focusChanged).toBe(true);
    expect(result.announcement).toContain('1 seçili sonuç artık mevcut değil');
  });

  it('preserves focus and anchor when refreshed results retain them', () => {
    const result = reconcileResultSelection(
      createSnapshot({ focusedId: 'c', anchorId: 'b', selectedIds: ['b'] }),
      ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
    );
    expect(result.next.focusedId).toBe('c');
    expect(result.next.anchorId).toBe('b');
    expect(result.focusChanged).toBe(false);
    expect(result.anchorChanged).toBe(false);
  });

  it('announces changed collection size without removed selections', () => {
    const result = reconcileResultSelection(createSnapshot(), ['a', 'b']);
    expect(result.announcement).toBe('2 sonuç kullanılabilir.');
  });

  it('produces toolbar facts for an empty selection', () => {
    const facts = createResultSelectionToolbarFacts(createSnapshot());
    expect(facts.canClear).toBe(false);
    expect(facts.canSelectVisible).toBe(true);
    expect(facts.canSelectPage).toBe(true);
    expect(facts.canSelectLoaded).toBe(true);
    expect(facts.canInvertVisible).toBe(true);
    expect(facts.summary).toBe('Sonuç seçimi yok.');
  });

  it('disables select actions when the selection capacity is exhausted', () => {
    const facts = createResultSelectionToolbarFacts(createSnapshot({ selectedIds: ['a', 'b'], maxSelection: 2 }));
    expect(facts.canClear).toBe(true);
    expect(facts.canSelectVisible).toBe(false);
    expect(facts.canSelectPage).toBe(false);
    expect(facts.canSelectLoaded).toBe(false);
    expect(facts.canInvertVisible).toBe(true);
    expect(facts.capacityRemaining).toBe(0);
  });

  it('disables a select scope that is already fully selected', () => {
    const facts = createResultSelectionToolbarFacts(createSnapshot({ selectedIds: ['a', 'b', 'c'] }));
    expect(facts.canSelectPage).toBe(false);
    expect(facts.canSelectVisible).toBe(true);
  });

  it('provides a bounded human-readable toolbar summary', () => {
    const facts = createResultSelectionToolbarFacts(createSnapshot({ selectedIds: ['a', 'b', 'c'], maxSelection: 10 }));
    expect(facts.summary).toBe('3 sonuç seçili; en fazla 10 sonuç seçilebilir.');
  });

  it('caps pathological result collections at the UI safety budget', () => {
    const resultIds = Array.from({ length: 25_000 }, (_, index) => `id-${index}`);
    const snapshot = normalizeResultSelectionSnapshot({ resultIds });
    expect(snapshot.resultIds).toHaveLength(20_000);
  });
});
