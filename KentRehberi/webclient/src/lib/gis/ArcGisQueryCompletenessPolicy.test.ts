import { describe, expect, it } from 'vitest';
import { ArcGisQueryCompletenessPolicy } from './ArcGisQueryCompletenessPolicy';

const create = (overrides: Partial<ConstructorParameters<typeof ArcGisQueryCompletenessPolicy>[0]> = {}) => new ArcGisQueryCompletenessPolicy({ maxExpectedFeatures: 100, maxPageSize: 20, requireObjectIdField: true, allowUnknownTransferLimit: false, ...overrides });

describe('ArcGisQueryCompletenessPolicy', () => {
  it('accepts a bounded continuing page when transfer-limit metadata agrees', () => {
    const result = create().evaluate({ featureCount: 20, requestedRecordCount: 20, hasMore: true, transferLimit: 'exceeded', objectIdField: 'OBJECTID', uniqueIdentityCount: 20 }, 20);
    expect(result).toEqual({ accepted: true, terminal: false, reason: 'accepted', observedFeatures: 40, remainingFeatureBudget: 60 });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('accepts a terminal partial page when transfer limit is clear', () => {
    expect(create().evaluate({ featureCount: 7, requestedRecordCount: 20, hasMore: false, transferLimit: 'clear', objectIdField: 'OBJECTID', uniqueIdentityCount: 7 }, 40)).toMatchObject({ accepted: true, terminal: true, observedFeatures: 47 });
  });

  it('fails closed when feature identity cardinality disagrees', () => {
    expect(create().evaluate({ featureCount: 4, requestedRecordCount: 20, hasMore: false, transferLimit: 'clear', objectIdField: 'OBJECTID', uniqueIdentityCount: 3 }, 0)).toMatchObject({ accepted: false, reason: 'identity-mismatch' });
  });

  it('rejects missing object identity metadata when required', () => {
    expect(create().evaluate({ featureCount: 1, requestedRecordCount: 20, hasMore: false, transferLimit: 'clear', objectIdField: ' ', uniqueIdentityCount: 1 }, 0)).toMatchObject({ accepted: false, reason: 'missing-object-id' });
    expect(create({ requireObjectIdField: false }).evaluate({ featureCount: 1, requestedRecordCount: 20, hasMore: false, transferLimit: 'clear', objectIdField: null, uniqueIdentityCount: 1 }, 0).accepted).toBe(true);
  });

  it('rejects contradictory ArcGIS transfer-limit facts', () => {
    expect(create().evaluate({ featureCount: 20, requestedRecordCount: 20, hasMore: true, transferLimit: 'clear', objectIdField: 'OBJECTID', uniqueIdentityCount: 20 }, 0).reason).toBe('contradictory-transfer-limit');
    expect(create().evaluate({ featureCount: 5, requestedRecordCount: 20, hasMore: false, transferLimit: 'exceeded', objectIdField: 'OBJECTID', uniqueIdentityCount: 5 }, 0).reason).toBe('contradictory-transfer-limit');
  });

  it('governs unknown transfer-limit metadata explicitly', () => {
    const facts = { featureCount: 1, requestedRecordCount: 20, hasMore: false, transferLimit: 'unknown' as const, objectIdField: 'OBJECTID', uniqueIdentityCount: 1 };
    expect(create().evaluate(facts, 0).reason).toBe('ambiguous-transfer-limit');
    expect(create({ allowUnknownTransferLimit: true }).evaluate(facts, 0).accepted).toBe(true);
  });

  it('enforces total feature and page-size budgets', () => {
    const page = { featureCount: 11, requestedRecordCount: 20, hasMore: false, transferLimit: 'clear' as const, objectIdField: 'OBJECTID', uniqueIdentityCount: 11 };
    expect(create().evaluate(page, 95).reason).toBe('feature-budget');
    expect(create({ maxPageSize: 10 }).evaluate({ ...page, featureCount: 10, uniqueIdentityCount: 10 }, 0).reason).toBe('page-size');
  });

  it('validates policy and observed counters', () => {
    expect(() => create({ maxExpectedFeatures: 0 })).toThrow('maxExpectedFeatures outside configured bounds');
    expect(() => create({ maxExpectedFeatures: 5, maxPageSize: 6 })).toThrow('query page size exceeds total feature budget');
    expect(() => create().evaluate({ featureCount: 1, requestedRecordCount: 20, hasMore: false, transferLimit: 'clear', objectIdField: 'OBJECTID', uniqueIdentityCount: 1 }, -1)).toThrow('observedBefore outside configured bounds');
  });
});
