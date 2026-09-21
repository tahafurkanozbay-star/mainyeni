import { describe, expect, it } from 'vitest';
import type { StoreRuntimeSnapshot } from './contracts';
import { assessStorePressure } from './statePressure';

const snapshot = (history: number, windows: number, graphics: number): StoreRuntimeSnapshot => ({
  generatedAt: 1,
  health: {
    initialized: true,
    disposed: false,
    dispatches: history,
    changedTransitions: history,
    noopTransitions: 0,
    failedTransitions: 0,
    subscriberCount: 0,
    subscriberErrors: 0,
    historyRetained: history,
    invariantErrors: 0,
    invariantWarnings: 0,
    stateFingerprint: '12345678',
    lastActionType: 'x',
  },
  projection: {
    schemaVersion: 1,
    generatedAt: 1,
    common: {
      moduleSelectBarVisible: false,
      windows: Array.from({ length: windows }, (_, index) => ({
        id: 'w-' + index,
        title: null,
        visible: false,
        minimized: false,
        order: null,
        lazy: false,
        query: null,
      })),
      mapConfiguration: null,
      services: [],
      message: null,
    },
    map: {
      isUpdating: false,
      mobileRightClickEnabled: false,
      graphicsCount: graphics,
      hasMapView: false,
      hasMapClickHandler: true,
    },
    contextMenu: { activeOnLeftClick: false },
    dynamicLayers: { count: 0 },
  },
  invariants: null,
  history: {
    capacity: 100,
    retained: history,
    totalRecorded: history,
    dropped: 0,
    changed: history,
    noop: 0,
    failed: 0,
    entries: [],
  },
});

describe('statePressure', () => {
  it('reports normal pressure below seventy percent', () => {
    expect(assessStorePressure(snapshot(2, 2, 2), {
      maxHistoryEntries: 10,
      maxWindows: 10,
      maxGraphics: 10,
    }).level).toBe('normal');
  });

  it('reports elevated and critical resources independently', () => {
    const result = assessStorePressure(snapshot(8, 9, 2), {
      maxHistoryEntries: 10,
      maxWindows: 10,
      maxGraphics: 10,
    });
    expect(result.level).toBe('critical');
    expect(result.elevated).toContain('history');
    expect(result.critical).toContain('windows');
  });

  it('never divides by zero for malformed limits', () => {
    const result = assessStorePressure(snapshot(1, 1, 1), {
      maxHistoryEntries: 0,
      maxWindows: 0,
      maxGraphics: 0,
    });
    for (const item of result.metrics) {
      expect(Number.isFinite(item.ratio)).toBe(true);
    }
  });
});
