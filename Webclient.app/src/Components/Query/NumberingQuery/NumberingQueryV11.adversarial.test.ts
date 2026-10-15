import { describe, expect, it, vi } from 'vitest';
import { Constants_ServiceResultType } from '../../../Core/Constants';
import {
  type NumberingFeatureV11,
  type NumberingServiceResultV11,
  type NumberingTransportV11,
} from './NumberingQueryContractsV11';
import { auditNumberingSnapshotV11 } from './NumberingQueryAuditV11';
import { createNumberingQueryRuntimeV11 } from './NumberingQueryRuntimeV11';

const feature = (
  attr: Record<string, unknown>,
  geometry?: unknown,
): NumberingFeatureV11 => Object.freeze({
  attr: Object.freeze({ ...attr }),
  ...(geometry === undefined ? {} : { geometry }),
});

const success = (
  data: readonly NumberingFeatureV11[],
): NumberingServiceResultV11 => Object.freeze({
  type: Constants_ServiceResultType.Success,
  data: Object.freeze([...data]),
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const baseTransport = (
  districtRows: readonly NumberingFeatureV11[],
): NumberingTransportV11 => ({
  loadDistricts: async () => success(districtRows),
  loadDistrict: async id => success([
    feature({ id, ad: `İlçe ${id}` }, { kind: 'district', id }),
  ]),
  loadNeighborhoods: async districtId => success([
    feature({ id: `${districtId}-n1`, ad: 'Merkez Mahallesi' }),
    feature({ id: `${districtId}-n2`, ad: 'Yeni Mahalle' }),
  ]),
  loadNeighborhood: async id => success([
    feature({ id, ad: 'Merkez Mahallesi' }, { kind: 'neighborhood', id }),
  ]),
  loadStreets: async neighborhoodId => success([
    feature({ yolid: `${neighborhoodId}-s1`, ad: 'Atatürk Caddesi' }),
    feature({ yolid: `${neighborhoodId}-s2`, ad: 'Cumhuriyet Sokak' }),
  ]),
  loadStreetGeometries: async id => Object.freeze([
    feature({ yolid: id }, { kind: 'street', id }),
  ]),
  loadDoors: async streetId => success([
    feature({ id: `${streetId}-d1`, kapino: '1' }),
    feature({ id: `${streetId}-d2`, kapino: '2/A' }),
  ]),
  loadDoor: async id => success([
    feature({ id, kapino: '1' }, { kind: 'door', id }),
  ]),
});

describe('NumberingQuery v11 large option scale', () => {
  it('retains configured hard maximum instead of entire 25K source', async () => {
    const rows = Array.from({ length: 25_000 }, (_, index) =>
      feature({ id: index + 1, ad: `Ankara İlçe ${index + 1}` }));
    const runtime = createNumberingQueryRuntimeV11(baseTransport(rows), {}, {
      maxOptionsPerLevel: 4_000,
      maxVisibleOptions: 120,
      minimumFilterLengthForOverflow: 2,
    });

    await runtime.initialize();

    expect(runtime.snapshot().levels.district.optionCount).toBe(4_000);
    expect(runtime.snapshot().levels.district.visibleOptionCount).toBe(0);
    expect(runtime.snapshot().levels.district.truncated).toBe(true);
    expect(runtime.snapshot().metrics.optionTruncations).toBe(1);
  });

  it('filters retained large option set without expanding DOM window', async () => {
    const rows = Array.from({ length: 8_000 }, (_, index) =>
      feature({ id: index + 1, ad: `Mahalle ${String(index + 1).padStart(5, '0')}` }));
    const runtime = createNumberingQueryRuntimeV11(baseTransport(rows), {}, {
      maxOptionsPerLevel: 8_000,
      maxVisibleOptions: 80,
      minimumFilterLengthForOverflow: 2,
    });

    await runtime.initialize();
    runtime.setFilter('district', 'mahalle 07');

    const state = runtime.snapshot().levels.district;
    expect(state.optionCount).toBe(8_000);
    expect(state.visibleOptionCount).toBeLessThanOrEqual(80);
    expect(state.options.every(option => option.searchLabel.includes('mahalle 07'))).toBe(true);
  });

  it('keeps stable source order inside filtered window', async () => {
    const rows = Array.from({ length: 1_000 }, (_, index) =>
      feature({ id: index + 1, ad: index % 2 === 0 ? `Çankaya ${index}` : `Keçiören ${index}` }));
    const runtime = createNumberingQueryRuntimeV11(baseTransport(rows), {}, {
      maxOptionsPerLevel: 1_000,
      maxVisibleOptions: 30,
      minimumFilterLengthForOverflow: 1,
    });

    await runtime.initialize();
    runtime.setFilter('district', 'cankaya');

    const sourceIndexes = runtime.snapshot().levels.district.options.map(option => option.sourceIndex);
    expect(sourceIndexes).toEqual([...sourceIndexes].sort((left, right) => left - right));
  });
});

describe('NumberingQuery v11 malformed source pressure', () => {
  it('deduplicates repeated identities before UI exposure', async () => {
    const rows = [
      feature({ id: 1, ad: 'Çankaya' }),
      feature({ id: 1, ad: 'Çankaya Tekrar' }),
      feature({ id: 2, ad: 'Keçiören' }),
    ];
    const runtime = createNumberingQueryRuntimeV11(baseTransport(rows));
    await runtime.initialize();
    expect(runtime.snapshot().levels.district.options.map(option => option.label))
      .toEqual(['Çankaya', 'Keçiören']);
  });

  it('drops rows without an identity', async () => {
    const rows = [
      feature({ id: '', ad: 'Eksik' }),
      feature({ ad: 'Kimliksiz' }),
      feature({ id: 9, ad: 'Geçerli' }),
    ];
    const runtime = createNumberingQueryRuntimeV11(baseTransport(rows));
    await runtime.initialize();
    expect(runtime.snapshot().levels.district.optionCount).toBe(1);
    expect(runtime.snapshot().levels.district.options[0]?.label).toBe('Geçerli');
  });

  it('falls back to readable identity for missing label', async () => {
    const runtime = createNumberingQueryRuntimeV11(baseTransport([
      feature({ id: 42 }),
    ]));
    await runtime.initialize();
    expect(runtime.snapshot().levels.district.options[0]?.label).toBe('42');
  });
});

describe('NumberingQuery v11 concurrency pressure', () => {
  it('ignores a late neighborhood list from superseded district', async () => {
    const oldList = deferred<NumberingServiceResultV11>();
    const newList = deferred<NumberingServiceResultV11>();
    const transport: NumberingTransportV11 = {
      ...baseTransport([
        feature({ id: 'old', ad: 'Eski İlçe' }),
        feature({ id: 'new', ad: 'Yeni İlçe' }),
      ]),
      loadDistrict: async () => success([]),
      loadNeighborhoods: id => id === 'old' ? oldList.promise : newList.promise,
    };
    const runtime = createNumberingQueryRuntimeV11(transport);
    await runtime.initialize();

    const oldRequest = runtime.select('district', 'old');
    const newRequest = runtime.select('district', 'new');

    newList.resolve(success([
      feature({ id: 'new-n', ad: 'Yeni Mahalle' }),
    ]));
    await newRequest;

    oldList.resolve(success([
      feature({ id: 'old-n', ad: 'Eski Mahalle' }),
    ]));
    await oldRequest;

    expect(runtime.snapshot().path.district?.value).toBe('new');
    expect(runtime.snapshot().levels.neighborhood.options.map(option => option.value))
      .toEqual(['new-n']);
    expect(runtime.snapshot().metrics.staleResponses).toBeGreaterThan(0);
  });

  it('ignores late door list after parent street is cleared', async () => {
    const pendingDoors = deferred<NumberingServiceResultV11>();
    const transport: NumberingTransportV11 = {
      ...baseTransport([feature({ id: 1, ad: 'Çankaya' })]),
      loadDoors: () => pendingDoors.promise,
    };
    const runtime = createNumberingQueryRuntimeV11(transport);
    await runtime.initialize();
    await runtime.select('district', '1');
    await runtime.select('neighborhood', '1-n1');

    const pendingStreet = runtime.select('street', '1-n1-s1');
    runtime.clearSelection('neighborhood');

    pendingDoors.resolve(success([
      feature({ id: 'late-door', kapino: '99' }),
    ]));
    await pendingStreet;

    expect(runtime.snapshot().path.neighborhood).toBeNull();
    expect(runtime.snapshot().path.street).toBeNull();
    expect(runtime.snapshot().levels.door.optionCount).toBe(0);
  });

  it('records cancellation pressure when clearing a loading level', async () => {
    const pending = deferred<NumberingServiceResultV11>();
    const transport: NumberingTransportV11 = {
      ...baseTransport([
        feature({ id: 1, ad: 'Çankaya' }),
      ]),
      loadNeighborhoods: () => pending.promise,
    };
    const runtime = createNumberingQueryRuntimeV11(transport);
    await runtime.initialize();

    const request = runtime.select('district', '1');
    runtime.clearSelection('district');
    pending.resolve(success([]));
    await request;

    expect(runtime.snapshot().metrics.cancellations).toBeGreaterThan(0);
  });
});

describe('NumberingQuery v11 effect payload retention', () => {
  it('does not retain geometry graph in snapshot', async () => {
    const geometry = Object.freeze({
      rings: Array.from({ length: 500 }, (_, index) => [index, index + 1]),
      spatialReference: { wkid: 4326 },
    });
    const runtime = createNumberingQueryRuntimeV11({
      ...baseTransport([feature({ id: 1, ad: 'Çankaya' })]),
      loadDistrict: async () => success([
        feature({ id: 1, ad: 'Çankaya' }, geometry),
      ]),
    }, {
      focusGeometries: async () => undefined,
    });

    await runtime.initialize();
    await runtime.select('district', '1');

    const serialized = JSON.stringify(runtime.snapshot());
    expect(serialized).not.toContain('rings');
    expect(serialized).not.toContain('spatialReference');
  });

  it('does not retain geometry after focus failure', async () => {
    const runtime = createNumberingQueryRuntimeV11({
      ...baseTransport([feature({ id: 1, ad: 'Çankaya' })]),
      loadDistrict: async () => success([
        feature({ id: 1, ad: 'Çankaya' }, { huge: 'geometry' }),
      ]),
    }, {
      focusGeometries: async () => {
        throw new Error('map failure');
      },
    });
    await runtime.initialize();
    await runtime.select('district', '1');
    expect(JSON.stringify(runtime.snapshot())).not.toContain('geometry');
  });
});

describe('NumberingQuery v11 observer pressure', () => {
  it('keeps runtime functional when every observer throws', async () => {
    const reportObserverError = vi.fn();
    const runtime = createNumberingQueryRuntimeV11(
      baseTransport([feature({ id: 1, ad: 'Çankaya' })]),
      { reportObserverError },
      { maxObservers: 8 },
    );
    for (let index = 0; index < 8; index += 1) {
      runtime.subscribe(() => {
        throw new Error(`observer-${index}`);
      });
    }

    await runtime.initialize();

    expect(runtime.snapshot().levels.district.optionCount).toBe(1);
    expect(runtime.snapshot().metrics.observerFailures).toBeGreaterThanOrEqual(8);
    expect(reportObserverError).toHaveBeenCalled();
  });

  it('rejects observer beyond configured capacity', () => {
    const runtime = createNumberingQueryRuntimeV11(
      baseTransport([]),
      {},
      { maxObservers: 2 },
    );
    runtime.subscribe(() => undefined);
    runtime.subscribe(() => undefined);
    expect(() => runtime.subscribe(() => undefined)).toThrow(RangeError);
  });
});

describe('NumberingQuery v11 lifecycle audit', () => {
  it('passes audit through a complete address path', async () => {
    const runtime = createNumberingQueryRuntimeV11(
      baseTransport([feature({ id: 1, ad: 'Çankaya' })]),
    );
    await runtime.initialize();
    await runtime.select('district', '1');
    await runtime.select('neighborhood', '1-n1');
    await runtime.select('street', '1-n1-s1');
    await runtime.select('door', '1-n1-s1-d1');

    const report = auditNumberingSnapshotV11(runtime.snapshot());
    expect(report.valid).toBe(true);
    expect(runtime.snapshot().complete).toBe(true);
  });

  it('passes audit after reset', async () => {
    const runtime = createNumberingQueryRuntimeV11(
      baseTransport([feature({ id: 1, ad: 'Çankaya' })]),
    );
    await runtime.initialize();
    await runtime.select('district', '1');
    runtime.reset();
    expect(auditNumberingSnapshotV11(runtime.snapshot()).valid).toBe(true);
  });

  it('passes audit after dispose with zero retained options and history', async () => {
    const runtime = createNumberingQueryRuntimeV11(
      baseTransport([feature({ id: 1, ad: 'Çankaya' })]),
    );
    await runtime.initialize();
    await runtime.select('district', '1');
    runtime.dispose();
    const snapshot = runtime.snapshot();
    expect(snapshot.levels.district.optionCount).toBe(0);
    expect(snapshot.history).toEqual([]);
    expect(auditNumberingSnapshotV11(snapshot).valid).toBe(true);
  });
});
