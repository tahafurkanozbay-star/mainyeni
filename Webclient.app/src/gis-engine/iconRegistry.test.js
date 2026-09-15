import { buildIconRegistry, resolveIcon } from './iconResolver';
import entries from './iconRegistry.json';
import { create3DGraphicModel, createListIconModel, createPictureMarkerSymbol } from './iconPresentation';

describe('shared GIS icon registry', () => {
  const registry = buildIconRegistry(entries);

  test('resolves exact type', () => expect(resolveIcon({ type: 'park' }, registry).id).toBe('parklar'));
  test('resolves category aliases', () => expect(resolveIcon({ category: 'Kütüphaneler' }, registry).id).toBe('kutuphane'));
  test('resolves diacritic-insensitive aliases', () => expect(resolveIcon({ type: 'kultur sanat' }, registry).id).toBe('kultur'));

  test.each([
    ['YeniParklarQeryUrl', 'parklar'],
    ['YeniKadinDanismaQueryUrl', 'kadin'],
    ['YeniWifiNoktalariQeryUrl', 'wifi'],
    ['YeniSosyalHizmetlerQueryUrl', 'sosyal'],
    ['YeniTeknolojiMerkezleriQueryUrl', 'teknoloji'],
    ['AssemblyAreaQueryUrl', 'aciltoplanma'],
    ['EventQueryUrl', 'etkinlik'],
    ['PharmacyQueryUrl', 'eczane'],
    ['TaxiQueryUrl', 'taksi']
  ])('uses the JSON registry for service key %s', (serviceKey, expectedId) => {
    expect(resolveIcon({ type: serviceKey }, registry).id).toBe(expectedId);
  });

  test.each([
    ['YeniKadinDanismaQueryUrl', 'kadin'],
    ['AssemblyAreaQueryUrl', 'aciltoplanma'],
    ['EventQueryUrl', 'etkinlik'],
    ['PharmacyQueryUrl', 'eczane'],
    ['TaxiQueryUrl', 'taksi']
  ])('keeps list, 2D and 3D icon identity aligned for %s', (type, expectedKey) => {
    const record = { type, title: type };
    const list = createListIconModel(record);
    const marker = createPictureMarkerSymbol(record, 12);
    const scene = create3DGraphicModel(record);

    expect(list.key).toBe(expectedKey);
    expect(scene.iconKey).toBe(expectedKey);
    expect(marker.url).toBe(list.src);
    expect(scene.billboard).toBe(list.src);
  });

  test('falls back safely', () => {
    const icon = resolveIcon({ type: 'does-not-exist' }, registry);
    expect(icon.id).toBe('default');
    expect(icon.isFallback).toBe(true);
  });
});
