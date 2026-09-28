import type { CommandCenterState } from './commandCenterInteractionModel';

export interface CommandCenterRenderWindowLimits {
  readonly maxRendered: number;
  readonly overscan: number;
}

export interface CommandCenterRenderOption {
  readonly commandId: string;
  readonly absoluteIndex: number;
  readonly position: number;
  readonly setSize: number;
  readonly active: boolean;
}

export interface CommandCenterRenderWindow {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly totalCount: number;
  readonly hiddenBefore: number;
  readonly hiddenAfter: number;
  readonly options: readonly CommandCenterRenderOption[];
}

const DEFAULT_LIMITS: CommandCenterRenderWindowLimits = Object.freeze({
  maxRendered: 18,
  overscan: 3,
});

const clampInteger = (value: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
};

const normalizeLimits = (
  input: Partial<CommandCenterRenderWindowLimits> = {},
): CommandCenterRenderWindowLimits => Object.freeze({
  maxRendered: clampInteger(input.maxRendered ?? DEFAULT_LIMITS.maxRendered, 4, 64),
  overscan: clampInteger(input.overscan ?? DEFAULT_LIMITS.overscan, 0, 16),
});

const activeIndexOf = (state: CommandCenterState): number => {
  if (!state.activeId) return -1;
  return state.matches.findIndex(match => match.item.id === state.activeId);
};

export const createCommandCenterRenderWindow = (
  state: CommandCenterState,
  input: Partial<CommandCenterRenderWindowLimits> = {},
): CommandCenterRenderWindow => {
  const limits = normalizeLimits(input);
  const totalCount = state.matches.length;

  if (totalCount === 0) {
    return Object.freeze({
      startIndex: 0,
      endIndex: 0,
      totalCount: 0,
      hiddenBefore: 0,
      hiddenAfter: 0,
      options: Object.freeze([]),
    });
  }

  const windowSize = Math.min(limits.maxRendered, totalCount);
  const activeIndex = activeIndexOf(state);
  const anchor = activeIndex >= 0 ? activeIndex : 0;
  const preferredStart = Math.max(0, anchor - Math.floor(windowSize / 2));
  const maxStart = Math.max(0, totalCount - windowSize);
  let startIndex = Math.min(preferredStart, maxStart);
  let endIndex = Math.min(totalCount, startIndex + windowSize);

  if (activeIndex >= 0) {
    const visibleStart = Math.max(0, startIndex - limits.overscan);
    const visibleEnd = Math.min(totalCount, endIndex + limits.overscan);
    startIndex = visibleStart;
    endIndex = visibleEnd;
  }

  const options = Object.freeze(state.matches
    .slice(startIndex, endIndex)
    .map((match, localIndex) => {
      const absoluteIndex = startIndex + localIndex;
      return Object.freeze({
        commandId: match.item.id,
        absoluteIndex,
        position: absoluteIndex + 1,
        setSize: totalCount,
        active: match.item.id === state.activeId,
      });
    }));

  return Object.freeze({
    startIndex,
    endIndex,
    totalCount,
    hiddenBefore: startIndex,
    hiddenAfter: Math.max(0, totalCount - endIndex),
    options,
  });
};

export const isCommandCenterResultRendered = (
  renderWindow: CommandCenterRenderWindow,
  commandId: string | null,
): boolean => Boolean(commandId) && renderWindow.options.some(
  option => option.commandId === commandId,
);
