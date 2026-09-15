import React, { useEffect, useImperativeHandle } from "react";
import { CommonQueryWindowTools } from "../_Common/CommonQueryWindowTools";
import "./ReportQueryWindow.css";

export const ReportQueryWindow = React.forwardRef((props, ref) => {
    const windowTitle = "Rapor";
    const windowLogo = "images/icons/common/rapor.png";

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

    const isVisible = props.windowManager.IsVisible(props.id);
    const isMinimized = props.windowManager.IsMinimized(props.id);

    return (
        <div
            className="common-query-window"
            style={{
                maxWidth: "100%",
                width: "calc(100vw - 140px)",
                height: "calc(100vh - 90px)",
                visibility: isVisible ? "visible" : "hidden"
            }}
            aria-hidden={!isVisible}
        >
            <div className="common-query-window-header">
                <img
                    className="common-query-window-header-icon"
                    src={windowLogo}
                    alt=""
                    aria-hidden="true"
                />
                <span>{windowTitle}</span>
                <CommonQueryWindowTools
                    windowManager={props.windowManager}
                    windowId={props.id}
                    showNearbySearch={false}
                    showMapSelect={false}
                />
            </div>
            <div className={`common-query-window-body ${isMinimized ? "common-query-window-body-collapsed" : ""}`}>
                <iframe
                    src="https://cbsportal.shkbilisim.com/portal/apps/dashboards/18385387c4c94f418a0b80caa30225aa"
                    className="report-frame"
                    title="Kent Rehberi rapor panosu"
                    loading="lazy"
                    referrerPolicy="strict-origin-when-cross-origin"
                />
            </div>
        </div>
    );
});

ReportQueryWindow.displayName = "ReportQueryWindow";
