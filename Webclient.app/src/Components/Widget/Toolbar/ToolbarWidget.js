import { loadModules } from "esri-loader";
import React, { useEffect, useState } from "react";
import MapManager from "../../../Store/Managers/MapManager";
import "./ToolbarWidget.css";
import { ToolbarWidgetButton } from "./ToolbarWidgetButton";
import {Constants_MessageType} from "../../../Core/Constants";
import { DatetimeHelper } from "../../../Toolbox/DatetimeHelper";
import {AppConfig} from "../../../Core/AppConfig";
//import { Constants_MessageType, Constants_UserMesssages } from "../../Core/Constants";
import { BiAbacus, BiEnvelope, BiTargetLock } from "react-icons/bi";
import { GisGraphicsHelper } from "../../../Toolbox/GisGraphicsHelper";


export const ToolbarWidget = (props) => {

    const [extentHistory, setExtentHistory] = useState([]);
    const [extentIndex, setExtentIndex] = useState(0);
    const [addExtent, setAddExtent] = useState(true);
    const [mapView, setMapView] = useState(null);
    
    useEffect(() => {

        const extChangeHandler = extentChangeHandler;
        return loadModules(["esri/core/watchUtils"]).then(([watchUtils]) => {

            let mapView = MapManager.GetMapView();
            setMapView(mapView);

            let _extentHistory = [];
            if (mapView.extent != null) {
                _extentHistory.push(mapView.extent);
                setExtentHistory(_extentHistory);
            }

            watchUtils.when(mapView, "ready", () => {
                watchUtils.whenOnce(mapView, "extent", () => {
                    watchUtils.whenTrue(mapView, 'stationary', (evt) => {

                        if (evt) {
                            extentChangeHandler();
                        }
                    });
                });
            });
        });

    }, []);


    const extentChangeHandler = () => {

        if (addExtent) {

            let mapView = MapManager.GetMapView();

            let _extent = mapView.extent;

            let _exhistory = extentHistory;
            _exhistory.push(_extent);

            setExtentHistory(_exhistory);
            setExtentIndex  (_exhistory.length - 1);
        }
    }

    const zoomIn = () => {

        let zoomLevel = mapView.zoom;
        zoomLevel++;

        mapView.goTo({
            zoom: zoomLevel
        });
    }

    const zoomOut = () => {
        let mapView = MapManager.GetMapView();
        let zoomLevel = mapView.zoom;
        zoomLevel--;
        mapView.goTo({
            zoom: zoomLevel
        });
    }


    const toggleOverviewMap = () => {
        let isVisible = props.getWindowVisibility("overviewmapwindow");
        if (isVisible) {
            props.hideWindow("overviewmapwindow");
        }
        else {
            props.showWindow("overviewmapwindow");
        }
    }

    const gotoPreviousView = () => {

        setAddExtent(false);

        let mapView = MapManager.GetMapView();

        let targetIndex = extentIndex - 1;
        if (targetIndex > 0 && targetIndex < extentHistory.length) {

            setExtentIndex(targetIndex);

            let targetExtent = extentHistory[targetIndex];
            mapView.goTo(targetExtent);
        }
    }

    const gotoNextView = () => {

        setAddExtent(false);

        let mapView = MapManager.GetMapView();

        let targetIndex = extentIndex + 1;

        if (targetIndex > 0 && targetIndex < extentHistory.length) {

            setExtentIndex(targetIndex);
            let targetExtent = extentHistory[targetIndex];
            mapView.goTo(targetExtent);
        }
    }

    const gotoInitialView = () => {

        setAddExtent(false);

        let targetExtent = extentHistory[0];
        mapView.goTo(targetExtent);
        props.windowManager.ShowWindow("sidebar")

    }

    const clearMap = (e) => {
        mapView.graphics.removeAll();
    }

    const printMap = () => {

        let mapView = MapManager.GetMapView();

        mapView.takeScreenshot({
            width: 1920,
            height: 1080
        }).then(function (screenshot) {

            let html="<html><head><script>function step1(){setTimeout('step2()', 10);}" +
            "function step2(){window.print();window.close()}\n" +
            "</script></head><body onload='step1()'>\n" +
            "<div style='border:1px solid gray;'>" +
            "<div style='font-size:24px;font-family:Ubuntu,SegoeUI;padding:5px;'>"+AppConfig.App.Title1+" | "+AppConfig.App.Title2+" (" + DatetimeHelper.GetFormatted(new Date()) + ")</div>" +
            "<div style='border:1px solid gray;padding:0;margin:0;'>" +
            "<img style='width:100%' src='" + screenshot.dataUrl + "' />" +
            "</div>" +
            "</div>" +
            +"</body></html>";

            let Pagelink = "about:blank";
            let pwa = window.open(Pagelink, "_new");
            pwa.document.open();
            pwa.document.write(html);
            pwa.document.close();
            props.windowManager.ShowWindow("sidebar")

        });

    }

    const showwindowCallback=(_windowid)=>{
        props.windowManager.ShowWindow(_windowid)
    }
    const getUserLocation=()=>{
        
        const mapConfig = MapManager.GetMapConfiguration();
        //let location = { x: mapConfig.Centerx, y: mapConfig.Centery }; //TODO: Geçici olarak gölbaşı merkeze ayarlandı değiştirilecek
        let location = { x: 32.80409955978453, y: 39.94494728389463 };

        if (!navigator.geolocation) {
            //props.windowManager.ShowMessage(Constants_MessageType.Error, Constants_UserMesssages.LOCATION_REJECTED);
            createLocation(location);
            props.windowManager.ShowWindow("sidebar")
        }
        else{
            //props.windowManager.ShowMessage(Constants_MessageType.Success, Constants_UserMesssages.LOCATION_ALLOWED);

            navigator.geolocation.getCurrentPosition((_location) => {

                location = {
                    x: _location.coords.longitude,
                    y: _location.coords.latitude,
                };

                createLocation(location);
                

            }, (error) => {

               // props.windowManager.ShowMessage(Constants_MessageType.Error, Constants_UserMesssages.LOCATION_REJECTED);
                createLocation(location);
            });
        }
    }

    const createLocation = (_location) => {

        GisGraphicsHelper.CreatePoint(_location).then((_point) => {

            const mapView = MapManager.GetMapView();
            GisGraphicsHelper.CreateGraphicFromGeometry(_point, null).then((_graphic) => {
                MapManager.AddGraphics(_graphic, true);
                GisGraphicsHelper.ZoomToGeometry(mapView, _point, 15);
            });
        });
    }

  




    return (<>
        <div className="toolbarwidget">
       
        <ToolbarWidgetButton onClick={(e) => window.open("https://baskent153.ankara.bel.tr", "_blank")}  image="baskent153.png" tooltipText="Geri Bildirim(Başkent 153)"/>         
            <ToolbarWidgetButton onClick={()=>showwindowCallback("basemap-widget")} image="basemap.png" tooltipText="Altlık Haritalar"/>      
            <ToolbarWidgetButton onClick={()=>showwindowCallback("numbering-query-window")} image="adresarama.png" tooltipText="Adres Arama"/>    
            <ToolbarWidgetButton onClick={()=>getUserLocation()} image="konumbul.png" tooltipText="Konum Bul"/> 
            <ToolbarWidgetButton onClick={()=>showwindowCallback("cityblockparcel-query-window")} image="adaparsel.png" tooltipText="Ada-Parsel Arama"/>           
            <ToolbarWidgetButton onClick={()=>showwindowCallback("measurement-widget")} image="olcumaraci.png" tooltipText="Ölçüm Aracı"/>            
            <ToolbarWidgetButton onClick={()=>showwindowCallback("streetview-widget")} image="sokakgoruntusu.png" tooltipText="Sokak Görüntüsü"/>
            <ToolbarWidgetButton onClick={()=>gotoInitialView()} image="fullextent.png" tooltipText="Başlangıç görünümüne dön"/>           
            {
                AppConfig.App.IsFullVersion && false &&  <ToolbarWidgetButton onClick={()=>showwindowCallback("transit-route-query-window")} image="yoltarifi.png" tooltipText="Yol Tarifi"/>
            }
            
        </div>
    </>);
}