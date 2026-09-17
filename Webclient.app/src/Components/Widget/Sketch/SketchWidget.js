import React, { useEffect, useImperativeHandle, useRef } from "react";
import { loadArcgisModules as loadModules } from "../../../gis-engine/arcgisModuleRuntime";
import MapManager from "../../../Store/Managers/MapManager";
import { CommonQueryWindowTools } from "../../Query/_Common/CommonQueryWindowTools";
import "./SketchWidget.css";

export const SketchWidget = React.forwardRef((props, ref) => {
    const sketchRef = useRef(null);
    const sketchLayerRef = useRef(null);
    const containerRef = useRef(null);

    const initialize = async () => {
        if (sketchRef.current || !containerRef.current) return;
        const mapView = MapManager.GetMapView();
        if (!mapView?.map) return;
        const [Sketch, GraphicsLayer] = await loadModules(["esri/widgets/Sketch", "esri/layers/GraphicsLayer"]);
        const layer = new GraphicsLayer({ title: "Kullanıcı çizimleri" });
        mapView.map.add(layer);
        sketchLayerRef.current = layer;
        sketchRef.current = new Sketch({
            layer,
            view: mapView,
            container: containerRef.current,
            activeTool: null,
            iconClass: "sketch-icon"
        });
    };

    const clearSketch = () => {
        sketchRef.current?.cancel?.();
        sketchLayerRef.current?.removeAll?.();
    };

    useImperativeHandle(ref, () => ({
        id: props.id,
        visible: false,
        minimized: false,
        OnShow: () => {
            props.windowManager.ShowWindow("sidebar");
            initialize().catch(error => console.error("Sketch widget could not be initialized", error));
        },
        OnClose: clearSketch
    }), [props.id, props.windowManager]);

    useEffect(() => {
        props.windowManager.RegisterWindow(ref);
        return () => {
            const map = MapManager.GetMapView()?.map;
            clearSketch();
            sketchRef.current?.destroy?.();
            if (sketchLayerRef.current && map) map.remove(sketchLayerRef.current);
            sketchRef.current = null;
            sketchLayerRef.current = null;
        };
    }, [props.windowManager, ref]);

    return (
        <div className="common-query-window common-query-window-right" style={{ visibility: props.windowManager.IsVisible(props.id) ? 'visible' : 'hidden' }}>
            <div className="common-query-window-header">
                <img className="common-query-window-header-icon" src="images/icons/toolbar/cizimaraci.png" alt="" aria-hidden="true" />
                <span>Çizim Araçları</span>
                <CommonQueryWindowTools windowManager={props.windowManager} windowId={props.id} showNearbySearch={false} showMapSelect={false} setQueryField={() => {}} query={null} />
            </div>
            <div className="common-query-window-body layer-list-window-body">
                <div ref={containerRef} />
            </div>
        </div>
    );
});

SketchWidget.displayName = "SketchWidget";
