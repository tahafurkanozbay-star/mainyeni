import React, { useEffect, useImperativeHandle, useState } from "react";
import "./ContextMenuWidget.css";
import { RiFocusLine, RiGoogleFill, RiGoogleLine, RiInformationLine, RiRouteLine } from "react-icons/ri";
import MapManager from "../../../Store/Managers/MapManager";
import { GisGraphicsHelper } from "../../../Toolbox/GisGraphicsHelper";
import { LoggingBusiness } from "../../../Business/LoggingBusiness";
import { GoogleMapsBusiness } from "../../../Business/GoogleMapsBusiness";

export const ContextMenuWidget = React.forwardRef((props, ref) => {

    useImperativeHandle(ref, () => ({
        id: props.id, visible: false, minimized: false,
        OnShow: () => {
            const clickEvent = MapManager.GetMapClickEvent();
            setPositionY(clickEvent.y);
            setPositionX(clickEvent.x);
        },
        OnClose: () => {

        }
    }));


    const [positionX, setPositionX] = useState(0);
    const [positionY, setPositionY] = useState(0);

    useEffect(() => {
        
        //Window Manager register window
        props.windowManager.RegisterWindow(ref);


    }, []);



    const showVicinityQuery = () => {
        props.windowManager.ShowWindow("vicinity-query-window");
        props.windowManager.HideWindow("context-menu-widget");

        const clickEvent = MapManager.GetMapClickEvent();
        const mapView = MapManager.GetMapView();
        GisGraphicsHelper.ZoomToGeometry(mapView, clickEvent.mapPoint, 14);

        const lat = clickEvent.mapPoint.latitude;
        const lng = clickEvent.mapPoint.longitude;

        LoggingBusiness.CreateClientLog("Sağ Tık/Yakınımda ara", lat + "/" + lng);
    }

    const showIdentify = () => {

        const clickEvent = MapManager.GetMapClickEvent();

        props.windowManager.ShowWindow("global-identify-widget");
        props.windowManager.HideWindow("context-menu-widget");

        const lat = clickEvent.mapPoint.latitude;
        const lng = clickEvent.mapPoint.longitude;

        LoggingBusiness.CreateClientLog("Sağ Tık/Bilgi al", lat + "/" + lng);
    }

    const showRoute = () => {

        const clickEvent = MapManager.GetMapClickEvent();
        props.windowManager.HideWindow("context-menu-widget");

        const lat = clickEvent.mapPoint.latitude;
        const lng = clickEvent.mapPoint.longitude;

        LoggingBusiness.CreateClientLog("Sağ Tık/Yol Tarifi", lat + "/" + lng);

        let url = "https://www.google.com.tr/maps?saddr=My+Location&daddr=" + lat + "," + lng;
        window.open(url, "_blank");

    }

    const showStreetView=()=>{
        const clickEvent = MapManager.GetMapClickEvent();
        var url=GoogleMapsBusiness.CreateStreetViewUrlFromPoint(clickEvent.mapPoint);
        window.open(url,"_blank");

        //props.windowManager.ShowWindow("streetview-widget");
    }

    return (<>
        <div className="context-menu-container" style={{
            position: "absolute", top: positionY, left: positionX, zIndex: 999,
            visibility: props.windowManager.IsVisible(props.id) ? 'visible' : 'hidden'
        }}>
            <div className="context-menu-item" onClick={(e) => showIdentify()}>
                <RiInformationLine className="context-menu-item-icon" />
                <span className="context-menu-item-text">Bilgi Al</span>
            </div>
            <div className="context-menu-item" onClick={(e) => showVicinityQuery()}>
                <RiFocusLine className="context-menu-item-icon" />
                <span className="context-menu-item-text">Yakınımda Ara</span>
            </div>

            <div className="context-menu-item" onClick={(e) => showRoute()}>
                <RiRouteLine className="context-menu-item-icon" />
                <span className="context-menu-item-text">Yol Tarifi Al</span>
            </div>

            <div className="context-menu-item" onClick={(e) => showStreetView()}>
                <RiGoogleFill className="context-menu-item-icon" />
                <span className="context-menu-item-text">Sokak Görünümü</span>
            </div>
        </div>
    </>);
});