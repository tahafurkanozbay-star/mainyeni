import { DynamicLayersReducer_ActionTypes } from '../Reducers/DynamicLayersReducer';
import Store from '../Store';

const normalizeLayerList = (value: readonly unknown[] | null | undefined): readonly unknown[] =>
  Object.freeze(Array.isArray(value) ? [...value] : []);

const resolveLayerIndex = (layers: readonly unknown[], layerOrIndex: unknown): number => {
  if (typeof layerOrIndex === 'number' && Number.isInteger(layerOrIndex)) {
    return layerOrIndex >= 0 && layerOrIndex < layers.length ? layerOrIndex : -1;
  }
  return layers.indexOf(layerOrIndex);
};

export const DynamicLayerManager = Object.freeze({
  GetLayers: (): readonly unknown[] => {
    const layers = Store.getState().DynamicLayers.List;
    return Array.isArray(layers) ? layers : Object.freeze([]);
  },

  Add: (layer: unknown): boolean => {
    if (layer === null || layer === undefined) return false;
    Store.dispatch({
      type: DynamicLayersReducer_ActionTypes.Add,
      payload: layer,
    });
    return true;
  },

  Remove: (layerOrIndex: unknown): boolean => {
    const layers = DynamicLayerManager.GetLayers();
    const index = resolveLayerIndex(layers, layerOrIndex);
    if (index < 0) return false;
    Store.dispatch({
      type: DynamicLayersReducer_ActionTypes.Remove,
      payload: index,
    });
    return true;
  },

  Replace: (layers: readonly unknown[]): void => {
    Store.dispatch({
      type: DynamicLayersReducer_ActionTypes.Replace,
      payload: normalizeLayerList(layers),
    });
  },

  Clear: (): void => {
    Store.dispatch({
      type: DynamicLayersReducer_ActionTypes.Set,
      payload: [],
    });
  },
});

export default DynamicLayerManager;
