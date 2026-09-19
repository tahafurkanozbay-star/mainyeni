import { describe, expect, it } from 'vitest';
import { normalizeSpatialReference } from './spatialReferenceRuntime';
import {
  inspectSpatialFeatures,
  projectSpatialFeatures,
  spatialFeatureCollectionExtent,
  type SpatialFeature,
} from './spatialReferenceFeatureRuntime';

const WGS84 = normalizeSpatialReference({ wkid: 4326 });
const WEB_MERCATOR = normalizeSpatialReference({ wkid: 3857 });

const pointFeature = (
  id: string | number,
  x = 32.85,
  y = 39.93,
  attributes: SpatialFeature['attributes'] = { NAME: 'Ankara' },
): SpatialFeature => ({
  id,
  geometry: {
    type: 'point',
    x,
    y,
    spatialReference: WGS84,
  },
  attributes,
});

describe('inspectSpatialFeatures identity and attributes', () => {
  it('accepts finite features and freezes normalized records', () => {
    const result = inspectSpatialFeatures([
      pointFeature(0, 32.85, 39.93, { NAME: 'Ankara', ACTIVE: true, SCORE: 8, NOTE: null }),
    ]);

    expect(result).toMatchObject({
      acceptedCount: 1,
      rejectedCount: 0,
      duplicateCount: 0,
      projectedCount: 0,
    });
    expect(result.estimatedAttributeBytes).toBeGreaterThan(0);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.features)).toBe(true);
    expect(Object.isFrozen(result.features[0]?.attributes)).toBe(true);
  });

  it('preserves numeric zero as a valid stable feature id', () => {
    const result = inspectSpatialFeatures([pointFeature(0)]);
    expect(result.features[0]?.id).toBe(0);
    expect(result.issues).toHaveLength(0);
  });

  it('treats numeric and string identities as distinct', () => {
    const result = inspectSpatialFeatures([
      pointFeature(7),
      pointFeature('7'),
    ]);
    expect(result.acceptedCount).toBe(2);
    expect(result.duplicateCount).toBe(0);
  });

  it('rejects duplicate identities by default', () => {
    const result = inspectSpatialFeatures([
      pointFeature('road-1'),
      pointFeature('road-1', 32.86, 39.94),
    ]);

    expect(result.acceptedCount).toBe(1);
    expect(result.rejectedCount).toBe(1);
    expect(result.duplicateCount).toBe(1);
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: 'duplicate-id',
        featureIndex: 1,
        featureId: 'road-1',
      }),
    ]);
  });

  it('can retain duplicates when explicitly requested while still reporting them', () => {
    const result = inspectSpatialFeatures(
      [pointFeature(1), pointFeature(1, 32.9, 40)],
      { rejectDuplicateIds: false },
    );

    expect(result.acceptedCount).toBe(2);
    expect(result.duplicateCount).toBe(1);
    expect(result.issues.map((issue) => issue.code)).toContain('duplicate-id');
  });

  it('rejects unsafe numeric feature identities', () => {
    const result = inspectSpatialFeatures([pointFeature(Number.MAX_SAFE_INTEGER + 10)]);
    expect(result.acceptedCount).toBe(0);
    expect(result.issues[0]).toMatchObject({ code: 'invalid-id' });
  });

  it('enforces the configured feature id length budget', () => {
    const result = inspectSpatialFeatures([pointFeature('abcdef')], { maxIdLength: 5 });
    expect(result.acceptedCount).toBe(0);
    expect(result.issues[0]).toMatchObject({
      code: 'invalid-id',
      message: 'feature id exceeds configured length budget',
    });
  });

  it('rejects empty string feature identities', () => {
    const result = inspectSpatialFeatures([pointFeature('   ')]);
    expect(result.acceptedCount).toBe(0);
    expect(result.issues[0]?.code).toBe('invalid-id');
  });

  it('rejects non-finite numeric attribute values', () => {
    const result = inspectSpatialFeatures([
      pointFeature(1, 32.85, 39.93, { VALUE: Number.POSITIVE_INFINITY }),
    ]);
    expect(result.acceptedCount).toBe(0);
    expect(result.issues[0]).toMatchObject({ code: 'invalid-attribute' });
  });

  it('rejects unsupported nested attribute values at runtime', () => {
    const feature = pointFeature(1) as unknown as {
      id: number;
      geometry: SpatialFeature['geometry'];
      attributes: Readonly<Record<string, unknown>>;
    };
    const malformed = {
      ...feature,
      attributes: { payload: { nested: true } },
    } as unknown as SpatialFeature;

    const result = inspectSpatialFeatures([malformed]);
    expect(result.acceptedCount).toBe(0);
    expect(result.issues[0]?.code).toBe('invalid-attribute');
  });

  it('enforces the attribute count budget', () => {
    const result = inspectSpatialFeatures(
      [pointFeature(1, 32.85, 39.93, { A: 1, B: 2 })],
      { maxAttributesPerFeature: 1 },
    );
    expect(result.acceptedCount).toBe(0);
    expect(result.issues[0]?.code).toBe('attribute-budget');
  });

  it('enforces attribute key length', () => {
    const result = inspectSpatialFeatures(
      [pointFeature(1, 32.85, 39.93, { ABCDE: 1 })],
      { maxAttributeKeyLength: 4 },
    );
    expect(result.acceptedCount).toBe(0);
    expect(result.issues[0]?.code).toBe('attribute-budget');
  });

  it('enforces string value length', () => {
    const result = inspectSpatialFeatures(
      [pointFeature(1, 32.85, 39.93, { NAME: 'abcdef' })],
      { maxStringValueLength: 5 },
    );
    expect(result.acceptedCount).toBe(0);
    expect(result.issues[0]?.code).toBe('attribute-budget');
  });

  it('enforces estimated attribute bytes per feature', () => {
    const result = inspectSpatialFeatures(
      [pointFeature(1, 32.85, 39.93, { NAME: 'abcdefghijklmnop' })],
      { maxAttributeBytesPerFeature: 16 },
    );
    expect(result.acceptedCount).toBe(0);
    expect(result.issues[0]).toMatchObject({
      code: 'attribute-budget',
      message: 'feature exceeds attribute byte budget',
    });
  });

  it('enforces total accepted attribute bytes across the collection', () => {
    const single = inspectSpatialFeatures([pointFeature(1)]);
    const result = inspectSpatialFeatures(
      [pointFeature(1), pointFeature(2)],
      { maxTotalAttributeBytes: single.estimatedAttributeBytes },
    );

    expect(result.acceptedCount).toBe(1);
    expect(result.rejectedCount).toBe(1);
    expect(result.issues[0]).toMatchObject({
      code: 'attribute-budget',
      featureIndex: 1,
    });
    expect(result.estimatedAttributeBytes).toBe(single.estimatedAttributeBytes);
  });

  it('rejects collections above the feature-count budget before iteration', () => {
    expect(() => inspectSpatialFeatures(
      [pointFeature(1), pointFeature(2)],
      { maxFeatures: 1 },
    )).toThrow('feature collection exceeds configured budget');
  });

  it('throws when rejectInvalidFeatures requests fail-fast behavior', () => {
    expect(() => inspectSpatialFeatures(
      [pointFeature(1, Number.NaN, 39.93)],
      { rejectInvalidFeatures: true },
    )).toThrow();
  });

  it('fails once the bounded issue journal is exhausted', () => {
    expect(() => inspectSpatialFeatures(
      [
        pointFeature(Number.NaN),
        pointFeature(Number.POSITIVE_INFINITY),
      ],
      { maxIssues: 1 },
    )).toThrow('spatial feature issue budget exhausted');
  });

  it('propagates cancellation before processing additional features', () => {
    const controller = new AbortController();
    controller.abort(new Error('query superseded'));

    expect(() => inspectSpatialFeatures(
      [pointFeature(1)],
      { signal: controller.signal } as Parameters<typeof inspectSpatialFeatures>[1],
    )).toThrow('query superseded');
  });
});

describe('inspectSpatialFeatures spatial reference alignment', () => {
  it('accepts equivalent target spatial references without projection', () => {
    const result = inspectSpatialFeatures([pointFeature(1)], {
      targetSpatialReference: WGS84,
    });
    expect(result.acceptedCount).toBe(1);
    expect(result.projectedCount).toBe(0);
    expect(result.features[0]?.geometry.spatialReference).toBe(WGS84);
  });

  it('rejects mixed spatial reference when projection is disabled', () => {
    const result = inspectSpatialFeatures([pointFeature(1)], {
      targetSpatialReference: WEB_MERCATOR,
    });

    expect(result.acceptedCount).toBe(0);
    expect(result.issues[0]?.code).toBe('spatial-reference-mismatch');
  });

  it('projects WGS84 point geometry to Web Mercator when explicitly enabled', () => {
    const result = projectSpatialFeatures([pointFeature(1, 0, 0)], WEB_MERCATOR);
    expect(result.acceptedCount).toBe(1);
    expect(result.projectedCount).toBe(1);
    expect(result.features[0]?.geometry).toMatchObject({
      type: 'point',
      x: 0,
      y: expect.closeTo(0, 6),
      spatialReference: WEB_MERCATOR,
    });
  });

  it('reports unsupported client-side projections without inventing a projection path', () => {
    const unsupported = normalizeSpatialReference({ wkid: 32636 });
    const result = inspectSpatialFeatures([pointFeature(1)], {
      targetSpatialReference: unsupported,
      projectToTarget: true,
    });

    expect(result.acceptedCount).toBe(0);
    expect(result.issues[0]?.code).toBe('projection-unsupported');
  });

  it('closes polygon rings through the shared geometry normalizer', () => {
    const feature: SpatialFeature = {
      id: 'polygon-1',
      geometry: {
        type: 'polygon',
        rings: [[
          [32, 39],
          [33, 39],
          [33, 40],
        ]],
        spatialReference: WGS84,
      },
      attributes: { NAME: 'area' },
    };

    const result = inspectSpatialFeatures([feature]);
    const geometry = result.features[0]?.geometry;
    expect(geometry?.type).toBe('polygon');
    if (geometry?.type !== 'polygon') throw new Error('expected polygon');
    expect(geometry.rings[0]).toHaveLength(4);
    expect(geometry.rings[0]?.[0]).toEqual(geometry.rings[0]?.[3]);
  });

  it('rejects geometry that exceeds inherited coordinate budgets', () => {
    const feature: SpatialFeature = {
      id: 'line-1',
      geometry: {
        type: 'polyline',
        paths: [[
          [1, 1],
          [2, 2],
          [3, 3],
        ]],
        spatialReference: WGS84,
      },
      attributes: {},
    };
    const result = inspectSpatialFeatures([feature], { maxCoordinates: 2 });
    expect(result.acceptedCount).toBe(0);
    expect(result.issues[0]?.code).toBe('geometry-invalid');
  });
});

describe('spatialFeatureCollectionExtent', () => {
  it('computes a deterministic collection extent for points', () => {
    const result = spatialFeatureCollectionExtent([
      pointFeature(1, 30, 40),
      pointFeature(2, 35, 38),
      pointFeature(3, 32, 42),
    ]);

    expect(result).toEqual({
      extent: {
        xmin: 30,
        ymin: 38,
        xmax: 35,
        ymax: 42,
      },
      spatialReference: WGS84,
    });
  });

  it('computes extents after verified projection to a target reference', () => {
    const result = spatialFeatureCollectionExtent(
      [pointFeature(1, 0, 0), pointFeature(2, 1, 1)],
      {
        targetSpatialReference: WEB_MERCATOR,
        projectToTarget: true,
      },
    );

    expect(result.spatialReference).toBe(WEB_MERCATOR);
    expect(result.extent.xmin).toBe(0);
    expect(result.extent.ymin).toBeCloseTo(0, 6);
    expect(result.extent.xmax).toBeGreaterThan(100_000);
    expect(result.extent.ymax).toBeGreaterThan(100_000);
  });

  it('rejects an empty collection because no finite extent exists', () => {
    expect(() => spatialFeatureCollectionExtent([]))
      .toThrow('feature collection has no accepted geometries');
  });

  it('rejects mixed references when no verified projection path was requested', () => {
    const webMercatorFeature: SpatialFeature = {
      id: 2,
      geometry: {
        type: 'point',
        x: 0,
        y: 0,
        spatialReference: WEB_MERCATOR,
      },
      attributes: {},
    };

    expect(() => spatialFeatureCollectionExtent([
      pointFeature(1, 0, 0),
      webMercatorFeature,
    ])).toThrow('feature collection contains mixed spatial references');
  });
});
