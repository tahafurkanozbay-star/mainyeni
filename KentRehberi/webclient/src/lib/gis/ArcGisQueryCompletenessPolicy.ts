export type ArcGisTransferLimitSignal = 'clear' | 'exceeded' | 'unknown';

export interface ArcGisQueryCompletenessPolicyOptions {
  readonly maxExpectedFeatures: number;
  readonly maxPageSize: number;
  readonly requireObjectIdField: boolean;
  readonly allowUnknownTransferLimit: boolean;
}

export interface ArcGisQueryPageFacts {
  readonly featureCount: number;
  readonly requestedRecordCount: number;
  readonly hasMore: boolean;
  readonly transferLimit: ArcGisTransferLimitSignal;
  readonly objectIdField: string | null;
  readonly uniqueIdentityCount: number;
}

export interface ArcGisQueryCompletenessDecision {
  readonly accepted: boolean;
  readonly terminal: boolean;
  readonly reason: 'accepted' | 'feature-budget' | 'page-size' | 'identity-mismatch' | 'missing-object-id' | 'ambiguous-transfer-limit' | 'contradictory-transfer-limit';
  readonly observedFeatures: number;
  readonly remainingFeatureBudget: number;
}

const safePositive = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} outside configured bounds`);
  return value;
};

const safeCount = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} outside configured bounds`);
  return value;
};

/**
 * Stateless fail-closed policy for ArcGIS REST query-page completeness facts.
 * The caller remains responsible for parsing verified REST responses. This policy
 * never owns URLs, transport, feature payloads, credentials or ArcGIS SDK objects.
 */
export class ArcGisQueryCompletenessPolicy {
  private readonly options: Readonly<ArcGisQueryCompletenessPolicyOptions>;

  constructor(options: ArcGisQueryCompletenessPolicyOptions) {
    const maxExpectedFeatures = safePositive(options.maxExpectedFeatures, 'maxExpectedFeatures');
    const maxPageSize = safePositive(options.maxPageSize, 'maxPageSize');
    if (maxPageSize > maxExpectedFeatures) throw new Error('query page size exceeds total feature budget');
    this.options = Object.freeze({
      maxExpectedFeatures,
      maxPageSize,
      requireObjectIdField: options.requireObjectIdField === true,
      allowUnknownTransferLimit: options.allowUnknownTransferLimit === true,
    });
  }

  evaluate(facts: ArcGisQueryPageFacts, observedBefore: number): ArcGisQueryCompletenessDecision {
    const observed = safeCount(observedBefore, 'observedBefore');
    const featureCount = safeCount(facts.featureCount, 'featureCount');
    const requestedRecordCount = safePositive(facts.requestedRecordCount, 'requestedRecordCount');
    const uniqueIdentityCount = safeCount(facts.uniqueIdentityCount, 'uniqueIdentityCount');
    if (observed > this.options.maxExpectedFeatures || featureCount > this.options.maxExpectedFeatures - observed) return this.decision(false, false, 'feature-budget', observed);
    if (featureCount > this.options.maxPageSize || requestedRecordCount > this.options.maxPageSize) return this.decision(false, false, 'page-size', observed);
    if (uniqueIdentityCount !== featureCount) return this.decision(false, false, 'identity-mismatch', observed);
    if (this.options.requireObjectIdField && !this.validField(facts.objectIdField)) return this.decision(false, false, 'missing-object-id', observed);
    this.assertTransferLimit(facts.transferLimit);
    if (facts.transferLimit === 'unknown' && !this.options.allowUnknownTransferLimit) return this.decision(false, false, 'ambiguous-transfer-limit', observed);
    if (facts.hasMore && facts.transferLimit === 'clear') return this.decision(false, false, 'contradictory-transfer-limit', observed);
    if (!facts.hasMore && facts.transferLimit === 'exceeded') return this.decision(false, false, 'contradictory-transfer-limit', observed);
    const total = observed + featureCount;
    return this.decision(true, !facts.hasMore, 'accepted', total);
  }

  private decision(accepted: boolean, terminal: boolean, reason: ArcGisQueryCompletenessDecision['reason'], observedFeatures: number): ArcGisQueryCompletenessDecision {
    return Object.freeze({ accepted, terminal, reason, observedFeatures, remainingFeatureBudget: Math.max(0, this.options.maxExpectedFeatures - observedFeatures) });
  }

  private validField(value: string | null): boolean {
    if (value === null || typeof value !== 'string') return false;
    const normalized = value.trim();
    return normalized.length > 0 && normalized.length <= 128 && !normalized.includes('\0');
  }

  private assertTransferLimit(value: ArcGisTransferLimitSignal): void {
    if (value !== 'clear' && value !== 'exceeded' && value !== 'unknown') throw new Error('invalid ArcGIS transfer-limit signal');
  }
}
