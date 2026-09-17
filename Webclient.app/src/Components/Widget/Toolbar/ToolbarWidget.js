import React, { useEffect, useRef } from "react";
import MapManager from "../../../Store/Managers/MapManager";
import { AppConfig } from "../../../Core/AppConfig";
import { GisGraphicsHelper } from "../../../Toolbox/GisGraphicsHelper";
import "./ToolbarWidget.css";
import { ToolbarWidgetButton } from "./ToolbarWidgetButton";

const FALLBACK_LOCATION = { x: 32.80409955978453, y: 39.94494728389463 };

export const ToolbarWidget = (props) => {
    const initialExtentRef = useRef(null);

    useEffect(() => {
        const mapView = MapManager.GetMapView();
        if (!mapView) return undefined;

        const captureInitialExtent = () => {
            if (!initialExtentRef.current && mapView.extent) {
                initialExtentRef.current = mapView.extent.clone?.() ?? mapView.extent;
            }
        };

        captureInitialExtent();
        const readyHandle = mapView.watch?.("ready", ready => {
            if (ready) captureInitialExtent();
        });

        return () => readyHandle?.remove?.();
    }, []);

    const showWindow = windowId => {
        props.windowManager.ShowWindow(windowId);
    };

    const createLocation = async location => {
        const point = await GisGraphicsHelper.CreatePoint(location);
        const mapView = MapManager.GetMapView();
        if (!mapView) return;

        const graphic = await GisGraphicsHelper.CreateGraphicFromGeometry(point, null);
        MapManager.AddGraphics(graphic, true);
        GisGraphicsHelper.ZoomToGeometry(mapView, point, 15);
    };

    const getUserLocation = () => {
        if (!navigator.geolocation) {
            createLocation(FALLBACK_LOCATION).catch(error => console.error("Location could not be shown", error));
            props.windowManager.ShowWindow("sidebar");
            return;
        }

        navigator.geolocation.getCurrentPosition(
            position => {
                createLocation({
                    x: position.coords.longitude,
                    y: position.coords.latitude
                }).catch(error => console.error("Location could not be shown", error));
            },
            () => {
                createLocation(FALLBACK_LOCATION).catch(error => console.error("Fallback location could not be shown", error));
            },
            { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 }
        );
    };

    const gotoInitialView = () => {
        const mapView = MapManager.GetMapView();
        const initialExtent = initialExtentRef.current;
        if (mapView && initialExtent) {
            mapView.goTo(initialExtent).catch?.(error => console.error("Initial map extent could not be restored", error));
        }
        props.windowManager.ShowWindow("sidebar");
    };

    const openFeedbackPortal = () => {
        window.open("https://ulakbell.ankara.bel.tr/WebForm/basket153basvuru#/", "_blank", "noopener,noreferrer");
    };

    return (
        <div className="toolbarwidget" aria-label="Harita araçları">
            <ToolbarWidgetButton onClick={openFeedbackPortal} image="baskent153.png" tooltipText="Geri Bildirim (Başkent 153)" />
            <ToolbarWidgetButton onClick={() => showWindow("basemap-widget")} image="basemap.png" tooltipText="Altlık Haritalar" />
            <ToolbarWidgetButton onClick={() => showWindow("numbering-query-window")} image="adresarama.png" tooltipText="Adres Arama" />
            <ToolbarWidgetButton onClick={getUserLocation} image="konumbul.png" tooltipText="Konum Bul" />
            <ToolbarWidgetButton onClick={() => showWindow("cityblockparcel-query-window")} image="adaparsel.png" tooltipText="Ada-Parsel Arama" />
            <ToolbarWidgetButton onClick={() => showWindow("measurement-widget")} image="olcumaraci.png" tooltipText="Ölçüm Aracı" />
            <ToolbarWidgetButton onClick={() => showWindow("streetview-widget")} image="sokakgoruntusu.png" tooltipText="Sokak Görüntüsü" />
            <ToolbarWidgetButton onClick={gotoInitialView} image="fullextent.png" tooltipText="Başlangıç görünümüne dön" />
            {AppConfig.App.IsFullVersion && false && (
                <ToolbarWidgetButton onClick={() => showWindow("transit-route-query-window")} image="yoltarifi.png" tooltipText="Yol Tarifi" />
            )}
        </div>
    );
};
