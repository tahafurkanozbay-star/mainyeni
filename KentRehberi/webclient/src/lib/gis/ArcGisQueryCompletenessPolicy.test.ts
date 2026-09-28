import { describe, expect, it } from 'vitest';
import { ArcGisQueryCompletenessPolicy } from './ArcGisQueryCompletenessPolicy';

const create = (overrides: Partial<ConstructorParameters<typeof ArcGisQueryCompletenessPolicy>[0]> = {}) => new ArcGisQueryCompletenessPolicy({ maxExpectedFeatures: 100, maxPageSize: 20, requireObjectIdField: true, allowUnknownTransferLimit: false, ...overrides });
const facts = (overrides: Record<string, unknown> = {}) => ({ featureCount: 1, requestedRecordCount: 20, hasMore: false, transferLimit: 'clear' as const, objectIdField: 'OBJECTID', uniqueIdentityCount: 1, ...overrides });

describe('ArcGisQueryCompletenessPolicy', () => {
  it('accepts a bounded continuing page when transfer-limit metadata agrees', () => {
    const result = create().evaluate({ featureCount: 20, requestedRecordCount: 20, hasMore: true, transferLimit: 'exceeded', objectIdField: 'OBJECTID', uniqueIdentityCount: 20 }, 20);
    expect(result).toEqual({ accepted: true, terminal: false, reason: 'accepted', observedFeatures: 40, remainingFeatureBudget: 60 });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('accepts a terminal partial page when transfer limit is clear', () => {
    expect(create().evaluate({ featureCount: 7, requestedRecordCount: 20, hasMore: false, transferLimit: 'clear', objectIdField: 'OBJECTID', uniqueIdentityCount: 7 }, 40)).toMatchObject({ accepted: true, terminal: true, observedFeatures: 47 });
  });

  it('accepts an empty terminal page without manufacturing identities', () => {
    expect(create().evaluate({ featureCount: 0, requestedRecordCount: 20, hasMore: false, transferLimit: 'clear', objectIdField: 'OBJECTID', uniqueIdentityCount: 0 }, 0)).toEqual({ accepted: true, terminal: true, reason: 'accepted', observedFeatures: 0, remainingFeatureBudget: 100 });
  });

  it('accepts exactly the total feature budget and reports zero remainder', () => {
    const result = create().evaluate({ featureCount: 20, requestedRecordCount: 20, hasMore: false, transferLimit: 'clear', objectIdField: 'OBJECTID', uniqueIdentityCount: 20 }, 80);
    expect(result).toMatchObject({ accepted: true, terminal: true, observedFeatures: 100, remainingFeatureBudget: 0 });
  });

  it('fails closed when feature identity cardinality disagrees', () => {
    expect(create().evaluate({ featureCount: 4, requestedRecordCount: 20, hasMore: false, transferLimit: 'clear', objectIdField: 'OBJECTID', uniqueIdentityCount: 3 }, 0)).toMatchObject({ accepted: false, reason: 'identity-mismatch' });
  });

  it('rejects missing object identity metadata when required', () => {
    expect(create().evaluate({ featureCount: 1, requestedRecordCount: 20, hasMore: false, transferLimit: 'clear', objectIdField: ' ', uniqueIdentityCount: 1 }, 0)).toMatchObject({ accepted: false, reason: 'missing-object-id' });
    expect(create({ requireObjectIdField: false }).evaluate({ featureCount: 1, requestedRecordCount: 20, hasMore: false, transferLimit: 'clear', objectIdField: null, uniqueIdentityCount: 1 }, 0).accepted).toBe(true);
  });

  it('rejects an oversized object identity field name when identity metadata is required', () => {
    expect(create().evaluate({ featureCount: 1, requestedRecordCount: 20, hasMore: false, transferLimit: 'clear', objectIdField: 'X'.repeat(129), uniqueIdentityCount: 1 }, 0).reason).toBe('missing-object-id');
  });

  it('rejects contradictory ArcGIS transfer-limit facts', () => {
    expect(create().evaluate({ featureCount: 20, requestedRecordCount: 20, hasMore: true, transferLimit: 'clear', objectIdField: 'OBJECTID', uniqueIdentityCount: 20 }, 0).reason).toBe('contradictory-transfer-limit');
    expect(create().evaluate({ featureCount: 5, requestedRecordCount: 20, hasMore: false, transferLimit: 'exceeded', objectIdField: 'OBJECTID', uniqueIdentityCount: 5 }, 0).reason).toBe('contradictory-transfer-limit');
  });

  it('governs unknown transfer-limit metadata explicitly', () => {
    const page = { featureCount: 1, requestedRecordCount: 20, hasMore: false, transferLimit: 'unknown' as const, objectIdField: 'OBJECTID', uniqueIdentityCount: 1 };
    expect(create().evaluate(page, 0).reason).toBe('ambiguous-transfer-limit');
    expect(create({ allowUnknownTransferLimit: true }).evaluate(page, 0).accepted).toBe(true);
  });

  it('allows unknown transfer metadata for continuing pages only when explicitly configured', () => {
    const page = { featureCount: 10, requestedRecordCount: 20, hasMore: true, transferLimit: 'unknown' as const, objectIdField: 'OBJECTID', uniqueIdentityCount: 10 };
    expect(create().evaluate(page, 0).accepted).toBe(false);
    expect(create({ allowUnknownTransferLimit: true }).evaluate(page, 0)).toMatchObject({ accepted: true, terminal: false });
  });

  it('enforces total feature and page-size budgets', () => {
    const page = { featureCount: 11, requestedRecordCount: 20, hasMore: false, transferLimit: 'clear' as const, objectIdField: 'OBJECTID', uniqueIdentityCount: 11 };
    expect(create().evaluate(page, 95).reason).toBe('feature-budget');
    expect(create({ maxPageSize: 10 }).evaluate({ ...page, featureCount: 10, uniqueIdentityCount: 10 }, 0).reason).toBe('page-size');
  });

  it('rejects a page whose feature count exceeds the configured page size', () => {
    expect(create({ maxPageSize: 5 }).evaluate({ featureCount: 6, requestedRecordCount: 5, hasMore: true, transferLimit: 'exceeded', objectIdField: 'OBJECTID', uniqueIdentityCount: 6 }, 0).reason).toBe('page-size');
  });

  it('rejects invalid transfer-limit enum values at the trust boundary', () => {
    expect(() => create().evaluate({ ...facts(), transferLimit: 'maybe' as never }, 0)).toThrow('invalid ArcGIS transfer-limit signal');
  });

  it('rejects negative and unsafe response counters', () => {
    expect(() => create().evaluate({ ...facts(), featureCount: -1 }, 0)).toThrow('featureCount outside configured bounds');
    expect(() => create().evaluate({ ...facts(), uniqueIdentityCount: -1 }, 0)).toThrow('uniqueIdentityCount outside configured bounds');
    expect(() => create().evaluate({ ...facts(), requestedRecordCount: 0 }, 0)).toThrow('requestedRecordCount outside configured bounds');
    expect(() => create().evaluate({ ...facts(), featureCount: Number.MAX_SAFE_INTEGER + 1 }, 0)).toThrow('featureCount outside configured bounds');
  });

  it('rejects observed totals already beyond the configured query budget', () => {
    expect(create().evaluate(facts(), 101).reason).toBe('feature-budget');
  });

  it('validates policy and observed counters', () => {
    expect(() => create({ maxExpectedFeatures: 0 })).toThrow('maxExpectedFeatures outside configured bounds');
    expect(() => create({ maxExpectedFeatures: 5, maxPageSize: 6 })).toThrow('query page size exceeds total feature budget');
    expect(() => create().evaluate({ featureCount: 1, requestedRecordCount: 20, hasMore: false, transferLimit: 'clear', objectIdField: 'OBJECTID', uniqueIdentityCount: 1 }, -1)).toThrow('observedBefore outside configured bounds');
  });
});
