import React, { useCallback, useEffect, useRef, useState } from "react";
import MapManager from "../../Store/Managers/MapManager";
import { DebugHelper } from "../../Toolbox/DebugHelper";
import {
    applyViewStateToMapView,
    snapshotMapViewState
} from "../../gis-engine/viewRuntime";
import {
    applyViewStateToSceneView,
    bindSceneState,
    createSceneView,
    destroySceneView,
    snapshotSceneState
} from "../../gis-engine/sceneRuntime";
import { createViewState } from "../../gis-engine/viewState";
import {
    EXPERIENCE_ANNOUNCEMENT_EVENT,
    EXPERIENCE_COMMAND_EVENT,
    EXPERIENCE_MAP_MODE_EVENT
} from "../../experience/experienceRuntime";

const DEFAULT_SCENE_TILT = 45;

const dispatchExperienceEvent = (type, detail) => {
    if (typeof window === "undefined" || typeof CustomEvent === "undefined") return false;
    return window.dispatchEvent(new CustomEvent(type, { detail }));
};

const announce = (message, politeness = "polite") => dispatchExperienceEvent(
    EXPERIENCE_ANNOUNCEMENT_EVENT,
    { message, politeness }
);

const publishMode = (mode, source = "map-runtime") => dispatchExperienceEvent(
    EXPERIENCE_MAP_MODE_EVENT,
    { mode, source }
);

const normalizeSceneStateFromMap = (mapView, bridge) => {
    const current = snapshotMapViewState(mapView, bridge?.getState?.() || {});
    return createViewState({
        ...current,
        mode: "3d",
        tilt: Number.isFinite(Number(current.tilt)) && Number(current.tilt) > 0
            ? Number(current.tilt)
            : DEFAULT_SCENE_TILT
    });
};

const normalizeMapStateFromScene = (sceneView, bridge) => {
    const current = snapshotSceneState(sceneView, bridge?.getState?.() || {});
    return createViewState({
        ...current,
        mode: "2d",
        zoom: null,
        tilt: 0
    });
};

/**
 * Owns the lazy 3D SceneView lifecycle without introducing a second map model.
 *
 * The current MapView and the SceneView share the exact same ArcGIS Map instance,
 * so basemap/layer visibility changes stay consistent. Camera/state is exchanged
 * through the repository's existing view-state bridge. The SceneView is created
 * only after the first explicit 3D request, which keeps initial 2D startup cost
 * unchanged for the majority path.
 */
export function ExperienceMapModeBridge({ mapView, modeRef }) {
    const sceneHostRef = useRef(null);
    const sceneRef = useRef(null);
    const unbindSceneRef = useRef(() => {});
    const disposedRef = useRef(false);
    const transitionRef = useRef(Promise.resolve());
    const [activeMode, setActiveMode] = useState("2d");
    const [sceneReady, setSceneReady] = useState(false);

    const setMode = useCallback((mode) => {
        if (modeRef) modeRef.current = mode;
        setActiveMode(mode);
    }, [modeRef]);

    const ensureScene = useCallback(async () => {
        if (sceneRef.current?.view && !sceneRef.current.view.destroyed) {
            return sceneRef.current;
        }
        if (!mapView || !sceneHostRef.current) return null;

        const scene = await createSceneView(sceneHostRef.current, {
            map: mapView.map,
            qualityProfile: "medium",
            padding: mapView.padding,
            environment: {
                atmosphereEnabled: true,
                starsEnabled: false,
                lighting: {
                    directShadowsEnabled: true,
                    cameraTrackingEnabled: false
                }
            }
        });

        if (disposedRef.current) {
            destroySceneView(scene);
            return null;
        }

        sceneRef.current = scene;
        setSceneReady(true);
        return scene;
    }, [mapView]);

    const activate3D = useCallback(async () => {
        if (!mapView || activeMode === "3d") {
            if (activeMode === "3d") publishMode("3d", "map-runtime-current");
            return;
        }

        const bridge = MapManager.GetViewStateBridge();
        if (!bridge?.getState || !bridge?.setState) {
            announce("3B görünüm için harita durumu henüz hazır değil.", "assertive");
            publishMode("2d", "map-runtime-unavailable");
            return;
        }

        try {
            const scene = await ensureScene();
            if (!scene?.view || disposedRef.current) return;

            const sceneState = normalizeSceneStateFromMap(mapView, bridge);
            // Mark the 3D runtime as authoritative before applying camera state;
            // this prevents subsequent UI work from treating the 2D camera as
            // the active interaction surface during the transition.
            if (modeRef) modeRef.current = "3d";
            bridge.setState(sceneState);

            await applyViewStateToSceneView(scene.view, sceneState, {
                allowCrossMode: true,
                duration: 0,
                animate: false
            });

            unbindSceneRef.current?.();
            unbindSceneRef.current = bindSceneState(scene.view, bridge, null, {
                applyIncoming: true,
                goToOptions: { duration: 0, animate: false },
                onApplyError: error => DebugHelper.Log(error)
            });

            if (disposedRef.current) return;
            setMode("3d");
            publishMode("3d");
        } catch (error) {
            DebugHelper.Log(error);
            if (modeRef) modeRef.current = "2d";
            setActiveMode("2d");
            publishMode("2d", "map-runtime-recovery");
            announce("3B görünüm başlatılamadı. 2B harita korunuyor.", "assertive");
        }
    }, [activeMode, ensureScene, mapView, modeRef, setMode]);

    const activate2D = useCallback(async () => {
        if (!mapView) return;
        if (activeMode === "2d") {
            publishMode("2d", "map-runtime-current");
            return;
        }

        const bridge = MapManager.GetViewStateBridge();
        try {
            const sceneView = sceneRef.current?.view;
            const mapState = sceneView && bridge
                ? normalizeMapStateFromScene(sceneView, bridge)
                : createViewState({ ...bridge?.getState?.(), mode: "2d", tilt: 0 });

            // Stop 3D from publishing camera changes before switching bridge
            // authority back to MapView.
            unbindSceneRef.current?.();
            unbindSceneRef.current = () => {};
            if (modeRef) modeRef.current = "2d";
            bridge?.setState?.(mapState);

            await applyViewStateToMapView(mapView, mapState, {
                allowCrossMode: true,
                duration: 0,
                animate: false
            });

            if (disposedRef.current) return;
            setMode("2d");
            publishMode("2d");
        } catch (error) {
            DebugHelper.Log(error);
            // If the 2D camera cannot be restored, retain the active scene rather
            // than hiding the only usable map surface.
            if (modeRef) modeRef.current = "3d";
            setActiveMode("3d");
            publishMode("3d", "map-runtime-recovery");
            announce("2B görünüme dönüş tamamlanamadı. 3B görünüm korunuyor.", "assertive");
        }
    }, [activeMode, mapView, modeRef, setMode]);

    const queueTransition = useCallback((mode) => {
        transitionRef.current = transitionRef.current
            .catch(() => undefined)
            .then(() => mode === "3d" ? activate3D() : activate2D());
        return transitionRef.current;
    }, [activate2D, activate3D]);

    useEffect(() => {
        if (!mapView) return undefined;
        disposedRef.current = false;
        if (modeRef) modeRef.current = "2d";
        publishMode("2d", "map-runtime-ready");

        const onCommand = event => {
            const detail = event?.detail;
            if (detail?.name !== "map-mode") return;
            if (detail.mode !== "2d" && detail.mode !== "3d") return;
            queueTransition(detail.mode);
        };

        window.addEventListener(EXPERIENCE_COMMAND_EVENT, onCommand);
        return () => {
            window.removeEventListener(EXPERIENCE_COMMAND_EVENT, onCommand);
        };
    }, [mapView, modeRef, queueTransition]);

    useEffect(() => () => {
        disposedRef.current = true;
        unbindSceneRef.current?.();
        unbindSceneRef.current = () => {};
        if (sceneRef.current) destroySceneView(sceneRef.current);
        sceneRef.current = null;
    }, []);

    return (
        <div
            ref={sceneHostRef}
            className={`experience-scene-host ${activeMode === "3d" ? "is-active" : "is-inactive"}`}
            aria-hidden={activeMode === "3d" ? "false" : "true"}
            data-scene-ready={sceneReady ? "true" : "false"}
            data-view-mode={activeMode}
        />
    );
}

export default ExperienceMapModeBridge;
