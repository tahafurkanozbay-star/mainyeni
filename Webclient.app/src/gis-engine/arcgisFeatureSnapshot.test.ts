import { describe, expect, it } from 'vitest';
import {
  ArcGisFeatureSnapshotError,
  ArcGisFeatureSnapshotSession,
  readArcGisOwnDataProperty,
  type ArcGisFeatureSnapshotBudget,
  snapshotArcGisFeatures,
} from './arcgisFeatureSnapshot';

const feature = (OBJECTID: number, label = 'parcel') => ({
  attributes: { OBJECTID, label, nested: { owner: 'ABB' } },
  geometry: { x: 32.8, y: 39.9, spatialReference: { wkid: 4326 } },
});

describe('ArcGIS bounded feature snapshot session', () => {
  it('deep-copies and freezes feature attributes, geometry and nested values', () => {
    const source = feature(1, 'before');
    const [captured] = snapshotArcGisFeatures<typeof source>([source]);
    source.attributes.label = 'after';
    source.attributes.nested.owner = 'changed';
    source.geometry.x = 999;
    expect(captured?.attributes.label).toBe('before');
    expect(captured?.attributes.nested.owner).toBe('ABB');
    expect(captured?.geometry.x).toBe(32.8);
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(captured?.attributes)).toBe(true);
    expect(Object.isFrozen(captured?.attributes.nested)).toBe(true);
    expect(Object.isFrozen(captured?.geometry)).toBe(true);
    expect(Object.isFrozen(captured?.geometry.spatialReference)).toBe(true);
  });

  it('preserves an own __proto__ data field without changing prototypes', () => {
    const source = JSON.parse('{"attributes":{"OBJECTID":2,"__proto__":{"polluted":true}}}') as object;
    const [captured] = snapshotArcGisFeatures<Record<string, unknown>>([source]);
    const attributes = captured?.attributes as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(attributes, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(attributes)).toBe(Object.prototype);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('never executes an accessor in attributes', () => {
    let calls = 0;
    const attributes: Record<string, unknown> = { OBJECTID: 1 };
    Object.defineProperty(attributes, 'privateValue', {
      enumerable: true,
      get() { calls += 1; throw new Error('getter must not execute'); },
    });
    expect(() => snapshotArcGisFeatures([{ attributes }])).toThrow(/non-data property|accessor/i);
    expect(calls).toBe(0);
  });

  it('never executes an accessor on a feature root', () => {
    let calls = 0;
    const input = { attributes: { OBJECTID: 1 } };
    Object.defineProperty(input, 'geometry', {
      enumerable: true,
      get() { calls += 1; return { x: 1, y: 2 }; },
    });
    expect(() => snapshotArcGisFeatures([input])).toThrow(/non-data property|accessor/i);
    expect(calls).toBe(0);
  });

  it('rejects accessor-backed feature-array indexes without invoking them', () => {
    let calls = 0;
    const features: object[] = [];
    Object.defineProperty(features, '0', {
      enumerable: true,
      configurable: true,
      get() { calls += 1; throw new Error('array getter must not execute'); },
    });
    features.length = 1;
    expect(() => snapshotArcGisFeatures(features)).toThrow(/accessor-backed feature array/);
    expect(calls).toBe(0);
  });

  it('rejects sparse feature arrays and sparse nested geometry arrays', () => {
    const sparse: object[] = [];
    sparse.length = 1;
    expect(() => snapshotArcGisFeatures(sparse)).toThrow(/sparse|accessor-backed/);
    const coordinates: number[] = [];
    coordinates.length = 2;
    const session = new ArcGisFeatureSnapshotSession();
    expect(() => session.capturePage([{ attributes: { OBJECTID: 1 }, geometry: { paths: [coordinates] } }])).toThrow(/sparse/);
    expect(session.snapshot()).toMatchObject({ pages: 0, features: 0, nodes: 0, estimatedBytes: 0 });
  });

  it('rejects arrays with extra own properties rather than silently dropping them', () => {
    const values = [{ attributes: { OBJECTID: 1 } }] as unknown[] & { metadata?: string };
    values.metadata = 'unexpected';
    expect(() => snapshotArcGisFeatures(values)).toThrow(/extended array/);
  });

  it('ignores inherited fields and accepts null-prototype JSON-like records', () => {
    const attributes = Object.assign(Object.create(null) as Record<string, unknown>, { OBJECTID: 7 });
    const source = Object.assign(Object.create(null) as Record<string, unknown>, { attributes });
    const [captured] = snapshotArcGisFeatures<Record<string, unknown>>([source]);
    expect(captured?.attributes).toEqual({ OBJECTID: 7 });
    const inherited = Object.create({ attributes: { OBJECTID: 8 } }) as object;
    expect(() => snapshotArcGisFeatures([inherited])).toThrow(/non-plain object/);
  });

  it('rejects class instances and host objects instead of retaining their prototypes', () => {
    class FeatureValue { value = 1; }
    expect(() => snapshotArcGisFeatures([{ attributes: { OBJECTID: 1 }, extra: new FeatureValue() }])).toThrow(/non-plain object/);
    expect(() => snapshotArcGisFeatures([{ attributes: { OBJECTID: 1 }, extra: new Date(0) }])).toThrow(/non-plain object/);
  });

  it('rejects cyclic and aliased object graphs', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => snapshotArcGisFeatures([{ attributes: { OBJECTID: 1 }, geometry: cyclic }])).toThrow(/cyclic or aliased/);
    const shared = { x: 1 };
    expect(() => snapshotArcGisFeatures([{ attributes: { OBJECTID: 2 }, geometry: { left: shared, right: shared } }])).toThrow(/cyclic or aliased/);
  });

  it('rejects object aliases that reappear across pages of the same query', () => {
    const session = new ArcGisFeatureSnapshotSession();
    const shared = { x: 1, y: 2 };
    session.capturePage([{ attributes: { OBJECTID: 1 }, geometry: shared }]);
    expect(() => session.capturePage([{ attributes: { OBJECTID: 2 }, geometry: shared }])).toThrow(/cyclic or aliased/);
    expect(session.snapshot()).toMatchObject({ pages: 1, features: 1 });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects non-finite numbers (%s) before retaining a page',
    (value) => {
      const session = new ArcGisFeatureSnapshotSession();
      expect(() => session.capturePage([{ attributes: { OBJECTID: 1 }, geometry: { x: value } }])).toThrow(/non-finite number/);
      expect(session.snapshot().features).toBe(0);
    },
  );

  it('rejects functions, symbols and bigint values in transport payloads', () => {
    expect(() => snapshotArcGisFeatures([{ attributes: { OBJECTID: 1, callback: () => undefined } }])).toThrow(/unsupported value/);
    expect(() => snapshotArcGisFeatures([{ attributes: { OBJECTID: 1, symbol: Symbol('x') } }])).toThrow(/unsupported value/);
    expect(() => snapshotArcGisFeatures([{ attributes: { OBJECTID: 1, large: 1n } }])).toThrow(/unsupported value/);
  });

  it('enforces string and property-key limits before creating retained copies', () => {
    expect(() => snapshotArcGisFeatures([{ attributes: { OBJECTID: 1, label: 'x'.repeat(9) } }], { maxStringLength: 8 })).toThrow(/string exceeds/);
    const attrs: Record<string, unknown> = { OBJECTID: 1 };
    attrs['x'.repeat(9)] = 'ok';
    expect(() => snapshotArcGisFeatures([{ attributes: attrs }], { maxKeyLength: 8 })).toThrow(/invalid property key/);
  });

  it('rejects control characters in JSON property names', () => {
    const attributes: Record<string, unknown> = { OBJECTID: 1 };
    attributes['bad\nkey'] = true;
    expect(() => snapshotArcGisFeatures([{ attributes }])).toThrow(/invalid property key/);
  });

  it('enforces nesting depth without overflowing the JavaScript stack', () => {
    let nested: Record<string, unknown> = { value: 1 };
    for (let index = 0; index < 8; index += 1) nested = { child: nested };
    expect(() => snapshotArcGisFeatures([{ attributes: { OBJECTID: 1 }, geometry: nested }], { maxDepth: 5 })).toThrow(/nesting exceeds/);
  });

  it('enforces per-feature node limits', () => {
    const session = new ArcGisFeatureSnapshotSession({
      maxNodesPerFeature: 8, maxNodesPerQuery: 16,
    });
    expect(() => session.capturePage([{ attributes: { OBJECTID: 1, a: 1, b: 2 } }])).toThrow(/node budget/);
    expect(session.snapshot()).toMatchObject({ pages: 0, features: 0, nodes: 0 });
  });

  it('enforces aggregate node limits across otherwise valid pages', () => {
    const session = new ArcGisFeatureSnapshotSession({
      maxNodesPerFeature: 8, maxNodesPerQuery: 8,
    });
    session.capturePage([{ attributes: { OBJECTID: 1 } }]);
    expect(() => session.capturePage([{ attributes: { OBJECTID: 2 } }])).toThrow(/node budget/);
    expect(session.snapshot().pages).toBe(1);
    expect(session.snapshot().features).toBe(1);
  });

  it('enforces per-feature byte limits', () => {
    const session = new ArcGisFeatureSnapshotSession({
      maxBytesPerFeature: 96, maxBytesPerQuery: 512,
    });
    expect(() => session.capturePage([{ attributes: { OBJECTID: 1, label: 'x'.repeat(50) } }])).toThrow(/byte budget/);
    expect(session.snapshot().features).toBe(0);
  });

  it('enforces aggregate byte limits across otherwise valid pages', () => {
    const session = new ArcGisFeatureSnapshotSession({
      maxBytesPerFeature: 128, maxBytesPerQuery: 150,
    });
    session.capturePage([{ attributes: { OBJECTID: 1 } }]);
    expect(() => session.capturePage([{ attributes: { OBJECTID: 2 } }])).toThrow(/byte budget/);
    expect(session.snapshot()).toMatchObject({ pages: 1, features: 1 });
  });

  it('bounds total features and only truncates when explicitly requested', () => {
    const session = new ArcGisFeatureSnapshotSession({ maxFeatures: 2 });
    expect(() => session.capturePage([feature(1), feature(2), feature(3)])).toThrow(/feature limit/);
    expect(session.snapshot().features).toBe(0);
    const page = session.capturePage([feature(1), feature(2), feature(3)], 2, true);
    expect(page.features).toHaveLength(2);
    expect(page.truncated).toBe(true);
    expect(session.snapshot().features).toBe(2);
  });

  it('does not inspect discarded overflow features when truncation is explicitly enabled', () => {
    let calls = 0;
    const overflow = { attributes: { OBJECTID: 3 } };
    Object.defineProperty(overflow, 'danger', { enumerable: true, get() { calls += 1; throw new Error('must not run'); } });
    const page = new ArcGisFeatureSnapshotSession({ maxFeatures: 1 }).capturePage(
      [{ attributes: { OBJECTID: 1 } }, overflow], 1, true,
    );
    expect(page.features).toHaveLength(1);
    expect(page.truncated).toBe(true);
    expect(calls).toBe(0);
  });

  it('enforces page-count limits', () => {
    const session = new ArcGisFeatureSnapshotSession({ maxPages: 1 });
    session.capturePage([]);
    expect(() => session.capturePage([])).toThrow(/page budget/);
    expect(session.snapshot().pages).toBe(1);
  });

  it('rolls back all page accounting and object ownership when any feature fails', () => {
    const session = new ArcGisFeatureSnapshotSession();
    const first = { attributes: { OBJECTID: 1 }, geometry: { x: 1, y: 2 } };
    const malformed = { attributes: { OBJECTID: 2, amount: Number.NaN } };
    expect(() => session.capturePage([first, malformed])).toThrow(/non-finite number/);
    expect(session.snapshot()).toEqual({ pages: 0, features: 0, nodes: 0, estimatedBytes: 0 });
    expect(session.capturePage([first]).featureCount).toBe(1);
  });

  it('converts throwing proxy traps into a safe bounded error', () => {
    const proxy = new Proxy({ attributes: { OBJECTID: 1 } }, {
      ownKeys() { throw new Error('secret payload detail'); },
    });
    let thrown: unknown;
    try {
      snapshotArcGisFeatures([proxy]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ArcGisFeatureSnapshotError);
    expect(thrown).toMatchObject({ code: 'UNSAFE_OBJECT' });
    expect((thrown as Error).message).not.toContain('secret payload detail');
  });

  it('reads only own data properties and never executes response envelope getters', () => {
    let calls = 0;
    const response = { features: [] as unknown[] };
    Object.defineProperty(response, 'error', {
      enumerable: true,
      get() { calls += 1; return { message: 'hidden' }; },
    });
    expect(() => readArcGisOwnDataProperty(response, 'error')).toThrow(/non-data property/);
    expect(readArcGisOwnDataProperty(response, 'features')).toMatchObject({ found: true, value: [] });
    expect(readArcGisOwnDataProperty(response, 'missing')).toMatchObject({ found: false, value: undefined });
    expect(calls).toBe(0);
  });

  it('rejects symbol and non-enumerable fields that JSON serialization would silently omit', () => {
    const attributes: Record<string, unknown> = { OBJECTID: 1 };
    Object.defineProperty(attributes, 'hidden', { value: true, enumerable: false });
    expect(() => snapshotArcGisFeatures([{ attributes }])).toThrow(/non-data property/);
    const withSymbol = { attributes: { OBJECTID: 1 }, [Symbol('hidden')]: true };
    expect(() => snapshotArcGisFeatures([withSymbol])).toThrow(/invalid property key/);
  });

  it('does not execute accessor-backed runtime budget options', () => {
    let calls = 0;
    const budget: Record<string, unknown> = {};
    Object.defineProperty(budget, 'maxFeatures', {
      enumerable: true,
      get() { calls += 1; throw new Error('budget getter must not execute'); },
    });
    expect(() => new ArcGisFeatureSnapshotSession(budget as unknown as Partial<ArcGisFeatureSnapshotBudget>)).toThrow(/plain data properties/);
    expect(calls).toBe(0);
  });

  it('rejects misspelled budget fields instead of silently ignoring configuration', () => {
    expect(() => new ArcGisFeatureSnapshotSession({
      maxFeature: 5,
    } as unknown as { maxFeatures?: number })).toThrow(/known plain data properties/);
  });

  it('sanitizes proxy failures when reading response envelope fields directly', () => {
    const response = new Proxy({ features: [] }, {
      getOwnPropertyDescriptor() { throw new Error('secret proxy payload'); },
    });
    let thrown: unknown;
    try {
      readArcGisOwnDataProperty(response, 'features');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ name: 'ArcGisFeatureSnapshotError', code: 'UNSAFE_OBJECT' });
    expect((thrown as Error).message).not.toContain('secret proxy payload');
  });
});
