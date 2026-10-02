import { describe, expect, it } from 'vitest';
import {
  chooseMapWorkspaceShellPlacement,
  evaluateMapWorkspacePlacement,
  mapWorkspaceIntersectionArea,
  normalizeMapWorkspaceRect,
} from './mapWorkspaceShellPlacementModel';

const rect = (left: number, top: number, width: number, height: number) => normalizeMapWorkspaceRect({ left, top, width, height });

describe('normalizeMapWorkspaceRect', () => {
  it('derives right and bottom from origin and size', () => {
    expect(normalizeMapWorkspaceRect({ left: 10, top: 20, width: 30, height: 40 })).toEqual({
      left: 10,
      top: 20,
      right: 40,
      bottom: 60,
      width: 30,
      height: 40,
    });
  });

  it('clamps negative dimensions to zero', () => {
    expect(normalizeMapWorkspaceRect({ left: 10, top: 20, width: -30, height: -40 })).toMatchObject({ width: 0, height: 0 });
  });

  it('contains non-finite dimensions', () => {
    expect(normalizeMapWorkspaceRect({ left: Number.NaN, top: Number.POSITIVE_INFINITY, width: Number.NaN, height: Number.NEGATIVE_INFINITY })).toEqual({
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
    });
  });
});

describe('mapWorkspaceIntersectionArea', () => {
  it('returns overlap area for intersecting rectangles', () => {
    expect(mapWorkspaceIntersectionArea(rect(0, 0, 100, 100), rect(50, 50, 100, 100))).toBe(2_500);
  });

  it('returns zero for separated rectangles', () => {
    expect(mapWorkspaceIntersectionArea(rect(0, 0, 100, 100), rect(120, 120, 10, 10))).toBe(0);
  });

  it('returns zero when rectangles only touch at an edge', () => {
    expect(mapWorkspaceIntersectionArea(rect(0, 0, 100, 100), rect(100, 0, 100, 100))).toBe(0);
  });
});

describe('evaluateMapWorkspacePlacement', () => {
  it('produces all three deterministic candidates', () => {
    const candidates = evaluateMapWorkspacePlacement({
      viewport: { width: 1200, height: 800 },
      overlay: { width: 600, height: 120 },
      occluders: [],
    });
    expect(candidates.map((candidate) => candidate.anchor)).toEqual(['bottom-left', 'bottom-center', 'bottom-right']);
    expect(Object.isFrozen(candidates)).toBe(true);
  });

  it('prefers bottom-left when no candidate overlaps anything', () => {
    const result = chooseMapWorkspaceShellPlacement({
      viewport: { width: 1600, height: 900 },
      overlay: { width: 600, height: 120 },
      occluders: [],
    });
    expect(result.anchor).toBe('bottom-left');
  });

  it('moves away from a left-side occluder', () => {
    const result = chooseMapWorkspaceShellPlacement({
      viewport: { width: 1600, height: 900 },
      overlay: { width: 600, height: 120 },
      occluders: [rect(0, 650, 700, 250)],
    });
    expect(result.anchor).not.toBe('bottom-left');
  });

  it('chooses bottom-right when left and center collide', () => {
    const result = chooseMapWorkspaceShellPlacement({
      viewport: { width: 1500, height: 900 },
      overlay: { width: 420, height: 110 },
      occluders: [rect(0, 700, 980, 200)],
    });
    expect(result.anchor).toBe('bottom-right');
  });

  it('chooses bottom-center when both edges are obstructed', () => {
    const result = chooseMapWorkspaceShellPlacement({
      viewport: { width: 1600, height: 900 },
      overlay: { width: 420, height: 110 },
      occluders: [rect(0, 680, 520, 220), rect(1080, 680, 520, 220)],
    });
    expect(result.anchor).toBe('bottom-center');
  });

  it('forces bottom-center on compact viewports', () => {
    const result = chooseMapWorkspaceShellPlacement({
      viewport: { width: 390, height: 844 },
      overlay: { width: 360, height: 170 },
      occluders: [rect(100, 650, 190, 194)],
    });
    expect(result.anchor).toBe('bottom-center');
  });

  it('allows compact breakpoint override', () => {
    const result = chooseMapWorkspaceShellPlacement({
      viewport: { width: 900, height: 800 },
      overlay: { width: 300, height: 100 },
      occluders: [],
      compactBreakpoint: 1_000,
    });
    expect(result.anchor).toBe('bottom-center');
  });

  it('honors safe bottom space', () => {
    const withoutSafeArea = evaluateMapWorkspacePlacement({
      viewport: { width: 1000, height: 800 },
      overlay: { width: 400, height: 100 },
      occluders: [],
      safeBottom: 0,
    });
    const withSafeArea = evaluateMapWorkspacePlacement({
      viewport: { width: 1000, height: 800 },
      overlay: { width: 400, height: 100 },
      occluders: [],
      safeBottom: 60,
    });
    expect(withSafeArea[0].rect.top).toBe(withoutSafeArea[0].rect.top - 60);
  });

  it('clamps excessive safe bottom values', () => {
    const candidates = evaluateMapWorkspacePlacement({
      viewport: { width: 1000, height: 800 },
      overlay: { width: 400, height: 100 },
      occluders: [],
      safeBottom: 9999,
    });
    expect(candidates[0].rect.top).toBeGreaterThanOrEqual(0);
  });

  it('limits occluder processing to a bounded set', () => {
    const occluders = Array.from({ length: 100 }, (_, index) => rect(index * 2, 650, 1, 100));
    const candidates = evaluateMapWorkspacePlacement({
      viewport: { width: 1600, height: 900 },
      overlay: { width: 400, height: 100 },
      occluders,
    });
    expect(candidates).toHaveLength(3);
    expect(candidates.every((candidate) => Number.isFinite(candidate.score))).toBe(true);
  });

  it('penalizes overflow more strongly than overlap', () => {
    const candidates = evaluateMapWorkspacePlacement({
      viewport: { width: 300, height: 200 },
      overlay: { width: 900, height: 500 },
      occluders: [],
      margin: 14,
    });
    expect(candidates.every((candidate) => candidate.overflowArea >= 0)).toBe(true);
  });

  it('keeps candidate rectangles inside viewport when overlay can fit', () => {
    const candidates = evaluateMapWorkspacePlacement({
      viewport: { width: 1200, height: 800 },
      overlay: { width: 500, height: 120 },
      occluders: [],
      margin: 20,
    });
    for (const candidate of candidates) {
      expect(candidate.rect.left).toBeGreaterThanOrEqual(20);
      expect(candidate.rect.right).toBeLessThanOrEqual(1180);
      expect(candidate.rect.bottom).toBeLessThanOrEqual(780);
    }
  });

  it('uses deterministic preference penalties for ties', () => {
    const candidates = evaluateMapWorkspacePlacement({
      viewport: { width: 1600, height: 900 },
      overlay: { width: 400, height: 100 },
      occluders: [],
    });
    expect(candidates.map((candidate) => candidate.preferencePenalty)).toEqual([0, 1, 2]);
    expect(candidates[0].score).toBeLessThan(candidates[1].score);
    expect(candidates[1].score).toBeLessThan(candidates[2].score);
  });
});
