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
import { ExperienceMapModeBridge } from "./ExperienceMapModeBridge";
import { createViewStateBridge } from "../../gis-engine/viewState";
import {
    bindMapViewState,
    createMapViewOptions,
    createResponsivePadding,
    createViewPerformanceMonitor
} from "../../gis-engine/viewRuntime";
import "./MapComponent.css";

const openExternalMapUrl = (url) => {
    if (!url) return;
    const opened = window.open(url, "_blank", "noopener,noreferrer");
    if (opened) opened.opener = null;
};

export const MapComponent = ({ windowManager }) => {
    const mapDiv = useRef(null);
    const activeViewModeRef = useRef("2d");
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
        let bridge = null;
        let performanceMonitor = null;
        let unbindViewState = () => {};
        const handles = [];

        const initializeMap = async () => {
            const mapConfig = MapManager.GetMapConfiguration() || {};
            const [Map, MapView, watchUtils] = await loadModules([
                "esri/Map",
                "esri/views/MapView",
                "esri/core/watchUtils"
            ]);

            if (disposed) return;

            // Preserve the application's existing OSM basemap contract. The
            // shared 3D runtime reuses this exact map so layer visibility,
            // basemap and selection state are not forked across view modes.
            const map = new Map({ basemap: "osm" });
            view = new MapView(createMapViewOptions({
                container: mapDiv.current,
                map,
                configuration: mapConfig,
                viewportWidth: window.innerWidth
            }));

            bridge = createViewStateBridge({ mode: "2d" }, {
                onListenerError: error => DebugHelper.Log(error)
            });
            MapManager.SetViewStateBridge(bridge);

            unbindViewState = bindMapViewState(view, bridge, {
                publishInitial: true,
                applyIncoming: true,
                goToOptions: { duration: 0, animate: false },
                onApplyError: error => DebugHelper.Log(error)
            });

            performanceMonitor = createViewPerformanceMonitor(view, {
                slowThresholdMs: 250
            });
            MapManager.SetViewPerformanceMonitor(performanceMonitor);

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
                if (view && !view.destroyed) {
                    view.padding = createResponsivePadding(window.innerWidth, mapConfig);
                }
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
            activeViewModeRef.current = "2d";
            unbindViewState();
            performanceMonitor?.dispose?.();
            MapManager.ClearViewPerformanceMonitor(performanceMonitor);
            MapManager.ClearViewStateBridge(bridge);
            bridge?.destroy?.();

            handles.forEach(handle => {
                try { handle?.remove?.(); } catch (error) { DebugHelper.Log(error); }
            });

            windowManager.SetMapUpdating(false);
            Store.dispatch({
                type: MapReducer_ActionTypes.SetMapView,
                payload: null
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
        <div
            className="esri-map"
            id="esri-map-container"
            ref={mapDiv}
            tabIndex={-1}
            aria-label="Kent Rehberi ana harita çalışma alanı"
        >
            {mapView && <>
                <ExperienceMapModeBridge mapView={mapView} modeRef={activeViewModeRef} />
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
