import { describe, expect, it } from 'vitest';
import {
  BusinessQueryPlanError,
  InvalidBusinessInputError,
  compilePredicatePlan,
  compileRequiredPredicatePlan,
  equalsPredicate,
  inPredicate,
  normalizeBusinessQuery,
  normalizeGeographicPoint,
  normalizeIdentifierList,
  normalizeLegacyIdentifier,
  normalizeNumberingSearchQuery,
  normalizeRouteQuery,
  normalizeTkgmParcelQuery,
  numericEqualsPredicate,
  quoteSqlLiteral,
  readEntityIdentifier,
  routeTypePredicate,
  upperContainsPredicate,
  unsignedIntegerLiteralPredicate,
} from './index';

describe('Business runtime input normalization', () => {
  it('preserves zero-valued identifiers and strips legacy single quoting', () => {
    expect(normalizeLegacyIdentifier(0)?.value).toBe('0');
    expect(normalizeLegacyIdentifier("'abc'")?.value).toBe('abc');
    expect(normalizeLegacyIdentifier({ attr: { id: 0 } })?.value).toBe('0');
    expect(normalizeLegacyIdentifier('   ')).toBeNull();
  });

  it('deduplicates identifier lists and keeps deterministic ordering', () => {
    const result = normalizeIdentifierList(['a', "'a'", 'b', '', null, 'c']);
    expect(result.values).toEqual(['a', 'b', 'c']);
    expect(result.duplicates).toBe(1);
    expect(result.rejected).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it('bounds large identifier lists with explicit truncation evidence', () => {
    const result = normalizeIdentifierList(
      Array.from({ length: 10 }, (_, index) => index),
      {
        maxTextLength: 160,
        maxIdentifierLength: 96,
        maxIdentifierCount: 3,
        maxWhereLength: 4096,
        maxDiagnosticEntries: 256,
        defaultCacheTtlMs: 30000,
        maxCacheTtlMs: 300000,
        defaultTimeoutMs: 15000,
        maxTimeoutMs: 120000,
        minNearbyDistance: 0,
        maxNearbyDistance: 100,
      },
    );
    expect(result.values).toEqual(['0', '1', '2']);
    expect(result.truncated).toBe(true);
  });

  it('normalizes generic map query state without coercing missing values', () => {
    const query = normalizeBusinessQuery({
      name: '  Park  ',
      districtId: 0,
      nbhoodId: "'42'",
      ObjectId: ' 7 ',
      showNearby: true,
      bufferDistance: '12.5',
      userLocation: { x: 1, y: 2 },
    });

    expect(query).toEqual({
      name: 'Park',
      districtId: '0',
      neighborhoodId: '42',
      objectId: '7',
      showNearby: true,
      bufferDistance: 12.5,
      userLocation: { x: 1, y: 2 },
    });
  });

  it('clamps nearby distance to the runtime policy', () => {
    expect(normalizeBusinessQuery({ bufferDistance: -10 }).bufferDistance).toBe(0);
    expect(normalizeBusinessQuery({ bufferDistance: 9999 }).bufferDistance).toBe(100);
  });

  it('normalizes route flags and finite route levels', () => {
    expect(normalizeRouteQuery({
      showCultureWalkingRoute: true,
      showNatureWalkingRoute: false,
      routeLevel: '3',
    })).toMatchObject({
      showCultureWalkingRoute: true,
      showNatureWalkingRoute: false,
      routeLevel: 3,
    });

    expect(normalizeRouteQuery({ routeLevel: 'not-a-number' }).routeLevel).toBeNull();
  });

  it('normalizes legacy numbering search field casing', () => {
    expect(normalizeNumberingSearchQuery({
      DistrictName: ' Çankaya ',
      NeighborhoodName: ' Kızılay ',
    })).toEqual({
      districtName: 'Çankaya',
      neighborhoodName: 'Kızılay',
    });
  });

  it('requires all parcel identity pieces and fails closed', () => {
    expect(normalizeTkgmParcelQuery({
      district: 1,
      nbhood: 2,
      cityblock: 3,
      parcel: 4,
    })).toEqual({
      district: '1',
      neighborhood: '2',
      cityBlock: '3',
      parcel: '4',
    });

    expect(() => normalizeTkgmParcelQuery({
      district: 1,
      nbhood: 2,
      cityblock: '',
      parcel: 4,
    })).toThrow(InvalidBusinessInputError);
  });

  it('accepts geographic points only inside WGS84 ranges', () => {
    expect(normalizeGeographicPoint({ latitude: 39.9, longitude: 32.8 }))
      .toEqual({ latitude: 39.9, longitude: 32.8 });
    expect(normalizeGeographicPoint({ latitude: 91, longitude: 32.8 })).toBeNull();
    expect(normalizeGeographicPoint({ latitude: 39.9, longitude: 181 })).toBeNull();
    expect(normalizeGeographicPoint({ latitude: 'x', longitude: 10 })).toBeNull();
  });

  it('reads entity ids from attr, root and primitive legacy forms', () => {
    expect(readEntityIdentifier({ attr: { id: 0 } })).toBe('0');
    expect(readEntityIdentifier({ id: 'abc' })).toBe('abc');
    expect(readEntityIdentifier("'xyz'")).toBe('xyz');
  });
});

describe('Business runtime SQL planning', () => {
  it('escapes SQL literal apostrophes centrally', () => {
    expect(quoteSqlLiteral("O'Connor")).toBe("'O''Connor'");
    expect(equalsPredicate('id', "A'B")).toBe("id='A''B'");
  });

  it('refuses unsafe field names', () => {
    expect(() => equalsPredicate('id;drop table x', '1')).toThrow(BusinessQueryPlanError);
  });

  it('builds deterministic IN filters and removes duplicates', () => {
    expect(inPredicate('id', ["'a'", 'a', 'b']))
      .toBe("id IN ('a','b')");
  });

  it('returns null rather than invalid IN for empty inputs', () => {
    expect(inPredicate('id', [])).toBeNull();
    expect(inPredicate('id', ['', null, undefined])).toBeNull();
  });

  it('escapes Turkish uppercase text matching', () => {
    expect(upperContainsPredicate('ad', "o'connor"))
      .toContain("O''CONNOR");
  });

  it('compiles canonical unsigned identities without numeric coercion', () => {
    expect(unsignedIntegerLiteralPredicate('objectid', '0')).toBe('objectid=0');
    expect(unsignedIntegerLiteralPredicate('objectid', '42')).toBe('objectid=42');
    expect(unsignedIntegerLiteralPredicate('objectid', '0042')).toBeNull();
    expect(unsignedIntegerLiteralPredicate('objectid', '42x')).toBeNull();
  });

  it('emits numeric equality only for finite numbers', () => {
    expect(numericEqualsPredicate('objectid', '12')).toBe('objectid=12');
    expect(numericEqualsPredicate('objectid', 'NaN')).toBeNull();
  });

  it('applies route-type exclusions only for list queries', () => {
    expect(routeTypePredicate(false, false, false)).toEqual([
      'tip <> 1',
      'tip <> 2',
    ]);
    expect(routeTypePredicate(false, false, true)).toEqual([]);
    expect(routeTypePredicate(true, false, false)).toEqual(['tip <> 2']);
  });

  it('compiles predicates with deterministic AND joining', () => {
    expect(compilePredicatePlan([
      '1=1',
      null,
      "id='1'",
      false,
      "ad='A'",
    ]).where).toBe("1=1 AND id='1' AND ad='A'");
  });

  it('marks overlong predicate plans as truncated', () => {
    const plan = compilePredicatePlan(
      ['1=1', 'x'.repeat(100)],
      {
        maxTextLength: 10,
        maxIdentifierLength: 10,
        maxIdentifierCount: 10,
        maxWhereLength: 20,
        maxDiagnosticEntries: 10,
        defaultCacheTtlMs: 10,
        maxCacheTtlMs: 100,
        defaultTimeoutMs: 10,
        maxTimeoutMs: 100,
        minNearbyDistance: 0,
        maxNearbyDistance: 100,
      },
    );
    expect(plan.where).toBe('1=1');
    expect(plan.truncated).toBe(true);
  });

  it('fails closed for required overlong predicate plans', () => {
    expect(() => compileRequiredPredicatePlan(
      ['x'.repeat(100)],
      {
        maxTextLength: 10,
        maxIdentifierLength: 10,
        maxIdentifierCount: 10,
        maxWhereLength: 20,
        maxDiagnosticEntries: 10,
        defaultCacheTtlMs: 10,
        maxCacheTtlMs: 100,
        defaultTimeoutMs: 10,
        maxTimeoutMs: 100,
        minNearbyDistance: 0,
        maxNearbyDistance: 100,
      },
    )).toThrow(BusinessQueryPlanError);
  });
});
