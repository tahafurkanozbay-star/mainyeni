import { describe, expect, it } from 'vitest';
import type { RootState } from '../contracts';
import { projectStoreState, sanitizeStoreValue } from './stateProjection';

const state = (): RootState => ({
  Common: {
    BigPopupLinkRef: null,
    WindowList: [
      {
        id: 'search',
        title: 'Search',
        visible: true,
        minimized: false,
        ref: { current: { private: true } },
        component: () => null,
        query: {
          text: 'ankara',
          token: 'must-not-leak',
          nested: { password: 'hidden', allowed: 3 },
        },
      },
    ],
    ModuleSelectBarVisible: true,
    MapConfiguration: {
      theme: 'dark',
      apiKey: 'redacted',
      nested: { enabled: true },
    },
    ConfigurationServices: [
      { title: 'Buildings', url: '/arcgis/rest/services/buildings/MapServer/0' },
    ],
    Message: { messageType: 2, messageText: 'Ready' },
  },
  Map: {
    MapView: { huge: true },
    IsUpdating: false,
    Graphics: [{ id: 1 }, { id: 2 }],
    MapClick: () => undefined,
    MobileRightClickEnabled: true,
  },
  ContextMenu: { ActiveOnLeftClick: false },
  DynamicLayers: { List: [{ id: 1 }] },
});

describe('stateProjection', () => {
  it('projects state without retaining map views, callbacks, DOM refs or secrets', () => {
    const projection = projectStoreState(state(), {}, 100);
    expect(projection.generatedAt).toBe(100);
    expect(projection.common.windows[0]).toMatchObject({
      id: 'search',
      visible: true,
      minimized: false,
      query: {
        text: 'ankara',
        nested: { allowed: 3 },
      },
    });
    expect(JSON.stringify(projection)).not.toContain('must-not-leak');
    expect(JSON.stringify(projection)).not.toContain('hidden');
    expect(JSON.stringify(projection)).not.toContain('apiKey');
    expect(JSON.stringify(projection)).not.toContain('private');
    expect(projection.map).toEqual({
      isUpdating: false,
      mobileRightClickEnabled: true,
      graphicsCount: 2,
      hasMapView: true,
      hasMapClickHandler: true,
    });
  });

  it('bounds nested projection depth and entries deterministically', () => {
    const input = {
      a: { b: { c: { d: 1 } } },
      x: [1, 2, 3, 4, 5],
    };
    const result = sanitizeStoreValue(input, {
      maxProjectionDepth: 2,
      maxProjectionEntries: 4,
    });
    expect(result.truncated).toBe(true);
    expect(result.entries).toBeLessThanOrEqual(4);
  });

  it('normalizes non-finite numbers and unsupported values out of snapshots', () => {
    const result = sanitizeStoreValue({
      finite: 2,
      nan: Number.NaN,
      infinity: Number.POSITIVE_INFINITY,
      fn: () => undefined,
      symbol: Symbol('x'),
    });
    expect(result.value).toEqual({ finite: 2 });
  });

  it('breaks circular references without throwing', () => {
    const value: Record<string, unknown> = { ok: true };
    value.self = value;
    const result = sanitizeStoreValue(value);
    expect(result.value).toEqual({ ok: true });
    expect(result.truncated).toBe(true);
  });

  it('caps windows and services by runtime limits', () => {
    const root = state();
    const windows = Array.from({ length: 5 }, (_, index) => ({
      id: 'window-' + index,
      visible: false,
    }));
    const services = Array.from({ length: 5 }, (_, index) => ({
      title: 'service-' + index,
      url: '/service/' + index,
    }));
    const projection = projectStoreState({
      ...root,
      Common: { ...root.Common, WindowList: windows, ConfigurationServices: services },
    }, {
      maxWindows: 2,
      maxServices: 3,
    });
    expect(projection.common.windows).toHaveLength(2);
    expect(projection.common.services).toHaveLength(3);
  });
});
