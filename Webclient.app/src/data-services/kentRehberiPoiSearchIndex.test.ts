import { afterEach, describe, expect, it } from 'vitest';
import {
  getKentRehberiPoiSearchSnapshot,
  normalizeKentRehberiPoiSearchText,
  publishKentRehberiPoiSearchIndex,
  searchKentRehberiPoiPoints,
  type KentRehberiPoiSearchInput,
} from './kentRehberiPoiSearchIndex';

let disposers: Array<() => void> = [];

afterEach(() => {
  disposers.reverse().forEach((dispose) => dispose());
  disposers = [];
});

const publish = (records: readonly KentRehberiPoiSearchInput[]): void => {
  disposers.push(publishKentRehberiPoiSearchIndex(records));
};

describe('Kent Rehberi point-name search index', () => {
  it('normalizes Turkish characters and searches point names across categories', () => {
    publish([
      { id: 1, name: 'Seğmen Su Satış Noktası', longitude: 32.854, latitude: 39.920 },
      { id: 2, name: 'Seğmen Su Fabrikası', longitude: 32.802, latitude: 39.791 },
      { id: 3, name: 'Ulus Metro Durağı', longitude: 32.860, latitude: 39.941 },
    ]);

    const result = searchKentRehberiPoiPoints(getKentRehberiPoiSearchSnapshot(), 'segmen su');

    expect(result.items.map((point) => point.id)).toEqual([2, 1]);
    expect(result.totalCount).toBe(2);
    expect(result.truncated).toBe(false);
    expect(normalizeKentRehberiPoiSearchText('KÜTÜPHANE ÇAĞRIŞIMI')).toBe('kutuphane cagrisimi');
  });

  it('searches names only and does not match an address when the name is different', () => {
    publish([
      {
        id: 10,
        name: 'Spor Tesisi',
        address: 'Kızılay Metro Durağı yanı',
        longitude: 32.854,
        latitude: 39.920,
      },
    ]);

    const result = searchKentRehberiPoiPoints(getKentRehberiPoiSearchSnapshot(), 'metro duragi');

    expect(result.items).toEqual([]);
    expect(result.totalCount).toBe(0);
  });

  it('skips invalid ids, missing coordinates, invalid coordinates, and empty names', () => {
    publish([
      { id: 11, name: 'Valid Point', longitude: 32.854, latitude: 39.920 },
      { id: 12, name: 'Missing longitude', longitude: null, latitude: 39.920 },
      { id: 13, name: 'Bad latitude', longitude: 32.854, latitude: 91 },
      { id: 0, name: 'Bad id', longitude: 32.854, latitude: 39.920 },
      { id: 14, name: '   ', longitude: 32.854, latitude: 39.920 },
    ]);

    expect(getKentRehberiPoiSearchSnapshot().points.map((point) => point.id)).toEqual([11]);
  });

  it('caps rendered results while preserving the total matching count', () => {
    publish(Array.from({ length: 5 }, (_, index) => ({
      id: index + 1,
      name: `Park ${index + 1}`,
      longitude: 32.8 + index / 1000,
      latitude: 39.9,
    })));

    const result = searchKentRehberiPoiPoints(getKentRehberiPoiSearchSnapshot(), 'park', 2);

    expect(result.items).toHaveLength(2);
    expect(result.totalCount).toBe(5);
    expect(result.truncated).toBe(true);
  });

  it('does not let an older map instance clear a newer index', () => {
    const disposeOld = publishKentRehberiPoiSearchIndex([
      { id: 20, name: 'Old Point', longitude: 32.8, latitude: 39.9 },
    ]);
    const disposeNew = publishKentRehberiPoiSearchIndex([
      { id: 21, name: 'New Point', longitude: 32.8, latitude: 39.9 },
    ]);
    disposers.push(disposeNew);
    disposeOld();

    expect(getKentRehberiPoiSearchSnapshot().points.map((point) => point.name)).toEqual(['New Point']);
  });
});
