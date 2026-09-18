import {
  DatasetCatalog,
  SchemaMigrationRegistry,
  compareAliasCoverage,
  compareSchemaProfiles,
  createSchemaEvolutionFingerprint,
  evaluateAliasCoverage,
  profileDatasetSchema,
} from './index';

const aliases = {
  id: ['OBJECTID', 'id'],
  title: ['ADI', 'title'],
  district: ['ILCE_ADI', 'district'],
  neighborhood: ['MAHALLE_ADI', 'neighborhood'],
  street: ['YOL_ADI', 'street'],
};

describe('schemaEvolution production runtime', () => {
  test('profiles required, nullable, type and sample information deterministically', () => {
    const profile = profileDatasetSchema([
      { OBJECTID: 1, ADI: 'Park A', ILCE_ADI: 'Çankaya', score: 10 },
      { OBJECTID: 2, ADI: 'Park B', ILCE_ADI: 'Mamak', score: 20 },
      { OBJECTID: 3, ADI: 'Park C', ILCE_ADI: null, score: 30 },
    ]);

    expect(profile.inputCount).toBe(3);
    expect(profile.sampledCount).toBe(3);
    expect(profile.fields.objectid.required).toBe(true);
    expect(profile.fields.objectid.dominantKind).toBe('number');
    expect(profile.fields.ilce_adi.nullable).toBe(true);
    expect(profile.fields.ilce_adi.required).toBe(false);
    expect(profile.fields.adi.examples).toEqual(expect.arrayContaining(['Park A', 'Park B']));
    expect(profile.fingerprint).toEqual(expect.any(String));
  });

  test('bounds profiling work and optional nested traversal', () => {
    const records = Array.from({ length: 100 }, (_, index) => ({
      id: index,
      nested: { name: `N${index}`, detail: { code: index } },
    }));
    const profile = profileDatasetSchema(records, {
      maxRecords: 10,
      includeNestedFields: true,
      maxNestedDepth: 1,
      maxFields: 10,
    });

    expect(profile.sampledCount).toBe(10);
    expect(profile.fields['nested.name'].seenCount).toBe(10);
    expect(profile.fields['nested.detail']).toBeDefined();
    expect(profile.fields['nested.detail.code']).toBeUndefined();
  });

  test('classifies removal and requiredness relaxation as incompatible drift', () => {
    const baseline = profileDatasetSchema([
      { id: 1, title: 'A', district: 'Çankaya' },
      { id: 2, title: 'B', district: 'Mamak' },
    ]);
    const candidate = profileDatasetSchema([
      { id: 1, title: 'A', added: 'x' },
      { id: 2, title: null, added: 'y' },
    ]);
    const drift = compareSchemaProfiles(baseline, candidate);

    expect(drift.compatibility).toBe('breaking');
    expect(drift.removedFields).toContain('district');
    expect(drift.addedFields).toContain('added');
    expect(drift.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'field-removed', field: 'district', compatibility: 'breaking' }),
      expect.objectContaining({ kind: 'requiredness-changed', field: 'title', compatibility: 'breaking' }),
    ]));
  });

  test('detects type expansion without hiding historical field shape', () => {
    const baseline = profileDatasetSchema([{ id: 1 }, { id: 2 }]);
    const candidate = profileDatasetSchema([{ id: 1 }, { id: '2' }]);
    const drift = compareSchemaProfiles(baseline, candidate);

    expect(drift.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'type-expanded', field: 'id', compatibility: 'warning' }),
    ]));
    expect(drift.baselineFingerprint).toBe(baseline.fingerprint);
    expect(drift.candidateFingerprint).toBe(candidate.fingerprint);
  });

  test('reports semantic alias coverage instead of assuming field names', () => {
    const baseline = profileDatasetSchema([
      { OBJECTID: 1, ADI: 'Park', ILCE_ADI: 'Çankaya', YOL_ADI: 'Hoşdere' },
    ]);
    const candidate = profileDatasetSchema([
      { id: 1, title: 'Park', district: 'Çankaya' },
    ]);
    const before = evaluateAliasCoverage(baseline, aliases);
    const after = evaluateAliasCoverage(candidate, aliases);
    const coverageDrift = compareAliasCoverage(before, after);

    expect(before.missingCount).toBe(1);
    expect(after.entries.find(entry => entry.semanticField === 'id').covered).toBe(true);
    expect(coverageDrift).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'alias-coverage-lost', field: 'street', compatibility: 'breaking' }),
    ]));
    expect(createSchemaEvolutionFingerprint(baseline, before)).not.toBe(
      createSchemaEvolutionFingerprint(candidate, after),
    );
  });

  test('finds shortest bounded migration path and transforms immutable records', () => {
    const migrations = new SchemaMigrationRegistry();
    migrations.register({
      id: 'v1-v2-title',
      fromVersion: '1',
      toVersion: '2',
      transform: record => ({ ...record, title: record.ADI }),
    });
    migrations.register({
      id: 'v2-v3-category',
      fromVersion: '2',
      toVersion: '3',
      transform: record => ({ ...record, category: record.KATEGORI ?? 'Diğer' }),
    });
    migrations.register({
      id: 'v1-v3-direct',
      fromVersion: '1',
      toVersion: '3',
      transform: record => ({ ...record, title: record.ADI, category: record.KATEGORI ?? 'Diğer' }),
    });

    expect(migrations.findPath('1', '3').map(step => step.id)).toEqual(['v1-v3-direct']);
    const result = migrations.migrate('places', [{ ADI: 'Park' }], '1', '3');
    expect(result.rejectedCount).toBe(0);
    expect(result.path).toEqual(['v1-v3-direct']);
    expect(result.records[0]).toEqual(expect.objectContaining({ title: 'Park', category: 'Diğer' }));
    expect(Object.isFrozen(result.records[0])).toBe(true);
  });

  test('keeps per-record migration errors visible', () => {
    const migrations = new SchemaMigrationRegistry();
    migrations.register({
      id: 'strict-title',
      fromVersion: '1',
      toVersion: '2',
      transform: record => {
        if (!record.title) throw new Error('title required');
        return record;
      },
    });
    const result = migrations.migrate('places', [{ title: 'A' }, { title: '' }], '1', '2');

    expect(result.transformedCount).toBe(1);
    expect(result.rejectedCount).toBe(1);
    expect(result.errors[0]).toEqual(expect.objectContaining({ index: 1, message: 'title required' }));
  });

  test('catalog preserves schema history and computes drift on replacement', () => {
    const catalog = new DatasetCatalog({ clock: () => 1000, defaultTtlMs: 100 });
    const firstProfile = profileDatasetSchema([{ id: 1, title: 'A' }]);
    const secondProfile = profileDatasetSchema([{ id: 1 }]);
    const first = catalog.register({
      key: 'Parks',
      title: 'Parklar',
      sourceKind: 'backend',
      tags: ['places', 'parks'],
      schemaProfile: firstProfile,
    });
    const second = catalog.register({ key: 'Parks', schemaProfile: secondProfile });

    expect(first.revision).toBe(1);
    expect(second.revision).toBe(2);
    expect(second.previousSchemaProfile.fingerprint).toBe(firstProfile.fingerprint);
    expect(second.schemaDrift.compatibility).toBe('breaking');
    expect(catalog.list({ tag: 'parks' })).toHaveLength(1);
  });

  test('catalog aliases resolve deterministically and cannot silently retarget', () => {
    const catalog = new DatasetCatalog();
    catalog.register({ key: 'district-addresses', tags: ['address'] });
    catalog.register({ key: 'poi' });
    catalog.alias('adres', 'district-addresses');

    expect(catalog.resolveKey('ADRES')).toBe('district-addresses');
    expect(catalog.get('adres').key).toBe('district-addresses');
    expect(() => catalog.alias('adres', 'poi')).toThrow('already points');
  });

  test('catalog TTL marks active entries stale without deleting them', () => {
    let now = 1000;
    const catalog = new DatasetCatalog({ clock: () => now, defaultTtlMs: 1_000 });
    catalog.register({ key: 'places' });
    now = 2_100;

    expect(catalog.get('places').state).toBe('stale');
    expect(catalog.get('places', { allowStale: false })).toBeNull();
    expect(catalog.snapshot()).toEqual(expect.objectContaining({ staleCount: 1, invalidations: 1 }));
  });

  test('tag invalidation is bounded to matching datasets', () => {
    const catalog = new DatasetCatalog();
    catalog.register({ key: 'a', tags: ['address'] });
    catalog.register({ key: 'b', tags: ['address'] });
    catalog.register({ key: 'c', tags: ['other'] });

    expect(catalog.invalidateTag('address')).toEqual(['a', 'b']);
    expect(catalog.get('a').state).toBe('stale');
    expect(catalog.get('c').state).toBe('active');
  });
});
