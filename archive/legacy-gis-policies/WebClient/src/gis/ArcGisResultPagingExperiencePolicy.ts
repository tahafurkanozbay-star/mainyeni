export type ResultPagingDirection = 'first' | 'previous' | 'next' | 'last';
export type ResultPagingStatus = 'idle' | 'loading' | 'ready' | 'error';
export type ResultPagingViewport = 'phone' | 'tablet' | 'desktop';

export interface ResultPagingSnapshot {
  readonly query?: string;
  readonly page?: number;
  readonly pageSize?: number;
  readonly totalCount?: number;
  readonly status?: ResultPagingStatus;
  readonly focusedObjectId?: string | number | null;
  readonly selectedObjectIds?: readonly (string | number)[];
  readonly filterRevision?: string | number | null;
  readonly sortRevision?: string | number | null;
  readonly viewportWidth?: number;
}

export interface ResultPagingModel {
  readonly query: string;
  readonly page: number;
  readonly pageSize: number;
  readonly pageCount: number;
  readonly totalCount: number;
  readonly firstItem: number;
  readonly lastItem: number;
  readonly hasPrevious: boolean;
  readonly hasNext: boolean;
  readonly status: ResultPagingStatus;
  readonly viewport: ResultPagingViewport;
  readonly visiblePages: readonly number[];
  readonly focusedObjectId: string | number | null;
  readonly selectedObjectIds: readonly (string | number)[];
  readonly summary: string;
  readonly announcement: string;
}

export interface ResultPagingTransition {
  readonly page: number;
  readonly pageSize: number;
  readonly shouldRequest: boolean;
  readonly shouldRestoreFocus: boolean;
  readonly shouldScrollToResults: boolean;
  readonly announcement: string;
}

export interface ResultPagingReconciliation {
  readonly page: number;
  readonly focusedObjectId: string | number | null;
  readonly selectedObjectIds: readonly (string | number)[];
  readonly resetReason: 'none' | 'query' | 'filter' | 'sort' | 'page-size' | 'out-of-range';
  readonly shouldScrollToResults: boolean;
  readonly announcement: string;
}

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 200;
const MAX_TOTAL_COUNT = Number.MAX_SAFE_INTEGER;
const MAX_QUERY_LENGTH = 160;
const MAX_SELECTION = 500;

const finiteInteger = (value: number | undefined, fallback: number): number =>
  Number.isFinite(value) ? Math.trunc(value as number) : fallback;

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const normalizeText = (value: unknown, maximum: number): string => {
  if (value === null || value === undefined) return '';
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length <= maximum ? text : `${text.slice(0, Math.max(0, maximum - 1)).trimEnd()}…`;
};

const stableId = (value: string | number): string => `${typeof value}:${String(value)}`;

const normalizeSelection = (values: readonly (string | number)[] | undefined): readonly (string | number)[] => {
  if (!values?.length) return Object.freeze([]);
  const seen = new Set<string>();
  const result: (string | number)[] = [];
  for (const value of values) {
    if (typeof value === 'number' && !Number.isFinite(value)) continue;
    const key = stableId(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
    if (result.length >= MAX_SELECTION) break;
  }
  return Object.freeze(result);
};

const normalizeFocus = (value: string | number | null | undefined): string | number | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value;
};

export const resolveResultPagingViewport = (width: number | undefined): ResultPagingViewport => {
  if (!Number.isFinite(width)) return 'desktop';
  if ((width as number) < 640) return 'phone';
  if ((width as number) < 1024) return 'tablet';
  return 'desktop';
};

export const resolveVisibleResultPages = (
  page: number,
  pageCount: number,
  viewport: ResultPagingViewport,
): readonly number[] => {
  const safeCount = clamp(finiteInteger(pageCount, 1), 1, MAX_TOTAL_COUNT);
  const safePage = clamp(finiteInteger(page, 1), 1, safeCount);
  const radius = viewport === 'phone' ? 1 : viewport === 'tablet' ? 2 : 3;
  const desired = (radius * 2) + 1;
  let start = Math.max(1, safePage - radius);
  let end = Math.min(safeCount, safePage + radius);
  if (end - start + 1 < desired) {
    if (start === 1) end = Math.min(safeCount, desired);
    else if (end === safeCount) start = Math.max(1, safeCount - desired + 1);
  }
  return Object.freeze(Array.from({ length: end - start + 1 }, (_, index) => start + index));
};

const buildAnnouncement = (
  status: ResultPagingStatus,
  page: number,
  pageCount: number,
  totalCount: number,
  query: string,
): string => {
  if (status === 'loading') return query
    ? `${query} için ${page}. sayfa yükleniyor.`
    : `${page}. sayfa yükleniyor.`;
  if (status === 'error') return `${page}. sayfa yüklenemedi. Mevcut sonuçlar korunuyor.`;
  if (totalCount === 0) return query ? `${query} için sonuç bulunamadı.` : 'Sonuç bulunamadı.';
  return `${page}. sayfa gösteriliyor. Toplam ${pageCount} sayfa ve ${totalCount} sonuç.`;
};

export const createResultPagingModel = (snapshot: ResultPagingSnapshot): ResultPagingModel => {
  const query = normalizeText(snapshot.query, MAX_QUERY_LENGTH);
  const pageSize = clamp(finiteInteger(snapshot.pageSize, DEFAULT_PAGE_SIZE), 1, MAX_PAGE_SIZE);
  const totalCount = clamp(finiteInteger(snapshot.totalCount, 0), 0, MAX_TOTAL_COUNT);
  const pageCount = Math.max(1, Math.ceil(totalCount / pageSize));
  const page = clamp(finiteInteger(snapshot.page, 1), 1, pageCount);
  const firstItem = totalCount === 0 ? 0 : ((page - 1) * pageSize) + 1;
  const lastItem = totalCount === 0 ? 0 : Math.min(totalCount, page * pageSize);
  const status: ResultPagingStatus = snapshot.status === 'loading' || snapshot.status === 'error' || snapshot.status === 'ready'
    ? snapshot.status
    : 'idle';
  const viewport = resolveResultPagingViewport(snapshot.viewportWidth);
  return Object.freeze({
    query,
    page,
    pageSize,
    pageCount,
    totalCount,
    firstItem,
    lastItem,
    hasPrevious: page > 1,
    hasNext: page < pageCount,
    status,
    viewport,
    visiblePages: resolveVisibleResultPages(page, pageCount, viewport),
    focusedObjectId: normalizeFocus(snapshot.focusedObjectId),
    selectedObjectIds: normalizeSelection(snapshot.selectedObjectIds),
    summary: totalCount === 0 ? 'Sonuç yok' : `${firstItem}–${lastItem} / ${totalCount}`,
    announcement: buildAnnouncement(status, page, pageCount, totalCount, query),
  });
};

export const resolveResultPagingTransition = (
  model: ResultPagingModel,
  direction: ResultPagingDirection,
): ResultPagingTransition => {
  let target = model.page;
  if (direction === 'first') target = 1;
  if (direction === 'previous') target = Math.max(1, model.page - 1);
  if (direction === 'next') target = Math.min(model.pageCount, model.page + 1);
  if (direction === 'last') target = model.pageCount;
  const changed = target !== model.page;
  const blocked = model.status === 'loading';
  return Object.freeze({
    page: target,
    pageSize: model.pageSize,
    shouldRequest: changed && !blocked,
    shouldRestoreFocus: changed && !blocked,
    shouldScrollToResults: changed && !blocked,
    announcement: blocked
      ? 'Sonuçlar yüklenirken sayfa değiştirilemez.'
      : changed
        ? `${target}. sayfaya geçiliyor.`
        : direction === 'previous' || direction === 'first'
          ? 'İlk sayfadasınız.'
          : 'Son sayfadasınız.',
  });
};

export const resolveResultPagingKeyboard = (
  key: string,
  model: ResultPagingModel,
  altKey = false,
): ResultPagingTransition | null => {
  if (key === 'PageUp' && altKey) return resolveResultPagingTransition(model, 'previous');
  if (key === 'PageDown' && altKey) return resolveResultPagingTransition(model, 'next');
  if (key === 'Home' && altKey) return resolveResultPagingTransition(model, 'first');
  if (key === 'End' && altKey) return resolveResultPagingTransition(model, 'last');
  return null;
};

const revisionsDiffer = (left: string | number | null | undefined, right: string | number | null | undefined): boolean =>
  (left ?? null) !== (right ?? null);

export const reconcileResultPaging = (
  previous: ResultPagingSnapshot,
  next: ResultPagingSnapshot,
): ResultPagingReconciliation => {
  const previousModel = createResultPagingModel(previous);
  const nextModel = createResultPagingModel(next);
  const queryChanged = previousModel.query !== nextModel.query;
  const filterChanged = revisionsDiffer(previous.filterRevision, next.filterRevision);
  const sortChanged = revisionsDiffer(previous.sortRevision, next.sortRevision);
  const pageSizeChanged = previousModel.pageSize !== nextModel.pageSize;
  let resetReason: ResultPagingReconciliation['resetReason'] = 'none';
  if (queryChanged) resetReason = 'query';
  else if (filterChanged) resetReason = 'filter';
  else if (sortChanged) resetReason = 'sort';
  else if (pageSizeChanged) resetReason = 'page-size';
  else if (finiteInteger(next.page, 1) > nextModel.pageCount) resetReason = 'out-of-range';

  const resetToFirst = resetReason === 'query' || resetReason === 'filter' || resetReason === 'sort' || resetReason === 'page-size';
  const page = resetToFirst ? 1 : nextModel.page;
  const preserveInteraction = resetReason === 'none';
  const selectedObjectIds = preserveInteraction
    ? nextModel.selectedObjectIds
    : Object.freeze([] as (string | number)[]);
  const focusedObjectId = preserveInteraction ? nextModel.focusedObjectId : null;
  const reasonCopy: Record<ResultPagingReconciliation['resetReason'], string> = {
    none: `Sayfa ${page} korunuyor.`,
    query: 'Arama değişti. Sonuçlar ilk sayfadan gösterilecek.',
    filter: 'Filtreler değişti. Sonuçlar ilk sayfadan gösterilecek.',
    sort: 'Sıralama değişti. Sonuçlar ilk sayfadan gösterilecek.',
    'page-size': 'Sayfa boyutu değişti. Sonuçlar ilk sayfadan gösterilecek.',
    'out-of-range': `İstenen sayfa artık mevcut değil. ${page}. sayfa gösterilecek.`,
  };
  return Object.freeze({
    page,
    focusedObjectId,
    selectedObjectIds,
    resetReason,
    shouldScrollToResults: resetReason !== 'none',
    announcement: reasonCopy[resetReason],
  });
};

export const resolveResultPagingFocusTarget = (
  requestedObjectId: string | number | null | undefined,
  visibleObjectIds: readonly (string | number)[],
): string | number | null => {
  const requested = normalizeFocus(requestedObjectId);
  if (requested !== null) {
    const key = stableId(requested);
    const match = visibleObjectIds.find((candidate) => stableId(candidate) === key);
    if (match !== undefined) return match;
  }
  return visibleObjectIds.length > 0 ? visibleObjectIds[0] : null;
};

export const resolveResultPagingPageForIndex = (
  absoluteIndex: number,
  pageSize: number,
  totalCount: number,
): number => {
  const safeTotal = clamp(finiteInteger(totalCount, 0), 0, MAX_TOTAL_COUNT);
  const safeSize = clamp(finiteInteger(pageSize, DEFAULT_PAGE_SIZE), 1, MAX_PAGE_SIZE);
  if (safeTotal === 0) return 1;
  const safeIndex = clamp(finiteInteger(absoluteIndex, 0), 0, safeTotal - 1);
  return Math.floor(safeIndex / safeSize) + 1;
};
