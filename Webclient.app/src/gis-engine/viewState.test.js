import {
  clearSelection,
  createViewState,
  createViewStateBridge,
  fromShareableQuery,
  parseViewState,
  serializeViewState,
  switchViewMode,
  syncLayerSelection,
  toShareableQuery,
  updateCamera,
  updateExtent,
  updateSelection,
  viewStateEquals,
} from './viewState';

describe('viewState', () => {
  test('rejects malformed center coordinates instead of storing NaN', () => {
    expect(createViewState({ center: ['x', 39] }).center).toBeNull();
    expect(createViewState({ center: [32, undefined] }).center).toBeNull();
    expect(createViewState({ center: [32, 39] }).center).toEqual([32, 39]);
  });

  test('rejects malformed or reversed extents', () => {
    expect(createViewState({
      extent: { xmin: 10, ymin: 0, xmax: 1, ymax: 2 },
    }).extent).toBeNull();
    expect(createViewState({
      extent: { xmin: 0, ymin: 4, xmax: 1, ymax: 2 },
    }).extent).toBeNull();
  });

  test('normalizes an ArcGIS spatialReference wkid', () => {
    expect(createViewState({
      extent: {
        xmin: 0,
        ymin: 1,
        xmax: 2,
        ymax: 3,
        spatialReference: { wkid: '3857' },
      },
    }).extent).toEqual({
      xmin: 0,
      ymin: 1,
      xmax: 2,
      ymax: 3,
      wkid: 3857,
    });
  });

  test('keeps numeric object id zero as a valid selection', () => {
    expect(createViewState({ selectedObjectId: 0 }).selectedObjectId).toBe(0);
  });

  test('trims text identifiers and converts empty values to null', () => {
    expect(createViewState({
      basemapId: '  osm  ',
      selectedLayerId: '  parks ',
    })).toMatchObject({
      basemapId: 'osm',
      selectedLayerId: 'parks',
    });
    expect(createViewState({ basemapId: '   ', selectedLayerId: '' })).toMatchObject({
      basemapId: null,
      selectedLayerId: null,
    });
  });

  test('normalizes Date time values to ISO strings', () => {
    expect(createViewState({
      time: new Date('2026-09-16T00:00:00.000Z'),
    }).time).toBe('2026-09-16T00:00:00.000Z');
  });

  test('drops invalid Date values', () => {
    expect(createViewState({ time: new Date('invalid') }).time).toBeNull();
  });

  test('clamps heading and tilt to the shared contract', () => {
    expect(createViewState({ heading: 999, tilt: -5 })).toMatchObject({
      heading: 360,
      tilt: 0,
    });
    expect(createViewState({ heading: -999, tilt: 999 })).toMatchObject({
      heading: -360,
      tilt: 180,
    });
  });

  test('switchViewMode preserves camera and selection state', () => {
    const state = createViewState({
      center: [32, 39],
      zoom: 12,
      selectedLayerId: 'parks',
      selectedObjectId: 4,
    });

    expect(switchViewMode(state, '3d')).toMatchObject({
      mode: '3d',
      center: [32, 39],
      zoom: 12,
      selectedLayerId: 'parks',
      selectedObjectId: 4,
    });
  });

  test('updateSelection can explicitly clear only one selection field', () => {
    const state = createViewState({
      selectedLayerId: 'parks',
      selectedObjectId: 5,
    });

    expect(updateSelection(state, { objectId: null })).toMatchObject({
      selectedLayerId: 'parks',
      selectedObjectId: null,
    });
  });

  test('clearSelection clears layer and object together', () => {
    expect(clearSelection({
      selectedLayerId: 'parks',
      selectedObjectId: 5,
    })).toMatchObject({
      selectedLayerId: null,
      selectedObjectId: null,
    });
  });

  test('syncLayerSelection accepts a zero object id', () => {
    expect(syncLayerSelection({}, 'roads', 0)).toMatchObject({
      selectedLayerId: 'roads',
      selectedObjectId: 0,
    });
  });

  test('updateCamera preserves omitted values but allows explicit null', () => {
    const state = createViewState({
      center: [32, 39],
      zoom: 12,
      scale: 10000,
    });

    expect(updateCamera(state, { scale: null })).toMatchObject({
      center: [32, 39],
      zoom: 12,
      scale: null,
    });
  });

  test('updateExtent validates the incoming extent', () => {
    expect(updateExtent({}, {
      xmin: 0,
      ymin: 1,
      xmax: 2,
      ymax: 3,
      wkid: 4326,
    }).extent).toEqual({ xmin: 0, ymin: 1, xmax: 2, ymax: 3, wkid: 4326 });

    expect(updateExtent({}, {
      xmin: 5,
      ymin: 1,
      xmax: 2,
      ymax: 3,
    }).extent).toBeNull();
  });

  test('serializes and parses a stable normalized state', () => {
    const state = {
      mode: '3d',
      center: ['32.5', '39.5'],
      scale: '25000',
      heading: '20',
      tilt: '45',
      selectedObjectId: 0,
    };
    const serialized = serializeViewState(state);

    expect(parseViewState(serialized)).toEqual(createViewState(state));
  });

  test('parseViewState falls back safely on malformed JSON', () => {
    expect(parseViewState('{not-json')).toEqual(createViewState());
  });

  test('shareable query preserves a zero object id', () => {
    const query = toShareableQuery({
      mode: '2d',
      center: [32.85, 39.93],
      zoom: 12,
      selectedLayerId: 'parks',
      selectedObjectId: 0,
    });
    const params = new URLSearchParams(query);

    expect(params.get('o')).toBe('0');
    expect(fromShareableQuery(query)).toMatchObject({
      selectedLayerId: 'parks',
      selectedObjectId: '0',
    });
  });

  test('shareable query writes scale when zoom is not available', () => {
    const params = new URLSearchParams(toShareableQuery({
      mode: '3d',
      center: [32, 39],
      scale: 25000.4,
      tilt: 40,
    }));

    expect(params.get('s')).toBe('25000');
    expect(params.has('z')).toBe(false);
    expect(fromShareableQuery(params.toString())).toMatchObject({
      mode: '3d',
      scale: 25000,
      tilt: 40,
    });
  });

  test('shareable query prefers zoom over scale to avoid conflicting camera inputs', () => {
    const params = new URLSearchParams(toShareableQuery({
      zoom: 12,
      scale: 25000,
    }));

    expect(params.get('z')).toBe('12');
    expect(params.has('s')).toBe(false);
  });

  test('shareable query rounds camera values deterministically', () => {
    const params = new URLSearchParams(toShareableQuery({
      center: [32.851234567, 39.931234567],
      zoom: 12.3456,
      heading: 18.26,
      tilt: 47.44,
    }));

    expect(params.get('c')).toBe('32.851235,39.931235');
    expect(params.get('z')).toBe('12.35');
    expect(params.get('h')).toBe('18.3');
    expect(params.get('t')).toBe('47.4');
  });

  test('fromShareableQuery rejects malformed center input', () => {
    expect(fromShareableQuery('?c=foo,39&z=10').center).toBeNull();
    expect(fromShareableQuery('?c=32&z=10').center).toBeNull();
  });

  test('viewStateEquals compares normalized values', () => {
    expect(viewStateEquals(
      { center: ['32', '39'], zoom: '12' },
      { center: [32, 39], zoom: 12 },
    )).toBe(true);
  });

  test('viewStateEquals includes extent, selection and time', () => {
    const base = {
      extent: { xmin: 0, ymin: 0, xmax: 1, ymax: 1, wkid: 4326 },
      selectedLayerId: 'parks',
      selectedObjectId: 1,
      time: '2026-09-16',
    };

    expect(viewStateEquals(base, { ...base })).toBe(true);
    expect(viewStateEquals(base, { ...base, selectedObjectId: 2 })).toBe(false);
    expect(viewStateEquals(base, { ...base, time: '2026-09-17' })).toBe(false);
  });

  test('bridge suppresses no-op updates', () => {
    const bridge = createViewStateBridge({ center: [32, 39], zoom: 12 });
    const listener = jest.fn();
    bridge.subscribe(listener);

    bridge.setState({ center: ['32', '39'], zoom: '12' });

    expect(listener).not.toHaveBeenCalled();
  });

  test('bridge notifies subscribers for meaningful updates', () => {
    const bridge = createViewStateBridge({ zoom: 10 });
    const listener = jest.fn();
    bridge.subscribe(listener);

    const result = bridge.setState((state) => ({ ...state, zoom: 11 }));

    expect(result.zoom).toBe(11);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ zoom: 11 }));
  });

  test('bridge isolates listener exceptions so later listeners still run', () => {
    const onListenerError = jest.fn();
    const bridge = createViewStateBridge({}, { onListenerError });
    const healthy = jest.fn();
    bridge.subscribe(() => { throw new Error('listener failed'); });
    bridge.subscribe(healthy);

    bridge.setState({ zoom: 12 });

    expect(onListenerError).toHaveBeenCalledWith(expect.objectContaining({ message: 'listener failed' }));
    expect(healthy).toHaveBeenCalledTimes(1);
  });

  test('bridge can emit the current state during subscription', () => {
    const bridge = createViewStateBridge({ zoom: 8 }, { emitCurrent: true });
    const listener = jest.fn();

    bridge.subscribe(listener);

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ zoom: 8 }));
  });

  test('unsubscribe is idempotent and updates listener count', () => {
    const bridge = createViewStateBridge();
    const listener = jest.fn();
    const unsubscribe = bridge.subscribe(listener);

    expect(bridge.listenerCount()).toBe(1);
    unsubscribe();
    unsubscribe();
    expect(bridge.listenerCount()).toBe(0);
    bridge.setState({ zoom: 9 });
    expect(listener).not.toHaveBeenCalled();
  });

  test('destroy clears listeners and prevents new subscriptions', () => {
    const bridge = createViewStateBridge();
    const existing = jest.fn();
    bridge.subscribe(existing);

    bridge.destroy();
    const afterDestroy = jest.fn();
    const unsubscribe = bridge.subscribe(afterDestroy);
    bridge.setState({ zoom: 13 });
    unsubscribe();

    expect(bridge.isDestroyed()).toBe(true);
    expect(bridge.listenerCount()).toBe(0);
    expect(existing).not.toHaveBeenCalled();
    expect(afterDestroy).not.toHaveBeenCalled();
  });
});
