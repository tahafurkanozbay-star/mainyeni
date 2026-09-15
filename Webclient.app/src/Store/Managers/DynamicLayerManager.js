import { DynamicLayersReducer_ActionTypes } from "../Reducers/DynamicLayersReducer";
import Store from "../Store";

export const DynamicLayerManager={

    GetLayers:()=>{
        return Store.getState().DynamicLayers.List;
    },

    Add:(_layer)=>{
        Store.dispatch({
            type: DynamicLayersReducer_ActionTypes.Add,
            payload: _layer
        });
    },

    Remove:(_layer)=>{
        Store.dispatch({
            type: DynamicLayersReducer_ActionTypes.Remove,
            payload: _layer
        });
    },

};

export default DynamicLayerManager;