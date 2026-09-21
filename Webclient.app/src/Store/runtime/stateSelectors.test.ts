import { describe, expect, it } from 'vitest';
import type { RootState } from '../contracts';
import {
  createServiceSelector,
  createSingleEntrySelector,
  createWindowSelector,
  selectActiveWindow,
  selectConfigurationServices,
  selectDynamicLayerRuntimeSummary,
  selectMapRuntimeSummary,
  selectVisibleWindows,
} from './stateSelectors';

const root: RootState = {
  Common: {
    BigPopupLinkRef: null,
    WindowList: [
      { id: 'a', visible: false },
      { id: 'b', visible: true },
    ],
    ModuleSelectBarVisible: false,
    MapConfiguration: null,
    ConfigurationServices: [
      { title: 'Buildings', url: '/buildings' },
    ],
    Message: null,
  },
  Map: {
    MapView: {},
    IsUpdating: true,
    Graphics: [1, 2],
    MapClick: () => undefined,
    MobileRightClickEnabled: true,
  },
  ContextMenu: { ActiveOnLeftClick: false },
  DynamicLayers: { List: [1, 2, 3] },
};

describe('stateSelectors', () => {
  it('selects active and visible window state', () => {
    expect(selectVisibleWindows(root).map((item) => item.id)).toEqual(['b']);
    expect(selectActiveWindow(root)?.id).toBe('b');
    expect(createWindowSelector('a')(root)?.id).toBe('a');
    expect(createWindowSelector('missing')(root)).toBeNull();
  });

  it('selects normalized map and dynamic layer summaries', () => {
    expect(selectMapRuntimeSummary(root)).toEqual({
      hasView: true,
      updating: true,
      graphicsCount: 2,
      mobileRightClickEnabled: true,
    });
    expect(selectDynamicLayerRuntimeSummary(root)).toEqual({
      count: 3,
      empty: false,
    });
  });

  it('finds services through compatibility identity fields', () => {
    expect(selectConfigurationServices(root)).toHaveLength(1);
    expect(createServiceSelector('buildings')(root)).toEqual({
      title: 'Buildings',
      url: '/buildings',
    });
  });

  it('memoizes a selector for identical root references', () => {
    let calls = 0;
    const selector = createSingleEntrySelector((state) => {
      calls += 1;
      return state.Map.Graphics.length;
    });
    expect(selector(root)).toBe(2);
    expect(selector(root)).toBe(2);
    expect(calls).toBe(1);
    expect(selector({ ...root })).toBe(2);
    expect(calls).toBe(2);
  });
});
