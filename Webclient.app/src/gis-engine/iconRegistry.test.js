import { buildIconRegistry, resolveIcon } from './iconResolver';
import entries from './iconRegistry.json';

describe('shared GIS icon registry', () => {
  const registry = buildIconRegistry(entries);
  test('resolves exact type', () => expect(resolveIcon({ type: 'park' }, registry).id).toBe('parklar'));
  test('resolves category aliases', () => expect(resolveIcon({ category: 'Kütüphaneler' }, registry).id).toBe('kutuphane'));
  test('resolves diacritic-insensitive aliases', () => expect(resolveIcon({ type: 'kultur sanat' }, registry).id).toBe('kultur'));
  test('falls back safely', () => {
    const icon = resolveIcon({ type: 'does-not-exist' }, registry);
    expect(icon.id).toBe('default');
    expect(icon.isFallback).toBe(true);
  });
});
