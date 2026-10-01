import { describe, expect, it } from 'vitest';
import {
  createResultAccessibilityAnnouncement,
  createResultAccessibilityHints,
  createResultAccessibilityRowFacts,
  createResultCollectionAriaFacts,
  normalizeResultAccessibilitySnapshot,
} from './ArcGisResultAccessibilityExperiencePolicy';

describe('ArcGisResultAccessibilityExperiencePolicy', () => {
  it('normalizes a ready result collection', () => {
    const snapshot = normalizeResultAccessibilitySnapshot({
      totalCount: 120,
      visibleCount: 20,
      pageIndex: 1,
      pageSize: 20,
      selectedCount: 3,
      focusedIndex: 4,
      query: 'park',
      sortLabel: 'Ada göre artan',
      status: 'ready',
    });
    expect(snapshot.totalCount).toBe(120);
    expect(snapshot.visibleCount).toBe(20);
    expect(snapshot.pageCount).toBe(6);
    expect(snapshot.currentPageNumber).toBe(2);
    expect(snapshot.pageStartPosition).toBe(21);
    expect(snapshot.pageEndPosition).toBe(40);
    expect(snapshot.focusedAbsolutePosition).toBe(25);
    expect(snapshot.collectionLabel).toBe('CBS sonuçları, arama: park');
    expect(snapshot.selectionSummary).toBe('3 sonuç seçili.');
    expect(snapshot.sortSummary).toBe('Sıralama: Ada göre artan.');
  });

  it('clamps hostile counts and pagination inputs', () => {
    const snapshot = normalizeResultAccessibilitySnapshot({
      totalCount: Number.POSITIVE_INFINITY,
      visibleCount: -50,
      pageSize: 99_999,
      pageIndex: 99_999,
      selectedCount: -1,
    });
    expect(snapshot.totalCount).toBe(0);
    expect(snapshot.visibleCount).toBe(0);
    expect(snapshot.pageSize).toBe(500);
    expect(snapshot.pageIndex).toBe(0);
    expect(snapshot.selectedCount).toBe(0);
  });

  it('caps very large collections at the accessibility budget', () => {
    const snapshot = normalizeResultAccessibilitySnapshot({ totalCount: 9_999_999, visibleCount: 500 });
    expect(snapshot.totalCount).toBe(1_000_000);
    expect(snapshot.visibleCount).toBe(500);
  });

  it('derives empty status when a ready collection has no results', () => {
    const snapshot = normalizeResultAccessibilitySnapshot({ totalCount: 0, status: 'ready' });
    expect(snapshot.status).toBe('empty');
    expect(snapshot.emptySummary).toBe('Bu görünümde sonuç bulunamadı.');
    expect(snapshot.countSummary).toBe('Sonuç bulunamadı.');
  });

  it('creates a query-specific empty summary', () => {
    const snapshot = normalizeResultAccessibilitySnapshot({ totalCount: 0, query: 'okul', status: 'empty' });
    expect(snapshot.emptySummary).toBe('“okul” aramasıyla eşleşen sonuç bulunamadı.');
  });

  it('marks loading collections busy', () => {
    const snapshot = normalizeResultAccessibilitySnapshot({ totalCount: 20, visibleCount: 20, status: 'loading' });
    expect(snapshot.ariaBusy).toBe(true);
    expect(snapshot.status).toBe('loading');
  });

  it('does not mark ready collections busy', () => {
    expect(normalizeResultAccessibilitySnapshot({ totalCount: 1, status: 'ready' }).ariaBusy).toBe(false);
  });

  it('supports single-select collection semantics', () => {
    const snapshot = normalizeResultAccessibilitySnapshot({ totalCount: 4, multiSelectable: false });
    expect(snapshot.ariaMultiSelectable).toBe(false);
    expect(createResultAccessibilityHints(snapshot).selection).toBe('Bu görünüm tekli sonuç seçimi kullanır.');
  });

  it('defaults to multi-select semantics', () => {
    const snapshot = normalizeResultAccessibilitySnapshot({ totalCount: 4 });
    expect(snapshot.ariaMultiSelectable).toBe(true);
    expect(createResultAccessibilityHints(snapshot).selection).toContain('toplu seçim');
  });

  it('calculates the last partial page range', () => {
    const snapshot = normalizeResultAccessibilitySnapshot({ totalCount: 45, visibleCount: 5, pageIndex: 2, pageSize: 20 });
    expect(snapshot.pageCount).toBe(3);
    expect(snapshot.pageStartPosition).toBe(41);
    expect(snapshot.pageEndPosition).toBe(45);
    expect(snapshot.pageSummary).toBe('Sayfa 3 / 3; 41-45 arası sonuçlar.');
  });

  it('uses count summary when pagination is unnecessary', () => {
    const snapshot = normalizeResultAccessibilitySnapshot({ totalCount: 8, visibleCount: 8, pageSize: 20 });
    expect(snapshot.pageCount).toBe(1);
    expect(snapshot.pageSummary).toBe('8 sonuç gösteriliyor.');
  });

  it('bounds the focused local index to visible rows', () => {
    const snapshot = normalizeResultAccessibilitySnapshot({
      totalCount: 100,
      visibleCount: 10,
      pageIndex: 3,
      pageSize: 10,
      focusedIndex: 99,
    });
    expect(snapshot.focusedIndex).toBe(9);
    expect(snapshot.focusedAbsolutePosition).toBe(40);
  });

  it('keeps focus null when no local row is focused', () => {
    const snapshot = normalizeResultAccessibilitySnapshot({ totalCount: 10, visibleCount: 10, focusedIndex: null });
    expect(snapshot.focusedIndex).toBeNull();
    expect(snapshot.focusedAbsolutePosition).toBeNull();
  });

  it('keeps focus null for empty pages', () => {
    const snapshot = normalizeResultAccessibilitySnapshot({ totalCount: 0, visibleCount: 0, focusedIndex: 0 });
    expect(snapshot.focusedAbsolutePosition).toBeNull();
  });

  it('sanitizes user-facing query, sort and error text', () => {
    const snapshot = normalizeResultAccessibilitySnapshot({
      totalCount: 10,
      query: ' park\u0000   okul ',
      sortLabel: ' Ada\n göre ',
      errorMessage: ' Sunucu\u0007 yanıt vermedi ',
      status: 'error',
    });
    expect(snapshot.query).toBe('park okul');
    expect(snapshot.sortLabel).toBe('Ada göre');
    expect(snapshot.errorMessage).toBe('Sunucu yanıt vermedi');
  });

  it('bounds user-facing text lengths', () => {
    const snapshot = normalizeResultAccessibilitySnapshot({
      totalCount: 1,
      query: 'q'.repeat(500),
      sortLabel: 's'.repeat(500),
      errorMessage: 'e'.repeat(500),
    });
    expect(snapshot.query.length).toBeLessThanOrEqual(100);
    expect(snapshot.sortLabel.length).toBeLessThanOrEqual(100);
    expect(snapshot.errorMessage?.length).toBeLessThanOrEqual(160);
  });

  it('creates deterministic row semantics with absolute collection position', () => {
    const snapshot = normalizeResultAccessibilitySnapshot({
      totalCount: 200,
      visibleCount: 20,
      pageIndex: 4,
      pageSize: 20,
      focusedIndex: 2,
    });
    const row = createResultAccessibilityRowFacts(snapshot, 2, 'parcel-83', true, ['row-title', 'row-meta']);
    expect(row).toEqual({
      id: 'result-option-parcel-83',
      role: 'option',
      ariaPosInSet: 83,
      ariaSetSize: 200,
      ariaSelected: true,
      tabIndex: 0,
      positionLabel: 'Sonuç 83 / 200',
      describedBy: ['row-title', 'row-meta'],
    });
  });

  it('makes non-focused rows non-tabbable', () => {
    const snapshot = normalizeResultAccessibilitySnapshot({ totalCount: 5, visibleCount: 5, focusedIndex: 1 });
    expect(createResultAccessibilityRowFacts(snapshot, 3, 'd', false)?.tabIndex).toBe(-1);
  });

  it('clamps hostile local row indices', () => {
    const snapshot = normalizeResultAccessibilitySnapshot({ totalCount: 10, visibleCount: 3, focusedIndex: 2 });
    const row = createResultAccessibilityRowFacts(snapshot, 99, 'c', false);
    expect(row?.ariaPosInSet).toBe(3);
  });

  it('returns no row semantics for empty collections', () => {
    const snapshot = normalizeResultAccessibilitySnapshot({ totalCount: 0, visibleCount: 0 });
    expect(createResultAccessibilityRowFacts(snapshot, 0, 'a', false)).toBeNull();
  });

  it('rejects an empty row identifier', () => {
    const snapshot = normalizeResultAccessibilitySnapshot({ totalCount: 1, visibleCount: 1 });
    expect(createResultAccessibilityRowFacts(snapshot, 0, '   ', false)).toBeNull();
  });

  it('sanitizes row identifiers and description ids', () => {
    const snapshot = normalizeResultAccessibilitySnapshot({ totalCount: 1, visibleCount: 1, focusedIndex: 0 });
    const row = createResultAccessibilityRowFacts(snapshot, 0, ' parcel 1 ', false, [' label\n one ', '', 'meta']);
    expect(row?.id).toBe('result-option-parcel-1');
    expect(row?.describedBy).toEqual(['label one', 'meta']);
  });

  it('announces initial load with count and sort information', () => {
    const snapshot = normalizeResultAccessibilitySnapshot({ totalCount: 20, visibleCount: 20, sortLabel: 'Ada göre', status: 'ready' });
    const announcement = createResultAccessibilityAnnouncement(snapshot, 'initial-load');
    expect(announcement.mode).toBe('polite');
    expect(announcement.message).toBe('20 sonuç gösteriliyor. Sıralama: Ada göre.');
  });

  it('announces refreshes separately from initial load', () => {
    const snapshot = normalizeResultAccessibilitySnapshot({ totalCount: 12, visibleCount: 12, status: 'ready' });
    expect(createResultAccessibilityAnnouncement(snapshot, 'refresh').message).toBe('Sonuçlar güncellendi. 12 sonuç gösteriliyor.');
  });

  it('announces page changes with absolute ranges', () => {
    const snapshot = normalizeResultAccessibilitySnapshot({ totalCount: 60, visibleCount: 20, pageIndex: 1, pageSize: 20 });
    expect(createResultAccessibilityAnnouncement(snapshot, 'page-change').message).toBe('Sayfa 2 / 3; 21-40 arası sonuçlar.');
  });

  it('announces filter changes with the resulting count', () => {
    const snapshot = normalizeResultAccessibilitySnapshot({ totalCount: 100, visibleCount: 18, status: 'ready' });
    expect(createResultAccessibilityAnnouncement(snapshot, 'filter-change').message).toBe('Filtreler uygulandı. 18 / 100 sonuç gösteriliyor.');
  });

  it('announces sort changes using a safe sort label', () => {
    const snapshot = normalizeResultAccessibilitySnapshot({ totalCount: 10, sortLabel: 'Tarihe göre azalan' });
    expect(createResultAccessibilityAnnouncement(snapshot, 'sort-change').message).toBe('Sıralama: Tarihe göre azalan.');
  });

  it('announces selection changes', () => {
    const snapshot = normalizeResultAccessibilitySnapshot({ totalCount: 10, selectedCount: 4 });
    expect(createResultAccessibilityAnnouncement(snapshot, 'selection-change').message).toBe('4 sonuç seçili.');
  });

  it('announces focused absolute position without atomic replacement', () => {
    const snapshot = normalizeResultAccessibilitySnapshot({ totalCount: 50, visibleCount: 10, pageIndex: 2, pageSize: 10, focusedIndex: 3 });
    const announcement = createResultAccessibilityAnnouncement(snapshot, 'focus-change');
    expect(announcement.mode).toBe('polite');
    expect(announcement.atomic).toBe(false);
    expect(announcement.message).toBe('Sonuç 24 / 50');
  });

  it('turns off focus announcements when no row is focused', () => {
    const snapshot = normalizeResultAccessibilitySnapshot({ totalCount: 10, focusedIndex: null });
    const announcement = createResultAccessibilityAnnouncement(snapshot, 'focus-change');
    expect(announcement.mode).toBe('off');
    expect(announcement.message).toBe('');
  });

  it('announces loading state politely before reason-specific text', () => {
    const snapshot = normalizeResultAccessibilitySnapshot({ totalCount: 10, status: 'loading' });
    const announcement = createResultAccessibilityAnnouncement(snapshot, 'sort-change');
    expect(announcement.mode).toBe('polite');
    expect(announcement.message).toBe('Sonuçlar yükleniyor.');
  });

  it('announces empty state politely', () => {
    const snapshot = normalizeResultAccessibilitySnapshot({ totalCount: 0, query: 'park', status: 'empty' });
    const announcement = createResultAccessibilityAnnouncement(snapshot, 'filter-change');
    expect(announcement.message).toBe('“park” aramasıyla eşleşen sonuç bulunamadı.');
    expect(announcement.priority).toBe(60);
  });

  it('announces errors assertively with sanitized detail', () => {
    const snapshot = normalizeResultAccessibilitySnapshot({ totalCount: 10, status: 'error', errorMessage: 'Bağlantı\n kesildi' });
    const announcement = createResultAccessibilityAnnouncement(snapshot, 'error');
    expect(announcement.mode).toBe('assertive');
    expect(announcement.atomic).toBe(true);
    expect(announcement.message).toBe('Sonuçlar yüklenemedi. Bağlantı kesildi');
    expect(announcement.priority).toBe(100);
  });

  it('uses a safe fallback error announcement', () => {
    const snapshot = normalizeResultAccessibilitySnapshot({ totalCount: 10, status: 'error' });
    expect(createResultAccessibilityAnnouncement(snapshot, 'refresh').message).toBe('Sonuçlar yüklenemedi.');
  });

  it('creates collection aria facts from normalized state', () => {
    const snapshot = normalizeResultAccessibilitySnapshot({ totalCount: 42, visibleCount: 20, selectedCount: 2, status: 'ready' });
    expect(createResultCollectionAriaFacts(snapshot)).toMatchObject({
      role: 'listbox',
      ariaLabel: 'CBS sonuçları',
      ariaBusy: false,
      ariaMultiSelectable: true,
      ariaRowCount: 42,
      setSize: 42,
      selectionSummary: '2 sonuç seçili.',
    });
  });

  it('provides keyboard, pagination and selection hints', () => {
    const snapshot = normalizeResultAccessibilitySnapshot({ totalCount: 45, visibleCount: 20, pageSize: 20 });
    const hints = createResultAccessibilityHints(snapshot);
    expect(hints.keyboard).toContain('Yön tuşlarıyla');
    expect(hints.pagination).toContain('Toplam 3 sayfa');
    expect(hints.selection).toContain('Shift ile aralık seçimi');
  });

  it('provides empty-state keyboard guidance', () => {
    const snapshot = normalizeResultAccessibilitySnapshot({ totalCount: 0 });
    expect(createResultAccessibilityHints(snapshot).keyboard).toBe('Sonuç yok. Filtreleri veya arama ifadesini değiştirin.');
  });
});
