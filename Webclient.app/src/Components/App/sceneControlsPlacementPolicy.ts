export interface SceneControlsRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

export type SceneControlsPlacementStrategy =
  | 'left-of-mode'
  | 'right-of-mode'
  | 'below-mode-right'
  | 'below-mode-left'
  | 'map-top-left'
  | 'map-top-right'
  | 'map-bottom-left'
  | 'map-bottom-right';

export interface SceneControlsPlacementInput {
  readonly mapRect: SceneControlsRect;
  readonly controlWidth: number;
  readonly controlHeight: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly modeRect?: SceneControlsRect | null;
  readonly obstacleRects: readonly SceneControlsRect[];
  readonly margin?: number;
  readonly gap?: number;
}

export interface SceneControlsPlacement {
  readonly left: number;
  readonly top: number;
  readonly strategy: SceneControlsPlacementStrategy;
  readonly overlapArea: number;
}

interface Candidate {
  readonly left: number;
  readonly top: number;
  readonly strategy: SceneControlsPlacementStrategy;
  readonly rank: number;
}

const finite = (value: number): boolean => Number.isFinite(value);
const clamp = (value: number, min: number, max: number): number => (
  Math.min(max, Math.max(min, value))
);

const intersectionArea = (
  left: number,
  top: number,
  width: number,
  height: number,
  obstacle: SceneControlsRect,
): number => {
  const overlapWidth = Math.max(0, Math.min(left + width, obstacle.right) - Math.max(left, obstacle.left));
  const overlapHeight = Math.max(0, Math.min(top + height, obstacle.bottom) - Math.max(top, obstacle.top));
  return overlapWidth * overlapHeight;
};

/**
 * Chooses a placement for the 3D camera control group while avoiding the 2D/3D
 * switcher and other visible overlays. It prefers sitting beside the switcher,
 * and only falls back to a lower corner when the side space is occupied.
 */
export const chooseSceneControlsPlacement = (
  input: SceneControlsPlacementInput,
): SceneControlsPlacement => {
  const width = Math.max(1, finite(input.controlWidth) ? input.controlWidth : 1);
  const height = Math.max(1, finite(input.controlHeight) ? input.controlHeight : 1);
  const viewportWidth = Math.max(width, finite(input.viewportWidth) ? input.viewportWidth : width);
  const viewportHeight = Math.max(height, finite(input.viewportHeight) ? input.viewportHeight : height);
  const margin = clamp(input.margin ?? 10, 0, 48);
  const gap = clamp(input.gap ?? 12, 0, 48);

  const minLeft = Math.max(margin, input.mapRect.left + margin);
  const maxLeft = Math.min(viewportWidth - width - margin, input.mapRect.right - width - margin);
  const minTop = Math.max(margin, input.mapRect.top + margin);
  const maxTop = Math.min(viewportHeight - height - margin, input.mapRect.bottom - height - margin);
  const leftFloor = maxLeft >= minLeft ? minLeft : clamp(input.mapRect.left, 0, Math.max(0, viewportWidth - width));
  const leftCeiling = maxLeft >= minLeft ? maxLeft : leftFloor;
  const topFloor = maxTop >= minTop ? minTop : clamp(input.mapRect.top, 0, Math.max(0, viewportHeight - height));
  const topCeiling = maxTop >= minTop ? maxTop : topFloor;

  const candidates: Candidate[] = [];
  const add = (
    left: number,
    top: number,
    strategy: SceneControlsPlacementStrategy,
  ): void => {
    const candidate = Object.freeze({
      left: Math.round(clamp(left, leftFloor, leftCeiling)),
      top: Math.round(clamp(top, topFloor, topCeiling)),
      strategy,
      rank: candidates.length,
    });
    if (candidates.some(existing => existing.left === candidate.left && existing.top === candidate.top)) return;
    candidates.push(candidate);
  };

  const mode = input.modeRect;
  if (mode) {
    add(mode.left - width - gap, mode.top, 'left-of-mode');
    add(mode.right + gap, mode.top, 'right-of-mode');
    add(mode.right - width, mode.bottom + gap, 'below-mode-right');
    add(mode.left, mode.bottom + gap, 'below-mode-left');
  }

  add(leftFloor, topFloor, 'map-top-left');
  add(leftCeiling, topFloor, 'map-top-right');
  add(leftFloor, topCeiling, 'map-bottom-left');
  add(leftCeiling, topCeiling, 'map-bottom-right');

  const obstacles = input.obstacleRects.filter(rect => (
    [rect.left, rect.top, rect.right, rect.bottom, rect.width, rect.height].every(finite)
      && rect.right > rect.left
      && rect.bottom > rect.top
  ));

  const scored = candidates.map(candidate => {
    const area = obstacles.reduce(
      (total, obstacle) => total + intersectionArea(candidate.left, candidate.top, width, height, obstacle),
      0,
    );
    return {
      ...candidate,
      overlapArea: area,
      score: area + candidate.rank * 0.01,
    };
  }).sort((left, right) => left.score - right.score);

  const best = scored[0] ?? {
    left: leftFloor,
    top: topFloor,
    strategy: 'map-top-left' as const,
    overlapArea: 0,
  };

  return Object.freeze({
    left: best.left,
    top: best.top,
    strategy: best.strategy,
    overlapArea: best.overlapArea,
  });
};
