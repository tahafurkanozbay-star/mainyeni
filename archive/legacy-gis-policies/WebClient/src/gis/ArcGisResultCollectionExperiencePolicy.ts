export type ResultCollectionViewport = 'phone' | 'tablet' | 'desktop';
export type ResultCollectionDensity = 'comfortable' | 'compact';
export type ResultCollectionFilterKind = 'single' | 'multiple';

export interface ResultCollectionFacetValue {
  readonly value: string;
  readonly label: string;
  readonly count: number;
  readonly selected?: boolean;
  readonly disabled?: boolean;
}

export interface ResultCollectionFacet {
  readonly id: string;
  readonly label: string;
  readonly kind: ResultCollectionFilterKind;
  readonly values: readonly ResultCollectionFacetValue[];
  readonly expanded?: boolean;
}

export interface ResultCollectionInput {
  readonly totalCount: number;
  readonly visibleCount: number;
  readonly activeFilterCount?: number;
  readonly facets?: readonly ResultCollectionFacet[];
  readonly viewportWidth?: number;
  readonly viewportHeight?: number;
  readonly rowHeight?: number;
  readonly density?: ResultCollectionDensity;
  readonly focusedIndex?: number | null;
  readonly selectedIndices?: readonly number[];
  readonly query?: string;
  readonly filterPanelOpen?: boolean;
}

export interface ResultCollectionFacetValueModel {
  readonly value: string;
  readonly label: string;
  readonly count: number;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly accessibleName: string;
}

export interface ResultCollectionFacetModel {
  readonly id: string;
  readonly label: string;
  readonly kind: ResultCollectionFilterKind;
  readonly expanded: boolean;
  readonly selectedCount: number;
  readonly values: readonly ResultCollectionFacetValueModel[];
  readonly summary: string;
}

export interface ResultCollectionWindow {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly overscanStartIndex: number;
  readonly overscanEndIndex: number;
  readonly renderedCount: number;
  readonly topSpacer: number;
  readonly bottomSpacer: number;
}

export interface ResultCollectionExperienceModel {
  readonly viewport: ResultCollectionViewport;
  readonly density: ResultCollectionDensity;
  readonly totalCount: number;
  readonly visibleCount: number;
  readonly activeFilterCount: number;
  readonly facets: readonly ResultCollectionFacetModel[];
  readonly filterPanelMode: 'inline' | 'drawer';
  readonly filterPanelOpen: boolean;
  readonly filterButtonLabel: string;
  readonly resultSummary: string;
  readonly selectionSummary: string;
  readonly focusedIndex: number | null;
  readonly selectedIndices: readonly number[];
  readonly rowHeight: number;
  readonly window: ResultCollectionWindow;
}

export interface ResultCollectionKeyboardInput {
  readonly key: string;
  readonly currentIndex: number | null;
  readonly rowCount: number;
  readonly pageSize: number;
  readonly shiftKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
}

export interface ResultCollectionKeyboardResolution {
  readonly handled: boolean;
  readonly nextIndex: number | null;
  readonly selectionMode: 'preserve' | 'replace' | 'extend' | 'toggle';
  readonly action: 'focus' | 'activate' | 'clear' | 'none';
}

const MAX_RESULTS = 1_000_000;
const MAX_FACETS = 24;
const MAX_VALUES_PER_FACET = 100;
const MAX_LABEL = 120;
const MIN_ROW_HEIGHT = 36;
const MAX_ROW_HEIGHT = 96;
const DEFAULT_COMFORTABLE_ROW_HEIGHT = 56;
const DEFAULT_COMPACT_ROW_HEIGHT = 44;
const DEFAULT_VIEWPORT_HEIGHT = 720;
const DEFAULT_OVERSCAN = 5;

const clamp = (value: number, minimum: number, maximum: number): number => Math.min(maximum, Math.max(minimum, value));
const integer = (value: number | undefined, fallback: number): number => Number.isFinite(value) ? Math.trunc(value as number) : fallback;
const boundedCount = (value: number | undefined): number => clamp(integer(value, 0), 0, MAX_RESULTS);
const cleanText = (value: unknown, maximum = MAX_LABEL): string => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length <= maximum ? text : `${text.slice(0, Math.max(0, maximum - 1)).trimEnd()}…`;
};

export const resolveResultCollectionViewport = (width: number | undefined): ResultCollectionViewport => {
  const safeWidth = clamp(integer(width, 1280), 240, 10_000);
  if (safeWidth < 640) return 'phone';
  if (safeWidth < 1024) return 'tablet';
  return 'desktop';
};

const normalizeFacetValue = (value: ResultCollectionFacetValue): ResultCollectionFacetValueModel | null => {
  const id = cleanText(value.value, 160);
  const label = cleanText(value.label);
  if (!id || !label) return null;
  const count = boundedCount(value.count);
  const selected = value.selected === true;
  const disabled = value.disabled === true || (count === 0 && !selected);
  return Object.freeze({
    value: id,
    label,
    count,
    selected,
    disabled,
    accessibleName: `${label}, ${count} sonuç${selected ? ', seçili' : ''}${disabled ? ', kullanılamıyor' : ''}`,
  });
};

const normalizeFacet = (facet: ResultCollectionFacet): ResultCollectionFacetModel | null => {
  const id = cleanText(facet.id, 80);
  const label = cleanText(facet.label);
  if (!id || !label) return null;
  const seen = new Set<string>();
  const values: ResultCollectionFacetValueModel[] = [];
  for (const candidate of facet.values.slice(0, MAX_VALUES_PER_FACET)) {
    const normalized = normalizeFacetValue(candidate);
    if (!normalized || seen.has(normalized.value)) continue;
    seen.add(normalized.value);
    values.push(normalized);
  }
  const selectedCount = values.filter((value) => value.selected).length;
  return Object.freeze({
    id,
    label,
    kind: facet.kind === 'single' ? 'single' : 'multiple',
    expanded: facet.expanded === true || selectedCount > 0,
    selectedCount,
    values: Object.freeze(values),
    summary: selectedCount > 0 ? `${label}: ${selectedCount} filtre etkin` : `${label}: filtre yok`,
  });
};

export const normalizeResultCollectionFacets = (facets: readonly ResultCollectionFacet[] | undefined): readonly ResultCollectionFacetModel[] => {
  const seen = new Set<string>();
  const normalized: ResultCollectionFacetModel[] = [];
  for (const facet of (facets ?? []).slice(0, MAX_FACETS)) {
    const model = normalizeFacet(facet);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    normalized.push(model);
  }
  return Object.freeze(normalized);
};

export const resolveResultCollectionRowHeight = (
  density: ResultCollectionDensity | undefined,
  requestedHeight: number | undefined,
): number => {
  const fallback = density === 'compact' ? DEFAULT_COMPACT_ROW_HEIGHT : DEFAULT_COMFORTABLE_ROW_HEIGHT;
  return clamp(integer(requestedHeight, fallback), MIN_ROW_HEIGHT, MAX_ROW_HEIGHT);
};

export const createResultCollectionWindow = (
  totalCount: number,
  scrollOffset: number,
  viewportHeight: number,
  rowHeight: number,
  overscan = DEFAULT_OVERSCAN,
): ResultCollectionWindow => {
  const total = boundedCount(totalCount);
  const height = clamp(integer(rowHeight, DEFAULT_COMFORTABLE_ROW_HEIGHT), MIN_ROW_HEIGHT, MAX_ROW_HEIGHT);
  const viewport = clamp(integer(viewportHeight, DEFAULT_VIEWPORT_HEIGHT), height, 10_000);
  const offset = clamp(Number.isFinite(scrollOffset) ? scrollOffset : 0, 0, Math.max(0, total * height - viewport));
  const safeOverscan = clamp(integer(overscan, DEFAULT_OVERSCAN), 0, 50);
  if (total === 0) {
    return Object.freeze({ startIndex: 0, endIndex: -1, overscanStartIndex: 0, overscanEndIndex: -1, renderedCount: 0, topSpacer: 0, bottomSpacer: 0 });
  }
  const startIndex = clamp(Math.floor(offset / height), 0, total - 1);
  const visibleRows = Math.max(1, Math.ceil(viewport / height));
  const endIndex = clamp(startIndex + visibleRows - 1, startIndex, total - 1);
  const overscanStartIndex = Math.max(0, startIndex - safeOverscan);
  const overscanEndIndex = Math.min(total - 1, endIndex + safeOverscan);
  return Object.freeze({
    startIndex,
    endIndex,
    overscanStartIndex,
    overscanEndIndex,
    renderedCount: overscanEndIndex - overscanStartIndex + 1,
    topSpacer: overscanStartIndex * height,
    bottomSpacer: Math.max(0, (total - overscanEndIndex - 1) * height),
  });
};

const normalizeIndices = (indices: readonly number[] | undefined, totalCount: number): readonly number[] => {
  const seen = new Set<number>();
  const result: number[] = [];
  for (const value of indices ?? []) {
    if (!Number.isInteger(value) || value < 0 || value >= totalCount || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return Object.freeze(result.sort((left, right) => left - right));
};

const resolveFocusedIndex = (index: number | null | undefined, totalCount: number): number | null => {
  if (totalCount <= 0 || index === null || index === undefined || !Number.isInteger(index)) return null;
  return clamp(index, 0, totalCount - 1);
};

export const createResultCollectionExperienceModel = (input: ResultCollectionInput): ResultCollectionExperienceModel => {
  const totalCount = boundedCount(input.totalCount);
  const visibleCount = clamp(boundedCount(input.visibleCount), 0, totalCount);
  const facets = normalizeResultCollectionFacets(input.facets);
  const selectedFromFacets = facets.reduce((sum, facet) => sum + facet.selectedCount, 0);
  const activeFilterCount = clamp(integer(input.activeFilterCount, selectedFromFacets), 0, 999);
  const viewport = resolveResultCollectionViewport(input.viewportWidth);
  const density: ResultCollectionDensity = input.density === 'compact' ? 'compact' : 'comfortable';
  const rowHeight = resolveResultCollectionRowHeight(density, input.rowHeight);
  const selectedIndices = normalizeIndices(input.selectedIndices, totalCount);
  const focusedIndex = resolveFocusedIndex(input.focusedIndex, totalCount);
  const query = cleanText(input.query, 120);
  const filterPanelMode = viewport === 'desktop' ? 'inline' : 'drawer';
  const filterPanelOpen = input.filterPanelOpen === true && (facets.length > 0 || activeFilterCount > 0);
  const filterButtonLabel = activeFilterCount > 0 ? `Filtreler, ${activeFilterCount} etkin` : 'Filtreler';
  const resultSummary = query
    ? `“${query}” için ${visibleCount} / ${totalCount} sonuç gösteriliyor`
    : `${visibleCount} / ${totalCount} sonuç gösteriliyor`;
  const selectionSummary = selectedIndices.length === 0 ? 'Seçili sonuç yok' : `${selectedIndices.length} sonuç seçili`;
  const window = createResultCollectionWindow(totalCount, 0, input.viewportHeight ?? DEFAULT_VIEWPORT_HEIGHT, rowHeight);
  return Object.freeze({
    viewport,
    density,
    totalCount,
    visibleCount,
    activeFilterCount,
    facets,
    filterPanelMode,
    filterPanelOpen,
    filterButtonLabel,
    resultSummary,
    selectionSummary,
    focusedIndex,
    selectedIndices,
    rowHeight,
    window,
  });
};

export const resolveResultCollectionKeyboard = (input: ResultCollectionKeyboardInput): ResultCollectionKeyboardResolution => {
  const rowCount = boundedCount(input.rowCount);
  const pageSize = clamp(integer(input.pageSize, 10), 1, 200);
  const current = resolveFocusedIndex(input.currentIndex, rowCount);
  const modifier = input.ctrlKey === true || input.metaKey === true;
  const selectionMode = input.shiftKey ? 'extend' : modifier ? 'toggle' : 'replace';
  if (rowCount === 0) return Object.freeze({ handled: false, nextIndex: null, selectionMode: 'preserve', action: 'none' });
  const base = current ?? 0;
  if (input.key === 'ArrowDown') return Object.freeze({ handled: true, nextIndex: Math.min(rowCount - 1, base + 1), selectionMode, action: 'focus' });
  if (input.key === 'ArrowUp') return Object.freeze({ handled: true, nextIndex: Math.max(0, base - 1), selectionMode, action: 'focus' });
  if (input.key === 'Home') return Object.freeze({ handled: true, nextIndex: 0, selectionMode, action: 'focus' });
  if (input.key === 'End') return Object.freeze({ handled: true, nextIndex: rowCount - 1, selectionMode, action: 'focus' });
  if (input.key === 'PageDown') return Object.freeze({ handled: true, nextIndex: Math.min(rowCount - 1, base + pageSize), selectionMode, action: 'focus' });
  if (input.key === 'PageUp') return Object.freeze({ handled: true, nextIndex: Math.max(0, base - pageSize), selectionMode, action: 'focus' });
  if (input.key === 'Enter' || input.key === ' ') return Object.freeze({ handled: true, nextIndex: base, selectionMode, action: 'activate' });
  if (input.key === 'Escape') return Object.freeze({ handled: true, nextIndex: current, selectionMode: 'preserve', action: 'clear' });
  return Object.freeze({ handled: false, nextIndex: current, selectionMode: 'preserve', action: 'none' });
};

export const resolveResultCollectionScrollOffset = (
  targetIndex: number,
  currentOffset: number,
  viewportHeight: number,
  rowHeight: number,
  totalCount: number,
): number => {
  const total = boundedCount(totalCount);
  if (total === 0) return 0;
  const height = clamp(integer(rowHeight, DEFAULT_COMFORTABLE_ROW_HEIGHT), MIN_ROW_HEIGHT, MAX_ROW_HEIGHT);
  const viewport = clamp(integer(viewportHeight, DEFAULT_VIEWPORT_HEIGHT), height, 10_000);
  const target = clamp(integer(targetIndex, 0), 0, total - 1);
  const maxOffset = Math.max(0, total * height - viewport);
  const offset = clamp(Number.isFinite(currentOffset) ? currentOffset : 0, 0, maxOffset);
  const rowTop = target * height;
  const rowBottom = rowTop + height;
  if (rowTop < offset) return rowTop;
  if (rowBottom > offset + viewport) return clamp(rowBottom - viewport, 0, maxOffset);
  return offset;
};
