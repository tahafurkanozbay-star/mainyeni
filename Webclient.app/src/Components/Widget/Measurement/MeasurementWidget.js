import React, { useEffect, useImperativeHandle, useRef, useState } from "react";
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChartArea, faChartLine } from '@fortawesome/free-solid-svg-icons';
import { CommonQueryWindowTools } from "../../Query/_Common/CommonQueryWindowTools";
import { createManagedWindowFocusLifecycle } from "../../Query/_Common/ManagedWindowFocus";
import MapManager from "../../../Store/Managers/MapManager";
import { createMeasurementController, MEASUREMENT_TOOLS } from "../../../gis-engine/measurementRuntime";
import "./MeasurementWidget.css";

const STATUS_LABELS = {
    idle: 'Ölçüm aracı seçin.',
    loading: 'Ölçüm araçları hazırlanıyor…',
    ready: 'Ölçüm aracı hazır.',
    measuring: 'Harita üzerinde ölçüm yapılıyor.',
    error: 'Ölçüm aracı hazırlanamadı. Tekrar deneyin.',
};

export const MeasurementWidget = React.forwardRef((props, ref) => {
    const rootRef = useRef(null);
    const [mapView, setMapView] = useState(null);
    const [activeTool, setActiveToolState] = useState(MEASUREMENT_TOOLS.NONE);
    const [measurementStatus, setMeasurementStatus] = useState('idle');
    const controllerRef = useRef(null);
    const unsubscribeRef = useRef(null);
    const focusLifecycleRef = useRef(null);

    const ensureController = () => {
        const view = MapManager.GetMapView() || mapView;
        if (!view) return null;

        if (!controllerRef.current || controllerRef.current.destroyed) {
            controllerRef.current = createMeasurementController({ view, container: "measurementDiv" });
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
        try { await controller.ensureWidget(); } catch (_) { /* controller state announces the error */ }
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
        } catch (_) { /* controller state announces unsupported/load errors */ }
    };

    const handleToolbarKeyDown = (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        const buttons = Array.from(event.currentTarget.querySelectorAll('button:not(:disabled)'));
        if (!buttons.length) return;
        const currentIndex = buttons.indexOf(document.activeElement);
        let nextIndex = currentIndex < 0 ? 0 : currentIndex;
        if (event.key === 'Home') nextIndex = 0;
        if (event.key === 'End') nextIndex = buttons.length - 1;
        if (event.key === 'ArrowRight') nextIndex = (nextIndex + 1) % buttons.length;
        if (event.key === 'ArrowLeft') nextIndex = (nextIndex - 1 + buttons.length) % buttons.length;
        event.preventDefault();
        buttons[nextIndex]?.focus({ preventScroll: true });
    };

    useImperativeHandle(ref, () => ({
        id: props.id,
        visible: false,
        minimized: false,
        OnShow: () => {
            props.windowManager.ShowWindow("sidebar");
            focusLifecycleRef.current?.open({ root: rootRef.current, initialFocusSelector: '.measurement-widget-tool-select-button:not([disabled])' });
            initialize();
        },
        OnClose: () => {
            controllerRef.current?.clear();
            focusLifecycleRef.current?.close();
        },
    }));

    useEffect(() => {
        focusLifecycleRef.current = createManagedWindowFocusLifecycle();
        props.windowManager.RegisterWindow(ref);
        setMapView(MapManager.GetMapView());
        return () => {
            focusLifecycleRef.current?.dispose();
            focusLifecycleRef.current = null;
            unsubscribeRef.current?.();
            unsubscribeRef.current = null;
            controllerRef.current?.destroy();
            controllerRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const statusLabel = STATUS_LABELS[measurementStatus] || STATUS_LABELS.idle;

    return (
        <section
            ref={rootRef}
            className="common-query-window common-query-window-right measurement-widget"
            style={{ visibility: props.windowManager.IsVisible(props.id) ? 'visible' : 'hidden' }}
            aria-labelledby={`${props.id}-title`}
            aria-describedby={`${props.id}-status`}
        >
            <div className="common-query-window-header">
                <img className="common-query-window-header-icon" src="images/icons/toolbar/olcumaraci.png" alt="" aria-hidden="true" />
                <span id={`${props.id}-title`}>Ölçüm Araçları</span>
                <CommonQueryWindowTools windowManager={props.windowManager} windowId={props.id} showNearbySearch={false} showMapSelect={false} setQueryField={() => {}} query={null} />
            </div>
            <div className="common-query-window-body layer-list-window-body measurement-widget-body" aria-busy={measurementStatus === 'loading'}>
                <p id={`${props.id}-status`} className="measurement-widget-status" role="status" aria-live="polite">{statusLabel}</p>
                <div className="measurement-widget-toolbar" role="toolbar" aria-label="Ölçüm araçları" onKeyDown={handleToolbarKeyDown}>
                    <button type="button" onClick={() => setActiveTool(MEASUREMENT_TOOLS.AREA)} className="measurement-widget-tool-select-button" aria-pressed={activeTool === MEASUREMENT_TOOLS.AREA} aria-label="Alan ölç" disabled={measurementStatus === 'loading'}>
                        <FontAwesomeIcon icon={faChartArea} size="2x" aria-hidden="true" />
                        <span>Alan</span>
                    </button>
                    <button type="button" onClick={() => setActiveTool(MEASUREMENT_TOOLS.DISTANCE)} className="measurement-widget-tool-select-button" aria-pressed={activeTool === MEASUREMENT_TOOLS.DISTANCE} aria-label="Mesafe ölç" disabled={measurementStatus === 'loading'}>
                        <FontAwesomeIcon icon={faChartLine} size="2x" aria-hidden="true" />
                        <span>Mesafe</span>
                    </button>
                </div>
                <div id="measurementDiv" className="measurement-widget-result" aria-live="polite" aria-label="Ölçüm sonucu" />
            </div>
        </section>
    );
});
