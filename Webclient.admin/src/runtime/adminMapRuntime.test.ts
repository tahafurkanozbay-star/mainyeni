import {
  DEFAULT_ADMIN_MAP_CONFIG,
  normalizeAdminMapConfig,
} from './adminMapRuntime';

describe('adminMapRuntime', () => {
  test('uses Ankara-safe defaults when configuration is absent', () => {
    expect(normalizeAdminMapConfig(undefined)).toEqual(DEFAULT_ADMIN_MAP_CONFIG);
  });

  test('normalizes numeric strings including comma decimal notation', () => {
    expect(normalizeAdminMapConfig({
      Centerx: '32,85',
      Centery: '39.92',
      Zoom: '12',
      DefaultBasemapTitle: ' osm ',
    })).toEqual({
      center: [32.85, 39.92],
      zoom: 12,
      basemap: 'osm',
    });
  });

  test('clamps invalid map coordinates and zoom to bounded values', () => {
    expect(normalizeAdminMapConfig({
      Centerx: 999,
      Centery: -999,
      Zoom: 99,
    })).toEqual({
      center: [180, -90],
      zoom: 23,
      basemap: DEFAULT_ADMIN_MAP_CONFIG.basemap,
    });
  });

  test('falls back for non-finite values and empty basemap titles', () => {
    expect(normalizeAdminMapConfig({
      Centerx: 'NaN',
      Centery: Number.POSITIVE_INFINITY,
      Zoom: '',
      DefaultBasemapTitle: '   ',
    })).toEqual(DEFAULT_ADMIN_MAP_CONFIG);
  });

  test('rejects oversized basemap identifiers and uses the governed fallback', () => {
    const config = normalizeAdminMapConfig({
      DefaultBasemapTitle: 'x'.repeat(121),
    });

    expect(config.basemap).toBe(DEFAULT_ADMIN_MAP_CONFIG.basemap);
  });

  test('returns immutable configuration objects', () => {
    const config = normalizeAdminMapConfig({ Centerx: 30, Centery: 40 });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.center)).toBe(true);
  });
});
