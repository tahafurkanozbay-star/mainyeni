import { describe, expect, it, vi } from 'vitest';
import {
  LayerListExperienceModel,
  normalizeLayerListText,
  type LayerListGroupInput,
} from './layerListExperienceModel';

const GROUPS: readonly LayerListGroupInput[] = Object.freeze([
  Object.freeze({
    id: 'base',
    title: 'Temel Katmanlar',
    layers: Object.freeze([
      Object.freeze({ id: 'roads', title: 'Ana Yollar', visible: true, opacity: 100 }),
      Object.freeze({ id: 'parks', title: 'Yeşil Alanlar', visible: false, opacity: 80 }),
      Object.freeze({ id: 'schools', title: 'Okullar', visible: true, opacity: 65 }),
    ]),
  }),
  Object.freeze({
    id: 'planning',
    title: 'İmar ve Planlama',
    layers: Object.freeze([
      Object.freeze({ id: 'zoning', title: 'İmar Planı', visible: true, opacity: 90 }),
      Object.freeze({ id: 'parcel', title: 'Kadastro Parselleri', visible: true, opacity: 70 }),
    ]),
  }),
]);

describe('normalizeLayerListText', () => {
  it('folds Turkish-specific letters and accents deterministically', () => {
    expect(normalizeLayerListText('ÖLÇÜM ŞİŞLİ')).toBe('olcum sisli');
    expect(normalizeLayerListText('İmar   Planı')).toBe('imar plani');
  });

  it('removes punctuation while preserving searchable word boundaries', () => {
    expect(normalizeLayerListText('Parklar / Bahçeler + Rekreasyon')).toBe('parklar bahceler rekreasyon');
  });
});

describe('LayerListExperienceModel', () => {
  it('starts with a stable idle snapshot', () => {
    const model = new LayerListExperienceModel();
    expect(model.getSnapshot()).toMatchObject({
      revision: 0,
      status: 'idle',
      query: '',
      activeKey: null,
      layerCount: 0,
      resultLayerCount: 0,
    });
  });

  it('publishes loading semantics before data arrives', () => {
    const model = new LayerListExperienceModel();
    model.markLoading();
    expect(model.getSnapshot()).toMatchObject({
      status: 'loading',
      announcement: 'Katmanlar hazırlanıyor.',
    });
  });

  it('normalizes a catalog and reports aggregate counts', () => {
    const model = new LayerListExperienceModel();
    model.replace(GROUPS);
    expect(model.getSnapshot()).toMatchObject({
      status: 'ready',
      groupCount: 2,
      layerCount: 5,
      visibleLayerCount: 4,
      announcement: '5 katman hazır.',
    });
  });

  it('uses a deterministic first group row as the initial active row', () => {
    const model = new LayerListExperienceModel();
    model.replace(GROUPS);
    expect(model.getSnapshot().activeKey).toBe('group:base');
    expect(model.getSnapshot().rows[0]).toMatchObject({
      key: 'group:base',
      kind: 'group',
      active: true,
      level: 1,
    });
  });

  it('keeps group children collapsed until explicitly expanded', () => {
    const model = new LayerListExperienceModel();
    model.replace(GROUPS);
    expect(model.getSnapshot().rows.map((row) => row.key)).toEqual([
      'group:base',
      'group:planning',
    ]);
    model.toggleGroup('base');
    expect(model.getSnapshot().rows.map((row) => row.key)).toEqual([
      'group:base',
      'layer:base:roads',
      'layer:base:parks',
      'layer:base:schools',
      'group:planning',
    ]);
  });

  it('forces matching groups open while search is active', () => {
    const model = new LayerListExperienceModel();
    model.replace(GROUPS);
    model.setQuery('yesil');
    expect(model.getSnapshot().rows.map((row) => row.key)).toEqual([
      'group:base',
      'layer:base:parks',
    ]);
    expect(model.getSnapshot().announcement).toBe('1 katman bulundu.');
  });

  it('searches Turkish text accent-insensitively', () => {
    const model = new LayerListExperienceModel();
    model.replace(GROUPS);
    model.setQuery('IMAR');
    expect(model.getSnapshot().rows.map((row) => row.key)).toEqual([
      'group:planning',
      'layer:planning:zoning',
      'layer:planning:parcel',
    ]);
    expect(model.getSnapshot().resultLayerCount).toBe(2);
  });

  it('searches layer titles independently from group titles', () => {
    const model = new LayerListExperienceModel();
    model.replace(GROUPS);
    model.setQuery('kadastro');
    expect(model.getSnapshot().rows.map((row) => row.key)).toEqual([
      'group:planning',
      'layer:planning:parcel',
    ]);
  });

  it('returns an explicit no-results announcement', () => {
    const model = new LayerListExperienceModel();
    model.replace(GROUPS);
    model.setQuery('uydu yörünge');
    expect(model.getSnapshot()).toMatchObject({
      resultLayerCount: 0,
      activeKey: null,
      announcement: 'Aramayla eşleşen katman bulunamadı.',
    });
  });

  it('bounds query length', () => {
    const model = new LayerListExperienceModel({ maxQueryLength: 8 });
    model.replace(GROUPS);
    model.setQuery('123456789012345');
    expect(model.getSnapshot().query).toBe('12345678');
  });

  it('bounds catalog group cardinality', () => {
    const model = new LayerListExperienceModel({ maxGroups: 1 });
    model.replace(GROUPS);
    expect(model.getSnapshot().groupCount).toBe(1);
    expect(model.getSnapshot().layerCount).toBe(3);
  });

  it('bounds global layer cardinality across groups', () => {
    const model = new LayerListExperienceModel({ maxLayers: 4 });
    model.replace(GROUPS);
    expect(model.getSnapshot().layerCount).toBe(4);
  });

  it('deduplicates duplicate group ids', () => {
    const model = new LayerListExperienceModel();
    model.replace([
      GROUPS[0]!,
      Object.freeze({ ...GROUPS[0]!, title: 'Kopya grup' }),
    ]);
    expect(model.getSnapshot().groupCount).toBe(1);
  });

  it('deduplicates duplicate layer ids within a group', () => {
    const model = new LayerListExperienceModel();
    model.replace([
      Object.freeze({
        id: 'x',
        title: 'X',
        layers: Object.freeze([
          Object.freeze({ id: 'dup', title: 'Bir', visible: true, opacity: 10 }),
          Object.freeze({ id: 'dup', title: 'İki', visible: true, opacity: 20 }),
        ]),
      }),
    ]);
    expect(model.getSnapshot().layerCount).toBe(1);
  });

  it('computes mixed group visibility state', () => {
    const model = new LayerListExperienceModel();
    model.replace(GROUPS);
    expect(model.getSnapshot().rows[0]).toMatchObject({
      visible: false,
      mixed: true,
    });
  });

  it('updates individual layer visibility immutably', () => {
    const model = new LayerListExperienceModel();
    model.replace(GROUPS);
    model.toggleGroup('base');
    const before = model.getSnapshot();
    model.setLayerVisibility('base', 'parks', true);
    const after = model.getSnapshot();
    expect(after).not.toBe(before);
    expect(after.visibleLayerCount).toBe(5);
    expect(after.rows[0]).toMatchObject({ visible: true, mixed: false });
    expect(after.rows.find((row) => row.layerId === 'parks')).toMatchObject({ visible: true });
  });

  it('updates group visibility while preserving disabled layers', () => {
    const model = new LayerListExperienceModel();
    model.replace([
      Object.freeze({
        id: 'group',
        title: 'Group',
        layers: Object.freeze([
          Object.freeze({ id: 'a', title: 'A', visible: false, opacity: 100 }),
          Object.freeze({ id: 'b', title: 'B', visible: false, opacity: 100, disabled: true }),
        ]),
      }),
    ]);
    model.toggleGroup('group');
    model.setGroupVisibility('group', true);
    const rows = model.getSnapshot().rows;
    expect(rows.find((row) => row.layerId === 'a')).toMatchObject({ visible: true });
    expect(rows.find((row) => row.layerId === 'b')).toMatchObject({ visible: false, disabled: true });
  });

  it('clamps opacity updates to 0..100', () => {
    const model = new LayerListExperienceModel();
    model.replace(GROUPS);
    model.toggleGroup('base');
    model.setLayerOpacity('base', 'parks', 150);
    expect(model.getSnapshot().rows.find((row) => row.layerId === 'parks')?.opacity).toBe(100);
    model.setLayerOpacity('base', 'parks', -4);
    expect(model.getSnapshot().rows.find((row) => row.layerId === 'parks')?.opacity).toBe(0);
  });

  it('moves active row one step at a time', () => {
    const model = new LayerListExperienceModel();
    model.replace(GROUPS);
    model.toggleGroup('base');
    model.moveActive('next');
    expect(model.getSnapshot().activeKey).toBe('layer:base:roads');
    model.moveActive('previous');
    expect(model.getSnapshot().activeKey).toBe('group:base');
  });

  it('does not wrap arrow navigation at collection boundaries', () => {
    const model = new LayerListExperienceModel();
    model.replace(GROUPS);
    model.moveActive('previous');
    expect(model.getSnapshot().activeKey).toBe('group:base');
    model.moveActive('last');
    model.moveActive('next');
    expect(model.getSnapshot().activeKey).toBe('group:planning');
  });

  it('supports first and last movement', () => {
    const model = new LayerListExperienceModel();
    model.replace(GROUPS);
    model.moveActive('last');
    expect(model.getSnapshot().activeKey).toBe('group:planning');
    model.moveActive('first');
    expect(model.getSnapshot().activeKey).toBe('group:base');
  });

  it('supports bounded page movement', () => {
    const model = new LayerListExperienceModel({ pageSize: 2 });
    model.replace(GROUPS);
    model.toggleGroup('base');
    model.moveActive('page-next');
    expect(model.getSnapshot().activeKey).toBe('layer:base:parks');
    model.moveActive('page-previous');
    expect(model.getSnapshot().activeKey).toBe('group:base');
  });

  it('moves from a child to its parent group', () => {
    const model = new LayerListExperienceModel();
    model.replace(GROUPS);
    model.toggleGroup('base');
    model.setActive('layer:base:parks');
    model.moveActive('parent');
    expect(model.getSnapshot().activeKey).toBe('group:base');
  });

  it('expands a collapsed group and moves to its first child', () => {
    const model = new LayerListExperienceModel();
    model.replace(GROUPS);
    model.moveActive('first-child');
    expect(model.getSnapshot().activeKey).toBe('layer:base:roads');
  });

  it('preserves an active row when it remains visible after mutation', () => {
    const model = new LayerListExperienceModel();
    model.replace(GROUPS);
    model.toggleGroup('base');
    model.setActive('layer:base:parks');
    model.setLayerOpacity('base', 'parks', 33);
    expect(model.getSnapshot().activeKey).toBe('layer:base:parks');
  });

  it('falls back to the first visible row when filtering hides active row', () => {
    const model = new LayerListExperienceModel();
    model.replace(GROUPS);
    model.toggleGroup('base');
    model.setActive('layer:base:parks');
    model.setQuery('kadastro');
    expect(model.getSnapshot().activeKey).toBe('group:planning');
  });

  it('reports sanitized error state without retaining arbitrary error objects', () => {
    const model = new LayerListExperienceModel();
    model.markError(new Error(' Sunucu\n  yanıt vermedi '));
    expect(model.getSnapshot()).toMatchObject({
      status: 'error',
      errorMessage: 'Sunucu yanıt vermedi',
      announcement: 'Katmanlar yüklenemedi. Sunucu yanıt vermedi',
    });
  });

  it('handles non-error failures without exposing object payloads', () => {
    const model = new LayerListExperienceModel();
    model.markError({ token: 'secret' });
    expect(model.getSnapshot().errorMessage).toBeNull();
    expect(model.getSnapshot().announcement).toBe('Katmanlar yüklenemedi.');
  });

  it('notifies observers after each meaningful state change', () => {
    const model = new LayerListExperienceModel();
    const observer = vi.fn();
    model.subscribe(observer);
    model.markLoading();
    model.replace(GROUPS);
    model.setQuery('park');
    expect(observer).toHaveBeenCalledTimes(3);
  });

  it('does not notify when a query is unchanged', () => {
    const model = new LayerListExperienceModel();
    model.replace(GROUPS);
    const observer = vi.fn();
    model.subscribe(observer);
    model.setQuery('');
    expect(observer).not.toHaveBeenCalled();
  });

  it('isolates failing observers and continues notifying healthy observers', () => {
    const reporter = vi.fn();
    const model = new LayerListExperienceModel({ onObserverError: reporter });
    const healthy = vi.fn();
    model.subscribe(() => { throw new TypeError('observer failed'); });
    model.subscribe(healthy);
    model.markLoading();
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(reporter).toHaveBeenCalledTimes(1);
    expect(model.getObserverDiagnostics()).toMatchObject({
      failureCount: 1,
      lastFailureKind: 'TypeError',
      lastFailureRevision: 1,
    });
  });

  it('contains reporter failures and records the second failure', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const model = new LayerListExperienceModel({
      onObserverError() {
        throw new RangeError('reporter failed');
      },
    });
    model.subscribe(() => { throw new TypeError('observer failed'); });
    expect(() => model.markLoading()).not.toThrow();
    expect(model.getObserverDiagnostics()).toMatchObject({
      failureCount: 2,
      lastFailureKind: 'RangeError',
    });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('enforces bounded observer capacity', () => {
    const model = new LayerListExperienceModel({ maxObservers: 1 });
    const first = model.subscribe(() => undefined);
    const second = model.subscribe(() => undefined);
    expect(model.getObserverDiagnostics()).toMatchObject({
      activeObserverCount: 1,
      rejectedObserverCount: 1,
    });
    first();
    second();
    expect(model.getObserverDiagnostics().activeObserverCount).toBe(0);
  });

  it('freezes public snapshots and row collections', () => {
    const model = new LayerListExperienceModel();
    model.replace(GROUPS);
    const snapshot = model.getSnapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.rows)).toBe(true);
    expect(Object.isFrozen(snapshot.rows[0])).toBe(true);
  });

  it('disposes idempotently and rejects later mutation', () => {
    const model = new LayerListExperienceModel();
    model.replace(GROUPS);
    const before = model.getSnapshot();
    model.dispose();
    model.dispose();
    model.setQuery('park');
    model.toggleGroup('base');
    expect(model.getSnapshot()).toBe(before);
    expect(model.getObserverDiagnostics()).toMatchObject({
      activeObserverCount: 0,
      disposed: true,
    });
  });

  it('rejects subscriptions after disposal', () => {
    const model = new LayerListExperienceModel();
    model.dispose();
    const unsubscribe = model.subscribe(() => undefined);
    unsubscribe();
    expect(model.getObserverDiagnostics().rejectedObserverCount).toBe(1);
  });

  it('preserves expanded groups across compatible catalog replacement', () => {
    const model = new LayerListExperienceModel();
    model.replace(GROUPS);
    model.toggleGroup('base');
    model.replace(GROUPS);
    expect(model.getSnapshot().rows.some((row) => row.key === 'layer:base:roads')).toBe(true);
  });

  it('drops expanded groups that no longer exist', () => {
    const model = new LayerListExperienceModel();
    model.replace(GROUPS);
    model.toggleGroup('base');
    model.replace([GROUPS[1]!]);
    expect(model.getSnapshot().rows.map((row) => row.key)).toEqual(['group:planning']);
  });
});
