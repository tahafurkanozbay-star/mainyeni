export type RovingFocusOrientation = "horizontal" | "vertical" | "both";
export type RovingFocusDirection = "ltr" | "rtl";

export interface RovingFocusItem {
  id: string;
  disabled?: boolean;
  hidden?: boolean;
}

export interface RovingFocusOptions {
  orientation?: RovingFocusOrientation;
  direction?: RovingFocusDirection;
  loop?: boolean;
}

export interface RovingFocusMove {
  index: number;
  id: string;
}

const DEFAULT_OPTIONS: Required<RovingFocusOptions> = {
  orientation: "both",
  direction: "ltr",
  loop: true,
};

const isAvailable = (item: RovingFocusItem | undefined): item is RovingFocusItem =>
  Boolean(item && !item.disabled && !item.hidden && item.id.trim());

export const getAvailableRovingIndices = (items: readonly RovingFocusItem[]): number[] =>
  items.reduce<number[]>((indices, item, index) => {
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
  const afterPreferred = available.find(index => index > preferredIndex);
  return afterPreferred ?? available[0] ?? -1;
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
  if (position === -1) return delta > 0 ? available[0]! : available[available.length - 1]!;

  const nextPosition = position + delta;
  if (nextPosition >= 0 && nextPosition < available.length) return available[nextPosition]!;
  if (!loop) return currentIndex;
  return delta > 0 ? available[0]! : available[available.length - 1]!;
};

const isPreviousKey = (
  key: string,
  orientation: RovingFocusOrientation,
  direction: RovingFocusDirection,
): boolean => {
  if ((orientation === "vertical" || orientation === "both") && key === "ArrowUp") return true;
  if (orientation === "horizontal" || orientation === "both") {
    return direction === "rtl" ? key === "ArrowRight" : key === "ArrowLeft";
  }
  return false;
};

const isNextKey = (
  key: string,
  orientation: RovingFocusOrientation,
  direction: RovingFocusDirection,
): boolean => {
  if ((orientation === "vertical" || orientation === "both") && key === "ArrowDown") return true;
  if (orientation === "horizontal" || orientation === "both") {
    return direction === "rtl" ? key === "ArrowLeft" : key === "ArrowRight";
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
  if (key === "Home") index = available[0]!;
  else if (key === "End") index = available[available.length - 1]!;
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
  return items.map((item, index) => isAvailable(item) && index === resolvedActive ? 0 : -1);
};

export interface RovingFocusControllerOptions extends RovingFocusOptions {
  initialIndex?: number;
  onActiveChange?: (move: RovingFocusMove) => void;
}

export interface RovingFocusController {
  getActiveIndex(): number;
  getActiveId(): string | null;
  getTabIndices(): readonly number[];
  setItems(items: readonly RovingFocusItem[]): void;
  setActiveIndex(index: number): boolean;
  handleKey(key: string): RovingFocusMove | null;
}

export const createRovingFocusController = (
  initialItems: readonly RovingFocusItem[],
  options: RovingFocusControllerOptions = {},
): RovingFocusController => {
  let items = [...initialItems];
  let activeIndex = getInitialRovingIndex(items, options.initialIndex ?? 0);

  const notify = () => {
    const item = items[activeIndex];
    if (isAvailable(item)) options.onActiveChange?.({ index: activeIndex, id: item.id });
  };

  return {
    getActiveIndex: () => activeIndex,
    getActiveId: () => isAvailable(items[activeIndex]) ? items[activeIndex]!.id : null,
    getTabIndices: () => createRovingTabIndex(items, activeIndex),
    setItems(nextItems) {
      const previousId = isAvailable(items[activeIndex]) ? items[activeIndex]!.id : null;
      items = [...nextItems];
      const matchingIndex = previousId ? items.findIndex(item => isAvailable(item) && item.id === previousId) : -1;
      activeIndex = matchingIndex >= 0 ? matchingIndex : getInitialRovingIndex(items, activeIndex);
    },
    setActiveIndex(index) {
      if (!isAvailable(items[index])) return false;
      if (index === activeIndex) return true;
      activeIndex = index;
      notify();
      return true;
    },
    handleKey(key) {
      const move = resolveRovingFocusMove(items, activeIndex, key, options);
      if (!move) return null;
      if (move.index !== activeIndex) {
        activeIndex = move.index;
        notify();
      }
      return move;
    },
  };
};

export const focusRovingTarget = (
  root: ParentNode | null | undefined,
  id: string,
): boolean => {
  if (!root || !id) return false;
  const escaped = typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(id)
    : id.replace(/["\\]/g, "\\$&");
  const target = root.querySelector<HTMLElement>(`[data-roving-focus-id="${escaped}"]`);
  if (!target || target.hidden || target.getAttribute("aria-hidden") === "true") return false;
  if (target.hasAttribute("disabled") || target.getAttribute("aria-disabled") === "true") return false;
  target.focus({ preventScroll: true });
  return document.activeElement === target;
};
