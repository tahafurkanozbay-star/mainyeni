export type ArcGisSpatialReferenceCompatibilityMode = 'identity' | 'alias' | 'project' | 'reject';
export type ArcGisSpatialReferenceCompatibilityReason =
  | 'horizontal-projection-unavailable'
  | 'vertical-transformation-unavailable';

export interface ArcGisSpatialReferenceContract {
  readonly wkid: number;
  readonly latestWkid: number | null;
  readonly vcsWkid: number | null;
  readonly latestVcsWkid: number | null;
}

export interface ArcGisSpatialReferenceCompatibilityRequest {
  readonly source: ArcGisSpatialReferenceContract;
  readonly target: ArcGisSpatialReferenceContract;
  readonly hasZ: boolean;
  readonly hasM: boolean;
  readonly horizontalProjectionAvailable: boolean;
  readonly verticalTransformationAvailable: boolean;
}

export interface ArcGisSpatialReferenceCompatibilityPolicy {
  readonly maxWkid: number;
  readonly requireVerticalReferenceForZ: boolean;
}

export interface ArcGisNormalizedSpatialReferenceContract extends ArcGisSpatialReferenceContract {
  readonly effectiveWkid: number;
  readonly effectiveVcsWkid: number | null;
}

export interface ArcGisSpatialReferenceCompatibilityPlan {
  readonly mode: ArcGisSpatialReferenceCompatibilityMode;
  readonly source: ArcGisNormalizedSpatialReferenceContract;
  readonly target: ArcGisNormalizedSpatialReferenceContract;
  readonly requiresHorizontalProjection: boolean;
  readonly requiresVerticalTransformation: boolean;
  readonly preserveZ: boolean;
  readonly preserveM: boolean;
  readonly reasons: readonly ArcGisSpatialReferenceCompatibilityReason[];
}

const positiveInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} outside configured bounds`);
  return value;
};

/**
 * Primitive-only compatibility authority for ArcGIS spatial-reference contracts.
 * Projection math remains in verified ArcGIS geometry/projection adapters; this planner only
 * decides whether identity, WKID aliasing, or an explicitly available projection path is safe.
 */
export class ArcGisSpatialReferenceCompatibilityPlanner {
  private readonly policy: Readonly<ArcGisSpatialReferenceCompatibilityPolicy>;

  constructor(policy: ArcGisSpatialReferenceCompatibilityPolicy) {
    this.policy = Object.freeze({
      maxWkid: positiveInteger(policy.maxWkid, 'maxWkid'),
      requireVerticalReferenceForZ: this.boolean(policy.requireVerticalReferenceForZ, 'requireVerticalReferenceForZ'),
    });
  }

  plan(input: ArcGisSpatialReferenceCompatibilityRequest): ArcGisSpatialReferenceCompatibilityPlan {
    if (!input || typeof input !== 'object') throw new Error('spatial reference request is required');
    const source = this.normalize(input.source, 'source');
    const target = this.normalize(input.target, 'target');
    const hasZ = this.boolean(input.hasZ, 'hasZ');
    const hasM = this.boolean(input.hasM, 'hasM');
    const horizontalProjectionAvailable = this.boolean(input.horizontalProjectionAvailable, 'horizontalProjectionAvailable');
    const verticalTransformationAvailable = this.boolean(input.verticalTransformationAvailable, 'verticalTransformationAvailable');
    const reasons: ArcGisSpatialReferenceCompatibilityReason[] = [];

    const exactHorizontal = source.wkid === target.wkid && source.latestWkid === target.latestWkid;
    const aliasHorizontal = source.effectiveWkid === target.effectiveWkid;
    const requiresHorizontalProjection = !aliasHorizontal;
    if (requiresHorizontalProjection && !horizontalProjectionAvailable) reasons.push('horizontal-projection-unavailable');

    const requiresVerticalTransformation = this.requiresVerticalTransformation(source, target, hasZ);
    if (requiresVerticalTransformation && !verticalTransformationAvailable) reasons.push('vertical-transformation-unavailable');

    if (hasZ && this.policy.requireVerticalReferenceForZ && (source.effectiveVcsWkid === null || target.effectiveVcsWkid === null)) {
      if (!reasons.includes('vertical-transformation-unavailable')) reasons.push('vertical-transformation-unavailable');
    }

    const rejected = reasons.length > 0;
    const mode: ArcGisSpatialReferenceCompatibilityMode = rejected
      ? 'reject'
      : requiresHorizontalProjection || requiresVerticalTransformation
        ? 'project'
        : exactHorizontal
          ? 'identity'
          : 'alias';

    return Object.freeze({
      mode,
      source,
      target,
      requiresHorizontalProjection,
      requiresVerticalTransformation,
      preserveZ: hasZ && !rejected,
      preserveM: hasM && !rejected,
      reasons: Object.freeze(reasons.sort()),
    });
  }

  private normalize(input: ArcGisSpatialReferenceContract, label: string): ArcGisNormalizedSpatialReferenceContract {
    if (!input || typeof input !== 'object') throw new Error(`${label} spatial reference is required`);
    const wkid = this.wkid(input.wkid, `${label}.wkid`);
    const latestWkid = input.latestWkid === null ? null : this.wkid(input.latestWkid, `${label}.latestWkid`);
    const vcsWkid = input.vcsWkid === null ? null : this.wkid(input.vcsWkid, `${label}.vcsWkid`);
    const latestVcsWkid = input.latestVcsWkid === null ? null : this.wkid(input.latestVcsWkid, `${label}.latestVcsWkid`);
    if (latestVcsWkid !== null && vcsWkid === null) throw new Error(`${label} latestVcsWkid requires vcsWkid`);
    return Object.freeze({
      wkid,
      latestWkid,
      vcsWkid,
      latestVcsWkid,
      effectiveWkid: latestWkid ?? wkid,
      effectiveVcsWkid: latestVcsWkid ?? vcsWkid,
    });
  }

  private requiresVerticalTransformation(
    source: ArcGisNormalizedSpatialReferenceContract,
    target: ArcGisNormalizedSpatialReferenceContract,
    hasZ: boolean,
  ): boolean {
    if (!hasZ) return false;
    return source.effectiveVcsWkid !== target.effectiveVcsWkid;
  }

  private wkid(value: number, name: string): number {
    const wkid = positiveInteger(value, name);
    if (wkid > this.policy.maxWkid) throw new Error(`${name} exceeds configured WKID bound`);
    return wkid;
  }

  private boolean(value: boolean, name: string): boolean {
    if (typeof value !== 'boolean') throw new Error(`${name} must be boolean`);
    return value;
  }
}
