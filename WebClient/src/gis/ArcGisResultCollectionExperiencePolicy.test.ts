import { describe, expect, it } from 'vitest';
import {
  createResultCollectionExperienceModel,
  createResultCollectionWindow,
  normalizeResultCollectionFacets,
  resolveResultCollectionKeyboard,
  resolveResultCollectionRowHeight,
  resolveResultCollectionScrollOffset,
  resolveResultCollectionViewport,
} from './ArcGisResultCollectionExperiencePolicy';

describe('ArcGisResultCollectionExperiencePolicy', () => {
  it('maps responsive widths into deterministic viewport classes', () => {
    expect(resolveResultCollectionViewport(320)).toBe('phone');
    expect(resolveResultCollectionViewport(639)).toBe('phone');
    expect(resolveResultCollectionViewport(640)).toBe('tablet');
    expect(resolveResultCollectionViewport(1023)).toBe('tablet');
    expect(resolveResultCollectionViewport(1024)).toBe('desktop');
    expect(resolveResultCollectionViewport(undefined)).toBe('desktop');
  });

  it('uses touch-safe bounded row heights', () => {
    expect(resolveResultCollectionRowHeight('compact', undefined)).toBe(44);
    expect(resolveResultCollectionRowHeight('comfortable', undefined)).toBe(56);
    expect(resolveResultCollectionRowHeight('compact', 1)).toBe(36);
    expect(resolveResultCollectionRowHeight('comfortable', 500)).toBe(96);
  });

  it('normalizes facets, removes duplicates and preserves selected zero-count values', () => {
    const facets = normalizeResultCollectionFacets([
      {
        id: 'category',
        label: 'Kategori',
        kind: 'multiple',
        values: [
          { value: 'park', label: 'Park', count: 4, selected: true },
          { value: 'park', label: 'Duplicate', count: 99 },
          { value: 'school', label: 'Okul', count: 0 },
          { value: 'museum', label: 'Müze', count: 0, selected: true },
        ],
      },
      { id: 'category', label: 'Duplicate facet', kind: 'single', values: [] },
    ]);
    expect(facets).toHaveLength(1);
    expect(facets[0].selectedCount).toBe(2);
    expect(facets[0].expanded).toBe(true);
    expect(facets[0].values).toHaveLength(3);
    expect(facets[0].values[1].disabled).toBe(true);
    expect(facets[0].values[2].disabled).toBe(false);
    expect(facets[0].values[0].accessibleName).toContain('seçili');
  });

  it('bounds facet count and value count to prevent unbounded UI work', () => {
    const facets = Array.from({ length: 40 }, (_, facetIndex) => ({
      id: `facet-${facetIndex}`,
      label: `Facet ${facetIndex}`,
      kind: 'multiple' as const,
      values: Array.from({ length: 150 }, (_, valueIndex) => ({
        value: `value-${valueIndex}`,
        label: `Value ${valueIndex}`,
        count: valueIndex,
      })),
    }));
    const normalized = normalizeResultCollectionFacets(facets);
    expect(normalized).toHaveLength(24);
    expect(normalized[0].values).toHaveLength(100);
  });

  it('creates a bounded initial virtualization window', () => {
    const window = createResultCollectionWindow(10_000, 0, 560, 56);
    expect(window.startIndex).toBe(0);
    expect(window.endIndex).toBe(9);
    expect(window.overscanStartIndex).toBe(0);
    expect(window.overscanEndIndex).toBe(14);
    expect(window.renderedCount).toBe(15);
    expect(window.topSpacer).toBe(0);
    expect(window.bottomSpacer).toBe((10_000 - 15) * 56);
  });

  it('virtualizes a scrolled collection with symmetric bounded overscan', () => {
    const window = createResultCollectionWindow(1_000, 5_600, 560, 56, 5);
    expect(window.startIndex).toBe(100);
    expect(window.endIndex).toBe(109);
    expect(window.overscanStartIndex).toBe(95);
    expect(window.overscanEndIndex).toBe(114);
    expect(window.renderedCount).toBe(20);
    expect(window.topSpacer).toBe(95 * 56);
    expect(window.bottomSpacer).toBe((1_000 - 115) * 56);
  });

  it('handles empty virtualization without phantom rows', () => {
    expect(createResultCollectionWindow(0, 100, 500, 50)).toEqual({
      startIndex: 0,
      endIndex: -1,
      overscanStartIndex: 0,
      overscanEndIndex: -1,
      renderedCount: 0,
      topSpacer: 0,
      bottomSpacer: 0,
    });
  });

  it('clamps hostile virtualization inputs', () => {
    const window = createResultCollectionWindow(Number.POSITIVE_INFINITY, Number.NaN, -50, -1, 999);
    expect(window.renderedCount).toBe(0);
    const bounded = createResultCollectionWindow(100, Number.POSITIVE_INFINITY, 10, 1, 999);
    expect(bounded.renderedCount).toBeLessThanOrEqual(100);
    expect(bounded.overscanStartIndex).toBeGreaterThanOrEqual(0);
    expect(bounded.overscanEndIndex).toBeLessThan(100);
  });

  it('builds phone drawer presentation with active-filter announcement', () => {
    const model = createResultCollectionExperienceModel({
      totalCount: 120,
      visibleCount: 35,
      viewportWidth: 390,
      query: 'park',
      filterPanelOpen: true,
      facets: [{
        id: 'district',
        label: 'İlçe',
        kind: 'multiple',
        values: [{ value: 'cankaya', label: 'Çankaya', count: 35, selected: true }],
      }],
    });
    expect(model.viewport).toBe('phone');
    expect(model.filterPanelMode).toBe('drawer');
    expect(model.filterPanelOpen).toBe(true);
    expect(model.activeFilterCount).toBe(1);
    expect(model.filterButtonLabel).toBe('Filtreler, 1 etkin');
    expect(model.resultSummary).toContain('35 / 120');
    expect(model.resultSummary).toContain('park');
  });

  it('uses inline filter presentation on desktop', () => {
    const model = createResultCollectionExperienceModel({
      totalCount: 20,
      visibleCount: 20,
      viewportWidth: 1440,
      facets: [],
      filterPanelOpen: true,
    });
    expect(model.filterPanelMode).toBe('inline');
    expect(model.filterPanelOpen).toBe(false);
    expect(model.filterButtonLabel).toBe('Filtreler');
  });

  it('deduplicates, sorts and bounds selected indices', () => {
    const model = createResultCollectionExperienceModel({
      totalCount: 5,
      visibleCount: 5,
      selectedIndices: [4, 2, 2, -1, 99, 0, Number.NaN],
    });
    expect(model.selectedIndices).toEqual([0, 2, 4]);
    expect(model.selectionSummary).toBe('3 sonuç seçili');
  });

  it('clamps focused index to available rows', () => {
    expect(createResultCollectionExperienceModel({ totalCount: 4, visibleCount: 4, focusedIndex: 99 }).focusedIndex).toBe(3);
    expect(createResultCollectionExperienceModel({ totalCount: 0, visibleCount: 0, focusedIndex: 0 }).focusedIndex).toBeNull();
    expect(createResultCollectionExperienceModel({ totalCount: 4, visibleCount: 4, focusedIndex: null }).focusedIndex).toBeNull();
  });

  it('resolves arrow navigation without wrapping unexpectedly', () => {
    expect(resolveResultCollectionKeyboard({ key: 'ArrowDown', currentIndex: 2, rowCount: 4, pageSize: 2 })).toMatchObject({ handled: true, nextIndex: 3, action: 'focus' });
    expect(resolveResultCollectionKeyboard({ key: 'ArrowDown', currentIndex: 3, rowCount: 4, pageSize: 2 }).nextIndex).toBe(3);
    expect(resolveResultCollectionKeyboard({ key: 'ArrowUp', currentIndex: 0, rowCount: 4, pageSize: 2 }).nextIndex).toBe(0);
  });

  it('resolves home, end and page navigation', () => {
    expect(resolveResultCollectionKeyboard({ key: 'Home', currentIndex: 5, rowCount: 20, pageSize: 5 }).nextIndex).toBe(0);
    expect(resolveResultCollectionKeyboard({ key: 'End', currentIndex: 5, rowCount: 20, pageSize: 5 }).nextIndex).toBe(19);
    expect(resolveResultCollectionKeyboard({ key: 'PageDown', currentIndex: 5, rowCount: 20, pageSize: 5 }).nextIndex).toBe(10);
    expect(resolveResultCollectionKeyboard({ key: 'PageUp', currentIndex: 5, rowCount: 20, pageSize: 5 }).nextIndex).toBe(0);
  });

  it('communicates selection intent for keyboard modifiers', () => {
    expect(resolveResultCollectionKeyboard({ key: 'ArrowDown', currentIndex: 0, rowCount: 5, pageSize: 2, shiftKey: true }).selectionMode).toBe('extend');
    expect(resolveResultCollectionKeyboard({ key: 'ArrowDown', currentIndex: 0, rowCount: 5, pageSize: 2, ctrlKey: true }).selectionMode).toBe('toggle');
    expect(resolveResultCollectionKeyboard({ key: 'ArrowDown', currentIndex: 0, rowCount: 5, pageSize: 2, metaKey: true }).selectionMode).toBe('toggle');
  });

  it('maps activation and clear keys to semantic actions', () => {
    expect(resolveResultCollectionKeyboard({ key: 'Enter', currentIndex: 2, rowCount: 5, pageSize: 2 })).toMatchObject({ handled: true, nextIndex: 2, action: 'activate' });
    expect(resolveResultCollectionKeyboard({ key: ' ', currentIndex: 2, rowCount: 5, pageSize: 2 }).action).toBe('activate');
    expect(resolveResultCollectionKeyboard({ key: 'Escape', currentIndex: 2, rowCount: 5, pageSize: 2 })).toMatchObject({ handled: true, action: 'clear', selectionMode: 'preserve' });
  });

  it('leaves unknown keys to the host without swallowing them', () => {
    expect(resolveResultCollectionKeyboard({ key: 'Tab', currentIndex: 2, rowCount: 5, pageSize: 2 })).toEqual({ handled: false, nextIndex: 2, selectionMode: 'preserve', action: 'none' });
  });

  it('does not claim keyboard handling for an empty collection', () => {
    expect(resolveResultCollectionKeyboard({ key: 'ArrowDown', currentIndex: null, rowCount: 0, pageSize: 10 })).toEqual({ handled: false, nextIndex: null, selectionMode: 'preserve', action: 'none' });
  });

  it('scrolls upward only when target is above the viewport', () => {
    expect(resolveResultCollectionScrollOffset(5, 560, 560, 56, 100)).toBe(280);
  });

  it('scrolls downward only when target is below the viewport', () => {
    expect(resolveResultCollectionScrollOffset(25, 560, 560, 56, 100)).toBe(896);
  });

  it('keeps offset stable when focused row is already visible', () => {
    expect(resolveResultCollectionScrollOffset(12, 560, 560, 56, 100)).toBe(560);
  });

  it('bounds scroll offsets at the collection end', () => {
    const maxOffset = 100 * 56 - 560;
    expect(resolveResultCollectionScrollOffset(999, 0, 560, 56, 100)).toBe(maxOffset);
  });

  it('returns zero scroll offset for empty collections', () => {
    expect(resolveResultCollectionScrollOffset(5, 100, 560, 56, 0)).toBe(0);
  });

  it('bounds visible count against total count', () => {
    const model = createResultCollectionExperienceModel({ totalCount: 5, visibleCount: 99 });
    expect(model.totalCount).toBe(5);
    expect(model.visibleCount).toBe(5);
  });

  it('uses selected facet values as active filter fallback', () => {
    const model = createResultCollectionExperienceModel({
      totalCount: 10,
      visibleCount: 4,
      facets: [
        { id: 'a', label: 'A', kind: 'multiple', values: [{ value: '1', label: 'One', count: 2, selected: true }] },
        { id: 'b', label: 'B', kind: 'single', values: [{ value: '2', label: 'Two', count: 2, selected: true }] },
      ],
    });
    expect(model.activeFilterCount).toBe(2);
    expect(model.filterButtonLabel).toContain('2 etkin');
  });

  it('allows an authoritative external active-filter count', () => {
    const model = createResultCollectionExperienceModel({ totalCount: 10, visibleCount: 10, activeFilterCount: 7 });
    expect(model.activeFilterCount).toBe(7);
  });

  it('truncates hostile facet labels instead of allowing unbounded accessible names', () => {
    const huge = 'x'.repeat(1_000);
    const [facet] = normalizeResultCollectionFacets([{ id: 'x', label: huge, kind: 'single', values: [{ value: 'v', label: huge, count: 1 }] }]);
    expect(facet.label.length).toBeLessThanOrEqual(120);
    expect(facet.values[0].label.length).toBeLessThanOrEqual(120);
    expect(facet.values[0].accessibleName.length).toBeLessThan(180);
  });

  it('drops blank facet identifiers and labels', () => {
    expect(normalizeResultCollectionFacets([
      { id: '', label: 'Valid label', kind: 'single', values: [] },
      { id: 'valid', label: '   ', kind: 'single', values: [] },
    ])).toEqual([]);
  });

  it('marks zero-count unselected values disabled but keeps selected values reversible', () => {
    const [facet] = normalizeResultCollectionFacets([{
      id: 'status', label: 'Durum', kind: 'multiple', values: [
        { value: 'none', label: 'Yok', count: 0 },
        { value: 'selected-none', label: 'Seçili yok', count: 0, selected: true },
      ],
    }]);
    expect(facet.values[0].disabled).toBe(true);
    expect(facet.values[1].disabled).toBe(false);
  });

  it('keeps explicitly disabled selected values announced as both selected and unavailable', () => {
    const [facet] = normalizeResultCollectionFacets([{
      id: 'status', label: 'Durum', kind: 'multiple', values: [
        { value: 'legacy', label: 'Eski', count: 1, selected: true, disabled: true },
      ],
    }]);
    expect(facet.values[0].accessibleName).toContain('seçili');
    expect(facet.values[0].accessibleName).toContain('kullanılamıyor');
  });

  it('freezes policy outputs to discourage accidental state mutation', () => {
    const model = createResultCollectionExperienceModel({ totalCount: 1, visibleCount: 1 });
    expect(Object.isFrozen(model)).toBe(true);
    expect(Object.isFrozen(model.selectedIndices)).toBe(true);
    expect(Object.isFrozen(model.facets)).toBe(true);
    expect(Object.isFrozen(model.window)).toBe(true);
  });
});
