import { describe, expect, test } from 'vitest';
import {
  buildIdentifierPredicate,
  buildNamePredicate,
  buildWhereClause,
  combinePredicates,
  compileFastAccessQuery,
  createQueryFingerprint,
  createQueryPolicy,
  escapeSqlLikeLiteral,
  escapeSqlLiteral,
  normalizeBusinessText,
  normalizeCacheTtlMs,
  normalizeDistance,
  normalizeFastAccessQuery,
  normalizeIdentifier,
  normalizeObjectId,
  normalizePagination,
  normalizeTimeoutMs,
  objectIdPredicate,
  queryIsLocationBound,
  removeTurkishCharacters,
  stripControlCharacters,
  turkishUpper,
  validateServiceUrl,
} from './queryPolicy';
import { DEFAULT_QUERY_POLICY } from './contracts';

describe('query policy normalization', () => {
  test('creates bounded immutable policy values', () => {
    const policy = createQueryPolicy({
      maxWhereLength: 999999,
      maxNameLength: 2,
      maxIdLength: 9999,
      minNearbyDistance: -40,
      maxNearbyDistance: 500000,
      defaultTimeoutMs: 1,
      maxTimeoutMs: 9999999,
      defaultCacheTtlMs: -20,
      maxCacheTtlMs: 99999999,
    });

    expect(Object.isFrozen(policy)).toBe(true);
    expect(policy.maxWhereLength).toBe(32000);
    expect(policy.maxNameLength).toBe(8);
    expect(policy.maxIdLength).toBe(256);
    expect(policy.minNearbyDistance).toBe(0);
    expect(policy.maxNearbyDistance).toBe(100000);
    expect(policy.defaultTimeoutMs).toBe(250);
    expect(policy.maxTimeoutMs).toBe(600000);
    expect(policy.defaultCacheTtlMs).toBe(0);
    expect(policy.maxCacheTtlMs).toBe(3600000);
  });

  test('uses defaults for invalid policy values', () => {
    const policy = createQueryPolicy({
      maxWhereLength: Number.NaN,
      maxNameLength: Number.POSITIVE_INFINITY,
      maxIdLength: Number.NaN,
    });
    expect(policy.maxWhereLength).toBe(DEFAULT_QUERY_POLICY.maxWhereLength);
    expect(policy.maxNameLength).toBe(DEFAULT_QUERY_POLICY.maxNameLength);
    expect(policy.maxIdLength).toBe(DEFAULT_QUERY_POLICY.maxIdLength);
  });

  test('strips control characters before query construction', () => {
    expect(stripControlCharacters('An\u0000ka\rra\n')).toBe('Ankara');
    expect(normalizeBusinessText('  Ankara\n Büyükşehir\t Belediyesi  ')).toBe('Ankara Büyükşehir Belediyesi');
  });

  test('returns null for empty normalized text', () => {
    expect(normalizeBusinessText('   ')).toBeNull();
    expect(normalizeBusinessText('\n\r\t')).toBeNull();
    expect(normalizeIdentifier(null, 20)).toBeNull();
  });

  test('bounds normalized text', () => {
    expect(normalizeBusinessText('abcdef', 4)).toBe('abcd');
    expect(normalizeIdentifier('  district-123 ', 8)).toBe('district');
  });
});

describe('Turkish text compatibility', () => {
  test('preserves Turkish uppercase semantics', () => {
    expect(turkishUpper('iıişğüöç')).toBe('İIİŞĞÜÖÇ');
    expect(turkishUpper('ankara')).toBe('ANKARA');
  });

  test('creates ascii search alternative', () => {
    expect(removeTurkishCharacters('ÇÖŞİÜĞçöşıüğ')).toBe('COSIUGcosiug');
  });

  test('escapes SQL quotes without deleting ordinary Turkish text', () => {
    expect(escapeSqlLiteral("Etlik'in Parkı")).toBe("Etlik''in Parkı");
  });

  test('escapes SQL LIKE wildcards', () => {
    expect(escapeSqlLikeLiteral('100%_park')).toBe('100[%][_]park');
  });

  test('builds dual ascii/Turkish name predicate when needed', () => {
    const predicate = buildNamePredicate('Çankaya');
    expect(predicate).toContain("UPPER(adi) LIKE '%CANKAYA%'");
    expect(predicate).toContain("UPPER(adi) LIKE '%ÇANKAYA%'");
  });

  test('builds a single predicate when ascii form is identical', () => {
    expect(buildNamePredicate('Ankara')).toBe("UPPER(adi) LIKE '%ANKARA%'");
  });

  test('does not build predicate for empty names', () => {
    expect(buildNamePredicate(null)).toBeNull();
    expect(buildNamePredicate('   ')).toBeNull();
  });
});

describe('identifier and object id policy', () => {
  test.each([
    [1, 1],
    ['1', 1],
    [1.9, 1],
    ['42.7', 42],
    [0, 0],
  ])('normalizes %j into object id %j', (input, expected) => {
    expect(normalizeObjectId(input)).toBe(expected);
  });

  test.each([
    [null],
    [undefined],
    [''],
    ['abc'],
    [-1],
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
    [Number.MAX_SAFE_INTEGER + 10],
  ])('rejects invalid object id %j', (input) => {
    expect(normalizeObjectId(input)).toBeNull();
  });

  test('builds safe identifier predicate', () => {
    expect(buildIdentifierPredicate('ilceid', "06'1")).toBe("ilceid = '06''1'");
  });

  test('rejects unsafe field names instead of interpolating them', () => {
    expect(buildIdentifierPredicate('ilceid; DROP TABLE x', '1')).toBeNull();
    expect(buildIdentifierPredicate('x y', '1')).toBeNull();
    expect(buildIdentifierPredicate('', '1')).toBeNull();
  });

  test('normalizes object id collections deterministically', () => {
    expect(objectIdPredicate([3, '2', 3, -1, 'x', 1])).toBe('ObjectId IN (1,2,3)');
    expect(objectIdPredicate([])).toBeNull();
    expect(objectIdPredicate(['x', -1])).toBeNull();
  });
});

describe('fast access query compilation', () => {
  test('normalizes a complete query', () => {
    const normalized = normalizeFastAccessQuery({
      ObjectId: '12',
      name: '  Çankaya  ',
      districtId: '  6 ',
      nbhoodId: '  42 ',
      showNearby: false,
      bufferDistance: '8.5',
      userLocation: { x: 1, y: 2 },
    });

    expect(normalized).toEqual({
      objectId: 12,
      name: 'Çankaya',
      districtId: '6',
      neighborhoodId: '42',
      showNearby: false,
      bufferDistance: 8.5,
      userLocation: { x: 1, y: 2 },
    });
    expect(Object.isFrozen(normalized)).toBe(true);
  });

  test('builds standard where clause with object/name/district filters', () => {
    const where = buildWhereClause(normalizeFastAccessQuery({
      ObjectId: 12,
      name: 'Çankaya',
      districtId: '6',
      nbhoodId: '42',
    }));
    expect(where).toContain('1=1');
    expect(where).toContain('ObjectId = 12');
    expect(where).toContain("ilceid = '6'");
    expect(where).toContain("mahalleid = '42'");
  });

  test('does not include district filters in nearby mode', () => {
    const where = buildWhereClause(normalizeFastAccessQuery({
      districtId: '6',
      nbhoodId: '42',
      showNearby: true,
    }));
    expect(where).toBe('1=1');
  });

  test('compiles non-spatial query', () => {
    const compiled = compileFastAccessQuery('Parks', { name: 'Gençlik' }, true);
    expect(compiled.spatial).toBe(false);
    expect(compiled.where).toContain('GENÇLİK');
    expect(compiled.fingerprint).toMatch(/^bq-/u);
    expect('geometry' in compiled).toBe(false);
  });

  test('compiles spatial query with historical distance scale', () => {
    const location = { x: 1, y: 2 };
    const compiled = compileFastAccessQuery('Parks', {
      showNearby: true,
      bufferDistance: 5,
      userLocation: location,
    });
    expect(compiled.spatial).toBe(true);
    expect(compiled.geometry).toBe(location);
    expect(compiled.distance).toBe(500);
    expect(compiled.units).toBe('meters');
    expect(compiled.spatialRelationship).toBe('intersects');
  });

  test('clamps nearby distance to policy', () => {
    const policy = createQueryPolicy({ minNearbyDistance: 2, maxNearbyDistance: 10 });
    expect(normalizeDistance(-10, policy)).toBe(2);
    expect(normalizeDistance(999, policy)).toBe(10);
    expect(normalizeDistance(4.5, policy)).toBe(4.5);
  });

  test('marks only nearby queries as location bound', () => {
    expect(queryIsLocationBound({ showNearby: true })).toBe(true);
    expect(queryIsLocationBound({ showNearby: false })).toBe(false);
    expect(queryIsLocationBound(undefined)).toBe(false);
  });
});

describe('fingerprints and stable cache identity', () => {
  test('produces same fingerprint for equivalent query object key order', () => {
    const first = normalizeFastAccessQuery({ name: 'Park', districtId: 6, ObjectId: 2 });
    const second = normalizeFastAccessQuery({ ObjectId: 2, districtId: 6, name: 'Park' });
    expect(createQueryFingerprint({ serviceKey: 'Parks', query: first, returnGeometry: false }))
      .toBe(createQueryFingerprint({ serviceKey: 'Parks', query: second, returnGeometry: false }));
  });

  test('changes fingerprint when service changes', () => {
    const query = normalizeFastAccessQuery({ name: 'Park' });
    expect(createQueryFingerprint({ serviceKey: 'A', query, returnGeometry: false }))
      .not.toBe(createQueryFingerprint({ serviceKey: 'B', query, returnGeometry: false }));
  });

  test('changes fingerprint when geometry requirement changes', () => {
    const query = normalizeFastAccessQuery({ name: 'Park' });
    expect(createQueryFingerprint({ serviceKey: 'A', query, returnGeometry: false }))
      .not.toBe(createQueryFingerprint({ serviceKey: 'A', query, returnGeometry: true }));
  });
});

describe('service URL policy', () => {
  test.each([
    ['/api/gis/query'],
    ['https://maps.example.test/arcgis/rest/services/Parks/FeatureServer/0'],
    ['http://localhost:8080/arcgis/rest/services/Test/FeatureServer/0'],
  ])('accepts HTTP(S) URL/path %s', (value) => {
    expect(validateServiceUrl(value)).toBe(value);
  });

  test.each([
    ['javascript:alert(1)'],
    ['data:text/html,test'],
    ['file:///tmp/test'],
    ['https://user:pass@example.test/path'],
    ['   '],
    [null],
  ])('rejects unsafe service URL %j', (value) => {
    expect(validateServiceUrl(value)).toBeNull();
  });
});

describe('time, cache, pagination and predicate bounds', () => {
  test('normalizes timeout into bounded range', () => {
    const policy = createQueryPolicy({ defaultTimeoutMs: 5000, maxTimeoutMs: 10000 });
    expect(normalizeTimeoutMs(undefined, policy)).toBe(5000);
    expect(normalizeTimeoutMs(1, policy)).toBe(250);
    expect(normalizeTimeoutMs(999999, policy)).toBe(10000);
  });

  test('normalizes cache TTL into bounded range', () => {
    const policy = createQueryPolicy({ defaultCacheTtlMs: 500, maxCacheTtlMs: 2000 });
    expect(normalizeCacheTtlMs(undefined, policy)).toBe(500);
    expect(normalizeCacheTtlMs(-1, policy)).toBe(0);
    expect(normalizeCacheTtlMs(5000, policy)).toBe(2000);
  });

  test('normalizes pagination with defensive bounds', () => {
    expect(normalizePagination({ offset: -5, limit: 0 })).toEqual({ offset: 0, limit: 1 });
    expect(normalizePagination({ offset: 25.8, limit: 999999 })).toEqual({ offset: 25, limit: 2000 });
    expect(normalizePagination(undefined)).toEqual({ offset: 0, limit: 100 });
  });

  test('combines only non-empty predicates', () => {
    expect(combinePredicates('1=1', null, undefined, 'x = 1')).toBe('1=1 AND x = 1');
    expect(combinePredicates(null, undefined)).toBe('1=1');
  });

  test('enforces maximum where-clause length', () => {
    const policy = createQueryPolicy({ maxWhereLength: 128, maxNameLength: 1024 });
    const where = buildWhereClause(normalizeFastAccessQuery({ name: 'x'.repeat(500) }, policy), policy);
    expect(where.length).toBeLessThanOrEqual(128);
  });
});
