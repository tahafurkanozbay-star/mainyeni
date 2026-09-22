import { describe, expect, it } from 'vitest';
import { createSidebarCatalogRuntime, normalizeSidebarSearchText } from './sidebarCatalogRuntime';

const groups = [
  { id: 'ABB', label: 'Ankara Büyükşehir Belediyesi', shortLabel: 'ABB' },
  { id: 'EGO', label: 'EGO Genel Müdürlüğü', shortLabel: 'EGO' },
] as const;

const items = [
  { group: 'ABB', label: 'Kadın Danışma Merkezleri', windowId: 'women', iconType: 'kadın danışma merkezi', serviceKey: 'YeniKadinDanismaQueryUrl' },
  { group: 'ABB', label: 'Kültür ve Sanat', windowId: 'culture', iconType: 'kültür sanat', serviceKey: 'YeniKültürSanatQueryUrl' },
  { group: 'ABB', label: 'Wi-Fi Noktaları', windowId: 'wifi', iconType: 'wifi erişim noktası', serviceKey: 'YeniWifiNoktalariQeryUrl' },
  { group: 'EGO', label: 'Otobüs Durakları', windowId: 'bus', iconType: 'otobüs durağı', serviceKey: 'YeniEgoOtobusDuraklariQueryUrl' },
  { group: 'EGO', label: 'Elektrikli Bisiklet İstasyonları', windowId: 'bike', iconType: 'elektrikli bisiklet istasyonu', serviceKey: 'YeniEgoElektrikliBisikletİstasyonlariQueryUrl' },
] as const;

describe('normalizeSidebarSearchText', () => {
  it.each([
    ['  KADIN   DANIŞMA ', 'kadin danisma'],
    ['İSTASYONLARI', 'istasyonlari'],
    ['Wi-Fi!!!', 'wi-fi'],
    ['', ''],
    [null, ''],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeSidebarSearchText(input)).toBe(expected);
  });
});

describe('createSidebarCatalogRuntime', () => {
  it('creates immutable snapshots', () => {
    const runtime = createSidebarCatalogRuntime({ groups, items });
    const snapshot = runtime.snapshot();
    expect(snapshot).toMatchObject({ groupCount: 2, itemCount: 5, orphanGroups: [] });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.groups)).toBe(true);
    expect(Object.isFrozen(snapshot.items)).toBe(true);
  });

  it('looks groups and items up by exact id', () => {
    const runtime = createSidebarCatalogRuntime({ groups, items });
    expect(runtime.getGroup('ABB')?.label).toContain('Ankara');
    expect(runtime.getItem('bus')?.label).toBe('Otobüs Durakları');
    expect(runtime.getItem('missing')).toBeNull();
  });

  it('looks fast-access items up by stable service key', () => {
    const runtime = createSidebarCatalogRuntime({ groups, items });
    expect(runtime.getItemByServiceKey('YeniEgoOtobusDuraklariQueryUrl')?.windowId).toBe('bus');
    expect(runtime.getItemByServiceKey('missing')).toBeNull();
  });

  it('trims service-key lookups without changing stored identity', () => {
    const runtime = createSidebarCatalogRuntime({ groups, items });
    const item = runtime.getItemByServiceKey('  YeniKadinDanismaQueryUrl  ');
    expect(item?.serviceKey).toBe('YeniKadinDanismaQueryUrl');
    expect(item?.windowId).toBe('women');
  });

  it('trims lookup ids', () => {
    const runtime = createSidebarCatalogRuntime({ groups, items });
    expect(runtime.getGroup(' ABB ')?.id).toBe('ABB');
    expect(runtime.getItem(' bus ')?.windowId).toBe('bus');
  });

  it('returns alphabetically stable group items', () => {
    const runtime = createSidebarCatalogRuntime({ groups, items });
    expect(runtime.itemsForGroup('ABB').map((item) => item.windowId)).toEqual(['women', 'culture', 'wifi']);
  });

  it('returns an empty immutable group for unknown ids', () => {
    const runtime = createSidebarCatalogRuntime({ groups, items });
    expect(runtime.itemsForGroup('UNKNOWN')).toEqual([]);
    expect(Object.isFrozen(runtime.itemsForGroup('UNKNOWN'))).toBe(true);
  });

  it('searches label text case-insensitively', () => {
    const runtime = createSidebarCatalogRuntime({ groups, items });
    expect(runtime.search('otobüs').map((item) => item.windowId)).toEqual(['bus']);
    expect(runtime.search('OTOBÜS').map((item) => item.windowId)).toEqual(['bus']);
  });

  it('searches Turkish dotted and dotless i variants deterministically', () => {
    const runtime = createSidebarCatalogRuntime({ groups, items });
    expect(runtime.search('KADIN').map((item) => item.windowId)).toEqual(['women']);
    expect(runtime.search('istasyonlari').map((item) => item.windowId)).toEqual(['bike']);
  });

  it('searches icon type', () => {
    const runtime = createSidebarCatalogRuntime({ groups, items });
    expect(runtime.search('erişim').map((item) => item.windowId)).toEqual(['wifi']);
  });

  it('searches stable service keys for diagnostics and deep links', () => {
    const runtime = createSidebarCatalogRuntime({ groups, items });
    expect(runtime.search('YeniEgoOtobusDuraklariQueryUrl').map((item) => item.windowId)).toEqual(['bus']);
  });

  it('requires all query tokens', () => {
    const runtime = createSidebarCatalogRuntime({ groups, items });
    expect(runtime.search('elektrikli bisiklet').map((item) => item.windowId)).toEqual(['bike']);
    expect(runtime.search('elektrikli otobüs')).toEqual([]);
  });

  it('supports group filters', () => {
    const runtime = createSidebarCatalogRuntime({ groups, items });
    expect(runtime.search('durak', { groupId: 'EGO' }).map((item) => item.windowId)).toEqual(['bus']);
    expect(runtime.search('durak', { groupId: 'ABB' })).toEqual([]);
  });

  it('returns empty results for unknown group filters', () => {
    const runtime = createSidebarCatalogRuntime({ groups, items });
    expect(runtime.search('otobüs', { groupId: 'UNKNOWN' })).toEqual([]);
  });

  it('returns empty results for blank queries', () => {
    const runtime = createSidebarCatalogRuntime({ groups, items });
    expect(runtime.search('   ')).toEqual([]);
  });

  it('ranks exact labels before partial matches', () => {
    const runtime = createSidebarCatalogRuntime({
      groups,
      items: [
        ...items,
        { group: 'ABB', label: 'Kültür', windowId: 'culture-exact', iconType: 'kültür' },
      ],
    });
    expect(runtime.search('kültür').map((item) => item.windowId).slice(0, 2)).toEqual(['culture-exact', 'culture']);
  });

  it('ranks prefix matches before interior matches', () => {
    const runtime = createSidebarCatalogRuntime({
      groups,
      items: [
        { group: 'ABB', label: 'Park Alanları', windowId: 'prefix' },
        { group: 'ABB', label: 'Kent Park Hizmetleri', windowId: 'interior' },
      ],
    });
    expect(runtime.search('park').map((item) => item.windowId)).toEqual(['prefix', 'interior']);
  });

  it('enforces result limits', () => {
    const runtime = createSidebarCatalogRuntime({
      groups,
      items: Array.from({ length: 10 }, (_, index) => ({
        group: 'ABB',
        label: `Hizmet ${index}`,
        windowId: `w-${index}`,
      })),
    });
    expect(runtime.search('hizmet', { limit: 3 })).toHaveLength(3);
  });

  it('clamps result limit to at least one', () => {
    const runtime = createSidebarCatalogRuntime({ groups, items });
    expect(runtime.search('a', { limit: 0 })).toHaveLength(1);
  });

  it('rejects duplicate group ids', () => {
    expect(() => createSidebarCatalogRuntime({
      groups: [...groups, { id: 'ABB', label: 'Duplicate' }],
      items,
    })).toThrow(/duplicate sidebar group/i);
  });

  it('rejects duplicate window ids', () => {
    expect(() => createSidebarCatalogRuntime({
      groups,
      items: [...items, { group: 'EGO', label: 'Duplicate', windowId: 'bus' }],
    })).toThrow(/duplicate sidebar window/i);
  });

  it('rejects duplicate service keys when service identity is present', () => {
    expect(() => createSidebarCatalogRuntime({
      groups,
      items: [
        ...items,
        {
          group: 'EGO',
          label: 'Duplicate service',
          windowId: 'bus-copy',
          serviceKey: 'YeniEgoOtobusDuraklariQueryUrl',
        },
      ],
    })).toThrow(/duplicate sidebar service key/i);
  });

  it('rejects orphan items', () => {
    expect(() => createSidebarCatalogRuntime({
      groups,
      items: [...items, { group: 'OTHER', label: 'Other', windowId: 'other' }],
    })).toThrow(/unknown group/i);
  });

  it('rejects blank group ids', () => {
    expect(() => createSidebarCatalogRuntime({
      groups: [{ id: ' ', label: 'Blank' }],
      items: [],
    })).toThrow(/cannot be empty/i);
  });

  it('rejects blank labels', () => {
    expect(() => createSidebarCatalogRuntime({
      groups: [{ id: 'A', label: ' ' }],
      items: [],
    })).toThrow(/cannot be empty/i);
  });

  it('rejects oversized identifiers', () => {
    expect(() => createSidebarCatalogRuntime({
      groups: [{ id: 'x'.repeat(161), label: 'Long' }],
      items: [],
    })).toThrow(/160/i);
  });

  it('detaches normalized objects from mutable caller input', () => {
    const mutableGroups = [{ id: 'ABB', label: 'Original' }];
    const mutableItems = [{
      group: 'ABB',
      label: 'Service',
      windowId: 'service',
      serviceKey: 'YeniServiceQueryUrl',
    }];
    const runtime = createSidebarCatalogRuntime({ groups: mutableGroups, items: mutableItems });
    mutableGroups[0]!.label = 'Mutated';
    mutableItems[0]!.label = 'Mutated';
    mutableItems[0]!.serviceKey = 'MutatedServiceKey';
    expect(runtime.getGroup('ABB')?.label).toBe('Original');
    expect(runtime.getItem('service')?.label).toBe('Service');
    expect(runtime.getItem('service')?.serviceKey).toBe('YeniServiceQueryUrl');
  });
});
