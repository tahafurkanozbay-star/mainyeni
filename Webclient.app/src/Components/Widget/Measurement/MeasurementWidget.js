import React, { useEffect, useImperativeHandle, useRef } from "react";
import { loadModules } from "esri-loader";
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChartArea, faChartLine } from '@fortawesome/free-solid-svg-icons';
import { CommonQueryWindowTools } from "../../Query/_Common/CommonQueryWindowTools";
import MapManager from "../../../Store/Managers/MapManager";
import "./MeasurementWidget.css";

export const MeasurementWidget = React.forwardRef((props, ref) => {
    const measurementRef = useRef(null);
    const containerRef = useRef(null);

    const initialize = async () => {
        if (measurementRef.current || !containerRef.current) return;
        const [Measurement] = await loadModules(["esri/widgets/Measurement"]);
        measurementRef.current = new Measurement({
            view: MapManager.GetMapView(),
            container: containerRef.current,
            activeTool: ""
        });
    };

    useImperativeHandle(ref, () => ({
        id: props.id,
        visible: false,
        minimized: false,
        OnShow: () => {
            props.windowManager.ShowWindow("sidebar");
            initialize().catch(error => console.error("Measurement widget could not be initialized", error));
        },
        OnClose: () => measurementRef.current?.clear?.()
    }), [props.id, props.windowManager]);

    useEffect(() => {
        props.windowManager.RegisterWindow(ref);
        return () => {
            measurementRef.current?.destroy?.();
            measurementRef.current = null;
        };
    }, [props.windowManager, ref]);

    const setActiveTool = toolName => {
        if (measurementRef.current) measurementRef.current.activeTool = toolName;
    };

    return (
        <div className="common-query-window common-query-window-right" style={{ visibility: props.windowManager.IsVisible(props.id) ? 'visible' : 'hidden' }}>
            <div className="common-query-window-header">
                <img className="common-query-window-header-icon" src="images/icons/toolbar/olcumaraci.png" alt="" aria-hidden="true" />
                <span>Ölçüm Araçları</span>
                <CommonQueryWindowTools windowManager={props.windowManager} windowId={props.id} showNearbySearch={false} showMapSelect={false} setQueryField={() => {}} query={null} />
            </div>
            <div className="common-query-window-body layer-list-window-body">
                <div className="measurement-widget-tool-select">
                    <button type="button" onClick={() => setActiveTool("area")} className="measurement-widget-tool-select-button" aria-label="Alan ölç"><FontAwesomeIcon icon={faChartArea} size="2x" aria-hidden="true" /></button>
                    <button type="button" onClick={() => setActiveTool("distance")} className="measurement-widget-tool-select-button" aria-label="Mesafe ölç"><FontAwesomeIcon icon={faChartLine} size="2x" aria-hidden="true" /></button>
                </div>
                <div ref={containerRef} />
            </div>
        </div>
    );
});

MeasurementWidget.displayName = "MeasurementWidget";
