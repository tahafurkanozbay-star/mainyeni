import { describe, expect, it } from 'vitest';
import { joinPointsToPolygons, type SpatialJoinBudgets } from './spatialJoinRuntime';

const budgets: SpatialJoinBudgets = {
  maxFeatures: 10,
  maxPolygons: 10,
  maxRingVertices: 100,
  maxCandidatePairs: 100,
  maxMatches: 100,
};

const square = {
  id: 'square',
  rings: [[
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
    { x: 0, y: 0 },
  ]],
} as const;

describe('joinPointsToPolygons', () => {
  it('joins points deterministically and includes boundary points', () => {
    const result = joinPointsToPolygons([
      { id: 0, point: { x: 5, y: 5 } },
      { id: '0', point: { x: 10, y: 5 } },
      { id: 2, point: { x: 20, y: 20 } },
    ], [square], { budgets });

    expect(result.matches).toEqual([
      { featureId: 0, polygonId: 'square' },
      { featureId: '0', polygonId: 'square' },
    ]);
    expect(result.diagnostics.reason).toBe('complete');
    expect(result.diagnostics.truncated).toBe(false);
  });

  it('supports holes with even-odd containment', () => {
    const polygon = {
      id: 'with-hole',
      rings: [
        square.rings[0],
        [
          { x: 4, y: 4 },
          { x: 6, y: 4 },
          { x: 6, y: 6 },
          { x: 4, y: 6 },
          { x: 4, y: 4 },
        ],
      ],
    } as const;
    const result = joinPointsToPolygons([
      { id: 'shell', point: { x: 2, y: 2 } },
      { id: 'hole', point: { x: 5, y: 5 } },
    ], [polygon], { budgets });
    expect(result.matches).toEqual([{ featureId: 'shell', polygonId: 'with-hole' }]);
  });

  it('fails closed when the candidate-pair budget is exhausted', () => {
    const result = joinPointsToPolygons([
      { id: 1, point: { x: 5, y: 5 } },
      { id: 2, point: { x: 5, y: 5 } },
    ], [square], { budgets: { ...budgets, maxCandidatePairs: 1 } });
    expect(result.matches).toHaveLength(1);
    expect(result.diagnostics).toMatchObject({ truncated: true, reason: 'candidate-budget', candidatePairsVisited: 1 });
  });

  it('fails closed when polygon vertex budget is exceeded', () => {
    const result = joinPointsToPolygons([{ id: 1, point: { x: 5, y: 5 } }], [square], {
      budgets: { ...budgets, maxRingVertices: 4 },
    });
    expect(result.matches).toEqual([]);
    expect(result.diagnostics.reason).toBe('vertex-budget');
  });

  it('rejects non-finite feature coordinates', () => {
    expect(() => joinPointsToPolygons([
      { id: 1, point: { x: Number.NaN, y: 1 } },
    ], [square], { budgets })).toThrow(/finite coordinates/);
  });

  it('rejects invalid budgets', () => {
    expect(() => joinPointsToPolygons([], [], {
      budgets: { ...budgets, maxMatches: 0 },
    })).toThrow(/maxMatches/);
  });

  it('honors cancellation before work starts', () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    expect(() => joinPointsToPolygons([], [], { budgets, signal: controller.signal })).toThrow('cancelled');
  });

  it('caps feature cardinality deterministically', () => {
    const result = joinPointsToPolygons([
      { id: 1, point: { x: 5, y: 5 } },
      { id: 2, point: { x: 5, y: 5 } },
    ], [square], { budgets: { ...budgets, maxFeatures: 1 } });
    expect(result.matches).toEqual([{ featureId: 1, polygonId: 'square' }]);
    expect(result.diagnostics.reason).toBe('feature-budget');
  });

  it('caps match cardinality without allocating beyond the budget', () => {
    const overlapping = { ...square, id: 'second' } as const;
    const result = joinPointsToPolygons([{ id: 1, point: { x: 5, y: 5 } }], [square, overlapping], {
      budgets: { ...budgets, maxMatches: 1 },
    });
    expect(result.matches).toEqual([{ featureId: 1, polygonId: 'square' }]);
    expect(result.diagnostics.reason).toBe('match-budget');
  });
});
