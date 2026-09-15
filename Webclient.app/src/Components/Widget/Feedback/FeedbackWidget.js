import React, { useEffect, useImperativeHandle } from "react"
import FeedbackForm from "./FeedbackForm";
import "./FeedbackWidget.css";

export const FeedbackWidget = React.forwardRef((props, ref) => {

    useImperativeHandle(ref, () => ({

        id: props.id, visible: false, minimized: false,
        OnShow: () => {
            
        },
        OnClose: () => {
            
        }
    }));

    useEffect(() => {
        props.windowManager.RegisterWindow(ref);
    }, []);


    const closeWindow=(e)=>{
        props.windowManager.HideWindow(props.id);
    }

    return (<>
        <FeedbackForm
            show={props.windowManager.IsVisible(props.id) ? true : false}
            closeWindow={(e)=>closeWindow(e)}></FeedbackForm>

    </>);


}
);