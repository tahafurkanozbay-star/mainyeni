import { applyMiddleware, combineReducers, legacy_createStore as createStore } from 'redux';
import { CommonReducer } from './Reducers/CommonReducer';
import { ContextMenuReducer } from './Reducers/ContextMenuReducer';
import { DynamicLayersReducer } from './Reducers/DynamicLayersReducer';
import { MapReducer } from './Reducers/MapReducer';
import { createStoreStateRuntime, createStoreStateRuntimeMiddleware } from './runtime';

export const rootReducer = combineReducers({
  DynamicLayers: DynamicLayersReducer,
  ContextMenu: ContextMenuReducer,
  Map: MapReducer,
  Common: CommonReducer,
});

export const StoreStateRuntime = createStoreStateRuntime();
export const Store = createStore(
  rootReducer,
  applyMiddleware(createStoreStateRuntimeMiddleware(StoreStateRuntime)),
);
StoreStateRuntime.initialize(Store.getState());
export type AppState = ReturnType<typeof rootReducer>;
export type AppDispatch = typeof Store.dispatch;

export default Store;
