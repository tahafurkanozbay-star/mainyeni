import { describe, expect, it } from 'vitest';
import type { StoreStateProjection } from './contracts';
import { storeProjectionToSafeValue } from './stateProjectionValue';

const projection = (): StoreStateProjection => ({
  schemaVersion: 1,
  generatedAt: 123,
  common: {
    moduleSelectBarVisible: true,
    windows: [{
      id: 'search',
      title: 'Search',
      visible: true,
      minimized: false,
      order: 2,
      lazy: false,
      query: { text: 'ankara' },
    }],
    mapConfiguration: { theme: 'dark' },
    services: [{
      key: 'buildings',
      title: 'Buildings',
      url: '/services/buildings',
      type: 'feature',
    }],
    message: { type: 1, text: 'Ready' },
  },
  map: {
    isUpdating: false,
    mobileRightClickEnabled: true,
    graphicsCount: 3,
    hasMapView: true,
    hasMapClickHandler: true,
  },
  contextMenu: { activeOnLeftClick: false },
  dynamicLayers: { count: 4 },
});

describe('stateProjectionValue', () => {
  it('materializes the typed projection as canonical JSON-safe records', () => {
    expect(storeProjectionToSafeValue(projection())).toEqual({
      schemaVersion: 1,
      common: {
        moduleSelectBarVisible: true,
        windows: [{
          id: 'search',
          title: 'Search',
          visible: true,
          minimized: false,
          order: 2,
          lazy: false,
          query: { text: 'ankara' },
        }],
        mapConfiguration: { theme: 'dark' },
        services: [{
          key: 'buildings',
          title: 'Buildings',
          url: '/services/buildings',
          type: 'feature',
        }],
        message: { type: 1, text: 'Ready' },
      },
      map: {
        isUpdating: false,
        mobileRightClickEnabled: true,
        graphicsCount: 3,
        hasMapView: true,
        hasMapClickHandler: true,
      },
      contextMenu: { activeOnLeftClick: false },
      dynamicLayers: { count: 4 },
    });
  });

  it('intentionally excludes generatedAt from canonical state identity', () => {
    expect(JSON.stringify(storeProjectionToSafeValue(projection())))
      .not.toContain('generatedAt');
  });

  it('preserves null-compatible optional projection values', () => {
    const source = projection();
    const value = storeProjectionToSafeValue({
      ...source,
      common: {
        ...source.common,
        message: null,
        mapConfiguration: null,
        windows: [{
          ...source.common.windows[0]!,
          title: null,
          order: null,
          query: null,
        }],
      },
    });
    expect(value).toEqual(expect.objectContaining({
      common: expect.objectContaining({
        message: null,
        mapConfiguration: null,
        windows: [expect.objectContaining({
          title: null,
          order: null,
          query: null,
        })],
      }),
    }));
  });
});
