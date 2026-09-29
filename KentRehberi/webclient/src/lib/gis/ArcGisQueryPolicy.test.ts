import { describe, expect, it } from 'vitest';
import { planArcGisQuery, type ArcGisQueryRequest } from './ArcGisQueryPolicy';

const request = (overrides: Partial<ArcGisQueryRequest> = {}): ArcGisQueryRequest => ({
  expectedRevision: 4,
  mapScale: 10_000,
  fields: ['OBJECTID', 'name'],
  sort: [{ field: 'name', order: 'asc' }],
  resultOffset: 0,
  resultLimit: 25,
  returnGeometry: false,
  layers: [{
    id: 'parks',
    revision: 4,
    visible: true,
    queryable: true,
    priority: 1,
    allowedFields: ['OBJECTID', 'name', 'district'],
  }],
  ...overrides,
});

describe('planArcGisQuery', () => {
  it('builds an immutable deterministic plan', () => {
    const first = planArcGisQuery(request());
    const second = planArcGisQuery(request());
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.plan.fingerprint).toBe(second.plan.fingerprint);
    expect(Object.isFrozen(first.plan)).toBe(true);
    expect(Object.isFrozen(first.plan.layers)).toBe(true);
    expect(Object.isFrozen(first.plan.layers[0])).toBe(true);
    expect(Object.isFrozen(first.plan.layers[0]?.fields)).toBe(true);
    expect(Object.isFrozen(first.plan.layers[0]?.sort)).toBe(true);
  });

  it('orders admitted layers by priority then id', () => {
    const decision = planArcGisQuery(request({
      layers: [
        { id: 'z', revision: 4, visible: true, queryable: true, priority: 2, allowedFields: ['name', 'OBJECTID'] },
        { id: 'a', revision: 4, visible: true, queryable: true, priority: 2, allowedFields: ['OBJECTID', 'name'] },
        { id: 'b', revision: 4, visible: true, queryable: true, priority: 1, allowedFields: ['OBJECTID', 'name'] },
      ],
    }));
    expect(decision.ok && decision.plan.layers.map(({ id }) => id)).toEqual(['a', 'z', 'b']);
  });

  it('canonicalizes requested field spelling through each layer contract', () => {
    const decision = planArcGisQuery(request({ fields: [' name ', 'objectid'] }));
    expect(decision.ok && decision.plan.layers[0]?.fields).toEqual(['name', 'OBJECTID']);
  });

  it.each([
    [{ expectedRevision: -1 }, 'invalid-revision'],
    [{ mapScale: 0 }, 'invalid-map-scale'],
    [{ resultOffset: -1 }, 'offset-budget-exceeded'],
    [{ resultLimit: 0 }, 'result-budget-exceeded'],
    [{ fields: [] }, 'invalid-fields'],
    [{ fields: ['name', ' NAME '] }, 'invalid-fields'],
  ] as const)('rejects invalid request boundary %#', (override, reason) => {
    expect(planArcGisQuery(request(override))).toEqual({ ok: false, reason });
  });

  it('rejects stale layer revisions', () => {
    expect(planArcGisQuery(request({ layers: [{ id: 'parks', revision: 3, visible: true, queryable: true, allowedFields: ['OBJECTID', 'name'] }] })))
      .toEqual({ ok: false, reason: 'stale-layer-revision' });
  });

  it('rejects duplicate normalized layer ids', () => {
    expect(planArcGisQuery(request({ layers: [
      { id: 'parks', revision: 4, visible: true, queryable: true, allowedFields: ['OBJECTID', 'name'] },
      { id: ' parks ', revision: 4, visible: true, queryable: true, allowedFields: ['OBJECTID', 'name'] },
    ] }))).toEqual({ ok: false, reason: 'duplicate-layer' });
  });

  it('rejects fields outside the layer contract', () => {
    expect(planArcGisQuery(request({ fields: ['secret'] }))).toEqual({ ok: false, reason: 'field-not-allowed' });
  });

  it('rejects sort fields outside the layer contract', () => {
    expect(planArcGisQuery(request({ sort: [{ field: 'secret', order: 'desc' }] })))
      .toEqual({ ok: false, reason: 'sort-field-not-allowed' });
  });

  it('rejects duplicate sort fields case-insensitively', () => {
    expect(planArcGisQuery(request({ sort: [{ field: 'name', order: 'asc' }, { field: ' NAME ', order: 'desc' }] })))
      .toEqual({ ok: false, reason: 'invalid-sort' });
  });

  it('filters invisible and non-queryable layers but requires one admitted layer', () => {
    expect(planArcGisQuery(request({ layers: [
      { id: 'hidden', revision: 4, visible: false, queryable: true, allowedFields: ['OBJECTID', 'name'] },
      { id: 'locked', revision: 4, visible: true, queryable: false, allowedFields: ['OBJECTID', 'name'] },
    ] }))).toEqual({ ok: false, reason: 'no-queryable-layers' });
  });

  it('honors ArcGIS scale ranges', () => {
    expect(planArcGisQuery(request({ layers: [
      { id: 'parks', revision: 4, visible: true, queryable: true, minScale: 5_000, allowedFields: ['OBJECTID', 'name'] },
    ] }))).toEqual({ ok: false, reason: 'no-queryable-layers' });
  });

  it('fails closed when estimated response bytes exceed budget', () => {
    expect(planArcGisQuery(request(), {
      maxLayers: 2,
      maxFields: 4,
      maxSortFields: 2,
      maxOffset: 100,
      maxResultLimit: 50,
      maxEstimatedResponseBytes: 100,
      estimatedBytesPerFeature: 10,
    })).toEqual({ ok: false, reason: 'response-byte-budget-exceeded' });
  });

  it('rejects malformed layer field contracts', () => {
    expect(planArcGisQuery(request({ layers: [{
      id: 'parks', revision: 4, visible: true, queryable: true, allowedFields: ['name', ' NAME ', 'OBJECTID'],
    }] }))).toEqual({ ok: false, reason: 'invalid-layer-field-contract' });
  });

  it('rejects an empty layer field contract', () => {
    expect(planArcGisQuery(request({ layers: [{ id: 'parks', revision: 4, visible: true, queryable: true, allowedFields: [] }] })))
      .toEqual({ ok: false, reason: 'empty-layer-field-contract' });
  });

  it('changes fingerprint when query semantics change', () => {
    const first = planArcGisQuery(request());
    const second = planArcGisQuery(request({ resultOffset: 25 }));
    expect(first.ok && second.ok && first.plan.fingerprint).not.toBe(second.ok && second.plan.fingerprint);
  });

  it('does not mutate caller-owned collections', () => {
    const fields = ['name', 'OBJECTID'];
    const layers = [{ id: 'parks', revision: 4, visible: true, queryable: true, allowedFields: ['name', 'OBJECTID'] }];
    const beforeFields = [...fields];
    const beforeAllowed = [...layers[0].allowedFields];
    planArcGisQuery(request({ fields, layers }));
    expect(fields).toEqual(beforeFields);
    expect(layers[0].allowedFields).toEqual(beforeAllowed);
  });
});
