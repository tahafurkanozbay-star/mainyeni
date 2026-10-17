import { describe, expect, it } from 'vitest';
import {
  chooseSceneControlsPlacement,
  type SceneControlsRect,
} from './sceneControlsPlacementPolicy';

const rect = (
  left: number,
  top: number,
  right: number,
  bottom: number,
): SceneControlsRect => Object.freeze({
  left,
  top,
  right,
  bottom,
  width: right - left,
  height: bottom - top,
});

describe('chooseSceneControlsPlacement', () => {
  it('places desktop camera controls beside the 2D/3D switcher instead of over it', () => {
    const mapRect = rect(0, 56, 1280, 800);
    const modeRect = rect(990, 78, 1264, 226);
    const utility = rect(1080, 540, 1266, 786);
    const disclaimer = rect(8, 755, 492, 792);

    const placement = chooseSceneControlsPlacement({
      mapRect,
      modeRect,
      controlWidth: 220,
      controlHeight: 114,
      viewportWidth: 1280,
      viewportHeight: 800,
      obstacleRects: [modeRect, utility, disclaimer],
    });

    expect(placement.strategy).toBe('left-of-mode');
    expect(placement.left + 220).toBeLessThanOrEqual(modeRect.left);
    expect(placement.top + 114).toBeLessThanOrEqual(utility.top);
    expect(placement.overlapArea).toBe(0);
  });

  it('uses the narrow side gap on mobile so controls do not cover the mode panel or bottom dock', () => {
    const mapRect = rect(0, 58, 390, 600);
    const modeRect = rect(128, 78, 380, 238);
    const utility = rect(190, 340, 382, 590);
    const disclaimer = rect(8, 522, 382, 555);

    const placement = chooseSceneControlsPlacement({
      mapRect,
      modeRect,
      controlWidth: 112,
      controlHeight: 212,
      viewportWidth: 390,
      viewportHeight: 600,
      obstacleRects: [modeRect, utility, disclaimer],
      margin: 8,
      gap: 12,
    });

    expect(placement.strategy).toBe('left-of-mode');
    expect(placement.left).toBeGreaterThanOrEqual(8);
    expect(placement.left + 112).toBeLessThanOrEqual(modeRect.left);
    expect(placement.top + 212).toBeLessThanOrEqual(disclaimer.top);
    expect(placement.overlapArea).toBe(0);
  });

  it('falls below the switcher when the adjacent side is occupied by another panel', () => {
    const mapRect = rect(0, 56, 1280, 800);
    const modeRect = rect(990, 78, 1264, 226);
    const sidebar = rect(0, 56, 980, 700);
    const utility = rect(1080, 540, 1266, 786);
    const disclaimer = rect(8, 755, 492, 792);

    const placement = chooseSceneControlsPlacement({
      mapRect,
      modeRect,
      controlWidth: 220,
      controlHeight: 114,
      viewportWidth: 1280,
      viewportHeight: 800,
      obstacleRects: [modeRect, sidebar, utility, disclaimer],
    });

    expect(placement.strategy).toBe('below-mode-right');
    expect(placement.top).toBeGreaterThanOrEqual(modeRect.bottom);
    expect(placement.overlapArea).toBe(0);
  });
});
