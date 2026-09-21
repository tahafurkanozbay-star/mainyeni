import { applyMiddleware, combineReducers, legacy_createStore as createStore } from 'redux';
import { describe, expect, it } from 'vitest';
import type { RootState } from '../contracts';
import { CommonReducer } from '../Reducers/CommonReducer';
import { ContextMenuReducer } from '../Reducers/ContextMenuReducer';
import { DynamicLayersReducer } from '../Reducers/DynamicLayersReducer';
import { MapReducer } from '../Reducers/MapReducer';
import { createStoreStateRuntimeMiddleware } from './stateMiddleware';
import { createStoreStateRuntime } from './stateRuntime';

const reducer = combineReducers({
  DynamicLayers: DynamicLayersReducer,
  ContextMenu: ContextMenuReducer,
  Map: MapReducer,
  Common: CommonReducer,
});

describe('stateMiddleware', () => {
  it('observes real Redux reducer transitions without changing dispatch results', () => {
    let tick = 0;
    const runtime = createStoreStateRuntime({ clock: () => ++tick });
    const store = createStore(
      reducer,
      applyMiddleware(createStoreStateRuntimeMiddleware(runtime, () => ++tick)),
    );
    const action = { type: 'MapReducer/SetMapUpdating', payload: true };
    const result = store.dispatch(action);
    expect(result).toBe(action);
    expect((store.getState() as RootState).Map.IsUpdating).toBe(true);
    expect(runtime.inspect().history.entries[0]).toMatchObject({
      actionType: 'MapReducer/SetMapUpdating',
      status: 'changed',
    });
  });

  it('records reducer failures and rethrows the original error', () => {
    const error = new Error('reducer failed');
    const initialState = reducer(undefined, { type: '@@store-runtime/test-init' }) as RootState;
    const failingReducer = (
      state: RootState = initialState,
      action: unknown,
    ): RootState => {
      if ((action as { type?: string }).type === 'boom') throw error;
      return state;
    };
    const runtime = createStoreStateRuntime();
    const store = createStore(
      failingReducer,
      applyMiddleware(createStoreStateRuntimeMiddleware(runtime)),
    );
    expect(() => store.dispatch({ type: 'boom' })).toThrow(error);
    expect(runtime.inspect().health.failedTransitions).toBe(1);
    expect(runtime.inspect().history.entries[0]).toMatchObject({
      status: 'failed',
      actionType: 'boom',
      errorCode: 'Error',
    });
  });
});
