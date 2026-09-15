import React, { useEffect, useImperativeHandle, useRef, useState } from "react";
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChartArea, faChartLine } from '@fortawesome/free-solid-svg-icons';
import { CommonQueryWindowTools } from "../../Query/_Common/CommonQueryWindowTools";
import MapManager from "../../../Store/Managers/MapManager";
import { createMeasurementController, MEASUREMENT_TOOLS } from "../../../gis-engine/measurementRuntime";
import "./MeasurementWidget.css";

export const MeasurementWidget = React.forwardRef((props, ref) => {
    const [mapView, setMapView] = useState(null);
    const [activeTool, setActiveToolState] = useState(MEASUREMENT_TOOLS.NONE);
    const [measurementStatus, setMeasurementStatus] = useState('idle');
    const controllerRef = useRef(null);
    const unsubscribeRef = useRef(null);

    const ensureController = () => {
        const view = MapManager.GetMapView() || mapView;
        if (!view) return null;

        if (!controllerRef.current || controllerRef.current.destroyed) {
            controllerRef.current = createMeasurementController({
                view,
                container: "measurementDiv",
            });
            unsubscribeRef.current?.();
            unsubscribeRef.current = controllerRef.current.subscribe((state) => {
                setActiveToolState(state.activeTool);
                setMeasurementStatus(state.status);
            });
        } else {
            controllerRef.current.setView(view);
            controllerRef.current.setContainer("measurementDiv");
        }
        return controllerRef.current;
    };

    const initialize = async () => {
        const view = MapManager.GetMapView();
        setMapView(view);
        const controller = ensureController();
        if (!controller) return;
        try {
            await controller.ensureWidget();
        } catch (_) {
            // State subscription exposes the loading error; the widget shell stays usable.
        }
    };

    const setActiveTool = async (toolName) => {
        const controller = ensureController();
        if (!controller) return;
        try {
            if (activeTool === toolName) {
                controller.clear();
                return;
            }
            await controller.setTool(toolName);
        } catch (_) {
            // Unsupported/load errors are reflected by controller state.
        }
    };

    useImperativeHandle(ref, () => ({
        id: props.id,
        visible: false,
        minimized: false,
        OnShow: () => {
            props.windowManager.ShowWindow("sidebar");
            initialize();
        },
        OnClose: () => {
            controllerRef.current?.clear();
        },
    }));

    useEffect(() => {
        props.windowManager.RegisterWindow(ref);
        setMapView(MapManager.GetMapView());

        return () => {
            unsubscribeRef.current?.();
            unsubscribeRef.current = null;
            controllerRef.current?.destroy();
            controllerRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <div
            className="common-query-window common-query-window-right"
            style={{ visibility: props.windowManager.IsVisible(props.id) ? 'visible' : 'hidden' }}
        >
            <div className="common-query-window-header">
                <img className="common-query-window-header-icon" src="images/icons/toolbar/olcumaraci.png" alt="" />
                <span>Ölçüm Araçları</span>
                <CommonQueryWindowTools
                    windowManager={props.windowManager}
                    windowId={props.id}
                    showNearbySearch={false}
                    showMapSelect={false}
                    setQueryField={() => {}}
                    query={null}
                />
            </div>
            <div className="common-query-window-body layer-list-window-body">
                <div role="toolbar" aria-label="Ölçüm araçları">
                    <button
                        type="button"
                        onClick={() => setActiveTool(MEASUREMENT_TOOLS.AREA)}
                        className="measurement-widget-tool-select-button"
                        aria-pressed={activeTool === MEASUREMENT_TOOLS.AREA}
                        aria-label="Alan ölç"
                        disabled={measurementStatus === 'loading'}
                    >
                        <FontAwesomeIcon icon={faChartArea} size="2x" aria-hidden="true" />
                    </button>
                    <button
                        type="button"
                        onClick={() => setActiveTool(MEASUREMENT_TOOLS.DISTANCE)}
                        className="measurement-widget-tool-select-button"
                        aria-pressed={activeTool === MEASUREMENT_TOOLS.DISTANCE}
                        aria-label="Mesafe ölç"
                        disabled={measurementStatus === 'loading'}
                    >
                        <FontAwesomeIcon icon={faChartLine} size="2x" aria-hidden="true" />
                    </button>
                </div>
                <div id="measurementDiv" aria-live="polite" />
            </div>
        </div>
    );
});
