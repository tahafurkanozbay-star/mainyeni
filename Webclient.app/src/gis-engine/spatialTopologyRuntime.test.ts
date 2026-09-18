import { describe, expect, it } from 'vitest';
import {
  analyzePolygonTopology,
  dedupeRingVertices,
  rewindPolygonRings,
  ringOrientation,
  ringSignedArea,
  type SpatialTopologyBudget,
} from './spatialTopologyRuntime';

const budget: SpatialTopologyBudget = {
  maxRings: 8,
  maxVertices: 1_000,
  maxSegments: 1_000,
  maxSegmentPairs: 10_000,
  maxIntersections: 64,
  maxIssues: 128,
};

describe('spatialTopologyRuntime', () => {
  it('accepts a simple closed ring and reports deterministic orientation', () => {
    const polygon = [[
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 4 },
      { x: 0, y: 4 },
      { x: 0, y: 0 },
    ]];
    const result = analyzePolygonTopology(polygon, budget);
    expect(result.valid).toBe(true);
    expect(result.diagnostics.truncated).toBe(false);
    expect(result.rings).toHaveLength(1);
    expect(result.rings[0]).toMatchObject({
      closed: true,
      normalizedVertexCount: 4,
      segmentCount: 4,
      orientation: 'counterclockwise',
    });
    expect(ringSignedArea(polygon[0]!)).toBe(16);
  });

  it('detects bow-tie self intersections without confusing adjacent endpoints', () => {
    const result = analyzePolygonTopology([[
      { x: 0, y: 0 },
      { x: 4, y: 4 },
      { x: 0, y: 4 },
      { x: 4, y: 0 },
      { x: 0, y: 0 },
    ]], budget);
    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.code === 'self-intersection' && issue.intersectionKind === 'cross')).toBe(true);
    expect(result.diagnostics.intersectionsFound).toBeGreaterThan(0);
  });

  it('detects crossing rings separately from self intersections', () => {
    const result = analyzePolygonTopology([
      [
        { x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 5 }, { x: 0, y: 0 },
      ],
      [
        { x: 4, y: -1 }, { x: 6, y: -1 }, { x: 6, y: 1 }, { x: 4, y: 1 }, { x: 4, y: -1 },
      ],
    ], budget);
    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.code === 'ring-intersection')).toBe(true);
  });

  it('removes repeated closure and consecutive duplicates deterministically', () => {
    const ring = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 4 },
      { x: 0, y: 4 },
      { x: 0, y: 0 },
    ];
    const deduped = dedupeRingVertices(ring, { closeRing: true });
    expect(deduped).toEqual([
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 4 },
      { x: 0, y: 4 },
      { x: 0, y: 0 },
    ]);
    const result = analyzePolygonTopology([ring], budget);
    expect(result.rings[0]?.duplicateVertices).toBe(1);
    expect(result.issues.some((issue) => issue.code === 'duplicate-vertex')).toBe(true);
  });

  it('rewinds outer and inner rings to opposite requested orientations', () => {
    const polygon = [
      [{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 6 }, { x: 0, y: 6 }, { x: 0, y: 0 }],
      [{ x: 2, y: 2 }, { x: 4, y: 2 }, { x: 4, y: 4 }, { x: 2, y: 4 }, { x: 2, y: 2 }],
    ];
    const rewound = rewindPolygonRings(polygon, { outerOrientation: 'clockwise' });
    expect(ringOrientation(rewound[0]!)).toBe('clockwise');
    expect(ringOrientation(rewound[1]!)).toBe('counterclockwise');
    expect(rewound[0]?.[0]).toEqual(rewound[0]?.[rewound[0]!.length - 1]);
    expect(rewound[1]?.[0]).toEqual(rewound[1]?.[rewound[1]!.length - 1]);
  });

  it('fails closed when the segment-pair budget is exhausted', () => {
    const result = analyzePolygonTopology([[
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
      { x: 0, y: 0 },
    ]], { ...budget, maxSegmentPairs: 1 });
    expect(result.valid).toBe(false);
    expect(result.diagnostics.truncated).toBe(true);
    expect(result.diagnostics.reasons).toContain('segment-pair-budget-exhausted');
  });

  it('honors AbortSignal before expensive pair scanning', () => {
    const controller = new AbortController();
    controller.abort(new Error('cancel topology'));
    expect(() => analyzePolygonTopology([[
      { x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 3 }, { x: 0, y: 0 },
    ]], budget, { signal: controller.signal })).toThrow('cancel topology');
  });

  it('rejects non-finite geometry input instead of propagating NaN', () => {
    expect(() => analyzePolygonTopology([[
      { x: 0, y: 0 },
      { x: Number.NaN, y: 1 },
      { x: 1, y: 1 },
    ]], budget)).toThrow(/finite/);
  });
});
