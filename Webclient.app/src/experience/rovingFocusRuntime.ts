export type RovingFocusOrientation = 'horizontal' | 'vertical' | 'both';
export type RovingFocusDirection = 'ltr' | 'rtl';

export interface RovingFocusItem {
  readonly id: string;
  readonly disabled?: boolean | undefined;
  readonly hidden?: boolean | undefined;
}

export interface RovingFocusOptions {
  readonly orientation?: RovingFocusOrientation;
  readonly direction?: RovingFocusDirection;
  readonly loop?: boolean;
}

export interface RovingFocusMove {
  readonly index: number;
  readonly id: string;
}

const DEFAULT_OPTIONS: Required<RovingFocusOptions> = {
  orientation: 'both',
  direction: 'ltr',
  loop: true,
};

const isAvailable = (
  item: RovingFocusItem | undefined,
): item is RovingFocusItem => Boolean(
  item && !item.disabled && !item.hidden && item.id.trim(),
);

export const getAvailableRovingIndices = (
  items: readonly RovingFocusItem[],
): number[] => items.reduce<number[]>((indices, item, index) => {
  if (isAvailable(item)) indices.push(index);
  return indices;
}, []);

export const getInitialRovingIndex = (
  items: readonly RovingFocusItem[],
  preferredIndex = 0,
): number => {
  if (isAvailable(items[preferredIndex])) return preferredIndex;
  const available = getAvailableRovingIndices(items);
  if (available.length === 0) return -1;
  const afterPreferred = available.find((index) => index > preferredIndex);
  if (afterPreferred !== undefined) return afterPreferred;

  for (let position = available.length - 1; position >= 0; position -= 1) {
    const candidate = available[position];
    if (candidate !== undefined && candidate < preferredIndex) return candidate;
  }

  return available[0] ?? -1;
};

const moveBy = (
  items: readonly RovingFocusItem[],
  currentIndex: number,
  delta: -1 | 1,
  loop: boolean,
): number => {
  const available = getAvailableRovingIndices(items);
  if (available.length === 0) return -1;

  const position = available.indexOf(currentIndex);
  if (position === -1) {
    return delta > 0
      ? available[0] ?? -1
      : available[available.length - 1] ?? -1;
  }

  const nextPosition = position + delta;
  if (nextPosition >= 0 && nextPosition < available.length) {
    return available[nextPosition] ?? currentIndex;
  }
  if (!loop) return currentIndex;
  return delta > 0
    ? available[0] ?? currentIndex
    : available[available.length - 1] ?? currentIndex;
};

const isPreviousKey = (
  key: string,
  orientation: RovingFocusOrientation,
  direction: RovingFocusDirection,
): boolean => {
  if ((orientation === 'vertical' || orientation === 'both') && key === 'ArrowUp') {
    return true;
  }
  if (orientation === 'horizontal' || orientation === 'both') {
    return direction === 'rtl' ? key === 'ArrowRight' : key === 'ArrowLeft';
  }
  return false;
};

const isNextKey = (
  key: string,
  orientation: RovingFocusOrientation,
  direction: RovingFocusDirection,
): boolean => {
  if ((orientation === 'vertical' || orientation === 'both') && key === 'ArrowDown') {
    return true;
  }
  if (orientation === 'horizontal' || orientation === 'both') {
    return direction === 'rtl' ? key === 'ArrowLeft' : key === 'ArrowRight';
  }
  return false;
};

export const resolveRovingFocusMove = (
  items: readonly RovingFocusItem[],
  currentIndex: number,
  key: string,
  options: RovingFocusOptions = {},
): RovingFocusMove | null => {
  const config = { ...DEFAULT_OPTIONS, ...options };
  const available = getAvailableRovingIndices(items);
  if (available.length === 0) return null;

  let index: number | null = null;
  if (key === 'Home') index = available[0] ?? null;
  else if (key === 'End') index = available[available.length - 1] ?? null;
  else if (isPreviousKey(key, config.orientation, config.direction)) {
    index = moveBy(items, currentIndex, -1, config.loop);
  } else if (isNextKey(key, config.orientation, config.direction)) {
    index = moveBy(items, currentIndex, 1, config.loop);
  }

  if (index === null || index < 0) return null;
  const item = items[index];
  return isAvailable(item) ? { index, id: item.id } : null;
};

export const createRovingTabIndex = (
  items: readonly RovingFocusItem[],
  activeIndex: number,
): readonly number[] => {
  const resolvedActive = isAvailable(items[activeIndex])
    ? activeIndex
    : getInitialRovingIndex(items, activeIndex);
  return items.map((item, index) => (
    isAvailable(item) && index === resolvedActive ? 0 : -1
  ));
};

export const reconcileRovingIndex = (
  previousItems: readonly RovingFocusItem[],
  nextItems: readonly RovingFocusItem[],
  previousIndex: number,
): number => {
  const previousId = isAvailable(previousItems[previousIndex])
    ? previousItems[previousIndex]?.id
    : null;
  if (previousId) {
    const matchingIndex = nextItems.findIndex(
      (item) => isAvailable(item) && item.id === previousId,
    );
    if (matchingIndex >= 0) return matchingIndex;
  }
  return getInitialRovingIndex(nextItems, previousIndex);
};

export const focusRovingTarget = (
  root: ParentNode | null | undefined,
  id: string,
): boolean => {
  if (!root || !id) return false;
  const candidates = root.querySelectorAll<HTMLElement>('[data-roving-focus-id]');
  for (const target of candidates) {
    if (target.dataset.rovingFocusId !== id) continue;
    if (target.hidden || target.getAttribute('aria-hidden') === 'true') return false;
    if (target.hasAttribute('disabled') || target.getAttribute('aria-disabled') === 'true') {
      return false;
    }
    target.focus({ preventScroll: true });
    return target.ownerDocument.activeElement === target;
  }
  return false;
};
