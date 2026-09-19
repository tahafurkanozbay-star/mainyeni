export type QueryResultNavigationKey =
  | 'ArrowDown'
  | 'ArrowUp'
  | 'Home'
  | 'End'
  | 'PageDown'
  | 'PageUp';

export type QueryResultActivationKey = 'Enter' | ' ';

export interface QueryResultInteractionItem {
  readonly key: string;
  readonly disabled?: boolean;
}

export interface QueryResultInteractionState {
  readonly activeIndex: number;
  readonly activeKey: string | null;
  readonly count: number;
  readonly enabledCount: number;
}

export interface QueryResultNavigationOptions {
  readonly pageSize?: number;
  readonly wrap?: boolean;
}

export interface QueryResultAnnouncementInput {
  readonly query?: string;
  readonly totalCount: number;
  readonly visibleCount: number;
  readonly categoryCount?: number;
  readonly loading?: boolean;
  readonly error?: boolean;
}

export interface QueryResultSelectionAnnouncementInput {
  readonly title: string;
  readonly position: number;
  readonly totalCount: number;
  readonly category?: string;
}

export interface QueryResultFocusRequest {
  readonly index: number;
  readonly key: string;
  readonly optionId: string;
}

const DEFAULT_PAGE_SIZE = 8;

const clampInteger = (value: unknown, minimum: number, maximum: number): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.trunc(numeric)));
};

const normalizeText = (value: unknown): string => String(value ?? '')
  .replace(/\s+/g, ' ')
  .trim();

const isEnabled = (item: QueryResultInteractionItem | undefined): boolean =>
  Boolean(item && !item.disabled);

export const normalizeResultOwnerId = (value: unknown): string => {
  const normalized = normalizeText(value)
    .toLocaleLowerCase('tr-TR')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'query-results';
};

export const normalizeResultKeyForId = (value: unknown): string => {
  const normalized = normalizeText(value)
    .toLocaleLowerCase('tr-TR')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'item';
};

export const createQueryResultOptionId = (
  ownerId: unknown,
  itemKey: unknown,
  index: number,
): string => `${normalizeResultOwnerId(ownerId)}-option-${normalizeResultKeyForId(itemKey)}-${Math.max(0, Math.trunc(index))}`;

export const findFirstEnabledIndex = (
  items: readonly QueryResultInteractionItem[],
): number => items.findIndex(isEnabled);

export const findLastEnabledIndex = (
  items: readonly QueryResultInteractionItem[],
): number => {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (isEnabled(items[index])) return index;
  }
  return -1;
};

export const findEnabledIndexFrom = (
  items: readonly QueryResultInteractionItem[],
  startIndex: number,
  direction: 1 | -1,
  wrap = false,
): number => {
  if (items.length === 0) return -1;
  const start = clampInteger(startIndex, 0, items.length - 1);
  let index = start;
  let visited = 0;

  while (visited < items.length) {
    index += direction;
    if (index < 0 || index >= items.length) {
      if (!wrap) return -1;
      index = direction > 0 ? 0 : items.length - 1;
    }
    if (isEnabled(items[index])) return index;
    visited += 1;
  }

  return -1;
};

export const normalizeQueryResultActiveIndex = (
  items: readonly QueryResultInteractionItem[],
  activeIndex: unknown,
): number => {
  if (items.length === 0) return -1;
  const numeric = Number(activeIndex);
  if (Number.isFinite(numeric)) {
    const candidate = clampInteger(numeric, 0, items.length - 1);
    if (isEnabled(items[candidate])) return candidate;
    const next = findEnabledIndexFrom(items, candidate, 1, false);
    if (next >= 0) return next;
    const previous = findEnabledIndexFrom(items, candidate, -1, false);
    if (previous >= 0) return previous;
  }
  return findFirstEnabledIndex(items);
};

export const createQueryResultInteractionState = (
  items: readonly QueryResultInteractionItem[],
  activeIndex: unknown = 0,
): QueryResultInteractionState => {
  const normalizedIndex = normalizeQueryResultActiveIndex(items, activeIndex);
  return Object.freeze({
    activeIndex: normalizedIndex,
    activeKey: normalizedIndex >= 0 ? items[normalizedIndex]?.key ?? null : null,
    count: items.length,
    enabledCount: items.reduce((count, item) => count + (item.disabled ? 0 : 1), 0),
  });
};

export const reconcileQueryResultInteractionState = (
  previous: QueryResultInteractionState | null | undefined,
  items: readonly QueryResultInteractionItem[],
): QueryResultInteractionState => {
  if (items.length === 0) return createQueryResultInteractionState(items, -1);
  if (previous?.activeKey) {
    const retainedIndex = items.findIndex(
      (item) => item.key === previous.activeKey && !item.disabled,
    );
    if (retainedIndex >= 0) return createQueryResultInteractionState(items, retainedIndex);
  }
  return createQueryResultInteractionState(items, previous?.activeIndex ?? 0);
};

const moveByPage = (
  items: readonly QueryResultInteractionItem[],
  currentIndex: number,
  direction: 1 | -1,
  pageSize: number,
): number => {
  if (items.length === 0) return -1;
  const target = clampInteger(
    currentIndex + (direction * pageSize),
    0,
    items.length - 1,
  );
  if (isEnabled(items[target])) return target;

  const directional = findEnabledIndexFrom(items, target, direction, false);
  if (directional >= 0) return directional;
  const opposite = findEnabledIndexFrom(items, target, direction === 1 ? -1 : 1, false);
  return opposite >= 0 ? opposite : currentIndex;
};

export const moveQueryResultActiveIndex = (
  items: readonly QueryResultInteractionItem[],
  activeIndex: unknown,
  key: QueryResultNavigationKey,
  options: QueryResultNavigationOptions = {},
): number => {
  if (items.length === 0) return -1;
  const current = normalizeQueryResultActiveIndex(items, activeIndex);
  if (key === 'Home') return findFirstEnabledIndex(items);
  if (key === 'End') return findLastEnabledIndex(items);

  const wrap = options.wrap ?? false;
  if (key === 'ArrowDown') {
    const next = findEnabledIndexFrom(items, current, 1, wrap);
    return next >= 0 ? next : current;
  }
  if (key === 'ArrowUp') {
    const previous = findEnabledIndexFrom(items, current, -1, wrap);
    return previous >= 0 ? previous : current;
  }

  const pageSize = clampInteger(options.pageSize ?? DEFAULT_PAGE_SIZE, 1, 100);
  return moveByPage(items, current, key === 'PageDown' ? 1 : -1, pageSize);
};

export const isQueryResultNavigationKey = (
  key: string,
): key is QueryResultNavigationKey => (
  key === 'ArrowDown'
  || key === 'ArrowUp'
  || key === 'Home'
  || key === 'End'
  || key === 'PageDown'
  || key === 'PageUp'
);

export const isQueryResultActivationKey = (
  key: string,
): key is QueryResultActivationKey => key === 'Enter' || key === ' ';

export const createQueryResultFocusRequest = (
  ownerId: unknown,
  items: readonly QueryResultInteractionItem[],
  index: unknown,
): QueryResultFocusRequest | null => {
  const normalizedIndex = normalizeQueryResultActiveIndex(items, index);
  const item = items[normalizedIndex];
  if (normalizedIndex < 0 || !item) return null;
  return Object.freeze({
    index: normalizedIndex,
    key: item.key,
    optionId: createQueryResultOptionId(ownerId, item.key, normalizedIndex),
  });
};

export const createQueryResultSetSize = (
  items: readonly QueryResultInteractionItem[],
): number => items.reduce((count, item) => count + (item.disabled ? 0 : 1), 0);

export const createQueryResultPositionInSet = (
  items: readonly QueryResultInteractionItem[],
  index: number,
): number => {
  if (!isEnabled(items[index])) return 0;
  let position = 0;
  for (let cursor = 0; cursor <= index; cursor += 1) {
    if (isEnabled(items[cursor])) position += 1;
  }
  return position;
};

export const createQueryResultAnnouncement = (
  input: QueryResultAnnouncementInput,
): string => {
  if (input.loading) return 'Arama sonuçları yükleniyor.';
  if (input.error) return 'Arama sonuçları yüklenemedi. Lütfen yeniden deneyin.';

  const totalCount = Math.max(0, Math.trunc(input.totalCount));
  const visibleCount = Math.max(0, Math.min(totalCount, Math.trunc(input.visibleCount)));
  const categoryCount = Math.max(0, Math.trunc(input.categoryCount ?? 0));
  const query = normalizeText(input.query);

  if (totalCount === 0) {
    return query
      ? `“${query}” için sonuç bulunamadı.`
      : 'Gösterilecek arama sonucu bulunamadı.';
  }

  const queryPrefix = query ? `“${query}” için ` : '';
  const visibility = visibleCount < totalCount
    ? `${totalCount} sonuçtan ${visibleCount} tanesi gösteriliyor.`
    : `${totalCount} sonuç gösteriliyor.`;
  const categories = categoryCount > 0
    ? ` ${categoryCount} kategori bulundu.`
    : '';
  return `${queryPrefix}${visibility}${categories}`;
};

export const createQueryResultSelectionAnnouncement = (
  input: QueryResultSelectionAnnouncementInput,
): string => {
  const title = normalizeText(input.title) || 'İsimsiz sonuç';
  const total = Math.max(1, Math.trunc(input.totalCount));
  const position = clampInteger(input.position, 1, total);
  const category = normalizeText(input.category);
  return category
    ? `${title}, ${category}, ${position}/${total}.`
    : `${title}, ${position}/${total}.`;
};

export const shouldAnnounceQueryResultChange = (
  previous: QueryResultAnnouncementInput | null | undefined,
  next: QueryResultAnnouncementInput,
): boolean => {
  if (!previous) return true;
  return normalizeText(previous.query) !== normalizeText(next.query)
    || previous.totalCount !== next.totalCount
    || previous.visibleCount !== next.visibleCount
    || previous.categoryCount !== next.categoryCount
    || previous.loading !== next.loading
    || previous.error !== next.error;
};

export const createQueryResultTabIndex = (
  activeIndex: number,
  itemIndex: number,
  disabled = false,
): 0 | -1 => (!disabled && activeIndex === itemIndex ? 0 : -1);

export const shouldScrollQueryResultIntoView = (
  containerTop: number,
  containerBottom: number,
  itemTop: number,
  itemBottom: number,
): boolean => itemTop < containerTop || itemBottom > containerBottom;

export const getQueryResultScrollAlignment = (
  containerTop: number,
  containerBottom: number,
  itemTop: number,
  itemBottom: number,
): ScrollLogicalPosition => {
  if (itemTop < containerTop) return 'start';
  if (itemBottom > containerBottom) return 'end';
  return 'nearest';
};

export const getQueryResultTouchTargetClassName = (
  compact: boolean,
): string => compact
  ? 'min-h-11 min-w-11'
  : 'min-h-12 min-w-12';

export const getQueryResultMotionBehavior = (
  prefersReducedMotion: boolean,
): ScrollBehavior => prefersReducedMotion ? 'auto' : 'smooth';

export const createQueryResultListboxAria = (
  label: string,
  activeDescendant?: string | null,
): Readonly<{
  role: 'listbox';
  'aria-label': string;
  'aria-activedescendant'?: string;
}> => Object.freeze({
  role: 'listbox' as const,
  'aria-label': normalizeText(label) || 'Arama sonuçları',
  ...(activeDescendant ? { 'aria-activedescendant': activeDescendant } : {}),
});

export const createQueryResultOptionAria = (
  selected: boolean,
  position: number,
  setSize: number,
  disabled = false,
): Readonly<{
  role: 'option';
  'aria-selected': boolean;
  'aria-disabled'?: true;
  'aria-posinset': number;
  'aria-setsize': number;
}> => Object.freeze({
  role: 'option' as const,
  'aria-selected': selected,
  ...(disabled ? { 'aria-disabled': true as const } : {}),
  'aria-posinset': Math.max(1, Math.trunc(position)),
  'aria-setsize': Math.max(1, Math.trunc(setSize)),
});
