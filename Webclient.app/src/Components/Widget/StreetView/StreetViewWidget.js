import React, { useEffect, useImperativeHandle, useState } from "react";
import { loadModules } from "esri-loader";
import MapManager from "../../../Store/Managers/MapManager";
import { CommonQueryWindowTools } from "../../Query/_Common/CommonQueryWindowTools";
import "./StreetViewWidget.css";
import { BiInfoCircle, BiZoomIn } from "react-icons/bi";
import { IsNull } from "../../../Toolbox/ObjectHelper";
import { ContainerLoading, NoResultsFound } from "../../Common/Loading";
import { Accordion, Button, Tab, Tabs } from "react-bootstrap";
import { GisGraphicsHelper } from "../../../Toolbox/GisGraphicsHelper";
import { GoogleMapsBusiness } from "../../../Business/GoogleMapsBusiness";

export const StreetViewWidget = React.forwardRef((props, ref) => {

    useImperativeHandle(ref, () => ({

        id: props.id, visible: false, minimized: false,
        OnShow: () => {
            props.windowManager.ShowWindow("sidebar")
            const clickEvent = MapManager.GetMapClickEvent();
            var _url=GoogleMapsBusiness.CreateStreetViewUrlFromPoint(clickEvent.mapPoint);
            setUrl(_url);
            props.windowManager.ShowWindow("sidebar")
            //startIdentify();
        },
        OnClose: () => {
            
            //cancelIdentify();
        }
    }));

    const [mapView, setMapView] = useState(null);
    useEffect(() => {
        
        
        props.windowManager.RegisterWindow(ref);
        const _mapView = MapManager.GetMapView();
        setMapView(_mapView);

    }, []);


    const [mapClickEvent, setMapClickEvent] = useState(null);

    const [url,setUrl]=useState(null);
    const startIdentify = () => {

        //mapView.popup.autoOpenEnabled = false;

        if (mapClickEvent == null) {

            const _mapClickEvent = mapView.on("click", function (event) {
                executeIdentify(event);
            });

            setMapClickEvent(_mapClickEvent);
        }
    }

    const cancelIdentify = () => {
        mapClickEvent?.remove();
        setMapClickEvent(null);
    }


    const executeIdentify = (_event) => {

        const mapPoint = _event.mapPoint;

        var lat = mapPoint.latitude;
        var lng = mapPoint.longitude;

        //http://maps.google.com/maps?q=&layer=c&cbll=31.33519,-89.28720
        var url = "http://maps.google.com/maps?q=&layer=c&cbll=" + lat + "," + lng;
        window.open(url, "_blank");

    }


    return (<div className="common-query-window common-query-window-right"
        style={{ visibility: props.windowManager.IsVisible(props.id) ? 'visible' : 'hidden' }}>
        <div className="common-query-window-header">
            <img className="common-query-window-header-icon" src="images/icons/toolbar/sokakgoruntusu.png"></img>
            <span>Sokak Görüntüsü</span>
            <CommonQueryWindowTools
                windowManager={props.windowManager}
                windowId={props.id}
                showNearbySearch={false}
                showMapSelect={false}
                setQueryField={(e) => { }}
                query={null} />
        </div>
        <div className="common-query-window-body layer-list-window-body">
            {
                /*
                     <div className="global-identify-message-container">
                <BiInfoCircle className="global-identify-message-icon" />
                <span className="global-identify-message-text">Sokak görüntüsü için haritaya tıklayın</span>
            </div>
                */

            url && <iframe src={url} width="100%" height="300px"/>
       
            }

            

        </div>
    </div>);
});