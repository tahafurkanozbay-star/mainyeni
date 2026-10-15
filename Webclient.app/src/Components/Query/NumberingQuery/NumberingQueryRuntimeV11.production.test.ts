import { describe, expect, it, vi } from 'vitest';
import { Constants_ServiceResultType } from '../../../Core/Constants';
import {
  NUMBERING_QUERY_VERSION_V11,
  type NumberingFeatureV11,
  type NumberingServiceResultV11,
  type NumberingTransportV11,
} from './NumberingQueryContractsV11';
import {
  createNumberingQueryRuntimeV11,
  NumberingQueryRuntimeV11,
} from './NumberingQueryRuntimeV11';

const success = (
  data: readonly NumberingFeatureV11[] = [],
): NumberingServiceResultV11 => Object.freeze({
  type: Constants_ServiceResultType.Success,
  data: Object.freeze([...data]),
});

const failure = (
  message = 'Servis hatası',
): NumberingServiceResultV11 => Object.freeze({
  type: Constants_ServiceResultType.Error,
  data: Object.freeze([]),
  message,
});

const feature = (
  attr: Record<string, unknown>,
  geometry?: unknown,
): NumberingFeatureV11 => Object.freeze({
  attr: Object.freeze({ ...attr }),
  ...(geometry === undefined ? {} : { geometry }),
});

const districts = Object.freeze([
  feature({ id: 1, ad: 'Çankaya' }),
  feature({ id: 2, ad: 'Keçiören' }),
  feature({ id: 3, ad: 'Yenimahalle' }),
]);

const neighborhoods = Object.freeze([
  feature({ id: 10, ad: 'Kızılay' }),
  feature({ id: 11, ad: 'Ayrancı' }),
]);

const streets = Object.freeze([
  feature({ yolid: 20, ad: 'Atatürk Bulvarı' }),
  feature({ yolid: 21, ad: 'Tunus Caddesi' }),
]);

const doors = Object.freeze([
  feature({ id: 30, kapino: '10' }),
  feature({ id: 31, kapino: '12/A' }),
]);

const transport = (
  override: Partial<NumberingTransportV11> = {},
): NumberingTransportV11 => ({
  loadDistricts: async () => success(districts),
  loadDistrict: async id => success([
    feature({ id, ad: id === '1' ? 'Çankaya' : 'Keçiören' }, { kind: 'district', id }),
  ]),
  loadNeighborhoods: async () => success(neighborhoods),
  loadNeighborhood: async id => success([
    feature({ id, ad: 'Kızılay' }, { kind: 'neighborhood', id }),
  ]),
  loadStreets: async () => success(streets),
  loadStreetGeometries: async id => Object.freeze([
    feature({ yolid: id, ad: 'Atatürk Bulvarı' }, { kind: 'street', id }),
  ]),
  loadDoors: async () => success(doors),
  loadDoor: async id => success([
    feature({ id, kapino: '10' }, { kind: 'door', id }),
  ]),
  ...override,
});

const deferred = <T>(): Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}> => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return Object.freeze({ promise, resolve, reject });
};

describe('NumberingQueryRuntimeV11 construction', () => {
  it('constructs through class and factory', () => {
    expect(new NumberingQueryRuntimeV11(transport()))
      .toBeInstanceOf(NumberingQueryRuntimeV11);
    expect(createNumberingQueryRuntimeV11(transport()))
      .toBeInstanceOf(NumberingQueryRuntimeV11);
  });

  it('starts with immutable empty snapshot', () => {
    const snapshot = createNumberingQueryRuntimeV11(transport()).snapshot();
    expect(snapshot.version).toBe(NUMBERING_QUERY_VERSION_V11);
    expect(snapshot.initialized).toBe(false);
    expect(snapshot.complete).toBe(false);
    expect(snapshot.busy).toBe(false);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.levels)).toBe(true);
  });

  it('exposes bounded policy', () => {
    const runtime = createNumberingQueryRuntimeV11(transport(), {}, {
      maxOptionsPerLevel: 500,
      maxVisibleOptions: 75,
      maxHistory: 12,
      maxObservers: 4,
    });
    expect(runtime.policy()).toMatchObject({
      maxOptionsPerLevel: 500,
      maxVisibleOptions: 75,
      maxHistory: 12,
      maxObservers: 4,
    });
  });
});

describe('NumberingQueryRuntimeV11 initialization', () => {
  it('loads district options', async () => {
    const runtime = createNumberingQueryRuntimeV11(transport());
    await runtime.initialize();
    expect(runtime.snapshot().initialized).toBe(true);
    expect(runtime.snapshot().levels.district.optionCount).toBe(3);
    expect(runtime.snapshot().levels.district.status).toBe('ready');
  });

  it('does not refetch districts after successful initialization', async () => {
    const loadDistricts = vi.fn(async () => success(districts));
    const runtime = createNumberingQueryRuntimeV11(transport({ loadDistricts }));
    await runtime.initialize();
    await runtime.initialize();
    expect(loadDistricts).toHaveBeenCalledTimes(1);
  });

  it('surfaces district list service failure', async () => {
    const runtime = createNumberingQueryRuntimeV11(transport({
      loadDistricts: async () => failure('İlçeler şu anda alınamıyor'),
    }));
    await runtime.initialize();
    expect(runtime.snapshot().levels.district.status).toBe('error');
    expect(runtime.snapshot().levels.district.error).toContain('İlçeler');
    expect(runtime.snapshot().metrics.failures).toBe(1);
  });

  it('surfaces transport rejection', async () => {
    const runtime = createNumberingQueryRuntimeV11(transport({
      loadDistricts: async () => {
        throw new TypeError('network-independent-test-error');
      },
    }));
    await runtime.initialize();
    expect(runtime.snapshot().levels.district.status).toBe('error');
    expect(runtime.snapshot().levels.district.error).toBe('network-independent-test-error');
  });

  it('reports initialization error through isolated effect', async () => {
    const reportError = vi.fn();
    const runtime = createNumberingQueryRuntimeV11(transport({
      loadDistricts: async () => failure('Liste yok'),
    }), { reportError });
    await runtime.initialize();
    expect(reportError).toHaveBeenCalled();
  });
});

describe('NumberingQueryRuntimeV11 hierarchy selection', () => {
  it('loads neighborhoods after district selection', async () => {
    const runtime = createNumberingQueryRuntimeV11(transport());
    await runtime.initialize();
    await runtime.select('district', '1');
    expect(runtime.snapshot().path.district).toEqual({
      value: '1',
      label: 'Çankaya',
    });
    expect(runtime.snapshot().levels.neighborhood.optionCount).toBe(2);
  });

  it('loads streets after neighborhood selection', async () => {
    const runtime = createNumberingQueryRuntimeV11(transport());
    await runtime.initialize();
    await runtime.select('district', '1');
    await runtime.select('neighborhood', '10');
    expect(runtime.snapshot().path.neighborhood?.label).toBe('Kızılay');
    expect(runtime.snapshot().levels.street.optionCount).toBe(2);
  });

  it('loads doors after street selection', async () => {
    const runtime = createNumberingQueryRuntimeV11(transport());
    await runtime.initialize();
    await runtime.select('district', '1');
    await runtime.select('neighborhood', '10');
    await runtime.select('street', '20');
    expect(runtime.snapshot().path.street?.label).toBe('Atatürk Bulvarı');
    expect(runtime.snapshot().levels.door.optionCount).toBe(2);
  });

  it('completes path after door selection', async () => {
    const runtime = createNumberingQueryRuntimeV11(transport());
    await runtime.initialize();
    await runtime.select('district', '1');
    await runtime.select('neighborhood', '10');
    await runtime.select('street', '20');
    await runtime.select('door', '30');
    expect(runtime.snapshot().complete).toBe(true);
    expect(runtime.snapshot().pathLabel).toBe(
      'Çankaya / Kızılay / Atatürk Bulvarı / 10',
    );
  });

  it('clears lower hierarchy when district changes', async () => {
    const runtime = createNumberingQueryRuntimeV11(transport());
    await runtime.initialize();
    await runtime.select('district', '1');
    await runtime.select('neighborhood', '10');
    await runtime.select('street', '20');
    expect(runtime.snapshot().path.street).not.toBeNull();

    await runtime.select('district', '2');
    expect(runtime.snapshot().path.district?.value).toBe('2');
    expect(runtime.snapshot().path.neighborhood).toBeNull();
    expect(runtime.snapshot().path.street).toBeNull();
    expect(runtime.snapshot().path.door).toBeNull();
    expect(runtime.snapshot().levels.street.optionCount).toBe(0);
    expect(runtime.snapshot().levels.door.optionCount).toBe(0);
  });

  it('clears street and door when neighborhood changes', async () => {
    const runtime = createNumberingQueryRuntimeV11(transport());
    await runtime.initialize();
    await runtime.select('district', '1');
    await runtime.select('neighborhood', '10');
    await runtime.select('street', '20');
    await runtime.select('neighborhood', '11');
    expect(runtime.snapshot().path.neighborhood?.value).toBe('11');
    expect(runtime.snapshot().path.street).toBeNull();
    expect(runtime.snapshot().path.door).toBeNull();
  });

  it('clears door when street changes', async () => {
    const runtime = createNumberingQueryRuntimeV11(transport());
    await runtime.initialize();
    await runtime.select('district', '1');
    await runtime.select('neighborhood', '10');
    await runtime.select('street', '20');
    await runtime.select('door', '30');
    await runtime.select('street', '21');
    expect(runtime.snapshot().path.street?.value).toBe('21');
    expect(runtime.snapshot().path.door).toBeNull();
  });

  it('clears selected level when unknown value is supplied', async () => {
    const runtime = createNumberingQueryRuntimeV11(transport());
    await runtime.initialize();
    await runtime.select('district', '1');
    await runtime.select('district', 'not-present');
    expect(runtime.snapshot().path.district).toBeNull();
  });

  it('clearSelection preserves options at selected level', async () => {
    const runtime = createNumberingQueryRuntimeV11(transport());
    await runtime.initialize();
    await runtime.select('district', '1');
    const count = runtime.snapshot().levels.district.optionCount;
    runtime.clearSelection('district');
    expect(runtime.snapshot().levels.district.optionCount).toBe(count);
    expect(runtime.snapshot().path.district).toBeNull();
  });
});

describe('NumberingQueryRuntimeV11 effects', () => {
  it('focuses district geometry transiently', async () => {
    const focusGeometries = vi.fn(async () => undefined);
    const runtime = createNumberingQueryRuntimeV11(transport(), {
      focusGeometries,
    });
    await runtime.initialize();
    await runtime.select('district', '1');
    expect(focusGeometries).toHaveBeenCalled();
    expect(focusGeometries.mock.calls[0]?.[1]).toMatchObject({
      level: 'district',
      zoomLevel: null,
    });
  });

  it('focuses door geometry at building zoom', async () => {
    const focusGeometries = vi.fn(async () => undefined);
    const runtime = createNumberingQueryRuntimeV11(transport(), {
      focusGeometries,
    });
    await runtime.initialize();
    await runtime.select('district', '1');
    await runtime.select('neighborhood', '10');
    await runtime.select('street', '20');
    await runtime.select('door', '30');
    const doorCall = focusGeometries.mock.calls.find(call => call[1].level === 'door');
    expect(doorCall?.[1].zoomLevel).toBe(18);
  });

  it('logs completed door selection without blocking result', async () => {
    const logSelection = vi.fn(async () => undefined);
    const runtime = createNumberingQueryRuntimeV11(transport(), {
      logSelection,
    });
    await runtime.initialize();
    await runtime.select('district', '1');
    await runtime.select('neighborhood', '10');
    await runtime.select('street', '20');
    await runtime.select('door', '30');
    expect(logSelection).toHaveBeenCalledTimes(1);
    expect(logSelection.mock.calls[0]?.[0].door?.label).toBe('10');
  });

  it('isolates logging failure', async () => {
    const runtime = createNumberingQueryRuntimeV11(transport(), {
      logSelection: async () => {
        throw new Error('log unavailable');
      },
    });
    await runtime.initialize();
    await runtime.select('district', '1');
    await runtime.select('neighborhood', '10');
    await runtime.select('street', '20');
    await expect(runtime.select('door', '30')).resolves.toBeUndefined();
    expect(runtime.snapshot().complete).toBe(true);
  });

  it('isolates focus failure from selected path', async () => {
    const reportError = vi.fn();
    const runtime = createNumberingQueryRuntimeV11(transport(), {
      focusGeometries: async () => {
        throw new Error('map unavailable');
      },
      reportError,
    });
    await runtime.initialize();
    await runtime.select('district', '1');
    expect(runtime.snapshot().path.district?.value).toBe('1');
    expect(reportError).toHaveBeenCalled();
  });
});

describe('NumberingQueryRuntimeV11 filtering and budgets', () => {
  it('filters options with Turkish normalization', async () => {
    const runtime = createNumberingQueryRuntimeV11(transport(), {}, {
      maxVisibleOptions: 20,
    });
    await runtime.initialize();
    runtime.setFilter('district', 'cank');
    expect(runtime.snapshot().levels.district.options.map(option => option.label))
      .toEqual(['Çankaya']);
  });

  it('bounds visible options for large lists', async () => {
    const many = Array.from({ length: 500 }, (_, index) =>
      feature({ id: index + 1, ad: `İlçe ${index + 1}` }));
    const runtime = createNumberingQueryRuntimeV11(transport({
      loadDistricts: async () => success(many),
    }), {}, {
      maxVisibleOptions: 40,
      minimumFilterLengthForOverflow: 0,
    });
    await runtime.initialize();
    expect(runtime.snapshot().levels.district.optionCount).toBe(500);
    expect(runtime.snapshot().levels.district.visibleOptionCount).toBe(40);
    expect(runtime.snapshot().levels.district.truncated).toBe(true);
  });

  it('requires filter before exposing oversized list when configured', async () => {
    const many = Array.from({ length: 500 }, (_, index) =>
      feature({ id: index + 1, ad: `Mahalle ${index + 1}` }));
    const runtime = createNumberingQueryRuntimeV11(transport({
      loadDistricts: async () => success(many),
    }), {}, {
      maxVisibleOptions: 40,
      minimumFilterLengthForOverflow: 2,
    });
    await runtime.initialize();
    expect(runtime.snapshot().levels.district.visibleOptionCount).toBe(0);
    runtime.setFilter('district', 'mahalle 49');
    expect(runtime.snapshot().levels.district.visibleOptionCount).toBeGreaterThan(0);
  });

  it('hard bounds retained options and records truncation metric', async () => {
    const many = Array.from({ length: 1_000 }, (_, index) =>
      feature({ id: index + 1, ad: `İlçe ${index + 1}` }));
    const runtime = createNumberingQueryRuntimeV11(transport({
      loadDistricts: async () => success(many),
    }), {}, {
      maxOptionsPerLevel: 250,
      minimumFilterLengthForOverflow: 0,
    });
    await runtime.initialize();
    expect(runtime.snapshot().levels.district.optionCount).toBe(250);
    expect(runtime.snapshot().metrics.optionTruncations).toBe(1);
  });

  it('bounds filter text length', async () => {
    const runtime = createNumberingQueryRuntimeV11(transport(), {}, {
      maxFilterLength: 32,
    });
    await runtime.initialize();
    runtime.setFilter('district', 'x'.repeat(200));
    expect(runtime.snapshot().levels.district.filter).toHaveLength(32);
  });
});

describe('NumberingQueryRuntimeV11 stale response safety', () => {
  it('does not let an older district response overwrite a newer selection', async () => {
    const firstNeighborhoods = deferred<NumberingServiceResultV11>();
    const secondNeighborhoods = deferred<NumberingServiceResultV11>();
    const runtime = createNumberingQueryRuntimeV11(transport({
      loadNeighborhoods: id => id === '1'
        ? firstNeighborhoods.promise
        : secondNeighborhoods.promise,
      loadDistrict: async () => success([]),
    }));
    await runtime.initialize();

    const first = runtime.select('district', '1');
    const second = runtime.select('district', '2');

    secondNeighborhoods.resolve(success([
      feature({ id: 200, ad: 'Yeni Mahalle' }),
    ]));
    await second;

    firstNeighborhoods.resolve(success([
      feature({ id: 100, ad: 'Eski Mahalle' }),
    ]));
    await first;

    expect(runtime.snapshot().path.district?.value).toBe('2');
    expect(runtime.snapshot().levels.neighborhood.options.map(option => option.label))
      .toEqual(['Yeni Mahalle']);
    expect(runtime.snapshot().metrics.staleResponses).toBeGreaterThanOrEqual(1);
  });

  it('does not let old street response restore cleared doors', async () => {
    const firstDoors = deferred<NumberingServiceResultV11>();
    const runtime = createNumberingQueryRuntimeV11(transport({
      loadDoors: id => id === '20' ? firstDoors.promise : Promise.resolve(success(doors)),
    }));
    await runtime.initialize();
    await runtime.select('district', '1');
    await runtime.select('neighborhood', '10');

    const first = runtime.select('street', '20');
    const second = runtime.select('street', '21');
    await second;
    expect(runtime.snapshot().path.street?.value).toBe('21');

    firstDoors.resolve(success([
      feature({ id: 999, kapino: 'Eski' }),
    ]));
    await first;

    expect(runtime.snapshot().path.street?.value).toBe('21');
    expect(runtime.snapshot().levels.door.options.some(option => option.value === '999'))
      .toBe(false);
  });

  it('ignores initialization response after disposal', async () => {
    const pending = deferred<NumberingServiceResultV11>();
    const runtime = createNumberingQueryRuntimeV11(transport({
      loadDistricts: () => pending.promise,
    }));
    const initialize = runtime.initialize();
    runtime.dispose();
    pending.resolve(success(districts));
    await initialize;
    expect(runtime.snapshot().disposed).toBe(true);
    expect(runtime.snapshot().levels.district.optionCount).toBe(0);
  });
});

describe('NumberingQueryRuntimeV11 observers', () => {
  it('notifies subscribed observer', async () => {
    const runtime = createNumberingQueryRuntimeV11(transport());
    const observer = vi.fn();
    const unsubscribe = runtime.subscribe(observer);
    await runtime.initialize();
    expect(observer).toHaveBeenCalled();
    unsubscribe();
  });

  it('does not notify after unsubscribe', async () => {
    const runtime = createNumberingQueryRuntimeV11(transport());
    const observer = vi.fn();
    const unsubscribe = runtime.subscribe(observer);
    unsubscribe();
    await runtime.initialize();
    expect(observer).not.toHaveBeenCalled();
  });

  it('deduplicates same observer subscription', () => {
    const runtime = createNumberingQueryRuntimeV11(transport(), {}, {
      maxObservers: 1,
    });
    const observer = vi.fn();
    expect(() => runtime.subscribe(observer)).not.toThrow();
    expect(() => runtime.subscribe(observer)).not.toThrow();
  });

  it('enforces observer capacity', () => {
    const runtime = createNumberingQueryRuntimeV11(transport(), {}, {
      maxObservers: 1,
    });
    runtime.subscribe(() => undefined);
    expect(() => runtime.subscribe(() => undefined)).toThrow(/observer limit/i);
  });

  it('isolates observer failure and reports it', async () => {
    const reportObserverError = vi.fn();
    const runtime = createNumberingQueryRuntimeV11(transport(), {
      reportObserverError,
    });
    runtime.subscribe(() => {
      throw new Error('observer failed');
    });
    await expect(runtime.initialize()).resolves.toBeUndefined();
    expect(runtime.snapshot().metrics.observerFailures).toBeGreaterThan(0);
    expect(reportObserverError).toHaveBeenCalled();
  });
});

describe('NumberingQueryRuntimeV11 history and reset', () => {
  it('records bounded request history', async () => {
    const runtime = createNumberingQueryRuntimeV11(transport(), {}, {
      maxHistory: 3,
    });
    await runtime.initialize();
    await runtime.select('district', '1');
    await runtime.select('neighborhood', '10');
    await runtime.select('street', '20');
    expect(runtime.snapshot().history.length).toBeLessThanOrEqual(3);
  });

  it('records success metrics', async () => {
    const runtime = createNumberingQueryRuntimeV11(transport());
    await runtime.initialize();
    await runtime.select('district', '1');
    expect(runtime.snapshot().metrics.requests).toBeGreaterThanOrEqual(2);
    expect(runtime.snapshot().metrics.successes).toBeGreaterThanOrEqual(2);
  });

  it('reset clears path and dependent option lists', async () => {
    const runtime = createNumberingQueryRuntimeV11(transport());
    await runtime.initialize();
    await runtime.select('district', '1');
    await runtime.select('neighborhood', '10');
    runtime.reset();
    expect(runtime.snapshot().path.district).toBeNull();
    expect(runtime.snapshot().path.neighborhood).toBeNull();
    expect(runtime.snapshot().levels.neighborhood.optionCount).toBe(0);
    expect(runtime.snapshot().levels.district.optionCount).toBe(3);
  });

  it('reset clears filters', async () => {
    const runtime = createNumberingQueryRuntimeV11(transport());
    await runtime.initialize();
    runtime.setFilter('district', 'can');
    runtime.reset();
    expect(runtime.snapshot().levels.district.filter).toBe('');
  });

  it('dispose releases options and history', async () => {
    const runtime = createNumberingQueryRuntimeV11(transport());
    await runtime.initialize();
    await runtime.select('district', '1');
    expect(runtime.snapshot().history.length).toBeGreaterThan(0);
    runtime.dispose();
    expect(runtime.snapshot().disposed).toBe(true);
    expect(runtime.snapshot().history).toEqual([]);
    expect(runtime.snapshot().levels.district.optionCount).toBe(0);
  });

  it('rejects mutation after dispose', () => {
    const runtime = createNumberingQueryRuntimeV11(transport());
    runtime.dispose();
    expect(() => runtime.setFilter('district', 'a')).toThrow(/disposed/i);
    expect(() => runtime.reset()).toThrow(/disposed/i);
  });
});
