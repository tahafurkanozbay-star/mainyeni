import { afterEach, describe, expect, test } from 'vitest';
import Store from '../Store';
import { DynamicLayerManager } from './DynamicLayerManager';

const reset = (): void => DynamicLayerManager.Clear();

afterEach(reset);

describe('typed DynamicLayerManager', () => {
  test('adds a non-null layer and exposes immutable reducer list', () => {
    const layer = { id: 'parks' };
    expect(DynamicLayerManager.Add(layer)).toBe(true);
    expect(DynamicLayerManager.GetLayers()).toEqual([layer]);
    expect(Object.isFrozen(Store.getState().DynamicLayers.List)).toBe(true);
  });

  test('rejects null-like layers', () => {
    expect(DynamicLayerManager.Add(null)).toBe(false);
    expect(DynamicLayerManager.Add(undefined)).toBe(false);
    expect(DynamicLayerManager.GetLayers()).toEqual([]);
  });

  test('removes by layer identity instead of accidentally treating object as splice index', () => {
    const first = { id: 'first' };
    const second = { id: 'second' };
    DynamicLayerManager.Add(first);
    DynamicLayerManager.Add(second);

    expect(DynamicLayerManager.Remove(first)).toBe(true);
    expect(DynamicLayerManager.GetLayers()).toEqual([second]);
    expect(DynamicLayerManager.Remove(first)).toBe(false);
  });

  test('retains backwards-compatible remove-by-index support', () => {
    const first = { id: 'first' };
    const second = { id: 'second' };
    DynamicLayerManager.Replace([first, second]);

    expect(DynamicLayerManager.Remove(1)).toBe(true);
    expect(DynamicLayerManager.GetLayers()).toEqual([first]);
    expect(DynamicLayerManager.Remove(9)).toBe(false);
    expect(DynamicLayerManager.Remove(-1)).toBe(false);
  });

  test('replaces list without retaining mutable input array', () => {
    const source = [{ id: 'a' }];
    DynamicLayerManager.Replace(source);
    source.push({ id: 'b' });
    expect(DynamicLayerManager.GetLayers()).toEqual([{ id: 'a' }]);
  });

  test('clears all dynamic layers', () => {
    DynamicLayerManager.Replace([{ id: 'a' }, { id: 'b' }]);
    DynamicLayerManager.Clear();
    expect(DynamicLayerManager.GetLayers()).toEqual([]);
  });
});
