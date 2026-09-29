import { describe, expect, it } from 'vitest';
import { planArcGisProximity, type ArcGisProximityRequest } from './ArcGisProximityPolicy';

const request = (overrides: Partial<ArcGisProximityRequest> = {}): ArcGisProximityRequest => ({
  mode: 'nearest',
  viewMode: '2d',
  origin: { x: 3650000, y: 4850000, spatialReferenceWkid: 102100 },
  distanceMeters: 2_500,
  maxResults: 20,
  mapScale: 10_000,
  expectedRevision: 7,
  layers: [
    { id: 'roads', revision: 7, priority: 1, visible: true, queryable: true },
    { id: 'poi', revision: 7, priority: 5, visible: true, queryable: true },
  ],
  ...overrides,
});

describe('planArcGisProximity', () => {
  it('canonicalizes Web Mercator aliases and orders layers deterministically', () => {
    const result = planArcGisProximity(request());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.spatialReferenceWkid).toBe(3857);
    expect(result.plan.origin.spatialReferenceWkid).toBe(3857);
    expect(result.plan.layerIds).toEqual(['poi', 'roads']);
  });

  it('keeps deterministic fingerprints for equivalent requests', () => {
    const first = planArcGisProximity(request());
    const second = planArcGisProximity(request());
    expect(first.ok && second.ok && first.plan.fingerprint).toBe(second.ok && second.plan.fingerprint);
  });

  it('changes fingerprints when spatial intent changes', () => {
    const first = planArcGisProximity(request());
    const second = planArcGisProximity(request({ distanceMeters: 2_501 }));
    expect(first.ok && second.ok && first.plan.fingerprint).not.toBe(second.ok && second.plan.fingerprint);
  });

  it('rejects stale layer revisions', () => {
    const result = planArcGisProximity(request({ layers: [{ id: 'poi', revision: 6, visible: true, queryable: true }] }));
    expect(result).toEqual({ ok: false, reason: 'stale-layer-revision' });
  });

  it('rejects duplicate canonical layer ids', () => {
    const result = planArcGisProximity(request({ layers: [
      { id: 'poi', revision: 7, visible: true, queryable: true },
      { id: ' poi ', revision: 7, visible: true, queryable: true },
    ] }));
    expect(result).toEqual({ ok: false, reason: 'duplicate-layer' });
  });

  it('filters hidden, non-queryable and out-of-scale layers', () => {
    const result = planArcGisProximity(request({ layers: [
      { id: 'hidden', revision: 7, visible: false, queryable: true },
      { id: 'blocked', revision: 7, visible: true, queryable: false },
      { id: 'small-scale-only', revision: 7, visible: true, queryable: true, maxScale: 20_000 },
      { id: 'accepted', revision: 7, visible: true, queryable: true },
    ] }));
    expect(result.ok && result.plan.layerIds).toEqual(['accepted']);
  });

  it('rejects requests without any admitted queryable layer', () => {
    expect(planArcGisProximity(request({ layers: [{ id: 'hidden', revision: 7, visible: false, queryable: true }] })))
      .toEqual({ ok: false, reason: 'no-queryable-layers' });
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid distance %s', (distanceMeters) => {
    expect(planArcGisProximity(request({ distanceMeters })).ok).toBe(false);
  });

  it('enforces distance budget', () => {
    expect(planArcGisProximity(request({ distanceMeters: 50_001 })))
      .toEqual({ ok: false, reason: 'distance-budget-exceeded' });
  });

  it('enforces result cardinality budget', () => {
    expect(planArcGisProximity(request({ maxResults: 501 })))
      .toEqual({ ok: false, reason: 'result-budget-exceeded' });
  });

  it('enforces layer cardinality budget', () => {
    const layers = Array.from({ length: 13 }, (_, index) => ({
      id: `layer-${index}`, revision: 7, visible: true, queryable: true,
    }));
    expect(planArcGisProximity(request({ layers }))).toEqual({ ok: false, reason: 'layer-budget-exceeded' });
  });

  it('enforces estimated response byte budget before transport', () => {
    const result = planArcGisProximity(request({ maxResults: 500 }), {
      maxDistanceMeters: 50_000,
      maxResults: 500,
      maxLayers: 12,
      maxEstimatedResponseBytes: 1_000,
      estimatedBytesPerFeature: 2_048,
    });
    expect(result).toEqual({ ok: false, reason: 'response-byte-budget-exceeded' });
  });

  it('rejects malformed coordinates', () => {
    expect(planArcGisProximity(request({ origin: { x: Number.NaN, y: 1, spatialReferenceWkid: 3857 } })))
      .toEqual({ ok: false, reason: 'invalid-origin' });
  });

  it('rejects invalid spatial references', () => {
    expect(planArcGisProximity(request({ origin: { x: 1, y: 1, spatialReferenceWkid: 0 } })))
      .toEqual({ ok: false, reason: 'invalid-spatial-reference' });
  });

  it('rejects z coordinates in 2d mode', () => {
    expect(planArcGisProximity(request({ origin: { x: 1, y: 1, z: 5, spatialReferenceWkid: 3857 } })))
      .toEqual({ ok: false, reason: '2d-origin-has-z' });
  });

  it('admits z coordinates in 3d mode', () => {
    const result = planArcGisProximity(request({ viewMode: '3d', origin: { x: 1, y: 1, z: 5, spatialReferenceWkid: 3857 } }));
    expect(result.ok).toBe(true);
  });

  it('returns immutable plan graph', () => {
    const result = planArcGisProximity(request());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.isFrozen(result.plan)).toBe(true);
    expect(Object.isFrozen(result.plan.origin)).toBe(true);
    expect(Object.isFrozen(result.plan.layerIds)).toBe(true);
  });

  it('does not retain mutable request arrays', () => {
    const layers = [{ id: 'poi', revision: 7, visible: true, queryable: true }];
    const result = planArcGisProximity(request({ layers }));
    layers[0] = { id: 'changed', revision: 7, visible: true, queryable: true };
    expect(result.ok && result.plan.layerIds).toEqual(['poi']);
  });
});
