import { beforeEach, describe, expect, test, vi } from 'vitest';
import { ArrayHelper } from './ArrayHelper';
import { DatetimeHelper } from './DatetimeHelper';
import { LocalStorageHelper } from './LocalStorageHelper';
import {
  HasNumeric,
  IsAlphabetic,
  IsFloat,
  IsInt,
  IsNull,
  IsNumeric,
  clone,
} from './ObjectHelper';
import { TextHelper } from './TextHelper';

describe('ObjectHelper typed compatibility', () => {
  test.each([null, undefined, '', 'Null', 'null'])('treats %j as null-like', (value) => {
    expect(IsNull(value)).toBe(true);
  });

  test.each([0, false, '0', [], {}, 'NULL'])('does not broaden legacy null semantics for %j', (value) => {
    expect(IsNull(value)).toBe(false);
  });

  test('detects numeric content', () => {
    expect(HasNumeric('abc123')).toBe(true);
    expect(HasNumeric('abc')).toBe(false);
    expect(HasNumeric(null)).toBe(false);
  });

  test.each([
    ['1', true],
    ['1.5', true],
    [1.5, true],
    ['', false],
    [null, false],
    ['x', false],
    [Number.POSITIVE_INFINITY, false],
  ])('normalizes numeric predicate for %j', (value, expected) => {
    expect(IsNumeric(value)).toBe(expected);
  });

  test('distinguishes integer and float numbers', () => {
    expect(IsInt(2)).toBe(true);
    expect(IsInt(2.2)).toBe(false);
    expect(IsInt('2')).toBe(false);
    expect(IsFloat(2.2)).toBe(true);
    expect(IsFloat(2)).toBe(false);
    expect(IsFloat('2.2')).toBe(false);
  });

  test('checks alphabetic legacy character set', () => {
    expect(IsAlphabetic('Test Value (A)')).toBe(true);
    expect(IsAlphabetic('Test-1')).toBe(false);
  });

  test('clones arrays and shallow nested object values without returning same root', () => {
    const source = { first: { id: 1 }, second: 2 };
    const result = clone(source);
    expect(result).toEqual(source);
    expect(result).not.toBe(source);
    expect(result.first).not.toBe(source.first);

    const array = [{ id: 1 }, { id: 2 }];
    const clonedArray = clone(array);
    expect(clonedArray).toEqual(array);
    expect(clonedArray).not.toBe(array);
  });
});

describe('TextHelper typed compatibility', () => {
  test('uppercases Turkish characters deterministically', () => {
    expect(TextHelper.TurkishToUpper('çiğdem ısı')).toBe('ÇİĞDEM ISI');
    expect(TextHelper.TurkishToUpper(null)).toBeUndefined();
  });

  test('lowercases Turkish characters with legacy I semantics', () => {
    expect(TextHelper.TurkishToLower('ÇİĞDEM I')).toBe('çiğdem i');
    expect(TextHelper.TurkishToLower(undefined)).toBeUndefined();
  });

  test('repairs common mojibake sequences', () => {
    expect(TextHelper.UnicodeToUtf8('Ãœmit ÅŸehir ÄŸ')).toBe('Ümit şehir ğ');
  });

  test('converts selected escaped Turkish code points to ASCII', () => {
    expect(TextHelper.convertToASCII('ÂâûİıŞşÜü')).toBe('AauIiSsUu');
  });

  test('maps Turkish characters to ASCII and strips unsafe punctuation', () => {
    expect(TextHelper.RemoveTurkishChars('Çankaya / Şube!')).toBe('Cankaya  Sube');
  });

  test('creates upper Turkish character sequence using legacy algorithm', () => {
    expect(TextHelper.ToTurkish('iığüşöçabc')).toBe('İIĞÜŞÖÇABC');
  });

  test('creates valid hex random color shape', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    expect(TextHelper.CreateRandomColor()).toMatch(/^#[0-9a-f]{6}$/u);
    expect(TextHelper.CreateRandomDarkColor()).toMatch(/^#[0-9]{6}$/u);
  });

  test('creates GUID-like value without Math.random dependency when crypto exists', () => {
    const first = TextHelper.CreateGuid();
    const second = TextHelper.CreateGuid();
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
    expect(second).toMatch(/^[0-9a-f-]{36}$/u);
  });

  test('shortens text while preserving historical html ellipsis marker', () => {
    expect(TextHelper.ShortenText('abcdef', 4)).toBe('abc&hellip;');
    expect(TextHelper.ShortenText('abc', 4)).toBe('abc');
    expect(TextHelper.ShortenText(null, 4)).toBeNull();
  });

  test('sanitizes string to historical allowlist', () => {
    expect(TextHelper.SanitizeString('<script>Çankaya!</script>')).toBe('scriptÇankayascript');
  });
});

describe('ArrayHelper generic behavior', () => {
  test('filters and preserves legacy _INDEX metadata', () => {
    const values = [{ id: 1 }, { id: 2 }, { id: 1 }];
    const found = ArrayHelper.Filter(values, 'id', 1);
    expect(found).toHaveLength(2);
    expect((found[0] as { _INDEX?: number })._INDEX).toBe(0);
    expect((found[1] as { _INDEX?: number })._INDEX).toBe(2);
  });

  test('find returns first match or null', () => {
    const values = [{ title: 'A' }, { title: 'B' }];
    expect(ArrayHelper.Find(values, 'title', 'B')).toBe(values[1]);
    expect(ArrayHelper.Find(values, 'title', 'X')).toBeNull();
    expect(ArrayHelper.Find(null, 'title', 'X')).toBeNull();
  });

  test('orders Turkish titles deterministically', () => {
    const values = [{ title: 'Ş' }, { title: 'A' }, { title: 'Ç' }];
    const ordered = [...values].sort((left, right) => ArrayHelper.OrderByTurkish(left, right, 'title'));
    expect(ordered.map((item) => item.title)).toEqual(['A', 'Ç', 'Ş']);
  });

  test('groups direct fields', () => {
    const grouped = ArrayHelper.GroupBy([
      { category: 'a', id: 1 },
      { category: 'b', id: 2 },
      { category: 'a', id: 3 },
    ], 'category');
    expect(grouped.a?.map((item) => item.id)).toEqual([1, 3]);
    expect(grouped.b?.map((item) => item.id)).toEqual([2]);
  });

  test('groups nested attr fields', () => {
    const grouped = ArrayHelper.GroupBy([
      { attr: { type: 'park' }, id: 1 },
      { attr: { type: 'taxi' }, id: 2 },
      { attr: { type: 'park' }, id: 3 },
    ], 'type', true);
    expect(grouped.park).toHaveLength(2);
    expect(grouped.taxi).toHaveLength(1);
  });

  test('counts group values', () => {
    expect(ArrayHelper.GroupByCount([
      { category: 'a' },
      { category: 'b' },
      { category: 'a' },
    ], 'category')).toEqual([
      { key: 'a', count: 2 },
      { key: 'b', count: 1 },
    ]);
  });

  test('deduplicates structurally equivalent serializable values in linear pass', () => {
    expect(ArrayHelper.Distinct([
      { id: 1, title: 'A' },
      { id: 1, title: 'A' },
      { id: 2, title: 'B' },
    ])).toEqual([
      { id: 1, title: 'A' },
      { id: 2, title: 'B' },
    ]);
  });
});

describe('DatetimeHelper typed behavior', () => {
  test('formats ESRI dates and rejects null-like input', () => {
    const timestamp = new Date(2026, 8, 16, 12, 30, 0).getTime();
    expect(DatetimeHelper.ConvertFromEsriDate(timestamp)).toBe('16/9/2026');
    expect(DatetimeHelper.ConvertFromEsriDate(null)).toBeNull();
    expect(DatetimeHelper.ConvertFromEsriDate('not-a-date')).toBeNull();
  });

  test('parses explicit format tokens', () => {
    const value = DatetimeHelper.StringToDateTime('16/09/2026 13:45:20', 'dd/mm/yyyy hh:ii:ss');
    expect(value.getFullYear()).toBe(2026);
    expect(value.getMonth()).toBe(8);
    expect(value.getDate()).toBe(16);
    expect(value.getHours()).toBe(13);
    expect(value.getMinutes()).toBe(45);
    expect(value.getSeconds()).toBe(20);
  });

  test('computes date differences', () => {
    const begin = new Date(2026, 0, 1, 0, 0, 0);
    const end = new Date(2026, 0, 2, 2, 31, 0);
    expect(DatetimeHelper.diffMilliSeconds(end, begin)).toBe(95_460_000);
    expect(DatetimeHelper.diffDays(end, begin)).toBe(1);
    expect(DatetimeHelper.diffHrs(end, begin)).toBe(2);
    expect(DatetimeHelper.diffMins(end, begin)).toBe(31);
  });

  test('formats with and without time', () => {
    const date = new Date(2026, 8, 6, 7, 5, 0);
    expect(DatetimeHelper.GetFormatted(date)).toBe('06/09/2026 - 07:05');
    expect(DatetimeHelper.GetFormatted(date, false)).toBe('06/09/2026');
  });
});

describe('LocalStorageHelper modern persistence', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  test('round trips versioned JSON value', () => {
    LocalStorageHelper.Set('preferences', { theme: 'dark', density: 'compact' });
    expect(LocalStorageHelper.Get('preferences')).toEqual({ theme: 'dark', density: 'compact' });
    expect(window.localStorage.getItem('preferences')).toMatch(/^kr:v2:/u);
  });

  test('reads historical raw JSON values without crypto dependency', () => {
    window.localStorage.setItem('legacy-json', JSON.stringify({ enabled: true }));
    expect(LocalStorageHelper.Get('legacy-json')).toEqual({ enabled: true });
  });

  test('fails closed for unreadable historical ciphertext', () => {
    window.localStorage.setItem('legacy-cipher', 'U2FsdGVkX1+not-json');
    expect(LocalStorageHelper.Get('legacy-cipher')).toBeNull();
    expect(LocalStorageHelper.Read('legacy-cipher')).toMatchObject({ ok: false, reason: 'invalid' });
  });

  test('returns missing state for absent key', () => {
    expect(LocalStorageHelper.Read('missing')).toEqual({ ok: false, value: null, reason: 'missing' });
  });

  test('removes keys safely', () => {
    LocalStorageHelper.Set('remove-me', { id: 1 });
    expect(LocalStorageHelper.Remove('remove-me')).toBe(true);
    expect(LocalStorageHelper.Get('remove-me')).toBeNull();
  });

  test('rejects invalid storage keys', () => {
    LocalStorageHelper.Set('', { id: 1 });
    LocalStorageHelper.Set('bad\nkey', { id: 2 });
    expect(window.localStorage.length).toBe(0);
  });

  test('clears only matching namespace', () => {
    LocalStorageHelper.Set('kr:a', 1);
    LocalStorageHelper.Set('kr:b', 2);
    LocalStorageHelper.Set('other', 3);
    expect(LocalStorageHelper.ClearNamespace('kr:')).toBe(2);
    expect(LocalStorageHelper.Get('kr:a')).toBeNull();
    expect(LocalStorageHelper.Get('other')).toBe(3);
  });

  test('refuses oversized values rather than exhausting storage quota', () => {
    LocalStorageHelper.Set('huge', 'x'.repeat(600 * 1024));
    expect(window.localStorage.getItem('huge')).toBeNull();
  });

  test('handles circular objects without throwing', () => {
    const value: { self?: unknown } = {};
    value.self = value;
    expect(() => LocalStorageHelper.Set('circular', value)).not.toThrow();
    expect(LocalStorageHelper.Get('circular')).toBeNull();
  });
});
