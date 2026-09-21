import { describe, expect, it, vi } from 'vitest';
import type { RootState } from '../contracts';
import { createStoreStateRuntime } from './stateRuntime';

const state = (graphics = 0): RootState => ({
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
    Graphics: Array.from({ length: graphics }, (_, index) => index),
    MapClick: () => undefined,
    MobileRightClickEnabled: false,
  },
  ContextMenu: { ActiveOnLeftClick: false },
  DynamicLayers: { List: [] },
});

describe('stateRuntime', () => {
  it('initializes with a safe projection, fingerprint and invariant report', () => {
    const runtime = createStoreStateRuntime({ clock: () => 100 });
    const snapshot = runtime.initialize(state(1));
    expect(snapshot.health).toMatchObject({
      initialized: true,
      disposed: false,
      dispatches: 0,
      invariantErrors: 0,
    });
    expect(snapshot.health.stateFingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(snapshot.projection?.map.graphicsCount).toBe(1);
  });

  it('records changed and noop transitions separately', () => {
    const runtime = createStoreStateRuntime();
    const before = state(1);
    runtime.initialize(before);
    runtime.recordTransition({
      action: { type: 'Map/Changed' },
      previousState: before,
      nextState: { ...before, Map: { ...before.Map, IsUpdating: true } },
      startedAt: 10,
      completedAt: 14,
    });
    runtime.recordTransition({
      action: { type: 'Map/Noop' },
      previousState: before,
      nextState: before,
      startedAt: 20,
      completedAt: 21,
    });
    expect(runtime.inspect().health).toMatchObject({
      dispatches: 2,
      changedTransitions: 1,
      noopTransitions: 1,
    });
    expect(runtime.inspect().history.entries[0]?.status).toBe('noop');
    expect(runtime.inspect().history.entries[1]?.changedPaths).toContain('map.isUpdating');
  });

  it('records failures without retaining error messages or action payloads', () => {
    const runtime = createStoreStateRuntime();
    const root = state();
    runtime.initialize(root);
    runtime.recordFailure({
      action: { type: 'Danger', payload: { token: 'secret' } },
      state: root,
      startedAt: 1,
      completedAt: 3,
      error: Object.assign(new Error('private server message'), { code: 'NETWORK_SECRET' }),
    });
    const serialized = JSON.stringify(runtime.inspect());
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('private server message');
    expect(runtime.inspect().history.entries[0]).toMatchObject({
      status: 'failed',
      actionType: 'Danger',
      errorCode: 'Error',
    });
  });

  it('notifies selector subscribers from successful transitions', () => {
    const runtime = createStoreStateRuntime();
    const root = state();
    const listener = vi.fn();
    runtime.initialize(root);
    runtime.subscribeSelector((value) => value.Map.IsUpdating, listener);
    runtime.recordTransition({
      action: { type: 'Map/Update' },
      previousState: root,
      nextState: { ...root, Map: { ...root.Map, IsUpdating: true } },
      startedAt: 1,
      completedAt: 2,
    });
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      current: true,
      previous: false,
      actionType: 'Map/Update',
    }));
  });

  it('exports only safe JSON snapshot content', () => {
    const runtime = createStoreStateRuntime();
    const root = state();
    const withSecret: RootState = {
      ...root,
      Common: {
        ...root.Common,
        MapConfiguration: { token: 'hide', mode: 'safe' },
      },
    };
    runtime.initialize(withSecret);
    const encoded = runtime.exportSnapshot();
    expect(encoded).toContain('safe');
    expect(encoded).not.toContain('hide');
  });

  it('bounds history independently of lifetime counters', () => {
    const runtime = createStoreStateRuntime({
      limits: { maxHistoryEntries: 2 },
    });
    const root = state();
    runtime.initialize(root);
    for (let index = 0; index < 4; index += 1) {
      runtime.recordTransition({
        action: { type: 'noop/' + index },
        previousState: root,
        nextState: root,
        startedAt: index,
        completedAt: index + 1,
      });
    }
    expect(runtime.inspect().history).toMatchObject({
      retained: 2,
      totalRecorded: 4,
      dropped: 2,
    });
  });

  it('disposes subscriber surface and rejects later mutation recording', () => {
    const runtime = createStoreStateRuntime();
    runtime.initialize(state());
    runtime.dispose();
    expect(runtime.inspect().health.disposed).toBe(true);
    expect(() => runtime.recordTransition({
      action: { type: 'late' },
      previousState: state(),
      nextState: state(),
      startedAt: 1,
      completedAt: 2,
    })).toThrow(/disposed/);
  });
});
