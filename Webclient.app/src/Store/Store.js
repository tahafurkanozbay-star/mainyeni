import { legacy_createStore as createStore, combineReducers } from "redux";
import { ContextMenuReducer } from "./Reducers/ContextMenuReducer";
import { MapReducer } from "./Reducers/MapReducer";
import { CommonReducer } from "./Reducers/CommonReducer";
import { DynamicLayersReducer } from "./Reducers/DynamicLayersReducer";

const rootReducer = combineReducers({
  DynamicLayers: DynamicLayersReducer,
  ContextMenu: ContextMenuReducer,
  Map: MapReducer,
  Common: CommonReducer
});

export const Store = createStore(rootReducer);
export default Store;
