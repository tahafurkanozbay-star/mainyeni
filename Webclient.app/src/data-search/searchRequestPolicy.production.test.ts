import { describe, expect, it } from 'vitest';
import {
  assertSearchRequestAllowed,
  calculateSearchComplexity,
  evaluateSearchRequestPolicy,
} from './searchRequestPolicy';

describe('searchRequestPolicy production contract', () => {
  it('accepts a bounded deterministic request and canonicalizes fields', () => {
    const decision = evaluateSearchRequestPolicy({
      request: {
        query: '  Çankaya   Atatürk Bulvarı  ',
        filters: [
          { field: 'district', operator: 'eq', values: ['Çankaya'] },
          { field: 'district', operator: 'eq', values: ['Çankaya'] },
        ],
        facetFields: ['category', 'category', 'type'],
        limit: 25,
        offset: 0,
        center: [32.85, 39.92],
        radiusMeters: 5_000,
        level: 'street',
      },
      sourceKeys: ['Primary.Search', 'secondary'],
      deadlineMs: 4_000,
    });

    expect(decision.allowed).toBe(true);
    expect(decision.request.query).toBe('Çankaya Atatürk Bulvarı');
    expect(decision.request.filters).toHaveLength(1);
    expect(decision.request.facetFields).toEqual(['category', 'type']);
    expect(decision.request.center).toEqual({ longitude: 32.85, latitude: 39.92 });
    expect(decision.sourceKeys).toEqual(['primary.search', 'secondary']);
    expect(decision.deadlineMs).toBe(4_000);
    expect(decision.violations).toEqual([]);
    expect(decision.fingerprint).toMatch(/^fnv1a-/);
  });

  it('rejects excessive query text and token cardinality without throwing during evaluation', () => {
    const query = Array.from({ length: 30 }, (_, index) => `token${index}`).join(' ');
    const decision = evaluateSearchRequestPolicy({ request: { query } }, {
      maxQueryCharacters: 100,
      maxQueryTokens: 8,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.violations.map(item => item.code)).toEqual(expect.arrayContaining([
      'query-too-long',
      'too-many-query-tokens',
    ]));
    expect(String(decision.request.query ?? '').length).toBeLessThanOrEqual(100);
  });

  it('rejects filter fan-out and value-size amplification', () => {
    const decision = evaluateSearchRequestPolicy({
      request: {
        filters: [
          {
            field: 'category',
            operator: 'in',
            values: ['x'.repeat(200), 'b', 'c', 'd'],
          },
          { field: 'type', operator: 'eq', values: ['one'] },
        ],
      },
    }, {
      maxFilters: 1,
      maxFilterValues: 2,
      maxFilterValueCharacters: 32,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.violations.map(item => item.code)).toEqual(expect.arrayContaining([
      'too-many-filters',
      'too-many-filter-values',
      'filter-value-too-long',
    ]));
    expect(decision.request.filters).toHaveLength(1);
    expect(decision.request.filters?.[0]?.values).toHaveLength(2);
  });

  it('rejects unsafe filter and facet identifiers', () => {
    const decision = evaluateSearchRequestPolicy({
      request: {
        filters: [{ field: 'name); DROP TABLE places;--', operator: 'eq', values: ['x'] }],
        facetFields: ['valid_field', '../../unsafe'],
      },
    });

    expect(decision.allowed).toBe(false);
    expect(decision.request.filters).toEqual([]);
    expect(decision.request.facetFields).toEqual(['valid_field']);
    expect(decision.violations.map(item => item.code)).toEqual(expect.arrayContaining([
      'invalid-filter-field',
      'invalid-facet-field',
    ]));
  });

  it('rejects deep offset, page amplification and huge radius', () => {
    const decision = evaluateSearchRequestPolicy({
      request: {
        limit: 5_000,
        offset: 1_000_000,
        radiusMeters: 900_000,
      },
    }, {
      maxPageSize: 100,
      maxOffset: 10_000,
      maxRadiusMeters: 50_000,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.request.limit).toBe(100);
    expect(decision.request.offset).toBe(10_000);
    expect(decision.request.radiusMeters).toBe(50_000);
    expect(decision.violations.map(item => item.code)).toEqual(expect.arrayContaining([
      'page-size-too-large',
      'offset-too-large',
      'radius-too-large',
    ]));
  });

  it('fails closed for invalid spatial centers and address levels', () => {
    const decision = evaluateSearchRequestPolicy({
      request: {
        center: [999, 999],
        level: 'country' as never,
      },
    });

    expect(decision.allowed).toBe(false);
    expect(decision.request.center).toBeNull();
    expect(decision.request.level).toBeNull();
    expect(decision.violations.map(item => item.code)).toEqual(expect.arrayContaining([
      'invalid-center',
      'invalid-address-level',
    ]));
  });

  it('bounds federated source fan-out and canonicalizes duplicate keys', () => {
    const decision = evaluateSearchRequestPolicy({
      request: { query: 'park' },
      sourceKeys: ['A', 'a', 'B', 'C', 'D'],
    }, { maxSourceKeys: 3 });

    expect(decision.allowed).toBe(false);
    expect(decision.sourceKeys).toEqual(['a', 'b']);
    expect(decision.violations.map(item => item.code)).toContain('too-many-source-keys');
  });

  it('rejects invalid source-key grammar rather than forwarding it', () => {
    const decision = evaluateSearchRequestPolicy({
      request: { query: 'school' },
      sourceKeys: ['valid', '../remote', 'also valid'],
    });

    expect(decision.allowed).toBe(false);
    expect(decision.sourceKeys).toEqual(['valid', 'also-valid']);
    expect(decision.violations.map(item => item.code)).toContain('invalid-source-key');
  });

  it('enforces bounded deadlines', () => {
    const tooShort = evaluateSearchRequestPolicy({ request: {}, deadlineMs: 1 }, {
      minDeadlineMs: 100,
      maxDeadlineMs: 10_000,
    });
    const tooLong = evaluateSearchRequestPolicy({ request: {}, deadlineMs: 100_000 }, {
      minDeadlineMs: 100,
      maxDeadlineMs: 10_000,
    });

    expect(tooShort.allowed).toBe(false);
    expect(tooShort.deadlineMs).toBe(100);
    expect(tooLong.allowed).toBe(false);
    expect(tooLong.deadlineMs).toBe(10_000);
  });

  it('produces a stable fingerprint for semantically equivalent bounded requests', () => {
    const first = evaluateSearchRequestPolicy({
      request: { query: '  ÇANKAYA ', facetFields: ['type', 'type'] },
      sourceKeys: ['PRIMARY'],
      deadlineMs: 2_000,
    });
    const second = evaluateSearchRequestPolicy({
      request: { query: 'ÇANKAYA', facetFields: ['type'] },
      sourceKeys: ['primary'],
      deadlineMs: 2_000,
    });

    expect(first.fingerprint).toBe(second.fingerprint);
  });

  it('charges complexity for filters, facets, pages and source fan-out', () => {
    const simple = calculateSearchComplexity({ query: 'park', limit: 10 }, 1);
    const expensive = calculateSearchComplexity({
      query: 'park school library address',
      limit: 250,
      offset: 5_000,
      filters: Array.from({ length: 10 }, (_, index) => ({
        field: `field${index}`,
        operator: 'in' as const,
        values: Array.from({ length: 10 }, (__, valueIndex) => `value-${valueIndex}`),
      })),
      facetFields: ['category', 'type', 'district', 'neighborhood'],
      center: [32.85, 39.92],
      radiusMeters: 25_000,
    }, 8);

    expect(expensive).toBeGreaterThan(simple);
  });

  it('rejects combined complexity even when individual dimensions fit', () => {
    const decision = evaluateSearchRequestPolicy({
      request: {
        query: 'a b c d e f g h',
        limit: 200,
        offset: 5_000,
        filters: Array.from({ length: 8 }, (_, index) => ({
          field: `field${index}`,
          operator: 'in' as const,
          values: Array.from({ length: 8 }, (__, valueIndex) => `value-${valueIndex}`),
        })),
      },
      sourceKeys: ['a', 'b', 'c', 'd'],
    }, { maxComplexityScore: 300 });

    expect(decision.allowed).toBe(false);
    expect(decision.violations.map(item => item.code)).toContain('complexity-budget-exceeded');
  });

  it('assert helper throws a policy-specific error', () => {
    expect(() => assertSearchRequestAllowed({
      request: { query: 'x'.repeat(1_000) },
    }, { maxQueryCharacters: 32 })).toThrowError(/Search request rejected/);
  });

  it('accepts a live AbortSignal and rejects a forged signal object', () => {
    const controller = new AbortController();
    const accepted = evaluateSearchRequestPolicy({ request: { signal: controller.signal } });
    expect(accepted.allowed).toBe(true);
    expect(accepted.request.signal).toBe(controller.signal);

    const forged = evaluateSearchRequestPolicy({
      request: { signal: { aborted: false } as AbortSignal },
    });
    expect(forged.allowed).toBe(false);
    expect(forged.request.signal).toBeNull();
    expect(forged.violations.map(item => item.code)).toContain('invalid-signal');
  });
});
