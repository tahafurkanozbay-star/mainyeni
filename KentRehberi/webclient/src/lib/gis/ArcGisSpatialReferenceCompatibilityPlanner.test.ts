import { describe, expect, it } from 'vitest';
import {
  ArcGisSpatialReferenceCompatibilityPlanner,
  type ArcGisSpatialReferenceCompatibilityPolicy,
  type ArcGisSpatialReferenceCompatibilityRequest,
} from './ArcGisSpatialReferenceCompatibilityPlanner';

const policy: ArcGisSpatialReferenceCompatibilityPolicy = {
  maxWkid: 1_000_000_000,
  requireVerticalReferenceForZ: false,
};

const planner = () => new ArcGisSpatialReferenceCompatibilityPlanner(policy);

const request = (overrides: Partial<ArcGisSpatialReferenceCompatibilityRequest> = {}): ArcGisSpatialReferenceCompatibilityRequest => ({
  source: { wkid: 3857, latestWkid: null, vcsWkid: null, latestVcsWkid: null },
  target: { wkid: 3857, latestWkid: null, vcsWkid: null, latestVcsWkid: null },
  hasZ: false,
  hasM: false,
  horizontalProjectionAvailable: false,
  verticalTransformationAvailable: false,
  ...overrides,
});

describe('ArcGisSpatialReferenceCompatibilityPlanner', () => {
  it('uses identity mode for identical horizontal and vertical contracts', () => {
    const plan = planner().plan(request({ hasZ: true, hasM: true, source: { wkid: 3857, latestWkid: null, vcsWkid: 5703, latestVcsWkid: null }, target: { wkid: 3857, latestWkid: null, vcsWkid: 5703, latestVcsWkid: null } }));
    expect(plan.mode).toBe('identity');
    expect(plan.requiresHorizontalProjection).toBe(false);
    expect(plan.requiresVerticalTransformation).toBe(false);
    expect(plan.preserveZ).toBe(true);
    expect(plan.preserveM).toBe(true);
  });

  it('recognizes legacy WKID aliases through latestWkid without projection', () => {
    const plan = planner().plan(request({
      source: { wkid: 102100, latestWkid: 3857, vcsWkid: null, latestVcsWkid: null },
      target: { wkid: 3857, latestWkid: 3857, vcsWkid: null, latestVcsWkid: null },
    }));
    expect(plan.mode).toBe('alias');
    expect(plan.source.effectiveWkid).toBe(3857);
    expect(plan.target.effectiveWkid).toBe(3857);
    expect(plan.reasons).toEqual([]);
  });

  it('requires an explicitly available projection path for different horizontal references', () => {
    const rejected = planner().plan(request({ target: { wkid: 4326, latestWkid: null, vcsWkid: null, latestVcsWkid: null } }));
    expect(rejected.mode).toBe('reject');
    expect(rejected.reasons).toContain('horizontal-projection-unavailable');

    const projected = planner().plan(request({
      target: { wkid: 4326, latestWkid: null, vcsWkid: null, latestVcsWkid: null },
      horizontalProjectionAvailable: true,
    }));
    expect(projected.mode).toBe('project');
    expect(projected.requiresHorizontalProjection).toBe(true);
  });

  it('ignores vertical-reference mismatch when input geometry has no Z values', () => {
    const plan = planner().plan(request({
      source: { wkid: 3857, latestWkid: null, vcsWkid: 5703, latestVcsWkid: null },
      target: { wkid: 3857, latestWkid: null, vcsWkid: 3855, latestVcsWkid: null },
      hasZ: false,
    }));
    expect(plan.mode).toBe('identity');
    expect(plan.requiresVerticalTransformation).toBe(false);
  });

  it('rejects Z-bearing geometry when vertical references differ and no vertical transform is available', () => {
    const plan = planner().plan(request({
      source: { wkid: 3857, latestWkid: null, vcsWkid: 5703, latestVcsWkid: null },
      target: { wkid: 3857, latestWkid: null, vcsWkid: 3855, latestVcsWkid: null },
      hasZ: true,
    }));
    expect(plan.mode).toBe('reject');
    expect(plan.requiresVerticalTransformation).toBe(true);
    expect(plan.reasons).toContain('vertical-transformation-unavailable');
    expect(plan.preserveZ).toBe(false);
  });

  it('permits a declared vertical transformation and preserves Z', () => {
    const plan = planner().plan(request({
      source: { wkid: 3857, latestWkid: null, vcsWkid: 5703, latestVcsWkid: null },
      target: { wkid: 3857, latestWkid: null, vcsWkid: 3855, latestVcsWkid: null },
      hasZ: true,
      verticalTransformationAvailable: true,
    }));
    expect(plan.mode).toBe('project');
    expect(plan.requiresVerticalTransformation).toBe(true);
    expect(plan.preserveZ).toBe(true);
  });

  it('resolves vertical WKID aliases with latestVcsWkid', () => {
    const plan = planner().plan(request({
      source: { wkid: 3857, latestWkid: null, vcsWkid: 5000, latestVcsWkid: 5703 },
      target: { wkid: 3857, latestWkid: null, vcsWkid: 5703, latestVcsWkid: 5703 },
      hasZ: true,
    }));
    expect(plan.mode).toBe('identity');
    expect(plan.source.effectiveVcsWkid).toBe(5703);
    expect(plan.requiresVerticalTransformation).toBe(false);
  });

  it('can require explicit vertical references for all Z-bearing geometry', () => {
    const strict = new ArcGisSpatialReferenceCompatibilityPlanner({ ...policy, requireVerticalReferenceForZ: true });
    const plan = strict.plan(request({ hasZ: true }));
    expect(plan.mode).toBe('reject');
    expect(plan.reasons).toEqual(['vertical-transformation-unavailable']);
  });

  it('preserves M only when the overall spatial contract is accepted', () => {
    const accepted = planner().plan(request({ hasM: true }));
    expect(accepted.preserveM).toBe(true);
    const rejected = planner().plan(request({
      hasM: true,
      target: { wkid: 4326, latestWkid: null, vcsWkid: null, latestVcsWkid: null },
    }));
    expect(rejected.preserveM).toBe(false);
  });

  it('rejects latest vertical WKID without a base vertical WKID', () => {
    expect(() => planner().plan(request({
      source: { wkid: 3857, latestWkid: null, vcsWkid: null, latestVcsWkid: 5703 },
    }))).toThrow('latestVcsWkid requires vcsWkid');
  });

  it('rejects malformed or over-bound WKIDs', () => {
    const p = planner();
    expect(() => p.plan(request({ source: { wkid: 0, latestWkid: null, vcsWkid: null, latestVcsWkid: null } }))).toThrow();
    expect(() => p.plan(request({ source: { wkid: 1_000_000_001, latestWkid: null, vcsWkid: null, latestVcsWkid: null } }))).toThrow('exceeds configured WKID bound');
    expect(() => p.plan(request({ source: { wkid: Number.NaN, latestWkid: null, vcsWkid: null, latestVcsWkid: null } }))).toThrow();
  });

  it('rejects malformed boolean adapter capabilities fail-closed', () => {
    expect(() => planner().plan(request({ horizontalProjectionAvailable: 1 as never }))).toThrow('horizontalProjectionAvailable must be boolean');
    expect(() => planner().plan(request({ verticalTransformationAvailable: 'yes' as never }))).toThrow('verticalTransformationAvailable must be boolean');
  });

  it('returns immutable normalized contracts and reasons', () => {
    const plan = planner().plan(request());
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.source)).toBe(true);
    expect(Object.isFrozen(plan.target)).toBe(true);
    expect(Object.isFrozen(plan.reasons)).toBe(true);
  });

  it('rejects invalid planner policy', () => {
    expect(() => new ArcGisSpatialReferenceCompatibilityPlanner({ maxWkid: 0, requireVerticalReferenceForZ: false })).toThrow();
  });
});
