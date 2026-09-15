import React, { useEffect, useImperativeHandle } from "react";
import FeedbackForm from "./FeedbackForm";
import "./FeedbackWidget.css";

export const FeedbackWidget = React.forwardRef((props, ref) => {
    useImperativeHandle(ref, () => ({
        id: props.id,
        visible: false,
        minimized: false,
        OnShow: () => {},
        OnClose: () => {}
    }), [props.id]);

    useEffect(() => {
        props.windowManager.RegisterWindow(ref);
    }, [props.windowManager, ref]);

    const closeWindow = () => {
        props.windowManager.HideWindow(props.id);
    };

    return (
        <FeedbackForm
            show={props.windowManager.IsVisible(props.id)}
            closeWindow={closeWindow}
        />
    );
});

FeedbackWidget.displayName = "FeedbackWidget";
