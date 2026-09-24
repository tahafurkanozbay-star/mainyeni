import { describe, expect, it } from 'vitest';
import { ArcGisLayerCapabilityPolicy, type ArcGisLayerCapabilities } from './arcgisLayerCapabilityPolicy';

const capabilities = (overrides: Partial<ArcGisLayerCapabilities> = {}): ArcGisLayerCapabilities => ({
  serviceKind: 'feature',
  supportsQuery: true,
  supportsPagination: true,
  supportsOrderBy: true,
  supportsStatistics: true,
  supportsDistinct: true,
  supportsReturningGeometry: true,
  supportsQuantization: true,
  supportsClustering: true,
  supportsZ: true,
  maxRecordCount: 1_000,
  objectIdField: 'OBJECTID',
  ...overrides,
});

describe('ArcGisLayerCapabilityPolicy', () => {
  it('builds a bounded plan from verified capability facts', () => {
    const policy = new ArcGisLayerCapabilityPolicy();
    const plan = policy.plan(capabilities(), {
      operation: 'features', requestedRecordCount: 5_000, returnGeometry: true, quantize: true,
    });
    expect(plan.allowed).toBe(true);
    expect(plan.pageSize).toBe(1_000);
    expect(plan.usePagination).toBe(true);
    expect(plan.useQuantization).toBe(true);
    expect(plan.stableIdField).toBe('OBJECTID');
  });

  it('fails closed when query support is not advertised', () => {
    const policy = new ArcGisLayerCapabilityPolicy();
    const plan = policy.plan(capabilities({ supportsQuery: false }), { operation: 'features' });
    expect(plan.allowed).toBe(false);
    expect(plan.reasons).toContain('service metadata does not advertise query support');
  });

  it('rejects non-feature query service kinds', () => {
    const policy = new ArcGisLayerCapabilityPolicy();
    expect(policy.plan(capabilities({ serviceKind: 'tile' }), { operation: 'features' }).allowed).toBe(false);
    expect(policy.plan(capabilities({ serviceKind: 'vector-tile' }), { operation: 'count' }).allowed).toBe(false);
  });

  it('does not infer optional capabilities from service kind', () => {
    const policy = new ArcGisLayerCapabilityPolicy();
    const sparse = capabilities({
      supportsPagination: undefined,
      supportsOrderBy: undefined,
      supportsStatistics: undefined,
      supportsDistinct: undefined,
      supportsReturningGeometry: undefined,
      supportsQuantization: undefined,
    });
    const plan = policy.plan(sparse, {
      operation: 'statistics',
      requestedRecordCount: 5_000,
      returnGeometry: true,
      orderBy: ['NAME ASC'],
      statistics: ['COUNT(*)'],
      distinct: true,
      quantize: true,
      requireStablePaging: true,
    });
    expect(plan.allowed).toBe(false);
    expect(plan.reasons.length).toBeGreaterThanOrEqual(5);
  });

  it('requires a stable identity when stable pagination is mandatory', () => {
    const policy = new ArcGisLayerCapabilityPolicy();
    const plan = policy.plan(capabilities({ objectIdField: undefined, globalIdField: undefined }), {
      operation: 'features', requestedRecordCount: 5_000, requireStablePaging: true,
    });
    expect(plan.allowed).toBe(false);
    expect(plan.reasons).toContain('stable paging requires a verified object/global id field');
  });

  it('uses global id as a verified stable fallback', () => {
    const policy = new ArcGisLayerCapabilityPolicy();
    const plan = policy.plan(capabilities({ objectIdField: undefined, globalIdField: 'GLOBALID' }), {
      operation: 'features', requestedRecordCount: 5_000, requireStablePaging: true,
    });
    expect(plan.allowed).toBe(true);
    expect(plan.stableIdField).toBe('GLOBALID');
  });

  it('caps page size by advertised and hard limits', () => {
    const policy = new ArcGisLayerCapabilityPolicy({ hardMaxPageSize: 750, defaultPageSize: 500 });
    expect(policy.plan(capabilities({ maxRecordCount: 10_000 }), {
      operation: 'features', requestedRecordCount: 8_000,
    }).pageSize).toBe(750);
  });

  it('honors maxRecordCountFactor without exceeding hard limit', () => {
    const policy = new ArcGisLayerCapabilityPolicy({ hardMaxPageSize: 5_000 });
    expect(policy.plan(capabilities({ maxRecordCount: 1_000, maxRecordCountFactor: 2 }), {
      operation: 'features', requestedRecordCount: 4_000,
    }).pageSize).toBe(2_000);
  });

  it('rejects geometry payloads for count, ids and extent operations', () => {
    const policy = new ArcGisLayerCapabilityPolicy();
    for (const operation of ['count', 'ids', 'extent'] as const) {
      expect(policy.plan(capabilities(), { operation, returnGeometry: true }).allowed).toBe(false);
    }
  });

  it('requires a statistic expression for statistics operation', () => {
    const policy = new ArcGisLayerCapabilityPolicy();
    const plan = policy.plan(capabilities(), { operation: 'statistics' });
    expect(plan.allowed).toBe(false);
    expect(plan.reasons).toContain('statistics operation requires at least one statistic expression');
  });

  it('bounds order and statistic expression counts', () => {
    const policy = new ArcGisLayerCapabilityPolicy({ maxOrderByFields: 1, maxStatistics: 1 });
    expect(() => policy.plan(capabilities(), { operation: 'features', orderBy: ['A', 'B'] })).toThrow();
    expect(() => policy.plan(capabilities(), { operation: 'statistics', statistics: ['A', 'B'] })).toThrow();
  });

  it('exposes clustering and z rendering only from explicit facts', () => {
    const policy = new ArcGisLayerCapabilityPolicy();
    expect(policy.canCluster(capabilities())).toBe(true);
    expect(policy.canCluster(capabilities({ supportsClustering: undefined }))).toBe(false);
    expect(policy.canCluster(capabilities({ serviceKind: 'scene' }))).toBe(false);
    expect(policy.canRenderZ(capabilities())).toBe(true);
    expect(policy.canRenderZ(capabilities({ supportsZ: undefined }))).toBe(false);
  });

  it('validates unsafe metadata values and configuration', () => {
    expect(() => new ArcGisLayerCapabilityPolicy({ defaultPageSize: 2_000, hardMaxPageSize: 1_000 })).toThrow();
    const policy = new ArcGisLayerCapabilityPolicy();
    expect(() => policy.plan(capabilities({ maxRecordCount: 0 }), { operation: 'features' })).toThrow();
    expect(() => policy.plan(capabilities({ maxRecordCountFactor: 101 }), { operation: 'features' })).toThrow();
    expect(() => policy.plan(capabilities({ objectIdField: 'x'.repeat(129) }), { operation: 'features' })).toThrow();
  });

  it('returns immutable plan and reasons', () => {
    const policy = new ArcGisLayerCapabilityPolicy();
    const plan = policy.plan(capabilities(), { operation: 'count' });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.reasons)).toBe(true);
  });

  it('keeps explicit unknown capability facts fail-closed under exact optional typing', () => {
    const policy = new ArcGisLayerCapabilityPolicy();
    const unknown = capabilities({
      supportsPagination: undefined,
      supportsOrderBy: undefined,
      supportsStatistics: undefined,
      supportsDistinct: undefined,
      supportsReturningGeometry: undefined,
      supportsQuantization: undefined,
      supportsClustering: undefined,
      supportsZ: undefined,
      maxRecordCount: undefined,
      maxRecordCountFactor: undefined,
      objectIdField: undefined,
      globalIdField: undefined,
    });
    const plan = policy.plan(unknown, {
      operation: 'features',
      requestedRecordCount: 5_000,
      returnGeometry: true,
      orderBy: ['NAME ASC'],
      distinct: true,
      quantize: true,
      requireStablePaging: true,
    });
    expect(plan.allowed).toBe(false);
    expect(plan.usePagination).toBe(false);
    expect(plan.pageSize).toBe(500);
    expect(plan.stableIdField).toBeUndefined();
    expect(policy.canCluster(unknown)).toBe(false);
    expect(policy.canRenderZ(unknown)).toBe(false);
  });

  it('normalizes verified identity fields before exposing a stable paging key', () => {
    const policy = new ArcGisLayerCapabilityPolicy();
    const objectIdPlan = policy.plan(capabilities({ objectIdField: '  OBJECTID  ' }), {
      operation: 'features', requestedRecordCount: 2_000, requireStablePaging: true,
    });
    const globalIdPlan = policy.plan(capabilities({ objectIdField: '   ', globalIdField: '  GLOBALID  ' }), {
      operation: 'features', requestedRecordCount: 2_000, requireStablePaging: true,
    });
    expect(objectIdPlan.allowed).toBe(true);
    expect(objectIdPlan.stableIdField).toBe('OBJECTID');
    expect(globalIdPlan.allowed).toBe(true);
    expect(globalIdPlan.stableIdField).toBe('GLOBALID');
  });

  it('does not paginate a request that fits inside the admitted page', () => {
    const policy = new ArcGisLayerCapabilityPolicy();
    const plan = policy.plan(capabilities({ maxRecordCount: 2_000 }), {
      operation: 'features', requestedRecordCount: 750, requireStablePaging: true,
    });
    expect(plan.allowed).toBe(true);
    expect(plan.pageSize).toBe(750);
    expect(plan.usePagination).toBe(false);
  });

  it('fails stable paging closed when pagination support is explicitly false', () => {
    const policy = new ArcGisLayerCapabilityPolicy();
    const plan = policy.plan(capabilities({ supportsPagination: false }), {
      operation: 'features', requestedRecordCount: 5_000, requireStablePaging: true,
    });
    expect(plan.allowed).toBe(false);
    expect(plan.usePagination).toBe(false);
    expect(plan.reasons).toContain('stable paging was required but pagination is not explicitly supported');
  });

  it('keeps render capability checks independent from query admission', () => {
    const policy = new ArcGisLayerCapabilityPolicy();
    const nonQueryable = capabilities({ supportsQuery: false, supportsClustering: true, supportsZ: true });
    expect(policy.plan(nonQueryable, { operation: 'features' }).allowed).toBe(false);
    expect(policy.canCluster(nonQueryable)).toBe(true);
    expect(policy.canRenderZ(nonQueryable)).toBe(true);
  });
});
