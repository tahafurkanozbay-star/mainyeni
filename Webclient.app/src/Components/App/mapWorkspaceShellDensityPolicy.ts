import type { MapWorkspaceShellPhase, MapWorkspaceViewport } from './mapWorkspaceShellModel';

export type MapWorkspaceShellDensity = 'full' | 'compact' | 'status-only';
export type MapWorkspaceShellDensityReason =
  | 'user-collapsed'
  | 'no-landmarks'
  | 'booting'
  | 'very-short-viewport'
  | 'compact-viewport'
  | 'coarse-medium-viewport'
  | 'normal';

export interface MapWorkspaceShellDensityInput {
  readonly viewport: MapWorkspaceViewport;
  readonly width: number;
  readonly height: number;
  readonly coarsePointer: boolean;
  readonly phase: MapWorkspaceShellPhase;
  readonly utilityCollapsed: boolean;
  readonly availableLandmarkCount: number;
}

export interface MapWorkspaceShellDensityDecision {
  readonly density: MapWorkspaceShellDensity;
  readonly reason: MapWorkspaceShellDensityReason;
  readonly showStatusDetail: boolean;
  readonly showKeyboardHint: boolean;
  readonly showActions: boolean;
  readonly actionColumns: 0 | 3 | 6;
  readonly minimumTargetSize: 44 | 48;
  readonly preferHorizontalScroll: boolean;
}

const SHORT_VIEWPORT_MAX_HEIGHT = 520;
const VERY_NARROW_MAX_WIDTH = 420;
const COARSE_MEDIUM_MAX_WIDTH = 960;

const finite = (value: number, fallback: number): number => Number.isFinite(value) ? value : fallback;

export const resolveMapWorkspaceShellDensity = (
  input: MapWorkspaceShellDensityInput,
): MapWorkspaceShellDensityDecision => {
  const width = Math.max(1, Math.trunc(finite(input.width, 1280)));
  const height = Math.max(1, Math.trunc(finite(input.height, 720)));
  const minimumTargetSize = input.coarsePointer ? 48 : 44;

  if (input.utilityCollapsed) {
    return Object.freeze({
      density: 'status-only',
      reason: 'user-collapsed',
      showStatusDetail: width > VERY_NARROW_MAX_WIDTH,
      showKeyboardHint: false,
      showActions: false,
      actionColumns: 0,
      minimumTargetSize,
      preferHorizontalScroll: false,
    });
  }

  if (input.availableLandmarkCount === 0) {
    return Object.freeze({
      density: 'status-only',
      reason: input.phase === 'booting' ? 'booting' : 'no-landmarks',
      showStatusDetail: true,
      showKeyboardHint: false,
      showActions: false,
      actionColumns: 0,
      minimumTargetSize,
      preferHorizontalScroll: false,
    });
  }

  const veryShort = height <= SHORT_VIEWPORT_MAX_HEIGHT;
  const narrow = input.viewport === 'compact' || width <= VERY_NARROW_MAX_WIDTH;
  const coarseMedium = input.coarsePointer && width <= COARSE_MEDIUM_MAX_WIDTH;

  if (veryShort || narrow || coarseMedium) {
    return Object.freeze({
      density: 'compact',
      reason: veryShort ? 'very-short-viewport' : narrow ? 'compact-viewport' : 'coarse-medium-viewport',
      showStatusDetail: !veryShort && width > VERY_NARROW_MAX_WIDTH,
      showKeyboardHint: false,
      showActions: true,
      actionColumns: 3,
      minimumTargetSize,
      preferHorizontalScroll: narrow,
    });
  }

  return Object.freeze({
    density: 'full',
    reason: 'normal',
    showStatusDetail: true,
    showKeyboardHint: !input.coarsePointer,
    showActions: true,
    actionColumns: 6,
    minimumTargetSize,
    preferHorizontalScroll: false,
  });
};
