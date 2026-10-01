import { describe, expect, it } from 'vitest';
import {
  createFastAccessResultAnnouncement,
  createFastAccessResultPresentationSnapshot,
  createFastAccessResultRowPresentation,
  fastAccessResultPresentationBudget,
} from './fastAccessResultPresentationModel';

describe('fastAccessResultPresentationModel', () => {
  it('normalizes a ready collection', () => {
    const snapshot = createFastAccessResultPresentationSnapshot({
      totalRows: 30,
      visibleRows: 20,
      activeIndex: 3,
      collectionLabel: 'Park sonuçları',
    });

    expect(snapshot.status).toBe('ready');
    expect(snapshot.totalRows).toBe(30);
    expect(snapshot.visibleRows).toBe(20);
    expect(snapshot.activePosition).toBe(4);
    expect(snapshot.collectionLabel).toBe('Park sonuçları');
    expect(snapshot.hasMore).toBe(true);
    expect(snapshot.ariaBusy).toBe(false);
    expect(snapshot.countSummary).toBe('20 / 30 sonuç gösteriliyor.');
  });

  it('derives loading before empty state', () => {
    const snapshot = createFastAccessResultPresentationSnapshot({
      totalRows: 0,
      visibleRows: 0,
      loading: true,
    });

    expect(snapshot.status).toBe('loading');
    expect(snapshot.ariaBusy).toBe(true);
    expect(snapshot.surfaceSummary).toBe('Sonuçlar ve harita katmanı yükleniyor.');
  });

  it('derives error before result count', () => {
    const snapshot = createFastAccessResultPresentationSnapshot({
      totalRows: 12,
      visibleRows: 12,
      errorMessage: 'Bağlantı kurulamadı',
    });

    expect(snapshot.status).toBe('error');
    expect(snapshot.errorSummary).toBe('Bağlantı kurulamadı');
    expect(snapshot.surfaceSummary).toBe('Bağlantı kurulamadı');
  });

  it('derives empty when no rows are available', () => {
    const snapshot = createFastAccessResultPresentationSnapshot({ totalRows: 0, visibleRows: 0 });
    expect(snapshot.status).toBe('empty');
    expect(snapshot.emptySummary).toBe('Bu görünümde sonuç bulunamadı.');
    expect(snapshot.countSummary).toBe('Sonuç bulunamadı.');
  });

  it('creates a filter-specific empty message', () => {
    const snapshot = createFastAccessResultPresentationSnapshot({
      totalRows: 0,
      visibleRows: 0,
      filterText: 'park',
    });
    expect(snapshot.emptySummary).toBe('“park” filtresiyle eşleşen sonuç bulunamadı.');
  });

  it('creates a filter summary for matching rows', () => {
    const snapshot = createFastAccessResultPresentationSnapshot({
      totalRows: 8,
      visibleRows: 8,
      filterText: 'çankaya',
    });
    expect(snapshot.filterSummary).toBe('“çankaya” filtresi etkin.');
    expect(snapshot.surfaceSummary).toContain('8 sonuç gösteriliyor.');
  });

  it('sanitizes user-facing text and control characters', () => {
    const snapshot = createFastAccessResultPresentationSnapshot({
      totalRows: 1,
      visibleRows: 1,
      filterText: ' park\u0000  okul ',
      collectionLabel: ' Park\n sonuçları ',
      errorMessage: ' Sunucu\u0007 yanıt vermedi ',
    });

    expect(snapshot.filterText).toBe('park okul');
    expect(snapshot.collectionLabel).toBe('Park sonuçları');
    expect(snapshot.errorSummary).toBe('Sunucu yanıt vermedi');
  });

  it('bounds hostile collection counts', () => {
    const snapshot = createFastAccessResultPresentationSnapshot({
      totalRows: Number.POSITIVE_INFINITY,
      visibleRows: Number.NEGATIVE_INFINITY,
      activeIndex: Number.POSITIVE_INFINITY,
    });
    expect(snapshot.totalRows).toBe(0);
    expect(snapshot.visibleRows).toBe(0);
    expect(snapshot.activeIndex).toBeNull();
  });

  it('caps very large collections at the presentation budget', () => {
    const snapshot = createFastAccessResultPresentationSnapshot({
      totalRows: 99_999_999,
      visibleRows: 99_999_999,
    });
    expect(snapshot.totalRows).toBe(fastAccessResultPresentationBudget.maxRows);
    expect(snapshot.visibleRows).toBe(fastAccessResultPresentationBudget.maxRows);
  });

  it('clamps visible rows to total rows', () => {
    const snapshot = createFastAccessResultPresentationSnapshot({ totalRows: 3, visibleRows: 30 });
    expect(snapshot.visibleRows).toBe(3);
    expect(snapshot.hasMore).toBe(false);
  });

  it('clamps active index to visible rows', () => {
    const snapshot = createFastAccessResultPresentationSnapshot({
      totalRows: 100,
      visibleRows: 10,
      activeIndex: 90,
    });
    expect(snapshot.activeIndex).toBe(9);
    expect(snapshot.activePosition).toBe(10);
  });

  it('keeps active position null when no rows are visible', () => {
    const snapshot = createFastAccessResultPresentationSnapshot({
      totalRows: 0,
      visibleRows: 0,
      activeIndex: 0,
    });
    expect(snapshot.activeIndex).toBeNull();
    expect(snapshot.activePosition).toBeNull();
  });

  it('keeps explicit has-more state', () => {
    const snapshot = createFastAccessResultPresentationSnapshot({
      totalRows: 5,
      visibleRows: 5,
      hasMore: true,
    });
    expect(snapshot.hasMore).toBe(true);
  });

  it('uses a safe default collection label', () => {
    expect(createFastAccessResultPresentationSnapshot({ totalRows: 1, visibleRows: 1 }).collectionLabel)
      .toBe('Kent rehberi sonuçları');
  });

  it('bounds long text', () => {
    const snapshot = createFastAccessResultPresentationSnapshot({
      totalRows: 1,
      visibleRows: 1,
      filterText: 'f'.repeat(500),
      collectionLabel: 'c'.repeat(500),
      errorMessage: 'e'.repeat(500),
    });
    expect(snapshot.filterText.length).toBeLessThanOrEqual(fastAccessResultPresentationBudget.maxFilterText);
    expect(snapshot.collectionLabel.length).toBeLessThanOrEqual(fastAccessResultPresentationBudget.maxCollectionLabel);
    expect(snapshot.errorSummary?.length).toBeLessThanOrEqual(fastAccessResultPresentationBudget.maxErrorText);
  });

  it('announces loading politely', () => {
    const snapshot = createFastAccessResultPresentationSnapshot({ totalRows: 0, visibleRows: 0, loading: true });
    expect(createFastAccessResultAnnouncement(snapshot, 'initial')).toEqual({
      mode: 'polite',
      atomic: true,
      message: 'Sonuçlar ve harita katmanı yükleniyor.',
    });
  });

  it('announces errors assertively', () => {
    const snapshot = createFastAccessResultPresentationSnapshot({
      totalRows: 1,
      visibleRows: 1,
      errorMessage: 'Sunucu yanıt vermedi',
    });
    expect(createFastAccessResultAnnouncement(snapshot, 'error')).toEqual({
      mode: 'assertive',
      atomic: true,
      message: 'Sunucu yanıt vermedi',
    });
  });

  it('announces empty filtered results', () => {
    const snapshot = createFastAccessResultPresentationSnapshot({
      totalRows: 0,
      visibleRows: 0,
      filterText: 'okul',
    });
    expect(createFastAccessResultAnnouncement(snapshot, 'filter').message)
      .toBe('“okul” filtresiyle eşleşen sonuç bulunamadı.');
  });

  it('announces refresh separately from initial load', () => {
    const snapshot = createFastAccessResultPresentationSnapshot({ totalRows: 9, visibleRows: 9 });
    expect(createFastAccessResultAnnouncement(snapshot, 'refresh').message)
      .toBe('Sonuçlar güncellendi. 9 sonuç gösteriliyor.');
  });

  it('announces active focus position non-atomically', () => {
    const snapshot = createFastAccessResultPresentationSnapshot({
      totalRows: 12,
      visibleRows: 12,
      activeIndex: 4,
    });
    expect(createFastAccessResultAnnouncement(snapshot, 'focus')).toEqual({
      mode: 'polite',
      atomic: false,
      message: 'Sonuç 5 / 12',
    });
  });

  it('turns focus announcements off without an active row', () => {
    const snapshot = createFastAccessResultPresentationSnapshot({ totalRows: 2, visibleRows: 2 });
    expect(createFastAccessResultAnnouncement(snapshot, 'focus')).toEqual({
      mode: 'off',
      atomic: false,
      message: '',
    });
  });

  it('announces filter state and count together', () => {
    const snapshot = createFastAccessResultPresentationSnapshot({
      totalRows: 4,
      visibleRows: 4,
      filterText: 'park',
    });
    expect(createFastAccessResultAnnouncement(snapshot, 'filter').message)
      .toBe('“park” filtresi etkin. 4 sonuç gösteriliyor.');
  });

  it('announces bounded visible rows when more rows are available', () => {
    const snapshot = createFastAccessResultPresentationSnapshot({ totalRows: 100, visibleRows: 60 });
    expect(createFastAccessResultAnnouncement(snapshot, 'page').message)
      .toBe('60 sonuç görünür. Daha fazla sonuç yüklenebilir.');
  });

  it('uses count summary for page announcement when all rows are visible', () => {
    const snapshot = createFastAccessResultPresentationSnapshot({ totalRows: 5, visibleRows: 5 });
    expect(createFastAccessResultAnnouncement(snapshot, 'page').message).toBe('5 sonuç gösteriliyor.');
  });

  it('creates deterministic row presentation facts', () => {
    const snapshot = createFastAccessResultPresentationSnapshot({ totalRows: 5, visibleRows: 5 });
    expect(createFastAccessResultRowPresentation(snapshot, 2, 'Kuğulu Park')).toEqual({
      position: 3,
      setSize: 5,
      positionLabel: 'Sonuç 3 / 5',
      accessibleLabel: 'Sonuç 3 / 5. Kuğulu Park',
    });
  });

  it('clamps hostile row indices', () => {
    const snapshot = createFastAccessResultPresentationSnapshot({ totalRows: 3, visibleRows: 3 });
    expect(createFastAccessResultRowPresentation(snapshot, 99, 'Son kayıt')?.position).toBe(3);
  });

  it('sanitizes and bounds row labels', () => {
    const snapshot = createFastAccessResultPresentationSnapshot({ totalRows: 1, visibleRows: 1 });
    const row = createFastAccessResultRowPresentation(snapshot, 0, ` Park\u0000 ${'x'.repeat(400)}`);
    expect(row?.accessibleLabel).not.toContain('\u0000');
    expect(row?.accessibleLabel.length).toBeLessThanOrEqual(
      fastAccessResultPresentationBudget.maxRowLabel + 30,
    );
  });

  it('returns no row facts for an empty collection', () => {
    const snapshot = createFastAccessResultPresentationSnapshot({ totalRows: 0, visibleRows: 0 });
    expect(createFastAccessResultRowPresentation(snapshot, 0, 'Yok')).toBeNull();
  });
});
