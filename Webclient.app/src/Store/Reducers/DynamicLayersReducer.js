const initialState = {
    List: []
}

export const DynamicLayersReducer_ActionTypes = {
    Add: "DynamicLayersReducer/Add",
    Remove: "DynamicLayersReducer/Remove",
    Replace: "DynamicLayersReducer/Replace"
}

export const DynamicLayersReducer = (state = initialState, action) => {

    let _Layers = [...state.List];
    switch (action.type) {

        case DynamicLayersReducer_ActionTypes.Set:
            return { ...state, List: action.payload };

        case DynamicLayersReducer_ActionTypes.Add:
            _Layers.push(action.payload);
            return { ...state, List: _Layers };

        case DynamicLayersReducer_ActionTypes.Remove:
            _Layers.splice(action.payload, 1);
            return { ...state, List: _Layers };

        default:
            return state
    }
}