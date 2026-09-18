import { describe, expect, it } from 'vitest';
import { Constants_ServiceResultType } from '../../../Core/Constants';
import {
  DEFAULT_FAST_ACCESS_QUERY,
  createQueryLogDescription,
  fastAccessResultKey,
  normalizeFastAccessDetail,
  normalizeFastAccessEnvelope,
  normalizeFastAccessResultItem,
  normalizeFastAccessResults,
  normalizeLookupOptions,
  paginateFastAccessResults,
  toBusinessQuery,
  updateFastAccessQuery,
} from './FastAccessQueryModel';

describe('FastAccessQueryModel', () => {
  it('normalizes legacy success envelopes', () => {
    expect(normalizeFastAccessEnvelope({
      Type: Constants_ServiceResultType.Success,
      Data: [{ attr: { id: 1 } }],
    })).toEqual({
      type: Constants_ServiceResultType.Success,
      data: [{ attr: { id: 1 } }],
      message: null,
    });
  });

  it('normalizes lookup options and removes duplicates', () => {
    const options = normalizeLookupOptions({
      type: Constants_ServiceResultType.Success,
      data: [
        { attr: { id: '1', ad: 'Çankaya' } },
        { attr: { id: '2', ad: 'Keçiören' } },
        { attr: { id: '1', ad: 'Çankaya tekrar' } },
      ],
    });
    expect(options).toEqual([
      { id: '1', label: 'Çankaya' },
      { id: '2', label: 'Keçiören' },
    ]);
  });

  it('maps result attributes into a stable view model', () => {
    expect(normalizeFastAccessResultItem({
      attr: {
        objectid: 15,
        adi: 'Park',
        adres: 'Ankara',
        telefon: '0312',
      },
    })).toEqual({
      objectId: 15,
      title: 'Park',
      address: 'Ankara',
      phone: '0312',
      addressDescription: 'Adres tarifi bulunmuyor',
    });
  });

  it('rejects records without a stable identifier', () => {
    expect(normalizeFastAccessResultItem({ attr: { adi: 'Kimliksiz' } })).toBeNull();
  });

  it('deduplicates results by object id', () => {
    const results = normalizeFastAccessResults({
      type: Constants_ServiceResultType.Success,
      data: [
        { attr: { objectid: 1, adi: 'Bir' } },
        { attr: { objectid: 1, adi: 'Tekrar' } },
        { attr: { objectid: 2, adi: 'İki' } },
      ],
    });
    expect(results.map((item) => item.title)).toEqual(['Bir', 'İki']);
  });

  it('extracts detail geometry and attributes', () => {
    expect(normalizeFastAccessDetail({
      type: Constants_ServiceResultType.Success,
      data: [{
        attr: { objectid: 1, adi: 'Detay' },
        geometry: { latitude: 39.9, longitude: 32.8 },
      }],
    })).toMatchObject({
      geometry: { latitude: 39.9, longitude: 32.8 },
      attributes: { objectid: 1, adi: 'Detay' },
    });
  });

  it('returns null for unsuccessful detail payloads', () => {
    expect(normalizeFastAccessDetail({
      type: Constants_ServiceResultType.Error,
      message: 'error',
    })).toBeNull();
  });

  it('updates only supported query fields', () => {
    const named = updateFastAccessQuery(DEFAULT_FAST_ACCESS_QUERY, 'name', '  Park  ');
    expect(named.name).toBe('Park');
    const unsupported = updateFastAccessQuery(named, 'unknown', 'x');
    expect(unsupported).toBe(named);
  });

  it('bounds buffer values', () => {
    expect(updateFastAccessQuery(
      DEFAULT_FAST_ACCESS_QUERY,
      'bufferDistance',
      1000,
    ).bufferDistance).toBe(100);
  });

  it('maps the UI filter state into the business contract', () => {
    const query = {
      ...DEFAULT_FAST_ACCESS_QUERY,
      name: 'Park',
      districtId: '06',
      nbhoodId: '100',
      showNearby: true,
      bufferDistance: 25,
    };
    expect(toBusinessQuery(query)).toMatchObject({
      name: 'Park',
      districtId: '06',
      nbhoodId: '100',
      showNearby: true,
      bufferDistance: 25,
    });
  });

  it('creates bounded client pages', () => {
    const page = paginateFastAccessResults(
      Array.from({ length: 45 }, (_, index) => index + 1),
      2,
      20,
    );
    expect(page.page).toBe(2);
    expect(page.pageCount).toBe(3);
    expect(page.items[0]).toBe(21);
    expect(page.items.at(-1)).toBe(40);
  });

  it('repairs out-of-range page values', () => {
    const page = paginateFastAccessResults([1, 2, 3], 999, 20);
    expect(page.page).toBe(1);
    expect(page.items).toEqual([1, 2, 3]);
  });

  it('builds stable result keys', () => {
    expect(fastAccessResultKey({
      objectId: 42,
      title: 'A',
      phone: '',
      address: '',
      addressDescription: '',
    })).toBe('fast-access:42');
  });

  it('keeps log descriptions bounded to useful filter text', () => {
    expect(createQueryLogDescription({
      ...DEFAULT_FAST_ACCESS_QUERY,
      districtName: 'Çankaya',
      nbhoodName: 'Kızılay',
      name: 'Park',
    })).toBe('Çankaya/Kızılay/Park');
  });
});
