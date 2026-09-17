import { type ArcGisMetadataContract } from './arcgisMetadataAdapter';
import { type ArcGisQuerySpec } from './arcgisQueryContract';

export type ArcGisWindowStrategy = 'offset' | 'objectIds';

export interface ArcGisFeatureWindowPlan {
  readonly strategy: ArcGisWindowStrategy;
  readonly pageSize: number;
  readonly maxFeatures: number;
  readonly maxPages: number;
  readonly identityField: string;
  readonly orderByFields: readonly string[];
  readonly warnings: readonly string[];
}

export class ArcGisFeatureWindowPlanningError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'ArcGisFeatureWindowPlanningError';
    this.code = code;
  }
}

const positiveInteger = (value: unknown, fallback: number, maximum: number): number => {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric <= 0) return fallback;
  return Math.min(numeric, maximum);
};

const identityField = (contract: ArcGisMetadataContract): string => {
  const field = contract.objectIdField || contract.globalIdField;
  if (!contract.identityReady || !field) {
    throw new ArcGisFeatureWindowPlanningError(
      'ArcGIS feature-window planning requires a verified stable identity field.',
      'STABLE_IDENTITY_REQUIRED',
    );
  }
  return field;
};

const normalizeOrderBy = (spec: ArcGisQuerySpec, identity: string): readonly string[] => {
  const configured = Array.isArray(spec.orderByFields)
    ? spec.orderByFields.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
  const hasIdentity = configured.some((value) => value.trim().split(/\s+/u)[0]?.toLowerCase() === identity.toLowerCase());
  return Object.freeze(hasIdentity ? configured.slice() : [...configured, `${identity} ASC`]);
};

/**
 * Produces a deterministic, bounded pagination plan from verified service metadata.
 * It never guesses pagination support and always adds a stable identity tie-breaker
 * so offset windows cannot silently reshuffle records that share the caller's sort key.
 */
export const planArcGisFeatureWindow = (
  contract: ArcGisMetadataContract,
  spec: ArcGisQuerySpec,
  options: Readonly<{ pageSize?: number; maxFeatures?: number; maxPages?: number }> = {},
): ArcGisFeatureWindowPlan => {
  if (!contract.queryReady) {
    throw new ArcGisFeatureWindowPlanningError('ArcGIS metadata contract is not query-ready.', 'METADATA_NOT_QUERY_READY');
  }
  const identity = identityField(contract);
  const maxRecordCount = positiveInteger(contract.maxRecordCount, 500, 10_000);
  const pageSize = positiveInteger(options.pageSize, Math.min(500, maxRecordCount), maxRecordCount);
  const maxFeatures = positiveInteger(options.maxFeatures, 10_000, 100_000);
  const maxPages = positiveInteger(options.maxPages, 50, 1_000);
  const warnings: string[] = [];

  if (!contract.capabilities.has('pagination')) {
    throw new ArcGisFeatureWindowPlanningError(
      'Verified ArcGIS pagination support is required for offset feature windows.',
      'PAGINATION_UNSUPPORTED',
    );
  }
  if (pageSize < maxRecordCount) warnings.push('page-size-below-service-limit');
  if (maxPages * pageSize < maxFeatures) warnings.push('page-budget-limits-feature-budget');

  return Object.freeze({
    strategy: 'offset',
    pageSize,
    maxFeatures,
    maxPages,
    identityField: identity,
    orderByFields: normalizeOrderBy(spec, identity),
    warnings: Object.freeze(warnings),
  });
};

export const applyArcGisFeatureWindowPlan = (
  spec: ArcGisQuerySpec,
  plan: ArcGisFeatureWindowPlan,
): ArcGisQuerySpec => Object.freeze({
  ...spec,
  orderByFields: plan.orderByFields,
});
