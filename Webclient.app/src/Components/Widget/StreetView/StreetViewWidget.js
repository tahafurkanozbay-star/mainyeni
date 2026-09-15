import React, { useEffect, useImperativeHandle, useState } from "react";
import { GoogleMapsBusiness } from "../../../Business/GoogleMapsBusiness";
import MapManager from "../../../Store/Managers/MapManager";
import { CommonQueryWindowTools } from "../../Query/_Common/CommonQueryWindowTools";
import "./StreetViewWidget.css";

export const StreetViewWidget = React.forwardRef((props, ref) => {
    const [url, setUrl] = useState(null);

    useImperativeHandle(ref, () => ({
        id: props.id,
        visible: false,
        minimized: false,
        OnShow: () => {
            const clickEvent = MapManager.GetMapClickEvent();
            const mapPoint = clickEvent?.mapPoint;
            if (!mapPoint) {
                setUrl(null);
                return;
            }
            setUrl(GoogleMapsBusiness.CreateStreetViewUrlFromPoint(mapPoint));
            props.windowManager.ShowWindow("sidebar");
        },
        OnClose: () => setUrl(null)
    }), [props.id, props.windowManager]);

    useEffect(() => {
        props.windowManager.RegisterWindow(ref);
    }, [props.windowManager, ref]);

    const isVisible = props.windowManager.IsVisible(props.id);

    return (
        <div
            className="common-query-window common-query-window-right"
            style={{ visibility: isVisible ? "visible" : "hidden" }}
            aria-hidden={!isVisible}
        >
            <div className="common-query-window-header">
                <img
                    className="common-query-window-header-icon"
                    src="images/icons/toolbar/sokakgoruntusu.png"
                    alt=""
                    aria-hidden="true"
                />
                <span>Sokak Görüntüsü</span>
                <CommonQueryWindowTools
                    windowManager={props.windowManager}
                    windowId={props.id}
                    showNearbySearch={false}
                    showMapSelect={false}
                    setQueryField={() => {}}
                    query={null}
                />
            </div>
            <div className="common-query-window-body layer-list-window-body">
                {url ? (
                    <iframe
                        src={url}
                        width="100%"
                        height="300"
                        title="Seçilen konumun sokak görüntüsü"
                        loading="lazy"
                        referrerPolicy="strict-origin-when-cross-origin"
                    />
                ) : (
                    <p role="status">Sokak görüntüsü için önce haritada bir konum seçin.</p>
                )}
            </div>
        </div>
    );
});

StreetViewWidget.displayName = "StreetViewWidget";
