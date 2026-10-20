import { describe, expect, it, vi } from 'vitest';
import { geocodeAddress, searchAddressCandidates } from './addressGeocoding';

describe('geocodeAddress', () => {
  it('uses an Ankara-bounded Turkish address query and returns a zoomed map target', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://nominatim.openstreetmap.org');
      expect(url.pathname).toBe('/search');
      expect(url.searchParams.get('q')).toBe('Kızılay Mahallesi');
      expect(url.searchParams.get('countrycodes')).toBe('tr');
      expect(url.searchParams.get('bounded')).toBe('1');
      expect(url.searchParams.get('viewbox')).toBe('31.0,40.8,34.3,38.8');
      expect(url.searchParams.get('limit')).toBe('5');
      return new Response(JSON.stringify([{
        display_name: 'Kızılay Mahallesi, Çankaya, Ankara, Türkiye',
        lat: '39.9208',
        lon: '32.8541',
        addresstype: 'neighbourhood',
        type: 'administrative',
      }]), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    });

    const result = await geocodeAddress(' Kızılay   Mahallesi ', { fetchImpl });

    expect(result).toMatchObject({
      displayName: 'Kızılay Mahallesi, Çankaya, Ankara, Türkiye',
      latitude: 39.9208,
      longitude: 32.8541,
      zoom: 15,
      attribution: '© OpenStreetMap katkıcıları',
      attributionUrl: 'https://www.openstreetmap.org/copyright',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('returns multiple distinct address options so the user can choose the exact match', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify([
      {
        display_name: 'Kızılay, Çankaya, Ankara, Türkiye',
        lat: '39.9208',
        lon: '32.8541',
        addresstype: 'neighbourhood',
        type: 'administrative',
      },
      {
        display_name: 'Kızılay Meydanı, Çankaya, Ankara, Türkiye',
        lat: '39.9209',
        lon: '32.8542',
        addresstype: 'square',
        type: 'place',
      },
      {
        display_name: 'Geçersiz adres adayı',
        lat: 'NaN',
        lon: '32.8542',
      },
    ]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const results = await searchAddressCandidates('Kızılay seçenek testi', { fetchImpl });

    expect(results).toHaveLength(2);
    expect(results.map((result) => result.displayName)).toEqual([
      'Kızılay, Çankaya, Ankara, Türkiye',
      'Kızılay Meydanı, Çankaya, Ankara, Türkiye',
    ]);
    expect(results[0]).toMatchObject({ latitude: 39.9208, longitude: 32.8541, zoom: 15 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects empty or unsafe queries before any external request', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(geocodeAddress('   ', { fetchImpl })).rejects.toThrow(/adres veya yer adı/i);
    await expect(geocodeAddress('1\u0000Main Street', { fetchImpl })).rejects.toThrow(/adres veya yer adı/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects malformed coordinates rather than navigating to a guessed point', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify([{
      display_name: 'Bozuk sonuç',
      lat: 'NaN',
      lon: '32.8',
      addresstype: 'house',
    }]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    await expect(geocodeAddress('Bilinmeyen adres', { fetchImpl })).rejects.toThrow(/adres bulunamadı/i);
  });
});
