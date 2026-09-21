import { describe, expect, it } from 'vitest';
import type { RootState } from '../contracts';
import { createStoreSelectorRegistry } from './stateSelectorRegistry';

const state: RootState = {
  Common: {
    BigPopupLinkRef: null,
    WindowList: [],
    ModuleSelectBarVisible: true,
    MapConfiguration: null,
    ConfigurationServices: [],
    Message: null,
  },
  Map: {
    MapView: null,
    IsUpdating: false,
    Graphics: [1, 2],
    MapClick: () => undefined,
    MobileRightClickEnabled: false,
  },
  ContextMenu: { ActiveOnLeftClick: false },
  DynamicLayers: { List: [] },
};

describe('stateSelectorRegistry', () => {
  it('registers, lists, selects and unregisters named selectors', () => {
    const registry = createStoreSelectorRegistry();
    const unregister = registry.register(
      'map.graphicsCount',
      (root) => root.Map.Graphics.length,
      'Count map graphics',
    );
    expect(registry.list()).toEqual([{
      name: 'map.graphicsCount',
      description: 'Count map graphics',
    }]);
    expect(registry.select<number>('map.graphicsCount', state)).toBe(2);
    unregister();
    expect(registry.size).toBe(0);
  });

  it('sorts selector metadata deterministically', () => {
    const registry = createStoreSelectorRegistry();
    registry.register('z', (root) => root.Map.IsUpdating);
    registry.register('a', (root) => root.Common.ModuleSelectBarVisible);
    expect(registry.list().map((item) => item.name)).toEqual(['a', 'z']);
  });

  it('rejects duplicate and missing selector names', () => {
    const registry = createStoreSelectorRegistry();
    registry.register('x', (root) => root.Map.IsUpdating);
    expect(() => registry.register('x', (root) => root.Map.IsUpdating))
      .toThrow(/already registered/);
    expect(() => registry.select('missing', state))
      .toThrow(/not registered/);
  });

  it('enforces bounded registry capacity', () => {
    const registry = createStoreSelectorRegistry(1);
    registry.register('x', (root) => root.Map.IsUpdating);
    expect(() => registry.register('y', (root) => root.Map.Graphics.length))
      .toThrow(/capacity/);
  });

  it('supports clearing all registered selectors', () => {
    const registry = createStoreSelectorRegistry();
    registry.register('x', (root) => root.Map.IsUpdating);
    registry.register('y', (root) => root.Map.Graphics.length);
    expect(registry.clear()).toBe(2);
    expect(registry.list()).toEqual([]);
  });
});
