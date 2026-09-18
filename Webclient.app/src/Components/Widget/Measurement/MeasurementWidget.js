import React, { useEffect, useImperativeHandle, useRef, useState } from "react";
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChartArea, faChartLine } from '@fortawesome/free-solid-svg-icons';
import { CommonQueryWindowTools } from "../../Query/_Common/CommonQueryWindowTools";
import MapManager from "../../../Store/Managers/MapManager";
import { createMeasurementController, MEASUREMENT_TOOLS } from "../../../gis-engine/measurementRuntime";
import { createManagedWindowFocus } from "../../Query/_Common/ManagedWindowFocus";
import { createRovingFocusController, focusRovingTarget } from "../../../experience/rovingFocusRuntime";
import "./MeasurementWidget.css";

const TOOL_ITEMS = [
    { id: MEASUREMENT_TOOLS.AREA },
    { id: MEASUREMENT_TOOLS.DISTANCE },
];

export const MeasurementWidget = React.forwardRef((props, ref) => {
    const [mapView, setMapView] = useState(null);
    const [activeTool, setActiveToolState] = useState(MEASUREMENT_TOOLS.NONE);
    const [measurementStatus, setMeasurementStatus] = useState('idle');
    const [, setFocusVersion] = useState(0);
    const controllerRef = useRef(null);
    const unsubscribeRef = useRef(null);
    const toolbarRef = useRef(null);
    const focusLifecycleRef = useRef(null);
    const rovingRef = useRef(null);

    if (!focusLifecycleRef.current) {
        focusLifecycleRef.current = createManagedWindowFocus({
            restoreFocusOnClose: true,
            initialFocusSelector: '[data-roving-focus-id]',
        });
    }
    if (!rovingRef.current) {
        rovingRef.current = createRovingFocusController(TOOL_ITEMS, {
            orientation: 'horizontal',
            loop: true,
            onActiveChange: () => setFocusVersion(version => version + 1),
        });
    }

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
        try { await controller.ensureWidget(); } catch (_) {
            // State subscription exposes loading errors while the shell remains usable.
        }
    };

    const setActiveTool = async (toolName) => {
        const controller = ensureController();
        if (!controller) return;
        try {
            if (activeTool === toolName) { controller.clear(); return; }
            await controller.setTool(toolName);
        } catch (_) {
            // Unsupported/load errors are reflected by controller state.
        }
    };

    const handleToolbarKeyDown = (event) => {
        const move = rovingRef.current?.handleKey(event.key);
        if (!move) return;
        event.preventDefault();
        focusRovingTarget(toolbarRef.current, move.id);
    };

    const activateRovingItem = (index) => {
        rovingRef.current?.setActiveIndex(index);
        setFocusVersion(version => version + 1);
    };

    useImperativeHandle(ref, () => ({
        id: props.id,
        visible: false,
        minimized: false,
        OnShow: () => {
            focusLifecycleRef.current?.captureOpener(document.activeElement);
            props.windowManager.ShowWindow("sidebar");
            initialize();
            focusLifecycleRef.current?.scheduleInitialFocus(document);
        },
        OnClose: () => {
            controllerRef.current?.clear();
            focusLifecycleRef.current?.restoreOpener(document);
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
            focusLifecycleRef.current?.dispose();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const tabIndices = rovingRef.current.getTabIndices();
    const isLoading = measurementStatus === 'loading';
    const statusText = isLoading
        ? 'Ölçüm aracı hazırlanıyor.'
        : activeTool === MEASUREMENT_TOOLS.AREA
            ? 'Alan ölçümü etkin.'
            : activeTool === MEASUREMENT_TOOLS.DISTANCE
                ? 'Mesafe ölçümü etkin.'
                : 'Bir ölçüm aracı seçin.';

    return (
        <section
            className="common-query-window common-query-window-right measurement-widget"
            style={{ visibility: props.windowManager.IsVisible(props.id) ? 'visible' : 'hidden' }}
            aria-labelledby={`${props.id}-title`}
            aria-busy={isLoading}
        >
            <div className="common-query-window-header">
                <img className="common-query-window-header-icon" src="images/icons/toolbar/olcumaraci.png" alt="" />
                <span id={`${props.id}-title`}>Ölçüm Araçları</span>
                <CommonQueryWindowTools windowManager={props.windowManager} windowId={props.id} showNearbySearch={false} showMapSelect={false} setQueryField={() => {}} query={null} />
            </div>
            <div className="common-query-window-body layer-list-window-body measurement-widget-body">
                <div
                    ref={toolbarRef}
                    className="measurement-widget-toolbar"
                    role="toolbar"
                    aria-label="Ölçüm araçları"
                    aria-orientation="horizontal"
                    onKeyDown={handleToolbarKeyDown}
                >
                    <button
                        type="button"
                        data-roving-focus-id={MEASUREMENT_TOOLS.AREA}
                        tabIndex={tabIndices[0]}
                        onFocus={() => activateRovingItem(0)}
                        onClick={() => setActiveTool(MEASUREMENT_TOOLS.AREA)}
                        className="measurement-widget-tool-select-button"
                        aria-pressed={activeTool === MEASUREMENT_TOOLS.AREA}
                        aria-label="Alan ölç"
                        disabled={isLoading}
                    ><FontAwesomeIcon icon={faChartArea} size="2x" aria-hidden="true" /></button>
                    <button
                        type="button"
                        data-roving-focus-id={MEASUREMENT_TOOLS.DISTANCE}
                        tabIndex={tabIndices[1]}
                        onFocus={() => activateRovingItem(1)}
                        onClick={() => setActiveTool(MEASUREMENT_TOOLS.DISTANCE)}
                        className="measurement-widget-tool-select-button"
                        aria-pressed={activeTool === MEASUREMENT_TOOLS.DISTANCE}
                        aria-label="Mesafe ölç"
                        disabled={isLoading}
                    ><FontAwesomeIcon icon={faChartLine} size="2x" aria-hidden="true" /></button>
                </div>
                <p className="measurement-widget-status" role="status" aria-live="polite">{statusText}</p>
                <div id="measurementDiv" className="measurement-widget-result" role="region" aria-label="Ölçüm sonucu" />
            </div>
        </section>
    );
});