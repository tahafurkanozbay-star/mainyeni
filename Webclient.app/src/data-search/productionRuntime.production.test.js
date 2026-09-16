import {
  createProductionDataSearchRuntime,
  decodeSearchCursor,
} from './index';

const cleanRecords = [
  {
    id: 'park-1',
    title: 'Kuğulu Park',
    category: 'Park',
    district: 'Çankaya',
    neighborhood: 'Kavaklıdere',
    street: 'Tunalı Hilmi Caddesi',
    latitude: 39.9079,
    longitude: 32.8608,
  },
  {
    id: 'park-2',
    title: 'Seğmenler Parkı',
    category: 'Park',
    district: 'Çankaya',
    neighborhood: 'Çankaya',
    street: 'Atatürk Bulvarı',
    latitude: 39.8997,
    longitude: 32.8554,
  },
  {
    id: 'museum-1',
    title: 'Anadolu Medeniyetleri Müzesi',
    category: 'Müze',
    district: 'Altındağ',
    neighborhood: 'Kale',
    street: 'Gözcü Sokak',
    latitude: 39.9385,
    longitude: 32.8619,
  },
];

const geocodePayload = label => ({
  candidates: [
    {
      address: label,
      score: 99,
      location: { x: 32.85, y: 39.92 },
    },
  ],
});

describe('ProductionDataSearchRuntime', () => {
  test('registers clean data through integrity, schema, indexes and catalog', () => {
    let now = 1_000;
    const runtime = createProductionDataSearchRuntime({ clock: () => now });
    const registered = runtime.registerDataset('Places', cleanRecords, {
      title: 'Kent Yerleri',
      sourceKind: 'backend',
      tags: ['poi', 'search'],
      schemaVersion: '2',
    });

    expect(registered.dataset.key).toBe('places');
    expect(registered.dataset.records).toHaveLength(3);
    expect(registered.integrity.releaseReady).toBe(true);
    expect(registered.catalog).toEqual(expect.objectContaining({
      key: 'places',
      title: 'Kent Yerleri',
      sourceKind: 'backend',
      schemaVersion: '2',
      state: 'active',
    }));
    expect(registered.catalog.schemaProfile.fieldCount).toBeGreaterThan(0);
    expect(runtime.diagnostics().catalog.activeCount).toBe(1);
    now += 1;
    expect(runtime.catalog.get('places')).not.toBeNull();
  });

  test('blocks conflicting duplicate ids by default and catalogs quarantine state', () => {
    const runtime = createProductionDataSearchRuntime();

    expect(() => runtime.registerDataset('conflict', [
      { id: '1', title: 'A', district: 'Çankaya' },
      { id: '1', title: 'B', district: 'Mamak' },
    ])).toThrow('failed data-integrity release policy');

    expect(runtime.catalog.get('conflict')).toEqual(expect.objectContaining({ state: 'quarantined' }));
    expect(runtime.searchRuntime.get('conflict')).toBeNull();
  });

  test('can explicitly index quarantined data without hiding release risk', () => {
    const runtime = createProductionDataSearchRuntime();
    const registered = runtime.registerDataset('legacy', [
      { id: '1', title: 'A' },
      { id: '1', title: 'B' },
    ], {
      allowReleaseBlocked: true,
      includeQuarantined: true,
    });

    expect(registered.integrity.releaseReady).toBe(false);
    expect(registered.dataset.records).toHaveLength(2);
    expect(registered.catalog.state).toBe('quarantined');
    expect(runtime.diagnostics().catalog.quarantinedCount).toBe(1);
  });

  test('searches with compiled plan and Turkish-normalized address fields', () => {
    const runtime = createProductionDataSearchRuntime();
    runtime.registerDataset('places', cleanRecords);

    const result = runtime.search('places', {
      query: 'kugulu park',
      district: 'CANKAYA',
      limit: 10,
    });

    expect(result.response.results[0].record.id).toBe('park-1');
    expect(result.plan.datasetKey).toBe('places');
    expect(result.plan.estimatedCandidateCount).toBeGreaterThan(0);
    expect(result.plan.stages.map(item => item.kind)).toContain('scoring');
    expect(result.catalog.key).toBe('places');
  });

  test('spatial planning narrows candidates before exact distance verification', () => {
    const runtime = createProductionDataSearchRuntime();
    runtime.registerDataset('places', cleanRecords);

    const plan = runtime.plan('places', {
      query: 'park',
      center: [32.8608, 39.9079],
      radiusMeters: 1_000,
    });
    const result = runtime.search('places', {
      query: 'park',
      center: [32.8608, 39.9079],
      radiusMeters: 1_000,
      sort: 'distance',
    });

    expect(plan.spatialCandidatePositions).not.toBeNull();
    expect(plan.stages.map(item => item.kind)).toContain('spatial-index');
    expect(result.response.results[0].record.id).toBe('park-1');
    expect(result.response.results.every(item => item.distanceMeters <= 1_000)).toBe(true);
  });

  test('cursor pages are bound to revision and query semantics', () => {
    const runtime = createProductionDataSearchRuntime();
    runtime.registerDataset('places', cleanRecords);

    const first = runtime.searchPage('places', { query: 'park', limit: 1 });
    expect(first.cursorPage.items).toHaveLength(1);
    expect(first.cursorPage.cursor).toEqual(expect.any(String));
    expect(decodeSearchCursor(first.cursorPage.cursor).datasetRevision).toBe(1);

    const second = runtime.searchPage('places', { query: 'park', limit: 1 }, first.cursorPage.cursor);
    expect(second.response.page.offset).toBe(1);
    expect(second.cursorPage.items[0].record.id).not.toBe(first.cursorPage.items[0].record.id);

    runtime.registerDataset('places', [...cleanRecords, {
      id: 'park-3',
      title: 'Botanik Parkı',
      category: 'Park',
      district: 'Çankaya',
    }]);
    expect(() => runtime.searchPage('places', { query: 'park', limit: 1 }, first.cursorPage.cursor))
      .toThrow('stale dataset revision');
  });

  test('schema migrations are explicit and reusable before registration', () => {
    const runtime = createProductionDataSearchRuntime();
    runtime.registerMigration({
      id: 'legacy-title-v2',
      fromVersion: '1',
      toVersion: '2',
      transform: record => ({
        ...record,
        id: record.OBJECTID,
        title: record.ADI,
        category: record.KATEGORI ?? 'Diğer',
      }),
    });

    const result = runtime.migrateAndRegisterDataset('legacy-places', [
      { OBJECTID: 1, ADI: 'Park A', KATEGORI: 'Park' },
    ], {
      fromVersion: '1',
      toVersion: '2',
      metadata: { owner: 'search' },
    });

    expect(result.dataset.records[0].title).toBe('Park A');
    expect(result.catalog.schemaVersion).toBe('2');
    expect(result.catalog.metadata.migrationPath).toEqual(['legacy-title-v2']);
  });

  test('geocoding remains provider-injected and shares runtime diagnostics', async () => {
    const runtime = createProductionDataSearchRuntime();
    runtime.registerGeocodingProvider({
      id: 'fixture',
      forward: request => geocodePayload(request.query),
    });

    const result = await runtime.geocodeForward({ query: 'Kızılay' });
    expect(result.providerId).toBe('fixture');
    expect(result.page.candidates[0].label).toBe('Kızılay');
    expect(runtime.diagnostics().geocoding.providerCalls.fixture).toBe(1);
  });

  test('created search session routes through production search and unregisters on dispose', async () => {
    const runtime = createProductionDataSearchRuntime();
    runtime.registerDataset('places', cleanRecords);
    const session = runtime.createSession({ debounceMs: 0 });

    const envelope = await session.searchNow('places', { query: 'park' });
    expect(envelope.result.results.length).toBeGreaterThan(0);
    expect(runtime.diagnostics().sessions).toBe(1);
    session.dispose();
    expect(runtime.diagnostics().sessions).toBe(0);
  });

  test('invalidating dataset marks catalog stale and invalidates result cache', () => {
    const runtime = createProductionDataSearchRuntime();
    runtime.registerDataset('places', cleanRecords);
    runtime.search('places', { query: 'park' });
    runtime.search('places', { query: 'park' });
    expect(runtime.diagnostics().search.cacheHits).toBeGreaterThan(0);

    expect(runtime.invalidate('places')).toBe(true);
    expect(runtime.catalog.get('places').state).toBe('stale');
    expect(runtime.diagnostics().search.cacheEntries).toBe(0);
  });

  test('diagnostics aggregate all production subsystems', () => {
    const runtime = createProductionDataSearchRuntime();
    runtime.registerDataset('places', cleanRecords);
    runtime.search('places', { query: 'park' });
    const diagnostics = runtime.diagnostics();

    expect(diagnostics.search.datasetCount).toBe(1);
    expect(diagnostics.catalog.size).toBe(1);
    expect(diagnostics.observability.sampleCount).toBeGreaterThan(0);
    expect(diagnostics.performanceGate).toEqual(expect.objectContaining({ withinBudget: expect.any(Boolean) }));
    expect(diagnostics.migrations.steps).toBe(0);
  });

  test('dispose clears datasets, sessions, geocoding cache and rejects future operations', () => {
    const runtime = createProductionDataSearchRuntime();
    runtime.registerDataset('places', cleanRecords);
    runtime.dispose();

    expect(runtime.diagnostics().search.datasetCount).toBe(0);
    expect(runtime.diagnostics().catalog.size).toBe(0);
    expect(() => runtime.search('places', { query: 'park' })).toThrow('disposed');
  });
});
