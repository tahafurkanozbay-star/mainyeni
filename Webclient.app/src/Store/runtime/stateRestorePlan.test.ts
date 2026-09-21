import { describe, expect, it } from 'vitest';
import type { RootState } from '../contracts';
import type { StoreStateProjection } from './contracts';
import { planStoreSnapshotRestore } from './stateRestorePlan';

const current = (): RootState => ({
  Common: {
    BigPopupLinkRef: null,
    WindowList: [
      { id: 'search', visible: false, minimized: false, query: null },
      { id: 'layers', visible: true, minimized: false, query: null },
    ],
    ModuleSelectBarVisible: false,
    MapConfiguration: null,
    ConfigurationServices: [],
    Message: null,
  },
  Map: {
    MapView: { runtime: true },
    IsUpdating: false,
    Graphics: [1, 2],
    MapClick: () => undefined,
    MobileRightClickEnabled: false,
  },
  ContextMenu: { ActiveOnLeftClick: false },
  DynamicLayers: { List: [1] },
});

const saved = (): StoreStateProjection => ({
  schemaVersion: 1,
  generatedAt: 10,
  common: {
    moduleSelectBarVisible: true,
    windows: [
      {
        id: 'search',
        title: 'Search',
        visible: true,
        minimized: true,
        order: null,
        lazy: false,
        query: { text: 'ankara' },
      },
      {
        id: 'missing',
        title: null,
        visible: true,
        minimized: false,
        order: null,
        lazy: false,
        query: null,
      },
    ],
    mapConfiguration: { ignored: true },
    services: [],
    message: { type: 1, text: 'stale' },
  },
  map: {
    isUpdating: true,
    mobileRightClickEnabled: true,
    graphicsCount: 999,
    hasMapView: false,
    hasMapClickHandler: false,
  },
  contextMenu: { activeOnLeftClick: true },
  dynamicLayers: { count: 999 },
});

describe('stateRestorePlan', () => {
  it('restores only bounded safe UI preferences', () => {
    const plan = planStoreSnapshotRestore(saved(), current());
    const serialized = JSON.stringify(plan.actions);
    expect(serialized).toContain('SetModuleSelectBarVisible');
    expect(serialized).toContain('SetWindowVisibility');
    expect(serialized).toContain('SetWindowMinimized');
    expect(serialized).toContain('SetMobileRightClick');
    expect(serialized).toContain('ActiveOnLeftClick/Enable');
    expect(serialized).not.toContain('MapView');
    expect(serialized).not.toContain('Graphics');
    expect(serialized).not.toContain('ConfigurationServices');
    expect(serialized).not.toContain('SetMessage');
    expect(plan.skippedWindows).toBe(1);
  });

  it('keeps saved query data only for windows already registered in memory', () => {
    const plan = planStoreSnapshotRestore(saved(), current());
    const action = plan.actions.find((item) => item.type === 'CommonReducer/SetWindowVisibility');
    expect(action).toMatchObject({
      payload: {
        windowid: 'search',
        visible: true,
        query: { text: 'ankara' },
      },
    });
  });

  it('enforces action-count bounds', () => {
    const projection = saved();
    const manyWindows = Array.from({ length: 10 }, (_, index) => ({
      id: 'window-' + index,
      title: null,
      visible: true,
      minimized: true,
      order: null,
      lazy: false,
      query: null,
    }));
    const root = current();
    const currentMany: RootState = {
      ...root,
      Common: {
        ...root.Common,
        WindowList: manyWindows.map((item) => ({
          id: item.id,
          visible: false,
          minimized: false,
        })),
      },
    };
    const plan = planStoreSnapshotRestore({
      ...projection,
      common: { ...projection.common, windows: manyWindows },
    }, currentMany, 3);
    expect(plan.actions).toHaveLength(3);
    expect(plan.truncated).toBe(true);
  });
});
