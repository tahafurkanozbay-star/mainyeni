import { afterEach, describe, expect, it } from 'vitest';
import Store from '../Store';
import { MapReducer } from '../Reducers/MapReducer';
import { MAP_ACTION_TYPES, initialMapState } from '../contracts';
import MapManager from './MapManager';
afterEach(() => { MapManager.SetMapClickEvent(null); Store.dispatch({ type: MAP_ACTION_TYPES.SetMapView, payload: null }); });
describe('real store map click selection contract', () => {
  it('makes the captured native point available to real managed map tools', () => {
    const point = { latitude: 39.92, longitude: 32.854 };
    MapManager.SetMapClickEvent({ x: 320, y: 210, mapPoint: point, native: { target: document.body } });
    expect(MapManager.GetMapClickEvent()).toEqual({ x: 320, y: 210, mapPoint: point });
    expect(typeof Store.getState().Map.MapClick).toBe('function');
    expect(Object.isFrozen(Store.getState().Map.LastMapClickEvent)).toBe(true);
    expect(Store.getState().Map.LastMapClickEvent).not.toHaveProperty('native');
  });
  it('preserves the legacy callback while a selection is captured and cleared', () => {
    const handler = () => undefined;
    const state = MapReducer(initialMapState, { type: MAP_ACTION_TYPES.SetMapClickEvent, payload: handler });
    const selected = MapReducer(state, { type: MAP_ACTION_TYPES.SetMapClickEvent, payload: { mapPoint: { x: 32, y: 39 } } });
    expect(selected.MapClick).toBe(handler); expect(selected.LastMapClickEvent?.mapPoint).toEqual({ x: 32, y: 39 });
    expect(MapReducer(selected, { type: MAP_ACTION_TYPES.SetMapClickEvent, payload: null }).MapClick).toBe(handler);
  });
  it('drops invalid pointer coordinates without discarding a valid map point', () => {
    const state = MapReducer(initialMapState, { type: MAP_ACTION_TYPES.SetMapClickEvent, payload: { x: Infinity, y: '12', mapPoint: { x: 32, y: 39 } } });
    expect(state.LastMapClickEvent).toEqual({ mapPoint: { x: 32, y: 39 } });
  });
  it.each(['bad', [], {}, { mapPoint: null }, { mapPoint: [] }])('does not change state for malformed click input %j', payload => {
    expect(MapReducer(initialMapState, { type: MAP_ACTION_TYPES.SetMapClickEvent, payload })).toBe(initialMapState);
  });
  it('retires the selected intent when its map view is replaced', () => {
    MapManager.SetMapClickEvent({ mapPoint: { latitude: 39, longitude: 32 } });
    Store.dispatch({ type: MAP_ACTION_TYPES.SetMapView, payload: { id: 'replacement' } });
    expect(Store.getState().Map.LastMapClickEvent).toBeNull(); expect(typeof MapManager.GetMapClickEvent()).toBe('function');
  });
  it('lets legacy callback registration replace an earlier click intent', () => {
    MapManager.SetMapClickEvent({ mapPoint: { latitude: 39, longitude: 32 } });
    const handler = () => undefined; MapManager.SetMapClickEvent(handler);
    expect(MapManager.GetMapClickEvent()).toBe(handler);
    expect(Store.getState().Map.LastMapClickEvent).toBeNull();
  });
  it('clears stale selections when a view is released even if the view was already null', () => {
    const selected = MapReducer(initialMapState, { type: MAP_ACTION_TYPES.SetMapClickEvent, payload: { mapPoint: { latitude: 39, longitude: 32 } } });
    expect(MapReducer(selected, { type: MAP_ACTION_TYPES.SetMapView, payload: null }).LastMapClickEvent).toBeNull();
  });
});
