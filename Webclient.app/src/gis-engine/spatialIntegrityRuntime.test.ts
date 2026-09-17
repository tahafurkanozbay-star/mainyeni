import { describe, expect, it } from 'vitest';
import {
  configurationFromCapabilities,
  createSpatialIntegrityRuntime,
  SpatialIntegrityRuntime,
} from './spatialIntegrityRuntime';
import type { ArcGisServiceCapabilities } from './arcgisCapabilityAdapter';

const point = (id: number, x = id, y = id, wkid = 4326) => ({
  attributes: { OBJECTID: id, NAME: `Point ${id}` },
  geometry: { x, y, spatialReference: { wkid } },
});

const capabilities: ArcGisServiceCapabilities = {
  kind: 'feature-server',
  geometryType: 'point',
  name: 'Places',
  objectIdField: 'OBJECTID',
  globalIdField: null,
  maxRecordCount: 1_000,
  spatialReferenceWkid: 4326,
  supportsQuery: true,
  supportsPagination: true,
  supportsOrderBy: true,
  supportsDistinct: true,
  supportsStatistics: true,
  supportsHavingClause: true,
  supportsSqlExpression: true,
  supportsReturningQueryExtent: true,
  supportsDistanceQuery: true,
  supportsCreate: false,
  supportsUpdate: false,
  supportsDelete: false,
  supportsSync: false,
  allowsGeometryUpdates: false,
  hasZ: false,
  hasM: false,
  hasTime: false,
  fieldNames: ['OBJECTID', 'NAME'],
  relationshipCount: 0,
  indexCount: 1,
  warnings: [],
};

describe('spatialIntegrityRuntime', () => {
  it('derives validation configuration from service capabilities without inventing fields', () => {
    const configuration = configurationFromCapabilities(capabilities, { mode: 'strict' });
    expect(configuration).toMatchObject({
      mode: 'strict',
      expectedGeometryType: 'point',
      expectedWkid: 4326,
      objectIdField: 'OBJECTID',
      allowedFields: ['OBJECTID', 'NAME'],
    });
  });

  it('accepts valid point batches and returns deterministic fingerprints', () => {
    const runtime = createSpatialIntegrityRuntime(configurationFromCapabilities(capabilities));
    const input = [point(1), point(2)];

    const first = runtime.inspectBatch(input);
    const second = runtime.inspectBatch(input);

    expect(first.valid).toBe(true);
    expect(first.accepted).toHaveLength(2);
    expect(first.quarantined).toHaveLength(0);
    expect(first.totalVertices).toBe(2);
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.records.every((record) => record.valid)).toBe(true);
  });

  it('quarantines non-finite or unrecognized geometries before rendering', () => {
    const runtime = createSpatialIntegrityRuntime(configurationFromCapabilities(capabilities));
    const result = runtime.inspectBatch([
      point(1),
      { attributes: { OBJECTID: 2, NAME: 'Broken' }, geometry: { x: Number.NaN, y: 2 } },
    ]);

    expect(result.accepted).toHaveLength(1);
    expect(result.quarantined).toHaveLength(1);
    expect(result.findings.some((item) => item.code === 'geometry-kind-unknown')).toBe(true);
    expect(result.valid).toBe(false);
  });

  it('detects geometry type mismatches and spatial reference mismatches', () => {
    const runtime = createSpatialIntegrityRuntime(configurationFromCapabilities(capabilities));
    const result = runtime.inspectBatch([
      {
        attributes: { OBJECTID: 3, NAME: 'Polygon' },
        geometry: {
          rings: [[[0, 0], [1, 0], [1, 1], [0, 0]]],
          spatialReference: { wkid: 3857 },
        },
      },
    ]);

    expect(result.quarantined).toHaveLength(1);
    expect(result.findings.map((item) => item.code)).toEqual(expect.arrayContaining([
      'geometry-type-mismatch',
      'spatial-reference-mismatch',
    ]));
  });

  it('detects duplicate stable object ids', () => {
    const runtime = createSpatialIntegrityRuntime(configurationFromCapabilities(capabilities));
    const result = runtime.inspectBatch([point(7), point(7, 8, 9)]);

    expect(result.duplicateObjectIds).toEqual([7]);
    expect(result.findings.some((item) => item.code === 'duplicate-object-id')).toBe(true);
    expect(result.quarantined).toHaveLength(1);
  });

  it('enforces required fields and flags attributes outside an allowlist', () => {
    const runtime = createSpatialIntegrityRuntime({
      ...configurationFromCapabilities(capabilities),
      requiredFields: ['OBJECTID', 'NAME'],
    });
    const result = runtime.inspectBatch([{
      attributes: { OBJECTID: 1, EXTRA: 'unexpected' },
      geometry: { x: 1, y: 1, spatialReference: { wkid: 4326 } },
    }]);

    expect(result.findings.map((item) => item.code)).toEqual(expect.arrayContaining([
      'required-field-missing',
      'field-not-allowlisted',
    ]));
    expect(result.quarantined).toHaveLength(1);
  });

  it('bounds feature batch size and reports truncation', () => {
    const runtime = createSpatialIntegrityRuntime({
      ...configurationFromCapabilities(capabilities),
      maxFeatures: 2,
    });
    const result = runtime.inspectBatch([point(1), point(2), point(3)]);

    expect(result.records).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.findings.some((item) => item.code === 'feature-batch-budget-exceeded')).toBe(true);
  });

  it('bounds per-feature vertices and quarantines pathological geometry payloads', () => {
    const runtime = createSpatialIntegrityRuntime({
      mode: 'quarantine',
      objectIdField: 'OBJECTID',
      expectedGeometryType: 'polyline',
      maxVerticesPerFeature: 3,
    });
    const result = runtime.inspectBatch([{
      attributes: { OBJECTID: 1 },
      geometry: { paths: [[[0, 0], [1, 1], [2, 2], [3, 3]]] },
    }]);

    expect(result.records[0]?.vertexCount).toBe(4);
    expect(result.findings.some((item) => item.code === 'feature-vertex-budget-exceeded')).toBe(true);
    expect(result.quarantined).toHaveLength(1);
  });

  it('bounds total vertices across a batch and stops non-audit processing', () => {
    const runtime = createSpatialIntegrityRuntime({
      mode: 'quarantine',
      objectIdField: 'OBJECTID',
      expectedGeometryType: 'polyline',
      maxTotalVertices: 5,
      maxVerticesPerFeature: 10,
    });
    const makeLine = (id: number) => ({
      attributes: { OBJECTID: id },
      geometry: { paths: [[[0, 0], [1, 1], [2, 2]]] },
    });
    const result = runtime.inspectBatch([makeLine(1), makeLine(2), makeLine(3)]);

    expect(result.records.length).toBeLessThan(3);
    expect(result.findings.some((item) => item.code === 'batch-vertex-budget-exceeded')).toBe(true);
  });

  it('detects extent ordering corruption', () => {
    const runtime = createSpatialIntegrityRuntime({
      mode: 'quarantine',
      objectIdField: 'OBJECTID',
      expectedGeometryType: 'extent',
    });
    const result = runtime.inspectBatch([{
      attributes: { OBJECTID: 1 },
      geometry: { xmin: 10, ymin: 0, xmax: 5, ymax: 20 },
    }]);

    expect(result.findings.some((item) => item.code === 'extent-order-invalid')).toBe(true);
    expect(result.quarantined).toHaveLength(1);
  });

  it('audit mode records errors without removing features', () => {
    const runtime = createSpatialIntegrityRuntime({
      mode: 'audit',
      objectIdField: 'OBJECTID',
      expectedGeometryType: 'point',
    });
    const broken = { attributes: { OBJECTID: 1 }, geometry: { x: Number.NaN, y: 1 } };
    const result = runtime.inspectBatch([broken]);

    expect(result.valid).toBe(false);
    expect(result.accepted).toEqual([broken]);
    expect(result.quarantined).toHaveLength(0);
  });

  it('strict mode stops on the first invalid record', () => {
    const runtime = createSpatialIntegrityRuntime({
      mode: 'strict',
      objectIdField: 'OBJECTID',
      expectedGeometryType: 'point',
    });
    const result = runtime.inspectBatch([
      { attributes: { OBJECTID: 1 }, geometry: { bad: true } },
      point(2),
    ]);

    expect(result.records).toHaveLength(1);
    expect(result.quarantined).toHaveLength(1);
  });

  it('exposes cumulative metrics and supports reset without changing configuration', () => {
    const runtime = new SpatialIntegrityRuntime(configurationFromCapabilities(capabilities));
    runtime.inspectBatch([point(1), point(2)]);
    runtime.inspectBatch([point(3)]);

    expect(runtime.snapshot()).toMatchObject({
      batches: 2,
      inspectedFeatures: 3,
      acceptedFeatures: 3,
      quarantinedFeatures: 0,
      totalVertices: 3,
    });

    runtime.resetMetrics();
    expect(runtime.snapshot()).toMatchObject({ batches: 0, inspectedFeatures: 0, totalVertices: 0 });
  });

  it('rejects work after disposal', () => {
    const runtime = createSpatialIntegrityRuntime(configurationFromCapabilities(capabilities));
    runtime.dispose();

    expect(() => runtime.inspectBatch([point(1)])).toThrow(/disposed/);
    expect(runtime.snapshot().disposed).toBe(true);
  });
});
