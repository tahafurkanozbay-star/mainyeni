export type ResultAccessibilityStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'error';
export type ResultAccessibilityReason =
  | 'initial-load'
  | 'refresh'
  | 'page-change'
  | 'filter-change'
  | 'sort-change'
  | 'selection-change'
  | 'focus-change'
  | 'error';
export type ResultAccessibilityLiveMode = 'off' | 'polite' | 'assertive';

export interface ResultAccessibilityInput {
  readonly totalCount?: number;
  readonly visibleCount?: number;
  readonly pageIndex?: number;
  readonly pageSize?: number;
  readonly selectedCount?: number;
  readonly focusedIndex?: number | null;
  readonly query?: string;
  readonly sortLabel?: string;
  readonly errorMessage?: string | null;
  readonly status?: ResultAccessibilityStatus;
  readonly multiSelectable?: boolean;
}

export interface ResultAccessibilitySnapshot {
  readonly totalCount: number;
  readonly visibleCount: number;
  readonly pageIndex: number;
  readonly pageSize: number;
  readonly pageCount: number;
  readonly currentPageNumber: number;
  readonly pageStartPosition: number;
  readonly pageEndPosition: number;
  readonly selectedCount: number;
  readonly focusedIndex: number | null;
  readonly focusedAbsolutePosition: number | null;
  readonly query: string;
  readonly sortLabel: string;
  readonly errorMessage: string | null;
  readonly status: ResultAccessibilityStatus;
  readonly ariaBusy: boolean;
  readonly ariaMultiSelectable: boolean;
  readonly collectionLabel: string;
  readonly countSummary: string;
  readonly pageSummary: string;
  readonly selectionSummary: string;
  readonly sortSummary: string;
  readonly emptySummary: string | null;
}

export interface ResultAccessibilityRowFacts {
  readonly id: string;
  readonly role: 'option';
  readonly ariaPosInSet: number;
  readonly ariaSetSize: number;
  readonly ariaSelected: boolean;
  readonly tabIndex: 0 | -1;
  readonly positionLabel: string;
  readonly describedBy: readonly string[];
}

export interface ResultAccessibilityAnnouncement {
  readonly mode: ResultAccessibilityLiveMode;
  readonly atomic: boolean;
  readonly message: string;
  readonly priority: number;
}

const MAX_TOTAL_COUNT = 1_000_000;
const MAX_PAGE_SIZE = 500;
const MAX_TEXT_LENGTH = 160;

const finiteInteger = (value: number | undefined, fallback: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value ?? fallback)));
};

const sanitizeText = (value: unknown, maxLength = MAX_TEXT_LENGTH): string => {
  if (typeof value !== 'string') return '';
  let result = '';
  let pendingSpace = false;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint < 32 || codePoint === 127) {
      pendingSpace = result.length > 0;
      continue;
    }
    if (/\s/u.test(character)) {
      pendingSpace = result.length > 0;
      continue;
    }
    if (pendingSpace && result.length < maxLength) result += ' ';
    pendingSpace = false;
    if (result.length >= maxLength) break;
    result += character;
  }
  return result.trim().slice(0, maxLength);
};

const normalizeStatus = (value: ResultAccessibilityStatus | undefined, totalCount: number): ResultAccessibilityStatus => {
  if (value === 'loading' || value === 'error' || value === 'idle') return value;
  if (value === 'empty') return 'empty';
  if (value === 'ready') return totalCount === 0 ? 'empty' : 'ready';
  return totalCount === 0 ? 'empty' : 'ready';
};

export const normalizeResultAccessibilitySnapshot = (input: ResultAccessibilityInput): ResultAccessibilitySnapshot => {
  const totalCount = finiteInteger(input.totalCount, 0, 0, MAX_TOTAL_COUNT);
  const visibleCount = finiteInteger(input.visibleCount, totalCount, 0, totalCount);
  const pageSize = finiteInteger(input.pageSize, Math.max(1, visibleCount || 20), 1, MAX_PAGE_SIZE);
  const pageCount = totalCount === 0 ? 0 : Math.max(1, Math.ceil(totalCount / pageSize));
  const pageIndex = pageCount === 0 ? 0 : finiteInteger(input.pageIndex, 0, 0, pageCount - 1);
  const currentPageNumber = pageCount === 0 ? 0 : pageIndex + 1;
  const pageStartPosition = totalCount === 0 ? 0 : pageIndex * pageSize + 1;
  const pageEndPosition = totalCount === 0 ? 0 : Math.min(totalCount, pageStartPosition + Math.max(0, visibleCount - 1));
  const selectedCount = finiteInteger(input.selectedCount, 0, 0, totalCount);
  const focusedLocalIndex = input.focusedIndex === null || input.focusedIndex === undefined
    ? null
    : finiteInteger(input.focusedIndex, 0, 0, Math.max(0, visibleCount - 1));
  const focusedAbsolutePosition = focusedLocalIndex === null || visibleCount === 0
    ? null
    : Math.min(totalCount, pageIndex * pageSize + focusedLocalIndex + 1);
  const query = sanitizeText(input.query, 100);
  const sortLabel = sanitizeText(input.sortLabel, 100);
  const errorMessage = sanitizeText(input.errorMessage, MAX_TEXT_LENGTH) || null;
  const status = normalizeStatus(input.status, totalCount);
  const countSummary = totalCount === 0
    ? 'Sonuç bulunamadı.'
    : visibleCount === totalCount
      ? `${totalCount} sonuç gösteriliyor.`
      : `${visibleCount} / ${totalCount} sonuç gösteriliyor.`;
  const pageSummary = pageCount <= 1
    ? countSummary
    : `Sayfa ${currentPageNumber} / ${pageCount}; ${pageStartPosition}-${pageEndPosition} arası sonuçlar.`;
  const selectionSummary = selectedCount === 0 ? 'Seçili sonuç yok.' : `${selectedCount} sonuç seçili.`;
  const sortSummary = sortLabel ? `Sıralama: ${sortLabel}.` : 'Varsayılan sıralama kullanılıyor.';
  const emptySummary = status === 'empty'
    ? query
      ? `“${query}” aramasıyla eşleşen sonuç bulunamadı.`
      : 'Bu görünümde sonuç bulunamadı.'
    : null;

  return Object.freeze({
    totalCount,
    visibleCount,
    pageIndex,
    pageSize,
    pageCount,
    currentPageNumber,
    pageStartPosition,
    pageEndPosition,
    selectedCount,
    focusedIndex: focusedLocalIndex,
    focusedAbsolutePosition,
    query,
    sortLabel,
    errorMessage,
    status,
    ariaBusy: status === 'loading',
    ariaMultiSelectable: input.multiSelectable !== false,
    collectionLabel: query ? `CBS sonuçları, arama: ${query}` : 'CBS sonuçları',
    countSummary,
    pageSummary,
    selectionSummary,
    sortSummary,
    emptySummary,
  });
};

export const createResultAccessibilityRowFacts = (
  snapshot: ResultAccessibilitySnapshot,
  localIndex: number,
  resultId: string,
  selected: boolean,
  descriptionIds: readonly string[] = [],
): ResultAccessibilityRowFacts | null => {
  if (snapshot.visibleCount === 0 || snapshot.totalCount === 0) return null;
  const index = finiteInteger(localIndex, 0, 0, Math.max(0, snapshot.visibleCount - 1));
  const absolutePosition = Math.min(snapshot.totalCount, snapshot.pageIndex * snapshot.pageSize + index + 1);
  const cleanId = sanitizeText(resultId, 120).replace(/\s+/gu, '-');
  if (!cleanId) return null;
  const describedBy = Object.freeze(descriptionIds.map((id) => sanitizeText(id, 120)).filter(Boolean));

  return Object.freeze({
    id: `result-option-${cleanId}`,
    role: 'option',
    ariaPosInSet: absolutePosition,
    ariaSetSize: snapshot.totalCount,
    ariaSelected: Boolean(selected),
    tabIndex: snapshot.focusedIndex === index ? 0 : -1,
    positionLabel: `Sonuç ${absolutePosition} / ${snapshot.totalCount}`,
    describedBy,
  });
};

const announcementForError = (snapshot: ResultAccessibilitySnapshot): ResultAccessibilityAnnouncement => Object.freeze({
  mode: 'assertive',
  atomic: true,
  priority: 100,
  message: snapshot.errorMessage ? `Sonuçlar yüklenemedi. ${snapshot.errorMessage}` : 'Sonuçlar yüklenemedi.',
});

export const createResultAccessibilityAnnouncement = (
  snapshot: ResultAccessibilitySnapshot,
  reason: ResultAccessibilityReason,
): ResultAccessibilityAnnouncement => {
  if (snapshot.status === 'error' || reason === 'error') return announcementForError(snapshot);
  if (snapshot.status === 'loading') {
    return Object.freeze({ mode: 'polite', atomic: true, priority: 30, message: 'Sonuçlar yükleniyor.' });
  }
  if (snapshot.status === 'empty') {
    return Object.freeze({ mode: 'polite', atomic: true, priority: 60, message: snapshot.emptySummary ?? 'Sonuç bulunamadı.' });
  }

  switch (reason) {
    case 'initial-load':
      return Object.freeze({ mode: 'polite', atomic: true, priority: 40, message: `${snapshot.countSummary} ${snapshot.sortSummary}` });
    case 'refresh':
      return Object.freeze({ mode: 'polite', atomic: true, priority: 45, message: `Sonuçlar güncellendi. ${snapshot.countSummary}` });
    case 'page-change':
      return Object.freeze({ mode: 'polite', atomic: true, priority: 55, message: snapshot.pageSummary });
    case 'filter-change':
      return Object.freeze({ mode: 'polite', atomic: true, priority: 55, message: `Filtreler uygulandı. ${snapshot.countSummary}` });
    case 'sort-change':
      return Object.freeze({ mode: 'polite', atomic: true, priority: 50, message: snapshot.sortSummary });
    case 'selection-change':
      return Object.freeze({ mode: 'polite', atomic: true, priority: 50, message: snapshot.selectionSummary });
    case 'focus-change':
      return Object.freeze({
        mode: snapshot.focusedAbsolutePosition === null ? 'off' : 'polite',
        atomic: false,
        priority: 20,
        message: snapshot.focusedAbsolutePosition === null
          ? ''
          : `Sonuç ${snapshot.focusedAbsolutePosition} / ${snapshot.totalCount}`,
      });
    case 'error':
      return announcementForError(snapshot);
  }
};

export const createResultCollectionAriaFacts = (snapshot: ResultAccessibilitySnapshot) => Object.freeze({
  role: 'listbox' as const,
  ariaLabel: snapshot.collectionLabel,
  ariaBusy: snapshot.ariaBusy,
  ariaMultiSelectable: snapshot.ariaMultiSelectable,
  ariaRowCount: snapshot.totalCount,
  setSize: snapshot.totalCount,
  status: snapshot.status,
  pageSummary: snapshot.pageSummary,
  selectionSummary: snapshot.selectionSummary,
});

export const createResultAccessibilityHints = (snapshot: ResultAccessibilitySnapshot) => Object.freeze({
  keyboard: snapshot.totalCount === 0
    ? 'Sonuç yok. Filtreleri veya arama ifadesini değiştirin.'
    : 'Yön tuşlarıyla sonuçlar arasında gezinin; Enter ile ayrıntıyı açın; Space ile seçimi değiştirin.',
  pagination: snapshot.pageCount > 1
    ? `Toplam ${snapshot.pageCount} sayfa. PageUp ve PageDown ile sayfa içi odağı taşıyabilirsiniz.`
    : 'Tüm sonuçlar tek sayfada.',
  selection: snapshot.ariaMultiSelectable
    ? 'Shift ile aralık seçimi, toplu seçim araçlarıyla görünür veya sayfadaki sonuçları seçme desteklenir.'
    : 'Bu görünüm tekli sonuç seçimi kullanır.',
});
