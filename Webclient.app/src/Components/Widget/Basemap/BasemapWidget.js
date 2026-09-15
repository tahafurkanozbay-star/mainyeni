import React, { useEffect, useImperativeHandle, useRef } from "react";
import { loadModules } from "esri-loader";
import MapManager from "../../../Store/Managers/MapManager";
import { CommonQueryWindowTools } from "../../Query/_Common/CommonQueryWindowTools";

const BASEMAP_IDS = [
    "topo",
    "streets",
    "satellite",
    "hybrid",
    "dark-gray",
    "gray",
    "national-geographic",
    "oceans",
    "osm",
    "terrain",
    "dark-gray-vector",
    "gray-vector",
    "streets-vector",
    "streets-night-vector",
    "streets-navigation-vector",
    "topo-vector",
    "streets-relief-vector"
];

export const BasemapWidget = React.forwardRef((props, ref) => {
    const galleryContainerRef = useRef(null);

    useImperativeHandle(ref, () => ({
        id: props.id,
        visible: false,
        minimized: false,
        OnShow: () => props.windowManager.ShowWindow("sidebar"),
        OnClose: () => {}
    }), [props.id, props.windowManager]);

    useEffect(() => {
        props.windowManager.RegisterWindow(ref);

        let disposed = false;
        let gallery = null;

        const initialize = async () => {
            const [BasemapGallery, Basemap] = await loadModules([
                "esri/widgets/BasemapGallery",
                "esri/Basemap"
            ]);

            if (disposed || !galleryContainerRef.current) return;

            const source = BASEMAP_IDS
                .map(id => Basemap.fromId(id))
                .filter(Boolean);

            gallery = new BasemapGallery({
                view: MapManager.GetMapView(),
                container: galleryContainerRef.current,
                source
            });
        };

        initialize().catch(error => {
            if (!disposed) console.error("Basemap gallery could not be initialized", error);
        });

        return () => {
            disposed = true;
            gallery?.destroy?.();
            gallery = null;
        };
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
                    src="images/icons/toolbar/basemap.png"
                    alt=""
                    aria-hidden="true"
                />
                <span>Altlık Haritalar</span>
                <CommonQueryWindowTools
                    windowManager={props.windowManager}
                    windowId={props.id}
                    showNearbySearch={false}
                    showMapSelect={false}
                    setQueryField={() => {}}
                    query={null}
                />
            </div>
            <div className="common-query-window-body">
                <div ref={galleryContainerRef} />
            </div>
        </div>
    );
});

BasemapWidget.displayName = "BasemapWidget";
