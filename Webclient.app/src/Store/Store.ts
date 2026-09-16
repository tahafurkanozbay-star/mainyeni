import { combineReducers, legacy_createStore as createStore } from 'redux';
import { CommonReducer } from './Reducers/CommonReducer';
import { ContextMenuReducer } from './Reducers/ContextMenuReducer';
import { DynamicLayersReducer } from './Reducers/DynamicLayersReducer';
import { MapReducer } from './Reducers/MapReducer';

export const rootReducer = combineReducers({
  DynamicLayers: DynamicLayersReducer,
  ContextMenu: ContextMenuReducer,
  Map: MapReducer,
  Common: CommonReducer,
});

export const Store = createStore(rootReducer);
export type AppState = ReturnType<typeof rootReducer>;
export type AppDispatch = typeof Store.dispatch;

export default Store;
