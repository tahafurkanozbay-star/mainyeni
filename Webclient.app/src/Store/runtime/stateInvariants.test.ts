import { describe, expect, it } from 'vitest';
import type { RootState } from '../contracts';
import { changedStoreSlices, inspectStoreInvariants } from './stateInvariants';

const healthy = (): RootState => ({
  Common: {
    BigPopupLinkRef: null,
    WindowList: [],
    ModuleSelectBarVisible: false,
    MapConfiguration: null,
    ConfigurationServices: [],
    Message: null,
  },
  Map: {
    MapView: null,
    IsUpdating: false,
    Graphics: [],
    MapClick: () => undefined,
    MobileRightClickEnabled: false,
  },
  ContextMenu: { ActiveOnLeftClick: false },
  DynamicLayers: { List: [] },
});

describe('stateInvariants', () => {
  it('reports healthy bounded default state', () => {
    const report = inspectStoreInvariants(healthy(), {}, 10);
    expect(report).toMatchObject({
      generatedAt: 10,
      healthy: true,
      errorCount: 0,
      warningCount: 0,
    });
  });

  it('finds duplicate windows and visible-window budget pressure', () => {
    const root = healthy();
    const report = inspectStoreInvariants({
      ...root,
      Common: {
        ...root.Common,
        WindowList: [
          { id: 'x', visible: true },
          { id: 'x', visible: true },
        ],
      },
    }, {
      maxVisibleWindows: 1,
    });
    expect(report.healthy).toBe(false);
    expect(report.issues.map((item) => item.code)).toContain('STORE_WINDOW_ID_DUPLICATE');
    expect(report.issues.map((item) => item.code)).toContain('STORE_VISIBLE_WINDOWS_LIMIT');
  });

  it('detects graphics, layers, services and message budget violations', () => {
    const root = healthy();
    const report = inspectStoreInvariants({
      ...root,
      Common: {
        ...root.Common,
        ConfigurationServices: [{ title: 'a' }, { title: 'b' }],
        Message: { messageText: '123456789' },
      },
      Map: {
        ...root.Map,
        Graphics: [1, 2, 3],
      },
      DynamicLayers: {
        List: [1, 2, 3],
      },
    }, {
      maxServices: 1,
      maxMessageLength: 4,
      maxGraphics: 2,
      maxDynamicLayers: 2,
    });
    expect(report.issues.map((item) => item.code)).toEqual(expect.arrayContaining([
      'STORE_SERVICES_LIMIT',
      'STORE_MESSAGE_LENGTH',
      'STORE_GRAPHICS_LIMIT',
      'STORE_DYNAMIC_LAYERS_LIMIT',
    ]));
  });

  it('caps issue retention without unbounded diagnostic growth', () => {
    const root = healthy();
    const report = inspectStoreInvariants({
      ...root,
      Common: {
        ...root.Common,
        WindowList: Array.from({ length: 10 }, () => ({ id: 'duplicate', visible: true })),
      },
    }, {
      maxInvariantIssues: 3,
      maxWindows: 2,
      maxVisibleWindows: 1,
    });
    expect(report.issues).toHaveLength(3);
    expect(report.truncated).toBe(true);
  });

  it('identifies changed root slices by reference', () => {
    const before = healthy();
    const after: RootState = {
      ...before,
      Map: { ...before.Map, IsUpdating: true },
      Common: { ...before.Common, ModuleSelectBarVisible: true },
    };
    expect(changedStoreSlices(before, after)).toEqual(['Common', 'Map']);
    expect(changedStoreSlices(after, after)).toEqual([]);
  });
});
