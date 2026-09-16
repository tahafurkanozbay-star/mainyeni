import { configureStore } from "@reduxjs/toolkit";
import { ContextMenuReducer } from "./Reducers/ContextMenuReducer";
import { MapReducer } from "./Reducers/MapReducer";
import { CommonReducer } from "./Reducers/CommonReducer";
import { DynamicLayersReducer } from "./Reducers/DynamicLayersReducer";

export const Store = configureStore({
  reducer: {
    DynamicLayers: DynamicLayersReducer,
    ContextMenu: ContextMenuReducer,
    Map: MapReducer,
    Common: CommonReducer
  },
  // ArcGIS SDK objects are intentionally stored by legacy reducers today. Keep the
  // migration behavior-compatible while gaining the modern Redux Toolkit store API.
  // These checks can be enabled per-slice as the remaining GIS state becomes serializable.
  middleware: (getDefaultMiddleware) => getDefaultMiddleware({
    immutableCheck: false,
    serializableCheck: false
  })
});

export default Store;
