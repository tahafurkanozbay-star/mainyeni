import { describe, expect, it, vi } from 'vitest';
import {
  CommonReducer_ActionTypes,
} from '../Reducers/CommonReducer';
import { MapReducer_ActionTypes } from '../Reducers/MapReducer';
import { Store, StoreStateRuntime } from '../Store';

describe('Store runtime integration', () => {
  it('observes the singleton Redux store without changing reducer behavior', () => {
    const before = StoreStateRuntime.inspect().health.dispatches;
    Store.dispatch({
      type: MapReducer_ActionTypes.SetMapUpdating,
      payload: true,
    });
    expect(Store.getState().Map.IsUpdating).toBe(true);
    expect(StoreStateRuntime.inspect().health.dispatches).toBe(before + 1);
    expect(StoreStateRuntime.inspect().history.entries[0]).toMatchObject({
      actionType: MapReducer_ActionTypes.SetMapUpdating,
      status: 'changed',
    });
  });

  it('supports typed selector subscriptions over singleton state', () => {
    const listener = vi.fn();
    const unsubscribe = StoreStateRuntime.subscribeSelector(
      (state) => state.Common.ModuleSelectBarVisible,
      listener,
    );
    Store.dispatch({
      type: CommonReducer_ActionTypes.SetModuleSelectBarVisible,
      payload: true,
    });
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      current: true,
      actionType: CommonReducer_ActionTypes.SetModuleSelectBarVisible,
    }));
    unsubscribe();
  });

  it('exports privacy-safe state diagnostics from singleton store', () => {
    Store.dispatch({
      type: CommonReducer_ActionTypes.SetMapConfiguration,
      payload: {
        mode: 'enterprise',
        token: 'do-not-export',
      },
    });
    const snapshot = StoreStateRuntime.exportSnapshot();
    expect(snapshot).toContain('enterprise');
    expect(snapshot).not.toContain('do-not-export');
  });
});
