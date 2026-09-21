import { describe, expect, it } from 'vitest';
import type { StoreStateProjection } from './contracts';
import { diffStoreProjections } from './stateDiff';

const base = (): StoreStateProjection => ({
  schemaVersion: 1,
  generatedAt: 1,
  common: {
    moduleSelectBarVisible: false,
    windows: [],
    mapConfiguration: { mode: 'a' },
    services: [],
    message: null,
  },
  map: {
    isUpdating: false,
    mobileRightClickEnabled: false,
    graphicsCount: 0,
    hasMapView: false,
    hasMapClickHandler: true,
  },
  contextMenu: { activeOnLeftClick: false },
  dynamicLayers: { count: 0 },
});

describe('stateDiff', () => {
  it('ignores generatedAt-only changes', () => {
    const left = base();
    const right = { ...base(), generatedAt: 999 };
    expect(diffStoreProjections(left, right)).toEqual({
      changed: false,
      changedPaths: [],
      truncated: false,
    });
  });

  it('reports deterministic privacy-safe paths without values', () => {
    const left = base();
    const right: StoreStateProjection = {
      ...left,
      common: {
        ...left.common,
        moduleSelectBarVisible: true,
        mapConfiguration: { mode: 'super-secret-mode' },
      },
      map: {
        ...left.map,
        graphicsCount: 4,
      },
    };
    const result = diffStoreProjections(left, right);
    expect(result.changedPaths).toEqual([
      'common.mapConfiguration.mode',
      'common.moduleSelectBarVisible',
      'map.graphicsCount',
    ]);
    expect(JSON.stringify(result)).not.toContain('super-secret-mode');
  });

  it('reports array length and indexed changes', () => {
    const left = base();
    const right: StoreStateProjection = {
      ...left,
      common: {
        ...left.common,
        windows: [{
          id: 'a',
          title: null,
          visible: true,
          minimized: false,
          order: null,
          lazy: false,
          query: null,
        }],
      },
    };
    const paths = diffStoreProjections(left, right).changedPaths;
    expect(paths).toContain('common.windows.length');
    expect(paths).toContain('common.windows[0]');
  });

  it('enforces a strict changed-path budget', () => {
    const left = base();
    const right: StoreStateProjection = {
      ...left,
      common: {
        ...left.common,
        mapConfiguration: {
          a: 1,
          b: 2,
          c: 3,
          d: 4,
          e: 5,
        },
      },
    };
    const result = diffStoreProjections(left, right, 2);
    expect(result.changedPaths).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });
});
