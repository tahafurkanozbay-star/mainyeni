import {
  createAddressHierarchyRuntime,
  normalizeRecordCollection,
} from './index';

const makeRecords = (
  districtCount = 8,
  neighborhoodPerDistrict = 5,
  streetPerNeighborhood = 4,
  doorsPerStreet = 3,
) => {
  const records: Array<Record<string, unknown>> = [];
  let id = 0;
  Array.from({ length: districtCount }, (_, districtIndex) =>
    Array.from({ length: neighborhoodPerDistrict }, (_, neighborhoodIndex) =>
      Array.from({ length: streetPerNeighborhood }, (_, streetIndex) =>
        Array.from({ length: doorsPerStreet }, (_, doorIndex) => {
          id += 1;
          records.push({
            id: `r-${id}`,
            district: `İlçe ${districtIndex}`,
            neighborhood: `Mahalle ${districtIndex}-${neighborhoodIndex}`,
            street: `Sokak ${districtIndex}-${neighborhoodIndex}-${streetIndex}`,
            building: `Bina ${streetIndex}`,
            door: `${doorIndex + 1}`,
            latitude: 39.8 + districtIndex / 100 + neighborhoodIndex / 10_000,
            longitude: 32.7 + streetIndex / 100 + doorIndex / 10_000,
          });
          return id;
        }),
      ),
    ),
  );
  return normalizeRecordCollection(records, { dedupe: false, keepInvalid: true }).records;
};

const build = (count = 8) => createAddressHierarchyRuntime(makeRecords(count), {
  buildingFieldAliases: ['building'],
  maxRecords: 10_000,
  maxNodes: 100_000,
  maxChildrenPerNode: 2_000,
  maxAliasesPerNode: 16,
});

describe('address hierarchy scale and integrity regression', () => {
  test('builds deterministic bounded counts across a multi-level synthetic dataset', () => {
    const runtime = build(8);
    const snapshot = runtime.snapshot();

    expect(snapshot.recordCount).toBe(8 * 5 * 4 * 3);
    expect(snapshot.districtCount).toBe(8);
    expect(snapshot.neighborhoodCount).toBe(8 * 5);
    expect(snapshot.streetCount).toBe(8 * 5 * 4);
    expect(snapshot.buildingCount).toBe(8 * 5 * 4);
    expect(snapshot.doorCount).toBe(8 * 5 * 4 * 3);
    expect(snapshot.nodeCount).toBe(
      snapshot.districtCount
      + snapshot.neighborhoodCount
      + snapshot.streetCount
      + snapshot.buildingCount
      + snapshot.doorCount,
    );
  });

  test('produces the same hierarchy fingerprint for identical logical input', () => {
    const first = build(4).snapshot();
    const second = build(4).snapshot();
    expect(second.fingerprint).toBe(first.fingerprint);
  });

  test('keeps canonical Turkish query matching stable under ASCII spelling', () => {
    const runtime = build(2);
    const Turkish = runtime.resolve('İlçe 1', { level: 'district' });
    const ascii = runtime.resolve('Ilce 1', { level: 'district' });

    expect(Turkish[0]?.node.key).toBe(ascii[0]?.node.key);
    expect(Turkish[0]?.exact).toBe(true);
    expect(ascii[0]?.exact).toBe(true);
  });

  test('resolves a street prefix without scanning unrelated hierarchy branches into output', () => {
    const runtime = build(8);
    const matches = runtime.resolve('Sokak 6-3-2', {
      level: 'street',
      district: 'İlçe 6',
      neighborhood: 'Mahalle 6-3',
      limit: 5,
    });

    expect(matches[0]?.node.level).toBe('street');
    expect(matches[0]?.node.canonicalName).toContain('sokak 6 3 2');
    expect(matches.every(match => runtime.getPath(match.node.key)[0]?.canonicalName === 'ilce 6')).toBe(true);
  });

  test('supports partial token prefixes through the prefix posting index', () => {
    const runtime = build(3);
    const matches = runtime.resolve('Sok 2-1-3', {
      level: 'street',
      district: 'İlçe 2',
      neighborhood: 'Mahalle 2-1',
    });

    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]?.node.canonicalName).toContain('2 1 3');
  });

  test('fails hierarchy filtering closed when a district does not match', () => {
    const runtime = build(3);
    const matches = runtime.resolve('Sokak 2-1-3', {
      level: 'street',
      district: 'İlçe 0',
      neighborhood: 'Mahalle 2-1',
    });
    expect(matches).toHaveLength(0);
  });

  test('can surface a hierarchy mismatch only when explicitly requested', () => {
    const runtime = build(3);
    const matches = runtime.resolve('Sokak 2-1-3', {
      level: 'street',
      district: 'İlçe 0',
      requireHierarchyMatch: false,
    });

    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]?.hierarchyScore).toBeLessThan(0);
    expect(matches[0]?.reasons).toContain('hierarchy-mismatch:district');
  });

  test('returns exact path ordering for the deepest door node', () => {
    const runtime = build(2);
    const door = runtime.findByPath({
      district: 'İlçe 1',
      neighborhood: 'Mahalle 1-2',
      street: 'Sokak 1-2-3',
      building: 'Bina 3',
      door: '2',
    });
    const path = door ? runtime.getPath(door.key) : [];

    expect(path.map(item => item.level)).toEqual([
      'district',
      'neighborhood',
      'street',
      'building',
      'door',
    ]);
    expect(path.at(-1)?.canonicalName).toBe('2');
  });

  test('returns only direct children from a parent node', () => {
    const runtime = build(2);
    const district = runtime.findByPath({ district: 'İlçe 1' });
    const children = district ? runtime.getChildren(district.key) : [];

    expect(children).toHaveLength(5);
    expect(children.every(child => child.level === 'neighborhood')).toBe(true);
    expect(children.every(child => child.parentKey === district?.key)).toBe(true);
  });

  test('binds every accepted normalized record to a deepest hierarchy key', () => {
    const records = makeRecords(2);
    const runtime = createAddressHierarchyRuntime(records, { buildingFieldAliases: ['building'] });
    const bindings = records.map(record => runtime.getBinding(record));

    expect(bindings).toHaveLength(records.length);
    expect(bindings.every(binding => binding?.deepestKey)).toBe(true);
    expect(new Set(bindings.map(binding => binding?.recordKey)).size).toBe(records.length);
  });

  test('keeps binding fingerprints stable across rebuilds of the same data', () => {
    const records = makeRecords(2);
    const runtime = createAddressHierarchyRuntime(records, { buildingFieldAliases: ['building'] });
    const before = records.map(record => runtime.getBinding(record)?.fingerprint);
    runtime.rebuild(records);
    const after = records.map(record => runtime.getBinding(record)?.fingerprint);

    expect(after).toEqual(before);
  });

  test('rebuild atomically replaces the previous hierarchy snapshot', () => {
    const runtime = build(2);
    const before = runtime.snapshot();
    const replacement = makeRecords(1);
    const after = runtime.rebuild(replacement);

    expect(after.recordCount).toBe(replacement.length);
    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(runtime.snapshot()).toBe(after);
    expect(runtime.resolve('İlçe 1', { level: 'district' })).toHaveLength(0);
  });

  test('enforces record budget without creating unbounded nodes', () => {
    const records = makeRecords(4);
    const runtime = createAddressHierarchyRuntime(records, {
      buildingFieldAliases: ['building'],
      maxRecords: 25,
      maxNodes: 10_000,
    });
    const snapshot = runtime.snapshot();

    expect(snapshot.recordCount).toBe(25);
    expect(snapshot.nodeCount).toBeLessThanOrEqual(25 * 5);
    expect(snapshot.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'record-budget-exceeded', severity: 'error' }),
    ]));
  });

  test('enforces node budget fail-closed without exceeding configured capacity', () => {
    const runtime = createAddressHierarchyRuntime(makeRecords(3), {
      buildingFieldAliases: ['building'],
      maxNodes: 20,
      maxRecords: 1_000,
    });
    const snapshot = runtime.snapshot();

    expect(snapshot.nodeCount).toBeLessThanOrEqual(20);
    expect(snapshot.diagnostics.some(item => item.code === 'node-budget-exceeded')).toBe(true);
  });

  test('bounds diagnostics under adversarial over-capacity data', () => {
    const runtime = createAddressHierarchyRuntime(makeRecords(5), {
      buildingFieldAliases: ['building'],
      maxNodes: 3,
      maxDiagnostics: 4,
    });
    const snapshot = runtime.snapshot();

    expect(snapshot.diagnostics.length).toBeLessThanOrEqual(4);
    expect(snapshot.diagnosticsTruncated).toBe(true);
  });

  test('detects coordinate divergence for records bound to the same path', () => {
    const records = normalizeRecordCollection([
      { id: 'a', district: 'Çankaya', street: 'Atatürk Bulvarı', latitude: 39.92, longitude: 32.85 },
      { id: 'b', district: 'Çankaya', street: 'Atatürk Bulvarı', latitude: 40.50, longitude: 33.50 },
    ], { dedupe: false, keepInvalid: true }).records;
    const runtime = createAddressHierarchyRuntime(records, { coordinateDivergenceMeters: 100 });

    expect(runtime.snapshot().diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'coordinate-divergence' }),
    ]));
  });

  test('uses coordinate bias to prefer a nearby otherwise-equivalent name', () => {
    const records = normalizeRecordCollection([
      { id: 'a', district: 'Çankaya', neighborhood: 'Merkez', latitude: 39.92, longitude: 32.85 },
      { id: 'b', district: 'Altındağ', neighborhood: 'Merkez', latitude: 40.50, longitude: 33.50 },
    ], { dedupe: false, keepInvalid: true }).records;
    const runtime = createAddressHierarchyRuntime(records);
    const matches = runtime.resolve('Merkez', {
      level: 'neighborhood',
      center: { latitude: 39.92, longitude: 32.85 },
    });

    expect(matches[0]?.distanceMeters).toBeLessThan(10);
    expect(matches[0]?.node.parentKey).toBe(runtime.findByPath({ district: 'Çankaya' })?.key);
  });

  test('enforces radius before returning spatially inconsistent hierarchy candidates', () => {
    const records = normalizeRecordCollection([
      { id: 'a', district: 'Çankaya', neighborhood: 'Merkez', latitude: 39.92, longitude: 32.85 },
      { id: 'b', district: 'Altındağ', neighborhood: 'Merkez', latitude: 40.50, longitude: 33.50 },
    ], { dedupe: false, keepInvalid: true }).records;
    const runtime = createAddressHierarchyRuntime(records);
    const matches = runtime.resolve('Merkez', {
      level: 'neighborhood',
      center: { latitude: 39.92, longitude: 32.85 },
      radiusMeters: 1_000,
    });

    expect(matches).toHaveLength(1);
    expect(runtime.getPath(matches[0]?.node.key ?? '')[0]?.canonicalName).toBe('cankaya');
  });

  test('keeps node keys stable when source order changes', () => {
    const records = makeRecords(2);
    const forward = createAddressHierarchyRuntime(records, { buildingFieldAliases: ['building'] });
    const reverse = createAddressHierarchyRuntime([...records].reverse(), { buildingFieldAliases: ['building'] });
    const path = {
      district: 'İlçe 1',
      neighborhood: 'Mahalle 1-2',
      street: 'Sokak 1-2-3',
    } as const;

    expect(forward.findByPath(path)?.key).toBe(reverse.findByPath(path)?.key);
  });

  test('keeps canonical path lookup strict for a missing intermediate level', () => {
    const runtime = build(2);
    expect(runtime.findByPath({ district: 'İlçe 1', street: 'Sokak 1-2-3' })).toBeNull();
  });

  test('returns empty results for blank resolution text', () => {
    const runtime = build(2);
    expect(runtime.resolve('   ')).toEqual([]);
  });

  test('caps query output at the requested limit', () => {
    const runtime = build(8);
    const matches = runtime.resolve('Mahalle', { level: 'neighborhood', limit: 7 });
    expect(matches).toHaveLength(7);
  });

  test('keeps minimum score filtering deterministic', () => {
    const runtime = build(2);
    const all = runtime.resolve('Sok', { level: 'street', minimumScore: 1, limit: 100 });
    const strict = runtime.resolve('Sok', { level: 'street', minimumScore: 10_000, limit: 100 });
    expect(all.length).toBeGreaterThan(0);
    expect(strict).toHaveLength(0);
  });

  test('snapshot is serializable and contains no raw record payloads', () => {
    const snapshot = build(2).toSerializableSnapshot();
    const serialized = JSON.stringify(snapshot);

    expect(() => JSON.parse(serialized)).not.toThrow();
    expect(serialized).not.toContain('latitude');
    expect(serialized).not.toContain('longitude');
    expect(serialized).not.toContain('source');
  });
});
