import React, { useEffect, useRef, useState } from "react";
import { loadModules } from "esri-loader";
import Store from "../../Store/Store";
import { MapReducer_ActionTypes } from "../../Store/Reducers/MapReducer";
import { NavigationBar } from "./NavigationBar";
import { Sidebar } from "./Sidebar";
import MapManager from "../../Store/Managers/MapManager";
import { ToolbarWidget } from "../Widget/Toolbar/ToolbarWidget";
import { BasemapWidget } from "../Widget/Basemap/BasemapWidget";
import { MeasurementWidget } from "../Widget/Measurement/MeasurementWidget";
import { SketchWidget } from "../Widget/Sketch/SketchWidget";
import { GlobalIdentifyWidget } from "../Widget/GlobalIdentify/GlobalIdentifyWidget";
import { StreetViewWidget } from "../Widget/StreetView/StreetViewWidget";
import { BookmarkWidget } from "../Widget/Bookmark/BookmarkWidget";
import { FeedbackWidget } from "../Widget/Feedback/FeedbackWidget";
import { ContextMenuWidget } from "../Widget/ContextMenu/ContextMenuWidget";
import { GoogleMapsBusiness } from "../../Business/GoogleMapsBusiness";
import { DebugHelper } from "../../Toolbox/DebugHelper";
import { LazyManagedWindow } from "../Common/LazyManagedWindow";
import { QUERY_WINDOW_DEFINITIONS } from "../Common/QueryWindowRegistry";
import "./MapComponent.css";

const createResponsivePadding = () => ({
    top: 0,
    bottom: window.innerWidth <= 576 ? 200 : 0,
    left: window.innerWidth <= 576 ? 0 : 400,
    right: 0
});

const openExternalMapUrl = (url) => {
    if (!url) return;
    const opened = window.open(url, "_blank", "noopener,noreferrer");
    if (opened) opened.opener = null;
};

export const MapComponent = ({ windowManager }) => {
    const mapDiv = useRef(null);
    const [mapView, setMapView] = useState(null);
    const sidebarRef = useRef(null);

    const basemapWidgetRef = useRef(null);
    const bookmarkWidgetRef = useRef(null);
    const contextMenuWidgetRef = useRef(null);
    const feedbackWidgetRef = useRef(null);
    const globalIdentifyWidgetRef = useRef(null);
    const measurementWidgetRef = useRef(null);
    const sketchWidgetRef = useRef(null);
    const streetViewWidgetRef = useRef(null);

    useEffect(() => {
        let disposed = false;
        let view = null;
        const handles = [];

        const initializeMap = async () => {
            const mapConfig = MapManager.GetMapConfiguration() || {};
            const [Map, MapView, watchUtils] = await loadModules([
                "esri/Map",
                "esri/views/MapView",
                "esri/core/watchUtils"
            ]);

            if (disposed) return;

            const map = new Map({ basemap: "osm" });
            view = new MapView({
                container: mapDiv.current,
                ui: { components: [] },
                map,
                zoom: 11,
                center: [mapConfig.Centerx ?? 34, mapConfig.Centery ?? 39],
                padding: createResponsivePadding(),
                constraints: {
                    maxZoom: 221,
                    minZoom: 1,
                    rotationEnabled: false
                }
            });

            handles.push(
                watchUtils.whenTrue(view, "updating", () => windowManager.SetMapUpdating(true)),
                watchUtils.whenFalse(view, "updating", () => windowManager.SetMapUpdating(false))
            );

            handles.push(view.popup.on("trigger-action", event => {
                const feature = view.popup.selectedFeature;
                if (!feature?.geometry) return;

                if (event.action.id === "show-on-google") {
                    openExternalMapUrl(GoogleMapsBusiness.CreateRoutesUrlFromPoint(feature.geometry));
                }

                if (event.action.id === "show-on-streetview" || event.action.id === "show-details") {
                    openExternalMapUrl(GoogleMapsBusiness.CreateStreetViewUrlFromPoint(feature.geometry));
                }
            }));

            handles.push(view.on("click", event => {
                if (event.button === 2 || MapManager.GetMobileRightClick()) {
                    MapManager.SetMapClickEvent(event);
                    windowManager.ShowWindow("context-menu-widget");
                } else {
                    windowManager.HideWindow("context-menu-widget");
                }
            }));

            const updatePadding = () => {
                if (view && !view.destroyed) view.padding = createResponsivePadding();
            };
            window.addEventListener("resize", updatePadding, { passive: true });
            handles.push({ remove: () => window.removeEventListener("resize", updatePadding) });

            Store.dispatch({
                type: MapReducer_ActionTypes.SetMapView,
                payload: view
            });

            setMapView(view);
        };

        initializeMap().catch(error => DebugHelper.Log(error));

        return () => {
            disposed = true;
            handles.forEach(handle => {
                try { handle?.remove?.(); } catch (error) { DebugHelper.Log(error); }
            });
            if (view) {
                try {
                    view.container = null;
                    view.destroy?.();
                } catch (error) {
                    DebugHelper.Log(error);
                }
            }
        };
    }, [windowManager]);

    return (
        <div className="esri-map" id="esri-map-container" ref={mapDiv}>
            {mapView && <>
                <NavigationBar id="mainbar" windowManager={windowManager} />
                <Sidebar id="sidebar" windowManager={windowManager} ref={sidebarRef} />
                <ToolbarWidget id="toolbar-widget" windowManager={windowManager} />

                <BasemapWidget id="basemap-widget" windowManager={windowManager} ref={basemapWidgetRef} />
                <BookmarkWidget id="bookmark-widget" windowManager={windowManager} ref={bookmarkWidgetRef} />
                <ContextMenuWidget id="context-menu-widget" windowManager={windowManager} ref={contextMenuWidgetRef} />
                <FeedbackWidget id="feedback-widget" windowManager={windowManager} ref={feedbackWidgetRef} />
                <GlobalIdentifyWidget id="global-identify-widget" windowManager={windowManager} ref={globalIdentifyWidgetRef} />
                <MeasurementWidget id="measurement-widget" windowManager={windowManager} ref={measurementWidgetRef} />
                <SketchWidget id="sketch-widget" windowManager={windowManager} ref={sketchWidgetRef} />
                <StreetViewWidget id="streetview-widget" windowManager={windowManager} ref={streetViewWidgetRef} />

                {QUERY_WINDOW_DEFINITIONS.map(definition => (
                    <LazyManagedWindow
                        key={definition.id}
                        id={definition.id}
                        label={definition.label}
                        component={definition.component}
                        windowManager={windowManager}
                    />
                ))}
            </>}
        </div>
    );
};
