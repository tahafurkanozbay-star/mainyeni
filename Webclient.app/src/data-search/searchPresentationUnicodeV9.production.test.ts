import { createSearchHighlightRangesV9 } from './searchResultPresentationRuntimeV9';

describe('search presentation v9 unicode and boundary regressions', () => {
  describe('Turkish locale folding', () => {
    test.each([
      ['Çankaya Belediyesi', 'cankaya'],
      ['Şehitler Caddesi', 'sehitler'],
      ['Gölbaşı', 'golbasi'],
      ['Küçükesat', 'kucukesat'],
      ['Öveçler', 'ovecler'],
      ['İncek', 'incek'],
    ])('maps normalized query %s / %s back to source offsets', (value, term) => {
      const ranges = createSearchHighlightRangesV9(value, [term]);
      expect(ranges).toHaveLength(1);
      const [range] = ranges;
      expect(range.start).toBe(0);
      expect(range.end).toBeGreaterThan(range.start);
      expect(range.end).toBeLessThanOrEqual(value.length);
      expect(range.term).toBe(term);
    });

    test('finds a Turkish folded token after a prefix', () => {
      const value = 'Ankara / Çankaya Belediyesi';
      const [range] = createSearchHighlightRangesV9(value, ['cankaya']);
      expect(value.slice(range.start, range.end)).toBe('Çankaya');
    });

    test('preserves UTF-16 source offsets around Turkish characters', () => {
      const value = 'A Şehitler B';
      const [range] = createSearchHighlightRangesV9(value, ['sehitler']);
      expect(value.slice(range.start, range.end)).toBe('Şehitler');
    });
  });

  describe('bounded output', () => {
    test('returns no ranges when maximum is zero', () => {
      expect(createSearchHighlightRangesV9('park park', ['park'], 0)).toEqual([]);
    });

    test('never exceeds the caller maximum', () => {
      const ranges = createSearchHighlightRangesV9('park park park park park park', ['park'], 3);
      expect(ranges).toHaveLength(3);
    });

    test('large repeated input remains bounded', () => {
      const value = Array.from({ length: 2_000 }, () => 'park').join(' ');
      const ranges = createSearchHighlightRangesV9(value, ['park'], 8);
      expect(ranges).toHaveLength(8);
      expect(ranges.every(range => range.end <= value.length)).toBe(true);
    });

    test('duplicate terms do not multiply output', () => {
      const ranges = createSearchHighlightRangesV9('Ankara Ankara', ['ankara', 'ankara', 'ANKARA'], 16);
      expect(ranges).toHaveLength(2);
    });

    test('empty terms remain empty', () => {
      expect(createSearchHighlightRangesV9('Ankara', [], 16)).toEqual([]);
    });

    test('empty source remains empty', () => {
      expect(createSearchHighlightRangesV9('', ['ankara'], 16)).toEqual([]);
    });

    test('whitespace-only source remains empty', () => {
      expect(createSearchHighlightRangesV9('   ', ['ankara'], 16)).toEqual([]);
    });
  });

  describe('overlap governance', () => {
    test('prefers the longest term when ranges are identical', () => {
      const [range] = createSearchHighlightRangesV9('Ankara', ['ank', 'ankara']);
      expect(range.start).toBe(0);
      expect(range.end).toBe(6);
      expect(range.term).toBe('ankara');
    });

    test('merges overlapping prefix matches into one source range', () => {
      const ranges = createSearchHighlightRangesV9('Çankaya', ['can', 'cankaya']);
      expect(ranges).toHaveLength(1);
      expect(ranges[0].start).toBe(0);
      expect(ranges[0].end).toBe('Çankaya'.length);
    });

    test('keeps separated matches separated', () => {
      const ranges = createSearchHighlightRangesV9('Ankara Çankaya', ['ankara', 'cankaya']);
      expect(ranges).toHaveLength(2);
      expect(ranges[0].end).toBeLessThan(ranges[1].start);
    });

    test('adjacent matches merge without invalid offsets', () => {
      const ranges = createSearchHighlightRangesV9('Ankara', ['ank', 'ara']);
      expect(ranges).toHaveLength(1);
      expect(ranges[0]).toMatchObject({ start: 0, end: 6 });
    });
  });

  describe('determinism and immutability', () => {
    test('same input yields structurally identical output', () => {
      const first = createSearchHighlightRangesV9('Ankara Çankaya', ['ankara', 'cankaya'], 8);
      const second = createSearchHighlightRangesV9('Ankara Çankaya', ['ankara', 'cankaya'], 8);
      expect(second).toEqual(first);
    });

    test('term order does not change final ranges', () => {
      const first = createSearchHighlightRangesV9('Ankara Çankaya', ['ankara', 'cankaya'], 8);
      const second = createSearchHighlightRangesV9('Ankara Çankaya', ['cankaya', 'ankara'], 8);
      expect(second).toEqual(first);
    });

    test('returned collection is frozen', () => {
      const ranges = createSearchHighlightRangesV9('Ankara', ['ankara']);
      expect(Object.isFrozen(ranges)).toBe(true);
    });

    test('returned range objects are frozen', () => {
      const ranges = createSearchHighlightRangesV9('Ankara', ['ankara']);
      expect(Object.isFrozen(ranges[0])).toBe(true);
    });

    test('does not mutate caller term collection', () => {
      const terms = ['cankaya', 'ankara'];
      const before = [...terms];
      createSearchHighlightRangesV9('Ankara Çankaya', terms);
      expect(terms).toEqual(before);
    });
  });

  describe('source offset safety', () => {
    test.each([
      ['Ankara Büyükşehir Belediyesi', ['ankara', 'buyuksehir', 'belediyesi']],
      ['Çankaya / Kızılay / Atatürk Bulvarı', ['cankaya', 'kizilay', 'ataturk']],
      ['Şehit Ömer Halisdemir Caddesi', ['sehit', 'omer', 'halisdemir']],
      ['Gölbaşı 06830 Ankara', ['golbasi', '06830', 'ankara']],
    ])('all offsets stay inside source for %s', (value, terms) => {
      const ranges = createSearchHighlightRangesV9(value, terms, 16);
      expect(ranges.length).toBeGreaterThan(0);
      for (const range of ranges) {
        expect(Number.isInteger(range.start)).toBe(true);
        expect(Number.isInteger(range.end)).toBe(true);
        expect(range.start).toBeGreaterThanOrEqual(0);
        expect(range.end).toBeGreaterThan(range.start);
        expect(range.end).toBeLessThanOrEqual(value.length);
      }
    });

    test('ranges are ordered by source position', () => {
      const ranges = createSearchHighlightRangesV9('Çankaya Ankara Kızılay', ['kizilay', 'cankaya', 'ankara']);
      for (let index = 1; index < ranges.length; index += 1) {
        expect(ranges[index].start).toBeGreaterThanOrEqual(ranges[index - 1].end);
      }
    });

    test('unmatched terms never fabricate a range', () => {
      expect(createSearchHighlightRangesV9('Ankara', ['istanbul'])).toEqual([]);
    });

    test('partial suffix match maps to exact source substring', () => {
      const value = 'Belediyesi';
      const [range] = createSearchHighlightRangesV9(value, ['iyesi']);
      expect(value.slice(range.start, range.end).toLocaleLowerCase('tr-TR')).toBe('iyesi');
    });
  });

  describe('adversarial text admission', () => {
    test('markup-like text is treated as plain searchable text', () => {
      const value = '<script>Ankara</script>';
      const [range] = createSearchHighlightRangesV9(value, ['ankara']);
      expect(value.slice(range.start, range.end)).toBe('Ankara');
    });

    test('quotes and angle brackets do not alter range semantics', () => {
      const value = '"<Çankaya>"';
      const [range] = createSearchHighlightRangesV9(value, ['cankaya']);
      expect(value.slice(range.start, range.end)).toBe('Çankaya');
    });

    test('URL-like source is not interpreted as transport', () => {
      const value = 'https://example.invalid/Ankara?q=Çankaya';
      const ranges = createSearchHighlightRangesV9(value, ['ankara', 'cankaya']);
      expect(ranges).toHaveLength(2);
      expect(ranges.map(range => value.slice(range.start, range.end))).toEqual(['Ankara', 'Çankaya']);
    });

    test('control whitespace cannot create out-of-bounds offsets', () => {
      const value = 'Ankara\nÇankaya\tKızılay';
      const ranges = createSearchHighlightRangesV9(value, ['ankara', 'cankaya', 'kizilay']);
      expect(ranges).toHaveLength(3);
      expect(ranges.every(range => range.start >= 0 && range.end <= value.length)).toBe(true);
    });

    test('very long unmatched term does not allocate output ranges', () => {
      const term = 'x'.repeat(10_000);
      expect(createSearchHighlightRangesV9('Ankara', [term], 16)).toEqual([]);
    });
  });

  describe('numeric and address-oriented tokens', () => {
    test.each([
      ['06550 Çankaya', '06550'],
      ['100. Yıl Mahallesi', '100'],
      ['No: 42', '42'],
      ['Cadde 7', '7'],
    ])('highlights numeric token %s / %s', (value, term) => {
      const ranges = createSearchHighlightRangesV9(value, [term]);
      expect(ranges).toHaveLength(1);
      expect(value.slice(ranges[0].start, ranges[0].end)).toContain(term);
    });

    test('multiple address components remain source ordered', () => {
      const value = 'Atatürk Bulvarı No: 42 Çankaya Ankara';
      const ranges = createSearchHighlightRangesV9(value, ['ataturk', '42', 'cankaya', 'ankara']);
      expect(ranges).toHaveLength(4);
      const starts = ranges.map(range => range.start);
      expect(starts).toEqual(starts.toSorted((a, b) => a - b));
    });
  });
});
