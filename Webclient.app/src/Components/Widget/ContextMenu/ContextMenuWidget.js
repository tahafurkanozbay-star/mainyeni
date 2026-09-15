import React, { useEffect, useImperativeHandle, useState } from "react";
import "./ContextMenuWidget.css";
import { RiFocusLine, RiGoogleFill, RiInformationLine, RiRouteLine } from "react-icons/ri";
import MapManager from "../../../Store/Managers/MapManager";
import { GisGraphicsHelper } from "../../../Toolbox/GisGraphicsHelper";
import { LoggingBusiness } from "../../../Business/LoggingBusiness";
import { GoogleMapsBusiness } from "../../../Business/GoogleMapsBusiness";

export const ContextMenuWidget = React.forwardRef((props, ref) => {
    const [positionX, setPositionX] = useState(0);
    const [positionY, setPositionY] = useState(0);

    useImperativeHandle(ref, () => ({
        id: props.id,
        visible: false,
        minimized: false,
        OnShow: () => {
            const clickEvent = MapManager.GetMapClickEvent();
            if (!clickEvent) return;
            setPositionY(clickEvent.y);
            setPositionX(clickEvent.x);
        },
        OnClose: () => {}
    }), [props.id]);

    useEffect(() => {
        props.windowManager.RegisterWindow(ref);
    }, [props.windowManager, ref]);

    const getClickedPoint = () => MapManager.GetMapClickEvent()?.mapPoint || null;

    const showVicinityQuery = () => {
        const point = getClickedPoint();
        if (!point) return;
        props.windowManager.ShowWindow("vicinity-query-window");
        props.windowManager.HideWindow("context-menu-widget");
        GisGraphicsHelper.ZoomToGeometry(MapManager.GetMapView(), point, 14);
        LoggingBusiness.CreateClientLog("Sağ Tık/Yakınımda ara", `${point.latitude}/${point.longitude}`);
    };

    const showIdentify = () => {
        const point = getClickedPoint();
        if (!point) return;
        props.windowManager.ShowWindow("global-identify-widget");
        props.windowManager.HideWindow("context-menu-widget");
        LoggingBusiness.CreateClientLog("Sağ Tık/Bilgi al", `${point.latitude}/${point.longitude}`);
    };

    const openExternal = url => {
        const opened = window.open(url, "_blank", "noopener,noreferrer");
        if (opened) opened.opener = null;
    };

    const showRoute = () => {
        const point = getClickedPoint();
        if (!point) return;
        props.windowManager.HideWindow("context-menu-widget");
        LoggingBusiness.CreateClientLog("Sağ Tık/Yol Tarifi", `${point.latitude}/${point.longitude}`);
        openExternal(`https://www.google.com.tr/maps?saddr=My+Location&daddr=${point.latitude},${point.longitude}`);
    };

    const showStreetView = () => {
        const point = getClickedPoint();
        if (!point) return;
        openExternal(GoogleMapsBusiness.CreateStreetViewUrlFromPoint(point));
        props.windowManager.HideWindow("context-menu-widget");
    };

    return (
        <div className="context-menu-container" role="menu" aria-label="Harita işlemleri" style={{ position: "absolute", top: positionY, left: positionX, zIndex: 999, visibility: props.windowManager.IsVisible(props.id) ? 'visible' : 'hidden' }}>
            <button type="button" role="menuitem" className="context-menu-item" onClick={showIdentify}><RiInformationLine className="context-menu-item-icon" aria-hidden="true" /><span className="context-menu-item-text">Bilgi Al</span></button>
            <button type="button" role="menuitem" className="context-menu-item" onClick={showVicinityQuery}><RiFocusLine className="context-menu-item-icon" aria-hidden="true" /><span className="context-menu-item-text">Yakınımda Ara</span></button>
            <button type="button" role="menuitem" className="context-menu-item" onClick={showRoute}><RiRouteLine className="context-menu-item-icon" aria-hidden="true" /><span className="context-menu-item-text">Yol Tarifi Al</span></button>
            <button type="button" role="menuitem" className="context-menu-item" onClick={showStreetView}><RiGoogleFill className="context-menu-item-icon" aria-hidden="true" /><span className="context-menu-item-text">Sokak Görünümü</span></button>
        </div>
    );
});

ContextMenuWidget.displayName = "ContextMenuWidget";
