import {
  QuerySafetyLimits,
  assertArcGisFieldName,
  buildArcGisEqualsFilter,
  buildArcGisInFilter,
  buildArcGisNumericEqualsFilter,
  buildArcGisUpperContainsFilter,
  escapeArcGisSqlLiteral,
  hasQueryIdentifier,
  normalizeFiniteInteger,
  normalizeHttpUrl,
  normalizeIdentifierList,
  normalizeLegacyIdentifier,
  normalizeNearbyDistanceMeters,
  normalizeQueryText,
  quoteArcGisSqlLiteral,
  readAttributeValue,
} from './querySafety';

describe('querySafety', () => {
  describe('normalizeQueryText', () => {
    test('normalizes compatibility characters, controls and repeated whitespace', () => {
      expect(normalizeQueryText('  A\u0000\tＢ   C  ')).toBe('A B C');
    });

    test('bounds untrusted text', () => {
      expect(normalizeQueryText('abcdefghij', 4)).toBe('abcd');
    });

    test('returns empty text for nullish values', () => {
      expect(normalizeQueryText(null)).toBe('');
      expect(normalizeQueryText(undefined)).toBe('');
    });
  });

  describe('identifier normalization', () => {
    test('reads legacy nested attr identifiers', () => {
      expect(normalizeLegacyIdentifier({ attr: { id: " 'abc-1' " } })).toBe('abc-1');
    });

    test('reads direct object identifiers', () => {
      expect(normalizeLegacyIdentifier({ id: 42 })).toBe('42');
      expect(normalizeLegacyIdentifier({ objectid: 43 })).toBe('43');
      expect(normalizeLegacyIdentifier({ ObjectId: 44 })).toBe('44');
    });

    test('rejects blank identifiers through hasQueryIdentifier', () => {
      expect(hasQueryIdentifier('   ')).toBe(false);
      expect(hasQueryIdentifier(null)).toBe(false);
      expect(hasQueryIdentifier('0')).toBe(true);
    });

    test('deduplicates and bounds identifier lists', () => {
      expect(normalizeIdentifierList(['a', 'a', 'b', null, 'c'], 2)).toEqual(['a', 'b']);
      expect(Object.isFrozen(normalizeIdentifierList(['a']))).toBe(true);
    });

    test('accepts comma-separated legacy identifiers', () => {
      expect(normalizeIdentifierList('1,2, 3')).toEqual(['1', '2', '3']);
    });
  });

  describe('ArcGIS where builders', () => {
    test('accepts safe field names', () => {
      expect(assertArcGisFieldName('mahalleid')).toBe('mahalleid');
      expect(assertArcGisFieldName('_object_id2')).toBe('_object_id2');
    });

    test.each([
      'name;delete',
      'field name',
      'field-name',
      '1field',
      "x') OR 1=1 --",
    ])('rejects unsafe field name %s', (field) => {
      expect(() => assertArcGisFieldName(field)).toThrow(/geçersiz/u);
    });

    test('escapes apostrophes in string literals', () => {
      expect(escapeArcGisSqlLiteral("O'Brien")).toBe("O''Brien");
      expect(quoteArcGisSqlLiteral("O'Brien")).toBe("'O''Brien'");
    });

    test('builds equality predicates with escaped identifiers', () => {
      expect(buildArcGisEqualsFilter('id', "a'b")).toBe("id='a''b'");
    });

    test('builds bounded IN predicates and removes duplicates', () => {
      expect(buildArcGisInFilter('id', ["a'", 'b', 'b'])).toBe("id IN ('a''','b')");
      expect(buildArcGisInFilter('id', [])).toBeNull();
    });

    test('builds uppercase contains predicates without allowing quote breakout', () => {
      expect(buildArcGisUpperContainsFilter(
        'adi',
        "ankara' OR 1=1 --",
        { uppercase: (value) => value.toLocaleUpperCase('tr-TR') },
      )).toBe("UPPER(adi) LIKE '%ANKARA'' OR 1=1 --%'");
    });

    test('accepts only actual finite integers for numeric predicates', () => {
      expect(buildArcGisNumericEqualsFilter('objectid', 42, 1)).toBe('objectid=42');
      expect(buildArcGisNumericEqualsFilter('objectid', '42', 1)).toBeNull();
      expect(buildArcGisNumericEqualsFilter('objectid', 42.5, 1)).toBeNull();
      expect(buildArcGisNumericEqualsFilter('objectid', Number.POSITIVE_INFINITY, 1)).toBeNull();
    });
  });

  describe('number normalization', () => {
    test('does not coerce string identity values to integers', () => {
      expect(normalizeFiniteInteger(12)).toBe(12);
      expect(normalizeFiniteInteger('12')).toBeNull();
    });

    test('enforces supplied integer bounds', () => {
      expect(normalizeFiniteInteger(5, 1, 10)).toBe(5);
      expect(normalizeFiniteInteger(0, 1, 10)).toBeNull();
      expect(normalizeFiniteInteger(11, 1, 10)).toBeNull();
    });

    test('normalizes nearby distance with a legacy multiplier while bounding it', () => {
      expect(normalizeNearbyDistanceMeters(20, { multiplier: 100 })).toBe(2_000);
      expect(normalizeNearbyDistanceMeters(999_999, { multiplier: 100 })).toBe(
        QuerySafetyLimits.maxNearbyDistanceMeters,
      );
      expect(normalizeNearbyDistanceMeters(-10)).toBe(1);
    });

    test('uses a safe fallback for malformed nearby distance', () => {
      expect(normalizeNearbyDistanceMeters('not-a-number')).toBe(
        QuerySafetyLimits.defaultNearbyDistanceMeters,
      );
    });
  });

  describe('record access', () => {
    test('reads nested legacy attr values', () => {
      expect(readAttributeValue({ attr: { id: 7 } }, 'id')).toBe(7);
    });

    test('reads direct record values when no attr record exists', () => {
      expect(readAttributeValue({ id: 8 }, 'id')).toBe(8);
    });

    test('fails closed for primitives', () => {
      expect(readAttributeValue('x', 'id')).toBeUndefined();
    });
  });

  describe('HTTP URL normalization', () => {
    test('accepts relative same-origin-looking values against a supplied base', () => {
      expect(normalizeHttpUrl('/api/test', 'https://example.test')).toBe(
        'https://example.test/api/test',
      );
    });

    test('accepts HTTPS URLs without credentials', () => {
      expect(normalizeHttpUrl('https://example.test/path')).toBe('https://example.test/path');
    });

    test('rejects embedded credentials and non-http protocols', () => {
      expect(normalizeHttpUrl('https://user:pass@example.test/path')).toBeNull();
      expect(normalizeHttpUrl('javascript:alert(1)')).toBeNull();
      expect(normalizeHttpUrl('data:text/plain,hello')).toBeNull();
    });
  });
});
