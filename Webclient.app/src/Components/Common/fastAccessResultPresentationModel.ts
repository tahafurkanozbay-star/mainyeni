export type FastAccessResultPresentationStatus = 'loading' | 'ready' | 'empty' | 'error';
export type FastAccessResultAnnouncementReason =
  | 'initial'
  | 'refresh'
  | 'filter'
  | 'focus'
  | 'page'
  | 'error';

export interface FastAccessResultPresentationInput {
  readonly totalRows: number;
  readonly visibleRows: number;
  readonly activeIndex?: number | null;
  readonly filterText?: string;
  readonly collectionLabel?: string;
  readonly loading?: boolean;
  readonly errorMessage?: string | null;
  readonly hasMore?: boolean;
}

export interface FastAccessResultPresentationSnapshot {
  readonly status: FastAccessResultPresentationStatus;
  readonly totalRows: number;
  readonly visibleRows: number;
  readonly activeIndex: number | null;
  readonly activePosition: number | null;
  readonly filterText: string;
  readonly collectionLabel: string;
  readonly hasMore: boolean;
  readonly ariaBusy: boolean;
  readonly countSummary: string;
  readonly surfaceSummary: string;
  readonly emptySummary: string | null;
  readonly errorSummary: string | null;
  readonly filterSummary: string | null;
}

export interface FastAccessResultAnnouncement {
  readonly mode: 'off' | 'polite' | 'assertive';
  readonly atomic: boolean;
  readonly message: string;
}

export interface FastAccessResultRowPresentation {
  readonly position: number;
  readonly setSize: number;
  readonly positionLabel: string;
  readonly accessibleLabel: string;
}

const MAX_COLLECTION_ROWS = 10_000;
const MAX_FILTER_TEXT = 100;
const MAX_ERROR_TEXT = 180;
const MAX_COLLECTION_LABEL = 120;
const MAX_ROW_LABEL = 180;

const clampInteger = (value: number, minimum: number, maximum: number): number => {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
};

const isControlCode = (codePoint: number): boolean => codePoint < 32 || codePoint === 127;

const sanitizeText = (value: unknown, maxLength: number): string => {
  if (typeof value !== 'string') return '';
  let safe = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    safe += codePoint !== undefined && isControlCode(codePoint) ? ' ' : character;
  }
  return safe.replace(/\s+/gu, ' ').trim().slice(0, maxLength);
};

const deriveStatus = (
  loading: boolean,
  errorMessage: string,
  totalRows: number,
): FastAccessResultPresentationStatus => {
  if (loading) return 'loading';
  if (errorMessage) return 'error';
  return totalRows === 0 ? 'empty' : 'ready';
};

const createCountSummary = (
  totalRows: number,
  visibleRows: number,
  hasMore: boolean,
): string => {
  if (totalRows === 0) return 'Sonuç bulunamadı.';
  if (visibleRows < totalRows || hasMore) {
    return `${visibleRows} / ${totalRows} sonuç gösteriliyor.`;
  }
  return `${totalRows} sonuç gösteriliyor.`;
};

const createFilterSummary = (filterText: string, totalRows: number): string | null => {
  if (!filterText) return null;
  if (totalRows === 0) return `“${filterText}” filtresiyle eşleşen sonuç bulunamadı.`;
  return `“${filterText}” filtresi etkin.`;
};

const createSurfaceSummary = (
  status: FastAccessResultPresentationStatus,
  countSummary: string,
  filterSummary: string | null,
  errorSummary: string | null,
): string => {
  if (status === 'loading') return 'Sonuçlar ve harita katmanı yükleniyor.';
  if (status === 'error') return errorSummary ?? 'Sonuçlar yüklenemedi.';
  if (status === 'empty') return filterSummary ?? 'Bu görünümde sonuç bulunamadı.';
  return [countSummary, filterSummary].filter(Boolean).join(' ');
};

export const createFastAccessResultPresentationSnapshot = (
  input: FastAccessResultPresentationInput,
): FastAccessResultPresentationSnapshot => {
  const totalRows = clampInteger(input.totalRows, 0, MAX_COLLECTION_ROWS);
  const visibleRows = clampInteger(input.visibleRows, 0, totalRows);
  const filterText = sanitizeText(input.filterText ?? '', MAX_FILTER_TEXT);
  const collectionLabel = sanitizeText(
    input.collectionLabel ?? 'Kent rehberi sonuçları',
    MAX_COLLECTION_LABEL,
  ) || 'Kent rehberi sonuçları';
  const errorSummary = sanitizeText(input.errorMessage ?? '', MAX_ERROR_TEXT) || null;
  const activeIndex = totalRows === 0 || input.activeIndex === null || input.activeIndex === undefined
    ? null
    : clampInteger(input.activeIndex, 0, Math.max(0, visibleRows - 1));
  const activePosition = activeIndex === null ? null : activeIndex + 1;
  const hasMore = Boolean(input.hasMore) || visibleRows < totalRows;
  const status = deriveStatus(Boolean(input.loading), errorSummary ?? '', totalRows);
  const countSummary = createCountSummary(totalRows, visibleRows, hasMore);
  const filterSummary = createFilterSummary(filterText, totalRows);
  const emptySummary = status === 'empty'
    ? filterSummary ?? 'Bu görünümde sonuç bulunamadı.'
    : null;

  return Object.freeze({
    status,
    totalRows,
    visibleRows,
    activeIndex,
    activePosition,
    filterText,
    collectionLabel,
    hasMore,
    ariaBusy: status === 'loading',
    countSummary,
    surfaceSummary: createSurfaceSummary(status, countSummary, filterSummary, errorSummary),
    emptySummary,
    errorSummary,
    filterSummary,
  });
};

export const createFastAccessResultAnnouncement = (
  snapshot: FastAccessResultPresentationSnapshot,
  reason: FastAccessResultAnnouncementReason,
): FastAccessResultAnnouncement => {
  if (snapshot.status === 'error') {
    return Object.freeze({
      mode: 'assertive',
      atomic: true,
      message: snapshot.errorSummary ?? 'Sonuçlar yüklenemedi.',
    });
  }

  if (snapshot.status === 'loading') {
    return Object.freeze({
      mode: 'polite',
      atomic: true,
      message: 'Sonuçlar ve harita katmanı yükleniyor.',
    });
  }

  if (reason === 'focus') {
    if (snapshot.activePosition === null || snapshot.totalRows === 0) {
      return Object.freeze({ mode: 'off', atomic: false, message: '' });
    }
    return Object.freeze({
      mode: 'polite',
      atomic: false,
      message: `Sonuç ${snapshot.activePosition} / ${snapshot.totalRows}`,
    });
  }

  if (snapshot.status === 'empty') {
    return Object.freeze({
      mode: 'polite',
      atomic: true,
      message: snapshot.emptySummary ?? 'Bu görünümde sonuç bulunamadı.',
    });
  }

  switch (reason) {
    case 'filter':
      return Object.freeze({
        mode: 'polite',
        atomic: true,
        message: snapshot.filterSummary
          ? `${snapshot.filterSummary} ${snapshot.countSummary}`
          : snapshot.countSummary,
      });
    case 'page':
      return Object.freeze({
        mode: 'polite',
        atomic: true,
        message: snapshot.hasMore
          ? `${snapshot.visibleRows} sonuç görünür. Daha fazla sonuç yüklenebilir.`
          : snapshot.countSummary,
      });
    case 'refresh':
      return Object.freeze({
        mode: 'polite',
        atomic: true,
        message: `Sonuçlar güncellendi. ${snapshot.countSummary}`,
      });
    case 'error':
      return Object.freeze({ mode: 'off', atomic: true, message: '' });
    case 'initial':
    default:
      return Object.freeze({ mode: 'polite', atomic: true, message: snapshot.surfaceSummary });
  }
};

export const createFastAccessResultRowPresentation = (
  snapshot: FastAccessResultPresentationSnapshot,
  index: number,
  label: string,
): FastAccessResultRowPresentation | null => {
  if (snapshot.totalRows === 0 || snapshot.visibleRows === 0) return null;
  const normalizedIndex = clampInteger(index, 0, Math.max(0, snapshot.visibleRows - 1));
  const position = normalizedIndex + 1;
  const safeLabel = sanitizeText(label, MAX_ROW_LABEL) || `Sonuç ${position}`;
  const positionLabel = `Sonuç ${position} / ${snapshot.totalRows}`;
  return Object.freeze({
    position,
    setSize: snapshot.totalRows,
    positionLabel,
    accessibleLabel: `${positionLabel}. ${safeLabel}`,
  });
};

export const fastAccessResultPresentationBudget = Object.freeze({
  maxRows: MAX_COLLECTION_ROWS,
  maxFilterText: MAX_FILTER_TEXT,
  maxErrorText: MAX_ERROR_TEXT,
  maxCollectionLabel: MAX_COLLECTION_LABEL,
  maxRowLabel: MAX_ROW_LABEL,
});
