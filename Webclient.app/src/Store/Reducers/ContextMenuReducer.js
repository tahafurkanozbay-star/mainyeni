const initialState = {
    ActiveOnLeftClick: false
}

export const ContextMenuReducer_ActionTypes = {
    EnableOnLeftClick: "ActiveOnLeftClick/Enable",
    DisableOnLeftClick: "ActiveOnLeftClick/Disable",

}

export const ContextMenuReducer = (state = initialState, action) => {

    switch (action.type) {

        case ContextMenuReducer_ActionTypes.EnableOnLeftClick:
            return { ...state, ActiveOnLeftClick: true };

        case ContextMenuReducer_ActionTypes.DisableOnLeftClick:
            return { ...state, ActiveOnLeftClick: false };

        default:
            return state
    }
}