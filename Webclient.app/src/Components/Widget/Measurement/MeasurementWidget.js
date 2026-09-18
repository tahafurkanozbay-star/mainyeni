import React, { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChartArea, faChartLine } from '@fortawesome/free-solid-svg-icons';
import { CommonQueryWindowTools } from "../../Query/_Common/CommonQueryWindowTools";
import { createManagedWindowFocusLifecycle } from "../../Query/_Common/ManagedWindowFocus";
import MapManager from "../../../Store/Managers/MapManager";
import { createMeasurementController, MEASUREMENT_TOOLS } from "../../../gis-engine/measurementRuntime";
import "./MeasurementWidget.css";

const TOOL_ORDER = [MEASUREMENT_TOOLS.AREA, MEASUREMENT_TOOLS.DISTANCE];
const TOOL_LABELS = {
    [MEASUREMENT_TOOLS.AREA]: 'Alan ölç',
    [MEASUREMENT_TOOLS.DISTANCE]: 'Mesafe ölç',
};

export const MeasurementWidget = React.forwardRef((props, ref) => {
    const [mapView, setMapView] = useState(null);
    const [activeTool, setActiveToolState] = useState(MEASUREMENT_TOOLS.NONE);
    const [measurementStatus, setMeasurementStatus] = useState('idle');
    const controllerRef = useRef(null);
    const unsubscribeRef = useRef(null);
    const rootRef = useRef(null);
    const toolbarRef = useRef(null);
    const focusLifecycleRef = useRef(null);

    if (!focusLifecycleRef.current && typeof document !== 'undefined') {
        focusLifecycleRef.current = createManagedWindowFocusLifecycle(document);
    }

    const ensureController = useCallback(() => {
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
    }, [mapView]);

    const initialize = useCallback(async () => {
        const view = MapManager.GetMapView();
        setMapView(view);
        const controller = ensureController();
        if (!controller) return;
        try {
            await controller.ensureWidget();
        } catch (_) {
            // State subscription exposes the loading error; the widget shell stays usable.
        }
    }, [ensureController]);

    const setActiveTool = useCallback(async (toolName) => {
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
    }, [activeTool, ensureController]);

    const moveToolbarFocus = useCallback((currentTool, direction) => {
        const currentIndex = TOOL_ORDER.indexOf(currentTool);
        const nextIndex = direction === 'first'
            ? 0
            : direction === 'last'
                ? TOOL_ORDER.length - 1
                : (currentIndex + direction + TOOL_ORDER.length) % TOOL_ORDER.length;
        toolbarRef.current?.querySelector(`[data-measurement-tool="${TOOL_ORDER[nextIndex]}"]`)?.focus();
    }, []);

    const onToolKeyDown = useCallback((event, tool) => {
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
            event.preventDefault();
            moveToolbarFocus(tool, 1);
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
            event.preventDefault();
            moveToolbarFocus(tool, -1);
        } else if (event.key === 'Home') {
            event.preventDefault();
            moveToolbarFocus(tool, 'first');
        } else if (event.key === 'End') {
            event.preventDefault();
            moveToolbarFocus(tool, 'last');
        }
    }, [moveToolbarFocus]);

    useImperativeHandle(ref, () => ({
        id: props.id,
        visible: false,
        minimized: false,
        OnShow: () => {
            props.windowManager.ShowWindow("sidebar");
            focusLifecycleRef.current?.open({
                root: rootRef.current,
                initialFocusSelector: '[data-measurement-tool]:not([disabled])',
                restorePolicy: 'if-focus-within',
            });
            initialize();
        },
        OnClose: () => {
            controllerRef.current?.clear();
            focusLifecycleRef.current?.close();
        },
    }), [initialize, props.id, props.windowManager]);

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
    }, [props.windowManager, ref]);

    const busy = measurementStatus === 'loading';
    const statusMessage = measurementStatus === 'loading'
        ? 'Ölçüm aracı hazırlanıyor.'
        : measurementStatus === 'error'
            ? 'Ölçüm aracı yüklenemedi. Tekrar deneyebilirsiniz.'
            : activeTool === MEASUREMENT_TOOLS.NONE
                ? 'Alan veya mesafe ölçümünü seçin.'
                : `${TOOL_LABELS[activeTool] ?? 'Ölçüm'} etkin.`;

    return (
        <section
            ref={rootRef}
            className="common-query-window common-query-window-right measurement-widget"
            style={{ visibility: props.windowManager.IsVisible(props.id) ? 'visible' : 'hidden' }}
            aria-labelledby={`${props.id}-measurement-title`}
            aria-busy={busy || undefined}
        >
            <header className="common-query-window-header">
                <img className="common-query-window-header-icon" src="images/icons/toolbar/olcumaraci.png" alt="" aria-hidden="true" />
                <span id={`${props.id}-measurement-title`}>Ölçüm Araçları</span>
                <CommonQueryWindowTools
                    windowManager={props.windowManager}
                    windowId={props.id}
                    showNearbySearch={false}
                    showMapSelect={false}
                    setQueryField={() => {}}
                    query={null}
                />
            </header>
            <div className="common-query-window-body layer-list-window-body measurement-widget__body">
                <p className="measurement-widget__intro">Harita üzerinde alan veya mesafe ölçmek için bir araç seçin. Ok tuşlarıyla araçlar arasında geçiş yapabilirsiniz.</p>
                <div ref={toolbarRef} className="measurement-widget__toolbar" role="toolbar" aria-label="Ölçüm araçları" aria-orientation="horizontal">
                    {TOOL_ORDER.map(tool => (
                        <button
                            key={tool}
                            type="button"
                            data-measurement-tool={tool}
                            onClick={() => setActiveTool(tool)}
                            onKeyDown={event => onToolKeyDown(event, tool)}
                            className="measurement-widget-tool-select-button"
                            aria-pressed={activeTool === tool}
                            disabled={busy}
                        >
                            <FontAwesomeIcon icon={tool === MEASUREMENT_TOOLS.AREA ? faChartArea : faChartLine} aria-hidden="true" />
                            <span>{TOOL_LABELS[tool]}</span>
                        </button>
                    ))}
                </div>
                <div className="measurement-widget__status" role="status" aria-live="polite" aria-atomic="true">
                    {statusMessage}
                </div>
                <div id="measurementDiv" className="measurement-widget__result" role="region" aria-label="Ölçüm sonucu" aria-live="polite" />
            </div>
        </section>
    );
});

MeasurementWidget.displayName = 'MeasurementWidget';
