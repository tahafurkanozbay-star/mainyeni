import { describe, expect, it } from 'vitest';
import { ArcGisServiceCapabilityPolicy } from './ArcGisServiceCapabilityPolicy';

const policy = new ArcGisServiceCapabilityPolicy({ maxRecordCountCeiling: 2_000 });

describe('ArcGisServiceCapabilityPolicy', () => {
  it('admits advertised query capabilities with a bounded record budget', () => {
    const snapshot = policy.admit({
      serviceKind: 'MapServer',
      layerKind: 'map-image',
      layerId: 3,
      maxRecordCount: 5_000,
      capabilities: 'Map, Query, Data',
      advancedQueryCapabilities: {
        supportsPagination: true,
        supportsOrderBy: true,
        supportsStatistics: true,
        supportsDistinct: true,
      },
      objectIdField: 'OBJECTID',
    });

    expect(snapshot.maxRecordCount).toBe(2_000);
    expect([...snapshot.operations]).toEqual([
      'query',
      'identify',
      'statistics',
      'pagination',
      'orderBy',
      'distinct',
    ]);
    expect(policy.decide(snapshot, 'query').allowed).toBe(true);
    expect(policy.clampRequestedRecordCount(snapshot, 10_000)).toBe(2_000);
  });

  it('fails closed when query is not advertised', () => {
    const snapshot = policy.admit({
      serviceKind: 'MapServer',
      layerKind: 'map-image',
      layerId: 0,
      maxRecordCount: 1_000,
      capabilities: 'Map',
    });

    expect(policy.decide(snapshot, 'query')).toMatchObject({
      allowed: false,
      reason: 'operation-not-advertised:query',
    });
  });

  it('requires FeatureServer feature semantics before admitting edits', () => {
    const map = policy.admit({
      serviceKind: 'MapServer',
      layerKind: 'feature',
      layerId: 1,
      maxRecordCount: 500,
      capabilities: 'Query,Editing,Create,Update,Delete',
      editing: { supportsAdd: true, supportsUpdate: true, supportsDelete: true },
      objectIdField: 'OBJECTID',
    });
    expect(map.operations.has('create')).toBe(false);

    const feature = policy.admit({
      serviceKind: 'FeatureServer',
      layerKind: 'feature',
      layerId: 1,
      maxRecordCount: 500,
      capabilities: 'Query,Editing',
      editing: { supportsAdd: true, supportsUpdate: true, supportsDelete: true },
      objectIdField: 'OBJECTID',
    });
    expect(feature.operations.has('create')).toBe(true);
    expect(feature.operations.has('update')).toBe(true);
    expect(feature.operations.has('delete')).toBe(true);
  });

  it('requires a stable mutation identity for update and delete', () => {
    const snapshot = policy.admit({
      serviceKind: 'FeatureServer',
      layerKind: 'feature',
      layerId: 2,
      maxRecordCount: 500,
      capabilities: 'Query,Editing',
      editing: { supportsUpdate: true, supportsDelete: true },
    });

    expect(policy.decide(snapshot, 'update')).toMatchObject({ allowed: false, reason: 'mutation-identity-missing' });
    expect(policy.decide(snapshot, 'delete')).toMatchObject({ allowed: false, reason: 'mutation-identity-missing' });
  });

  it('accepts a valid global id as mutation identity', () => {
    const snapshot = policy.admit({
      serviceKind: 'FeatureServer',
      layerKind: 'feature',
      layerId: 2,
      maxRecordCount: 500,
      capabilities: 'Query,Editing',
      editing: { supportsUpdate: true },
      globalIdField: 'GlobalID',
    });
    expect(policy.decide(snapshot, 'update').allowed).toBe(true);
  });

  it('sanitizes invalid field names rather than trusting metadata', () => {
    const snapshot = policy.admit({
      serviceKind: 'FeatureServer',
      layerKind: 'feature',
      layerId: 4,
      maxRecordCount: 100,
      capabilities: 'Query,Editing',
      editing: { supportsUpdate: true },
      objectIdField: 'OBJECTID;DROP TABLE x',
    });
    expect(snapshot.objectIdField).toBeNull();
    expect(policy.decide(snapshot, 'update').allowed).toBe(false);
  });

  it('rejects invalid layer ids', () => {
    expect(() => policy.admit({
      serviceKind: 'MapServer',
      layerKind: 'map-image',
      layerId: -1,
      capabilities: 'Query',
    })).toThrow('layerId');
  });

  it('rejects inverted ArcGIS scale ranges', () => {
    expect(() => policy.admit({
      serviceKind: 'MapServer',
      layerKind: 'map-image',
      layerId: 1,
      capabilities: 'Query',
      minScale: 1_000,
      maxScale: 10_000,
    })).toThrow('scale range');
  });

  it('evaluates ArcGIS visibility scales deterministically', () => {
    const snapshot = policy.admit({
      serviceKind: 'MapServer',
      layerKind: 'map-image',
      layerId: 1,
      capabilities: 'Query',
      maxRecordCount: 100,
      minScale: 100_000,
      maxScale: 5_000,
    });
    expect(policy.isVisibleAtScale(snapshot, 200_000)).toBe(false);
    expect(policy.isVisibleAtScale(snapshot, 50_000)).toBe(true);
    expect(policy.isVisibleAtScale(snapshot, 1_000)).toBe(false);
    expect(policy.isVisibleAtScale(snapshot, Number.NaN)).toBe(false);
  });

  it('fails closed when capability metadata exceeds its token budget', () => {
    const strict = new ArcGisServiceCapabilityPolicy({ maxCapabilityTokens: 2 });
    const snapshot = strict.admit({
      serviceKind: 'FeatureServer',
      layerKind: 'feature',
      layerId: 1,
      maxRecordCount: 100,
      capabilities: ['Query', 'Editing', 'Update'],
      editing: { supportsUpdate: true },
      objectIdField: 'OBJECTID',
    });
    expect(snapshot.operations.size).toBe(0);
  });

  it('does not infer advanced operations without query capability', () => {
    const snapshot = policy.admit({
      serviceKind: 'MapServer',
      layerKind: 'map-image',
      layerId: 1,
      maxRecordCount: 100,
      capabilities: 'Map',
      advancedQueryCapabilities: {
        supportsPagination: true,
        supportsOrderBy: true,
        supportsStatistics: true,
        supportsDistinct: true,
      },
    });
    expect(snapshot.operations.size).toBe(0);
  });

  it('keeps table identify disabled while allowing table query', () => {
    const snapshot = policy.admit({
      serviceKind: 'FeatureServer',
      layerKind: 'table',
      layerId: 7,
      maxRecordCount: 250,
      capabilities: 'Query',
    });
    expect(snapshot.operations.has('query')).toBe(true);
    expect(snapshot.operations.has('identify')).toBe(false);
  });

  it('returns zero for malformed requested record counts', () => {
    const snapshot = policy.admit({
      serviceKind: 'MapServer',
      layerKind: 'map-image',
      layerId: 1,
      maxRecordCount: 100,
      capabilities: 'Query',
    });
    expect(policy.clampRequestedRecordCount(snapshot, 0)).toBe(0);
    expect(policy.clampRequestedRecordCount(snapshot, 1.5)).toBe(0);
    expect(policy.clampRequestedRecordCount(snapshot, Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('fails query decisions when the service omitted a usable record budget', () => {
    const snapshot = policy.admit({
      serviceKind: 'MapServer',
      layerKind: 'map-image',
      layerId: 1,
      capabilities: 'Query',
    });
    expect(policy.decide(snapshot, 'query')).toMatchObject({ allowed: false, reason: 'record-budget-missing' });
  });

  it('validates policy budgets at construction time', () => {
    expect(() => new ArcGisServiceCapabilityPolicy({ maxRecordCountCeiling: 0 })).toThrow();
    expect(() => new ArcGisServiceCapabilityPolicy({ maxCapabilityTokens: 0 })).toThrow();
    expect(() => new ArcGisServiceCapabilityPolicy({ maxFieldNameLength: 0 })).toThrow();
  });
});
