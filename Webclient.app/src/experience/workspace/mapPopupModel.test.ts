import { describe, expect, it, vi } from 'vitest';
import { MapPopupModel, type PopupFeatureInput } from './mapPopupModel';

const features: readonly PopupFeatureInput[] = [
  {
    id: 'f-1', title: 'Atatürk Parkı', subtitle: 'Park', layerId: 'places', layerLabel: 'Yerler',
    fields: [
      { id: 'area', label: 'Alan', value: 12500, format: 'number' },
      { id: 'active', label: 'Aktif', value: true, format: 'boolean' },
      { id: 'secret', label: 'Gizli', value: 'x', hidden: true },
    ],
  },
  { id: 'f-2', title: 'Gençlik Parkı', fields: [{ id: 'district', label: 'İlçe', value: 'Altındağ' }] },
  { id: 'f-3', title: 'Kuğulu Park', fields: [{ id: 'note', label: 'Not', value: null }] },
];

describe('MapPopupModel', () => {
  it('starts closed with deterministic presentation facts', () => {
    const model = new MapPopupModel({ placement: 'bottom', preferences: { reducedMotion: true, forcedColors: true, compact: true } });
    expect(model.snapshot.open).toBe(false);
    expect(model.snapshot.status).toBe('idle');
    expect(model.snapshot.placement).toBe('bottom');
    expect(model.snapshot.reducedMotion).toBe(true);
    expect(model.snapshot.forcedColors).toBe(true);
    expect(model.snapshot.compact).toBe(true);
  });

  it('opens normalized feature content and excludes hidden fields', () => {
    const model = new MapPopupModel();
    model.open(features);
    expect(model.snapshot.open).toBe(true);
    expect(model.snapshot.status).toBe('ready');
    expect(model.snapshot.activeFeature?.title).toBe('Atatürk Parkı');
    expect(model.snapshot.activeFeature?.fields.map((field) => field.id)).toEqual(['area', 'active']);
    expect(model.snapshot.activeFeature?.fields[0]?.value).toMatch(/12/);
    expect(model.snapshot.activeFeature?.fields[1]?.value).toBe('Evet');
  });

  it('formats null and valid date values safely', () => {
    const model = new MapPopupModel();
    model.open([{ id: 'x', title: 'Kayıt', fields: [
      { id: 'null', label: 'Boş', value: null },
      { id: 'date', label: 'Tarih', value: '2026-09-24', format: 'date' },
    ] }]);
    expect(model.snapshot.activeFeature?.fields[0]?.value).toBe('—');
    expect(model.snapshot.activeFeature?.fields[1]?.value).toContain('2026');
  });

  it('supports requested active feature and focus restoration', () => {
    const model = new MapPopupModel();
    model.open(features, { activeId: 'f-2', restoreFocusTarget: 'map-canvas' });
    expect(model.snapshot.activeFeature?.id).toBe('f-2');
    expect(model.snapshot.restoreFocusTarget).toBe('map-canvas');
    expect(model.close()).toBe('map-canvas');
    expect(model.snapshot.open).toBe(false);
  });

  it('falls back to first feature for unknown requested active id', () => {
    const model = new MapPopupModel();
    model.open(features, { activeId: 'missing' });
    expect(model.snapshot.activeFeature?.id).toBe('f-1');
  });

  it('wraps next and previous feature navigation', () => {
    const model = new MapPopupModel();
    model.open(features);
    model.previous();
    expect(model.snapshot.activeFeature?.id).toBe('f-3');
    model.next();
    expect(model.snapshot.activeFeature?.id).toBe('f-1');
    model.next();
    expect(model.snapshot.activeFeature?.id).toBe('f-2');
  });

  it('supports first, last and direct feature activation', () => {
    const model = new MapPopupModel();
    model.open(features);
    model.last();
    expect(model.snapshot.activeFeature?.id).toBe('f-3');
    model.first();
    expect(model.snapshot.activeFeature?.id).toBe('f-1');
    model.activate('f-2');
    expect(model.snapshot.activeFeature?.id).toBe('f-2');
    const revision = model.snapshot.revision;
    model.activate('missing');
    expect(model.snapshot.revision).toBe(revision);
  });

  it('does not mutate revision for impossible navigation', () => {
    const model = new MapPopupModel();
    model.open([features[0]!]);
    const revision = model.snapshot.revision;
    model.next(); model.previous(); model.first(); model.last();
    expect(model.snapshot.revision).toBe(revision);
  });

  it('exposes loading and assertive error states', () => {
    const announce = vi.fn();
    const model = new MapPopupModel({ onAnnouncement: announce });
    model.setLoading('map');
    expect(model.snapshot.status).toBe('loading');
    expect(model.snapshot.restoreFocusTarget).toBe('map');
    model.setError('Detaylar alınamadı.');
    expect(model.snapshot.status).toBe('error');
    expect(model.snapshot.errorMessage).toBe('Detaylar alınamadı.');
    expect(announce.mock.calls.at(-1)?.[0].priority).toBe('assertive');
  });

  it('announces active feature position for multi-feature results', () => {
    const announce = vi.fn();
    const model = new MapPopupModel({ onAnnouncement: announce });
    model.open(features);
    expect(announce.mock.calls[0]?.[0].message).toContain('1 / 3');
    model.next();
    expect(announce.mock.calls[1]?.[0].message).toContain('2 / 3');
  });

  it('uses 48px coarse-pointer target sizing', () => {
    expect(new MapPopupModel({ preferences: { coarsePointer: true } }).snapshot.targetSize).toBe(48);
    expect(new MapPopupModel().snapshot.targetSize).toBe(40);
  });

  it('isolates observer failures and keeps healthy subscribers running', () => {
    const onObserverError = vi.fn();
    const healthy = vi.fn();
    const model = new MapPopupModel({ onObserverError });
    model.subscribe(() => { throw new Error('observer'); });
    model.subscribe(healthy);
    model.open(features);
    expect(onObserverError).toHaveBeenCalled();
    expect(healthy).toHaveBeenCalledTimes(2);
  });

  it('isolates announcement and reporter failures', () => {
    const model = new MapPopupModel({
      onAnnouncement: () => { throw new Error('announcement'); },
      onObserverError: () => { throw new Error('reporter'); },
    });
    expect(() => model.open(features)).not.toThrow();
    expect(model.snapshot.status).toBe('ready');
  });

  it('keeps snapshots and feature collections immutable', () => {
    const model = new MapPopupModel();
    model.open(features);
    expect(Object.isFrozen(model.snapshot)).toBe(true);
    expect(Object.isFrozen(model.snapshot.features)).toBe(true);
    expect(Object.isFrozen(model.snapshot.activeFeature)).toBe(true);
    expect(Object.isFrozen(model.snapshot.activeFeature?.fields)).toBe(true);
  });

  it('rejects blank identities, duplicate fields and duplicate features', () => {
    const model = new MapPopupModel();
    expect(() => model.open([{ id: ' ', title: 'x' }])).toThrow(/non-empty/);
    expect(() => model.open([{ id: 'x', title: ' ' }])).toThrow(/non-empty/);
    expect(() => model.open([{ id: 'x', title: 'x', fields: [{ id: 'a', label: 'A', value: 1 }, { id: 'a', label: 'B', value: 2 }] }])).toThrow(/Duplicate popup field/);
    expect(() => model.open([features[0]!, features[0]!])).toThrow(/Duplicate popup feature/);
  });

  it('rejects excessive feature results and blank error messages', () => {
    const model = new MapPopupModel();
    const excessive = Array.from({ length: 101 }, (_, index) => ({ id: `f-${index}`, title: `Feature ${index}` }));
    expect(() => model.open(excessive)).toThrow(/100/);
    expect(() => model.setError('   ')).toThrow(/non-empty/);
  });

  it('closes loading and error states cleanly', () => {
    const model = new MapPopupModel();
    model.setLoading('map');
    expect(model.close()).toBe('map');
    expect(model.snapshot.status).toBe('idle');
    model.setError('Hata');
    expect(model.close()).toBeUndefined();
    expect(model.snapshot.errorMessage).toBeUndefined();
  });
});
