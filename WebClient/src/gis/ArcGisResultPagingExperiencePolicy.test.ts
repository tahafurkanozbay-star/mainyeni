import { describe, expect, it } from 'vitest';
import {
  createResultPagingModel,
  reconcileResultPaging,
  resolveResultPagingFocusTarget,
  resolveResultPagingKeyboard,
  resolveResultPagingPageForIndex,
  resolveResultPagingTransition,
  resolveResultPagingViewport,
  resolveVisibleResultPages,
} from './ArcGisResultPagingExperiencePolicy';

describe('ArcGisResultPagingExperiencePolicy', () => {
  it('normalizes a normal paged result snapshot', () => {
    const model = createResultPagingModel({ page: 2, pageSize: 25, totalCount: 88, status: 'ready' });
    expect(model.page).toBe(2);
    expect(model.pageCount).toBe(4);
    expect(model.firstItem).toBe(26);
    expect(model.lastItem).toBe(50);
    expect(model.hasPrevious).toBe(true);
    expect(model.hasNext).toBe(true);
    expect(model.summary).toBe('26–50 / 88');
    expect(model.announcement).toContain('Toplam 4 sayfa');
  });

  it('clamps hostile page values without exposing phantom ranges', () => {
    const model = createResultPagingModel({ page: 999, pageSize: -10, totalCount: 4 });
    expect(model.pageSize).toBe(1);
    expect(model.page).toBe(4);
    expect(model.firstItem).toBe(4);
    expect(model.lastItem).toBe(4);
  });

  it('uses safe defaults for non-finite numeric inputs', () => {
    const model = createResultPagingModel({ page: Number.NaN, pageSize: Number.POSITIVE_INFINITY, totalCount: Number.NaN });
    expect(model.page).toBe(1);
    expect(model.pageSize).toBe(25);
    expect(model.totalCount).toBe(0);
    expect(model.summary).toBe('Sonuç yok');
  });

  it('bounds page size to protect rendering and request fanout', () => {
    expect(createResultPagingModel({ pageSize: 9999, totalCount: 1000 }).pageSize).toBe(200);
    expect(createResultPagingModel({ pageSize: 0, totalCount: 1000 }).pageSize).toBe(1);
  });

  it('maps responsive widths deterministically', () => {
    expect(resolveResultPagingViewport(320)).toBe('phone');
    expect(resolveResultPagingViewport(639)).toBe('phone');
    expect(resolveResultPagingViewport(640)).toBe('tablet');
    expect(resolveResultPagingViewport(1023)).toBe('tablet');
    expect(resolveResultPagingViewport(1024)).toBe('desktop');
    expect(resolveResultPagingViewport(undefined)).toBe('desktop');
  });

  it('shows a compact bounded page window on phone', () => {
    expect(resolveVisibleResultPages(5, 20, 'phone')).toEqual([4, 5, 6]);
  });

  it('shows a wider page window on tablet and desktop', () => {
    expect(resolveVisibleResultPages(5, 20, 'tablet')).toEqual([3, 4, 5, 6, 7]);
    expect(resolveVisibleResultPages(5, 20, 'desktop')).toEqual([2, 3, 4, 5, 6, 7, 8]);
  });

  it('fills the page window at the beginning and end', () => {
    expect(resolveVisibleResultPages(1, 20, 'desktop')).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(resolveVisibleResultPages(20, 20, 'desktop')).toEqual([14, 15, 16, 17, 18, 19, 20]);
  });

  it('never invents page numbers for a one-page result', () => {
    expect(resolveVisibleResultPages(99, 1, 'desktop')).toEqual([1]);
  });

  it('moves to the next page and requests focus restoration', () => {
    const model = createResultPagingModel({ page: 2, pageSize: 25, totalCount: 100, status: 'ready' });
    expect(resolveResultPagingTransition(model, 'next')).toEqual({
      page: 3,
      pageSize: 25,
      shouldRequest: true,
      shouldRestoreFocus: true,
      shouldScrollToResults: true,
      announcement: '3. sayfaya geçiliyor.',
    });
  });

  it('does not request beyond the final page', () => {
    const model = createResultPagingModel({ page: 4, pageSize: 25, totalCount: 100, status: 'ready' });
    const transition = resolveResultPagingTransition(model, 'next');
    expect(transition.page).toBe(4);
    expect(transition.shouldRequest).toBe(false);
    expect(transition.announcement).toBe('Son sayfadasınız.');
  });

  it('does not request before the first page', () => {
    const model = createResultPagingModel({ page: 1, pageSize: 25, totalCount: 100, status: 'ready' });
    const transition = resolveResultPagingTransition(model, 'previous');
    expect(transition.page).toBe(1);
    expect(transition.shouldRequest).toBe(false);
    expect(transition.announcement).toBe('İlk sayfadasınız.');
  });

  it('blocks competing pagination while a page is loading', () => {
    const model = createResultPagingModel({ page: 2, pageSize: 25, totalCount: 100, status: 'loading' });
    const transition = resolveResultPagingTransition(model, 'next');
    expect(transition.page).toBe(3);
    expect(transition.shouldRequest).toBe(false);
    expect(transition.shouldRestoreFocus).toBe(false);
    expect(transition.announcement).toContain('yüklenirken');
  });

  it('supports first and last transitions', () => {
    const model = createResultPagingModel({ page: 3, pageSize: 10, totalCount: 80, status: 'ready' });
    expect(resolveResultPagingTransition(model, 'first').page).toBe(1);
    expect(resolveResultPagingTransition(model, 'last').page).toBe(8);
  });

  it('requires Alt for pagination keyboard shortcuts to avoid stealing native keys', () => {
    const model = createResultPagingModel({ page: 2, pageSize: 10, totalCount: 80, status: 'ready' });
    expect(resolveResultPagingKeyboard('PageDown', model, false)).toBeNull();
    expect(resolveResultPagingKeyboard('PageDown', model, true)?.page).toBe(3);
    expect(resolveResultPagingKeyboard('PageUp', model, true)?.page).toBe(1);
    expect(resolveResultPagingKeyboard('Home', model, true)?.page).toBe(1);
    expect(resolveResultPagingKeyboard('End', model, true)?.page).toBe(8);
    expect(resolveResultPagingKeyboard('Tab', model, true)).toBeNull();
  });

  it('resets paging, focus and selection when query changes', () => {
    const result = reconcileResultPaging(
      { query: 'park', page: 4, totalCount: 100, focusedObjectId: 7, selectedObjectIds: [7, 8] },
      { query: 'school', page: 4, totalCount: 80, focusedObjectId: 7, selectedObjectIds: [7, 8] },
    );
    expect(result.page).toBe(1);
    expect(result.resetReason).toBe('query');
    expect(result.focusedObjectId).toBeNull();
    expect(result.selectedObjectIds).toEqual([]);
    expect(result.shouldScrollToResults).toBe(true);
  });

  it('resets paging when filters change', () => {
    const result = reconcileResultPaging(
      { page: 4, totalCount: 100, filterRevision: 'a' },
      { page: 4, totalCount: 80, filterRevision: 'b' },
    );
    expect(result.page).toBe(1);
    expect(result.resetReason).toBe('filter');
    expect(result.announcement).toContain('Filtreler değişti');
  });

  it('resets paging when sorting changes', () => {
    const result = reconcileResultPaging(
      { page: 4, totalCount: 100, sortRevision: 'name-asc' },
      { page: 4, totalCount: 100, sortRevision: 'name-desc' },
    );
    expect(result.page).toBe(1);
    expect(result.resetReason).toBe('sort');
  });

  it('resets paging when page size changes', () => {
    const result = reconcileResultPaging(
      { page: 4, pageSize: 25, totalCount: 100 },
      { page: 2, pageSize: 50, totalCount: 100 },
    );
    expect(result.page).toBe(1);
    expect(result.resetReason).toBe('page-size');
  });

  it('clamps an out-of-range page after result count shrinks', () => {
    const result = reconcileResultPaging(
      { page: 10, pageSize: 10, totalCount: 100 },
      { page: 10, pageSize: 10, totalCount: 21 },
    );
    expect(result.page).toBe(3);
    expect(result.resetReason).toBe('out-of-range');
    expect(result.shouldScrollToResults).toBe(true);
  });

  it('preserves interaction when query semantics do not change', () => {
    const result = reconcileResultPaging(
      { page: 2, totalCount: 100, filterRevision: 1, sortRevision: 1 },
      { page: 3, totalCount: 100, filterRevision: 1, sortRevision: 1, focusedObjectId: 'x', selectedObjectIds: ['x', 'y'] },
    );
    expect(result.resetReason).toBe('none');
    expect(result.page).toBe(3);
    expect(result.focusedObjectId).toBe('x');
    expect(result.selectedObjectIds).toEqual(['x', 'y']);
    expect(result.shouldScrollToResults).toBe(false);
  });

  it('deduplicates selection with type-stable identity', () => {
    const model = createResultPagingModel({ selectedObjectIds: [1, 1, '1', '1', 2] });
    expect(model.selectedObjectIds).toEqual([1, '1', 2]);
  });

  it('drops non-finite numeric identities', () => {
    const model = createResultPagingModel({ selectedObjectIds: [1, Number.NaN, Number.POSITIVE_INFINITY, 2] });
    expect(model.selectedObjectIds).toEqual([1, 2]);
  });

  it('bounds selection cardinality to avoid unbounded UI state', () => {
    const model = createResultPagingModel({ selectedObjectIds: Array.from({ length: 900 }, (_, index) => index) });
    expect(model.selectedObjectIds).toHaveLength(500);
  });

  it('bounds query copy exposed to assistive technology', () => {
    const model = createResultPagingModel({ query: 'x'.repeat(1000), status: 'loading', page: 2, totalCount: 50 });
    expect(model.query.length).toBeLessThanOrEqual(160);
    expect(model.announcement.length).toBeLessThan(240);
  });

  it('restores requested focus when the object remains visible', () => {
    expect(resolveResultPagingFocusTarget('b', ['a', 'b', 'c'])).toBe('b');
  });

  it('uses type-stable focus matching', () => {
    expect(resolveResultPagingFocusTarget(1, ['1', 1, 2])).toBe(1);
    expect(resolveResultPagingFocusTarget('1', [1, '1', 2])).toBe('1');
  });

  it('falls back to first visible result when prior focus is stale', () => {
    expect(resolveResultPagingFocusTarget('missing', ['a', 'b'])).toBe('a');
    expect(resolveResultPagingFocusTarget(null, ['a', 'b'])).toBe('a');
  });

  it('returns no focus target for an empty page', () => {
    expect(resolveResultPagingFocusTarget('missing', [])).toBeNull();
  });

  it('maps absolute indices to pages', () => {
    expect(resolveResultPagingPageForIndex(0, 25, 100)).toBe(1);
    expect(resolveResultPagingPageForIndex(24, 25, 100)).toBe(1);
    expect(resolveResultPagingPageForIndex(25, 25, 100)).toBe(2);
    expect(resolveResultPagingPageForIndex(99, 25, 100)).toBe(4);
  });

  it('clamps hostile absolute indices', () => {
    expect(resolveResultPagingPageForIndex(-100, 25, 100)).toBe(1);
    expect(resolveResultPagingPageForIndex(9999, 25, 100)).toBe(4);
    expect(resolveResultPagingPageForIndex(Number.NaN, 25, 100)).toBe(1);
  });

  it('returns page one for empty results', () => {
    expect(resolveResultPagingPageForIndex(999, 25, 0)).toBe(1);
  });

  it('announces loading and error states without losing current page context', () => {
    expect(createResultPagingModel({ page: 3, totalCount: 100, status: 'loading' }).announcement).toContain('3. sayfa yükleniyor');
    expect(createResultPagingModel({ page: 3, totalCount: 100, status: 'error' }).announcement).toContain('3. sayfa yüklenemedi');
  });

  it('announces an empty query result clearly', () => {
    expect(createResultPagingModel({ query: 'müze', totalCount: 0, status: 'ready' }).announcement).toBe('müze için sonuç bulunamadı.');
  });

  it('freezes public collection outputs against accidental mutation', () => {
    const model = createResultPagingModel({ page: 2, totalCount: 100, selectedObjectIds: [1, 2] });
    expect(Object.isFrozen(model)).toBe(true);
    expect(Object.isFrozen(model.visiblePages)).toBe(true);
    expect(Object.isFrozen(model.selectedObjectIds)).toBe(true);
  });
});
