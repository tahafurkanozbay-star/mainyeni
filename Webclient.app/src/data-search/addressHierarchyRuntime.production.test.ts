import { createAddressHierarchyRuntime } from './addressHierarchyRuntime';
import { normalizeRecordCollection } from './normalization';

const records = (items: readonly unknown[]) => normalizeRecordCollection(items, {
  dedupe: false,
  keepInvalid: true,
  maxRecords: Math.max(1, items.length),
}).records;

const baseRecords = () => records([
  {
    id: '1',
    title: 'Ankara Büyükşehir Belediyesi',
    district: 'Çankaya',
    neighborhood: 'Kızılay',
    street: 'Atatürk Bulvarı',
    door: '18',
    building: 'Merkez Bina',
    latitude: 39.9208,
    longitude: 32.8541,
  },
  {
    id: '2',
    title: 'Kültür Merkezi',
    district: 'Çankaya',
    neighborhood: 'Kızılay',
    street: 'Atatürk Bulvarı',
    door: '22',
    building: 'Kültür Sitesi',
    latitude: 39.9212,
    longitude: 32.8544,
  },
  {
    id: '3',
    title: 'Park Tesisi',
    district: 'Çankaya',
    neighborhood: 'Bahçelievler',
    street: '7. Cadde',
    door: '10A',
    building: 'Park Apartmanı',
    latitude: 39.925,
    longitude: 32.82,
  },
  {
    id: '4',
    title: 'Ulus Hizmet',
    district: 'Altındağ',
    neighborhood: 'Ulus',
    street: 'Anafartalar Caddesi',
    door: '5',
    latitude: 39.941,
    longitude: 32.856,
  },
]);

describe('AddressHierarchyRuntime', () => {
  test('builds deterministic district-neighborhood-street-building-door chains', () => {
    const runtime = createAddressHierarchyRuntime(baseRecords());
    const snapshot = runtime.snapshot();

    expect(snapshot.recordCount).toBe(4);
    expect(snapshot.districtCount).toBe(2);
    expect(snapshot.neighborhoodCount).toBe(3);
    expect(snapshot.streetCount).toBe(3);
    expect(snapshot.buildingCount).toBe(3);
    expect(snapshot.doorCount).toBe(4);
    expect(snapshot.nodeCount).toBe(15);
    expect(snapshot.rootCount).toBe(2);
    expect(snapshot.fingerprint).toMatch(/^[a-z0-9-]+$/i);
  });

  test('resolves exact canonical Turkish address names', () => {
    const runtime = createAddressHierarchyRuntime(baseRecords());
    const matches = runtime.resolve('Kızılay', { level: 'neighborhood' });

    expect(matches).toHaveLength(1);
    expect(matches[0]?.node.name).toBe('Kızılay');
    expect(matches[0]?.exact).toBe(true);
    expect(matches[0]?.reasons).toContain('exact-name');
  });

  test('normalizes address structural aliases for matching', () => {
    const runtime = createAddressHierarchyRuntime(baseRecords());
    const matches = runtime.resolve('Atatürk Bulvar', { level: 'street' });

    expect(matches[0]?.node.name).toBe('Atatürk Bulvarı');
    expect(matches[0]?.score).toBeGreaterThan(0);
  });

  test('supports prefix suggestions without full scans when token postings exist', () => {
    const runtime = createAddressHierarchyRuntime(baseRecords());
    const matches = runtime.suggest('Anaf', { level: 'street' });

    expect(matches[0]?.node.name).toBe('Anafartalar Caddesi');
    expect(matches[0]?.prefix || matches[0]?.reasons.some(reason => reason.startsWith('token-prefix:'))).toBe(true);
  });

  test('filters a shared street name through district hierarchy', () => {
    const data = records([
      { id: '1', district: 'Çankaya', neighborhood: 'Ayrancı', street: 'Gül Sokak' },
      { id: '2', district: 'Keçiören', neighborhood: 'Etlik', street: 'Gül Sokak' },
    ]);
    const runtime = createAddressHierarchyRuntime(data);

    const matches = runtime.resolve('Gül Sokak', {
      level: 'street',
      district: 'Çankaya',
      requireHierarchyMatch: true,
    });

    expect(matches).toHaveLength(1);
    expect(runtime.getPath(matches[0]?.node.key ?? '').map(item => item.name)).toEqual([
      'Çankaya',
      'Ayrancı',
      'Gül Sokak',
    ]);
  });

  test('can retain mismatched hierarchy candidates with an explicit penalty', () => {
    const data = records([
      { id: '1', district: 'Çankaya', neighborhood: 'Ayrancı', street: 'Gül Sokak' },
      { id: '2', district: 'Keçiören', neighborhood: 'Etlik', street: 'Gül Sokak' },
    ]);
    const runtime = createAddressHierarchyRuntime(data);

    const matches = runtime.resolve('Gül Sokak', {
      level: 'street',
      district: 'Çankaya',
      requireHierarchyMatch: false,
    });

    expect(matches).toHaveLength(2);
    expect(matches[0]?.hierarchyScore).toBeGreaterThan(matches[1]?.hierarchyScore ?? 0);
    expect(matches.some(match => match.reasons.includes('hierarchy-mismatch:district'))).toBe(true);
  });

  test('builds and resolves building nodes from verified local fields only', () => {
    const runtime = createAddressHierarchyRuntime(baseRecords(), {
      buildingFieldAliases: ['building'],
    });
    const matches = runtime.resolve('Merkez Bina', { level: 'building' });

    expect(matches).toHaveLength(1);
    expect(matches[0]?.node.level).toBe('building');
    expect(matches[0]?.node.name).toBe('Merkez Bina');
    expect(runtime.getChildren(matches[0]?.node.key ?? '')[0]?.name).toBe('18');
  });

  test('does not invent a building when no configured field contains one', () => {
    const runtime = createAddressHierarchyRuntime(records([
      {
        id: '1',
        district: 'Çankaya',
        neighborhood: 'Kızılay',
        street: 'Atatürk Bulvarı',
        door: '18',
        title: 'Başkanlık',
      },
    ]), { buildingFieldAliases: ['building'] });

    expect(runtime.snapshot().buildingCount).toBe(0);
    expect(runtime.snapshot().doorCount).toBe(1);
    const binding = runtime.getBinding('id:1');
    expect(binding?.buildingKey).toBeNull();
    expect(binding?.doorKey).not.toBeNull();
  });

  test('records missing hierarchy gaps instead of silently fabricating parent nodes', () => {
    const runtime = createAddressHierarchyRuntime(records([
      { id: '1', district: 'Çankaya', street: 'Atatürk Bulvarı', door: '18' },
    ]));

    expect(runtime.snapshot().diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'missing-parent-level', recordKey: 'id:1' }),
    ]));
    expect(runtime.snapshot().neighborhoodCount).toBe(0);
  });

  test('reports empty records as informational quality evidence', () => {
    const runtime = createAddressHierarchyRuntime(records([
      { id: '1', title: 'No address yet' },
    ]));

    expect(runtime.snapshot().recordCount).toBe(0);
    expect(runtime.snapshot().diagnostics[0]).toEqual(expect.objectContaining({
      code: 'empty-record',
      severity: 'info',
    }));
  });

  test('aggregates stable record bindings and deepest hierarchy nodes', () => {
    const source = baseRecords();
    const runtime = createAddressHierarchyRuntime(source);
    const binding = runtime.getBinding(source[0] ?? 'missing');

    expect(binding?.districtKey).not.toBeNull();
    expect(binding?.neighborhoodKey).not.toBeNull();
    expect(binding?.streetKey).not.toBeNull();
    expect(binding?.buildingKey).not.toBeNull();
    expect(binding?.doorKey).not.toBeNull();
    expect(binding?.deepestKey).toBe(binding?.doorKey);
    expect(binding?.pathKeys).toHaveLength(5);
  });

  test('supports deterministic path lookup without scanning all records', () => {
    const runtime = createAddressHierarchyRuntime(baseRecords());
    const node = runtime.findByPath({
      district: 'Çankaya',
      neighborhood: 'Kızılay',
      street: 'Atatürk Bulvarı',
      building: 'Merkez Bina',
      door: '18',
    });

    expect(node?.level).toBe('door');
    expect(node?.name).toBe('18');
    expect(runtime.getPath(node?.key ?? '').map(item => item.level)).toEqual([
      'district',
      'neighborhood',
      'street',
      'building',
      'door',
    ]);
  });

  test('applies distance bias when hierarchy candidates have coordinates', () => {
    const data = records([
      {
        id: '1', district: 'Çankaya', neighborhood: 'Kızılay', street: 'Cumhuriyet Caddesi',
        latitude: 39.92, longitude: 32.85,
      },
      {
        id: '2', district: 'Gölbaşı', neighborhood: 'Merkez', street: 'Cumhuriyet Caddesi',
        latitude: 39.79, longitude: 32.8,
      },
    ]);
    const runtime = createAddressHierarchyRuntime(data);
    const matches = runtime.resolve('Cumhuriyet Caddesi', {
      level: 'street',
      center: { latitude: 39.92, longitude: 32.85 },
      requireHierarchyMatch: false,
    });

    expect(matches).toHaveLength(2);
    expect(matches[0]?.distanceMeters).toBeLessThan(matches[1]?.distanceMeters ?? Number.POSITIVE_INFINITY);
    expect(matches[0]?.distanceScore).toBeGreaterThan(matches[1]?.distanceScore ?? 0);
  });

  test('enforces radius without leaking far-away candidates', () => {
    const runtime = createAddressHierarchyRuntime(baseRecords());
    const matches = runtime.resolve('Atatürk Bulvarı', {
      level: 'street',
      center: { latitude: 39.9208, longitude: 32.8541 },
      radiusMeters: 1_000,
    });

    expect(matches).toHaveLength(1);
    expect(matches[0]?.distanceMeters).toBeLessThan(1_000);
  });

  test('computes node coordinate spread and reports divergence beyond policy', () => {
    const runtime = createAddressHierarchyRuntime(records([
      {
        id: '1', district: 'Çankaya', neighborhood: 'Kızılay', street: 'Test Sokak',
        latitude: 39.92, longitude: 32.85,
      },
      {
        id: '2', district: 'Çankaya', neighborhood: 'Kızılay', street: 'Test Sokak',
        latitude: 40.1, longitude: 33.2,
      },
    ]), { coordinateDivergenceMeters: 500 });

    const street = runtime.resolve('Test Sokak', { level: 'street' })[0]?.node;
    expect(street?.coordinateSampleCount).toBe(2);
    expect(street?.coordinateSpreadMeters).toBeGreaterThan(500);
    expect(runtime.snapshot().diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'coordinate-divergence', nodeKey: street?.key }),
    ]));
  });

  test('preserves duplicate source names as aliases without duplicating path nodes', () => {
    const runtime = createAddressHierarchyRuntime(records([
      { id: '1', district: 'Çankaya', neighborhood: 'Kızılay', street: 'Atatürk Bulvarı' },
      { id: '2', district: 'cankaya', neighborhood: 'kizilay', street: 'Ataturk Bulvari' },
    ]));

    expect(runtime.snapshot().districtCount).toBe(1);
    expect(runtime.snapshot().neighborhoodCount).toBe(1);
    expect(runtime.snapshot().streetCount).toBe(1);
    const street = runtime.resolve('Atatürk Bulvarı', { level: 'street' })[0]?.node;
    expect(street?.sourceCount).toBe(2);
    expect(street?.aliases.length).toBeGreaterThanOrEqual(1);
  });

  test('bounds record ingestion and surfaces the capacity decision', () => {
    const runtime = createAddressHierarchyRuntime(baseRecords(), { maxRecords: 2 });

    expect(runtime.snapshot().recordCount).toBe(2);
    expect(runtime.snapshot().diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'record-budget-exceeded', severity: 'error' }),
    ]));
  });

  test('bounds diagnostics without turning truncation into silent success', () => {
    const runtime = createAddressHierarchyRuntime(records([
      { id: '1', street: 'A' },
      { id: '2', street: 'B' },
      { id: '3', street: 'C' },
    ]), { maxDiagnostics: 1 });

    expect(runtime.snapshot().diagnostics).toHaveLength(1);
    expect(runtime.snapshot().diagnosticsTruncated).toBe(true);
  });

  test('keeps child fan-out bounded and records overflow as an error', () => {
    const runtime = createAddressHierarchyRuntime(records([
      { id: '1', district: 'Çankaya', neighborhood: 'A' },
      { id: '2', district: 'Çankaya', neighborhood: 'B' },
      { id: '3', district: 'Çankaya', neighborhood: 'C' },
    ]), { maxChildrenPerNode: 2 });

    const district = runtime.resolve('Çankaya', { level: 'district' })[0]?.node;
    expect(runtime.getChildren(district?.key ?? '')).toHaveLength(2);
    expect(runtime.snapshot().diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'child-budget-exceeded', severity: 'error' }),
    ]));
  });

  test('keeps aliases bounded under highly duplicated source spellings', () => {
    const runtime = createAddressHierarchyRuntime(records([
      { id: '1', district: 'Çankaya' },
      { id: '2', district: 'Cankaya' },
      { id: '3', district: 'ÇANKAYA' },
    ]), { maxAliasesPerNode: 1 });

    const district = runtime.resolve('Çankaya', { level: 'district' })[0]?.node;
    expect(district?.aliases).toHaveLength(1);
    expect(runtime.snapshot().diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'alias-budget-exceeded' }),
    ]));
  });

  test('rebuild replaces all indexes atomically from the caller perspective', () => {
    const runtime = createAddressHierarchyRuntime(baseRecords());
    const previousFingerprint = runtime.snapshot().fingerprint;

    runtime.rebuild(records([
      { id: '9', district: 'Yenimahalle', neighborhood: 'Batıkent', street: 'Başkent Bulvarı' },
    ]));

    expect(runtime.resolve('Kızılay', { level: 'neighborhood' })).toHaveLength(0);
    expect(runtime.resolve('Batıkent', { level: 'neighborhood' })).toHaveLength(1);
    expect(runtime.snapshot().fingerprint).not.toBe(previousFingerprint);
  });

  test('produces identical fingerprints for equivalent canonical source data', () => {
    const a = createAddressHierarchyRuntime(records([
      { id: '1', district: 'Çankaya', neighborhood: 'Kızılay', street: 'Atatürk Bulvarı' },
    ]));
    const b = createAddressHierarchyRuntime(records([
      { id: '1', district: 'cankaya', neighborhood: 'kizilay', street: 'ataturk bulvari' },
    ]));

    expect(a.snapshot().fingerprint).toBe(b.snapshot().fingerprint);
  });

  test('serializable snapshot exposes bounded structural facts instead of raw source rows', () => {
    const runtime = createAddressHierarchyRuntime(baseRecords());
    const snapshot = runtime.toSerializableSnapshot();
    const serialized = JSON.stringify(snapshot);

    expect(snapshot.nodeCount).toBe(runtime.snapshot().nodeCount);
    expect(serialized).not.toContain('phone');
    expect(serialized).not.toContain('url');
    expect(serialized).not.toContain('source');
  });

  test('unknown node and record lookups fail closed with null/empty results', () => {
    const runtime = createAddressHierarchyRuntime(baseRecords());

    expect(runtime.getNode('missing')).toBeNull();
    expect(runtime.getBinding('missing')).toBeNull();
    expect(runtime.getPath('missing')).toEqual([]);
    expect(runtime.getChildren('missing')).toEqual([]);
  });

  test('empty query returns no suggestions rather than all hierarchy nodes', () => {
    const runtime = createAddressHierarchyRuntime(baseRecords());

    expect(runtime.resolve('')).toEqual([]);
    expect(runtime.suggest('   ')).toEqual([]);
  });

  test('limit and minimum score are enforced deterministically', () => {
    const runtime = createAddressHierarchyRuntime(records([
      { id: '1', district: 'Çankaya', neighborhood: 'Gültepe' },
      { id: '2', district: 'Keçiören', neighborhood: 'Gülveren' },
      { id: '3', district: 'Mamak', neighborhood: 'Gülseren' },
    ]));

    expect(runtime.resolve('Gül', { level: 'neighborhood', limit: 2 })).toHaveLength(2);
    expect(runtime.resolve('Gül', { level: 'neighborhood', minimumScore: 9_999 })).toHaveLength(0);
  });
});
