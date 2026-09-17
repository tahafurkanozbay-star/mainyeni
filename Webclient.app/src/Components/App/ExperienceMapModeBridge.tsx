import React, { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import MapManager from '../../Store/Managers/MapManager';
import { DebugHelper } from '../../Toolbox/DebugHelper';
import {
  applyViewStateToMapView,
  snapshotMapViewState,
} from '../../gis-engine/viewRuntime';
import {
  applyViewStateToSceneView,
  bindSceneState,
  createSceneView,
  destroySceneView,
  snapshotSceneState,
  type SceneViewLike,
} from '../../gis-engine/sceneRuntime';
import {
  createSceneExperienceRuntime,
  type SceneExperienceRuntime,
  type SceneExperienceSnapshot,
  type SceneExperienceView,
} from '../../gis-engine/sceneExperienceRuntime';
import { createViewState } from '../../gis-engine/viewState';
import {
  EXPERIENCE_ANNOUNCEMENT_EVENT,
  EXPERIENCE_COMMAND_EVENT,
  EXPERIENCE_MAP_MODE_EVENT,
  type ExperienceCommandDetail,
  type ExperienceMapMode,
} from '../../experience/experienceRuntime';

const DEFAULT_SCENE_TILT = 48;
const SCENE_TRANSITION_DURATION_MS = 320;

interface ArcGisMapViewLike {
  map: unknown;
  padding?: unknown;
  destroyed?: boolean;
  container?: unknown;
  goTo?: (target: unknown, options?: unknown) => Promise<unknown>;
  center?: unknown;
  extent?: unknown;
  scale?: number;
  zoom?: number;
  rotation?: number;
  watch?: (property: string, callback: (...args: unknown[]) => void) => { remove?: () => void };
}

interface ViewStateBridgeLike {
  getState: () => Record<string, unknown>;
  setState: (state: unknown) => unknown;
}

interface ExperienceMapModeBridgeProps {
  mapView: ArcGisMapViewLike;
  modeRef?: MutableRefObject<ExperienceMapMode>;
}

interface SceneHandle {
  map: unknown;
  view: SceneExperienceView;
  ownsMap: boolean;
}

interface SceneUiState {
  profileLabel: string;
  statusLabel: string;
  p95FrameMs: number;
  recoveryAttempts: number;
}

const INITIAL_UI_STATE: SceneUiState = Object.freeze({
  profileLabel: 'Dengeli',
  statusLabel: 'Hazır',
  p95FrameMs: 0,
  recoveryAttempts: 0,
});

const profileLabel = (profile: string): string => {
  if (profile === 'quality') return 'Yüksek kalite';
  if (profile === 'eco') return 'Tasarruf';
  return 'Dengeli';
};

const statusLabel = (status: string): string => {
  if (status === 'recovering') return 'Grafik motoru kurtarılıyor';
  if (status === 'degraded') return 'Güvenli performans modu';
  if (status === 'warming') return '3B hazırlanıyor';
  if (status === 'idle') return 'Beklemede';
  return 'Hazır';
};

const uiStateFromSnapshot = (snapshot: SceneExperienceSnapshot): SceneUiState => Object.freeze({
  profileLabel: profileLabel(snapshot.profile),
  statusLabel: statusLabel(snapshot.status),
  p95FrameMs: snapshot.p95FrameMs,
  recoveryAttempts: snapshot.recovery.attempts,
});

const dispatchExperienceEvent = <T,>(type: string, detail: T): boolean => {
  if (typeof window === 'undefined' || typeof CustomEvent === 'undefined') return false;
  return window.dispatchEvent(new CustomEvent<T>(type, { detail }));
};

const announce = (message: string, politeness: 'polite' | 'assertive' = 'polite'): boolean => (
  dispatchExperienceEvent(EXPERIENCE_ANNOUNCEMENT_EVENT, { message, politeness })
);

const publishMode = (mode: ExperienceMapMode, source = 'map-runtime'): boolean => (
  dispatchExperienceEvent(EXPERIENCE_MAP_MODE_EVENT, { mode, source })
);

const normalizeSceneStateFromMap = (mapView: ArcGisMapViewLike, bridge: ViewStateBridgeLike) => {
  const current = snapshotMapViewState(mapView as never, bridge.getState());
  return createViewState({
    ...current,
    mode: '3d',
    tilt: Number.isFinite(Number(current.tilt)) && Number(current.tilt) > 0
      ? Number(current.tilt)
      : DEFAULT_SCENE_TILT,
  });
};

const normalizeMapStateFromScene = (sceneView: SceneViewLike, bridge: ViewStateBridgeLike) => {
  const current = snapshotSceneState(sceneView, bridge.getState());
  return createViewState({
    ...current,
    mode: '2d',
    zoom: null,
    tilt: 0,
  });
};

const prefersReducedMotion = (): boolean => (
  typeof window !== 'undefined'
  && typeof window.matchMedia === 'function'
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches
);

/**
 * Type-safe ownership boundary for the application's 2D/3D transition.
 *
 * The SceneView is lazy and shares the exact ArcGIS Map used by the MapView.
 * This preserves layer visibility, basemap and selection state while avoiding a
 * second data model. A dedicated scene experience runtime adapts SDK quality to
 * device/frame pressure and owns WebGL fatal-error recovery.
 */
export function ExperienceMapModeBridge({ mapView, modeRef }: ExperienceMapModeBridgeProps) {
  const sceneHostRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<SceneHandle | null>(null);
  const sceneExperienceRef = useRef<SceneExperienceRuntime | null>(null);
  const unbindSceneRef = useRef<() => void>(() => undefined);
  const unsubscribeExperienceRef = useRef<() => boolean>(() => false);
  const disposedRef = useRef(false);
  const transitionRef = useRef<Promise<void>>(Promise.resolve());
  const sceneHomeStateRef = useRef<ReturnType<typeof createViewState> | null>(null);
  const activeModeRef = useRef<ExperienceMapMode>('2d');
  const [activeMode, setActiveMode] = useState<ExperienceMapMode>('2d');
  const [sceneReady, setSceneReady] = useState(false);
  const [sceneUi, setSceneUi] = useState<SceneUiState>(INITIAL_UI_STATE);

  const setMode = useCallback((mode: ExperienceMapMode) => {
    activeModeRef.current = mode;
    if (modeRef) modeRef.current = mode;
    setActiveMode(mode);
  }, [modeRef]);

  const syncSceneUi = useCallback((snapshot: SceneExperienceSnapshot) => {
    if (disposedRef.current) return;
    setSceneUi(uiStateFromSnapshot(snapshot));
  }, []);

  const bindSceneExperience = useCallback((view: SceneExperienceView) => {
    sceneExperienceRef.current?.dispose();
    unsubscribeExperienceRef.current?.();

    const runtime = createSceneExperienceRuntime(view, {
      onError: (error, context) => DebugHelper.Log({ context, error }),
      onSnapshot: (snapshot, reason) => {
        if (reason === 'recovery-start') {
          announce('3B grafik motoru yeniden başlatılıyor.', 'assertive');
        } else if (reason === 'recovery-success') {
          announce('3B grafik motoru başarıyla kurtarıldı.');
        } else if (reason === 'recovery-failure' && snapshot.status === 'degraded') {
          announce('3B grafik motoru kurtarılamadı. Güvenli moda geçildi.', 'assertive');
        }
      },
    });

    sceneExperienceRef.current = runtime;
    unsubscribeExperienceRef.current = runtime.subscribe((snapshot) => syncSceneUi(snapshot));
    syncSceneUi(runtime.getSnapshot());
    return runtime;
  }, [syncSceneUi]);

  const ensureScene = useCallback(async (): Promise<SceneHandle | null> => {
    const current = sceneRef.current;
    if (current?.view && !current.view.destroyed) return current;
    if (!mapView || !sceneHostRef.current) return null;

    const scene = await createSceneView(sceneHostRef.current, {
      map: mapView.map,
      qualityProfile: 'medium',
      padding: mapView.padding,
      environment: {
        atmosphereEnabled: true,
        starsEnabled: false,
        lighting: {
          directShadowsEnabled: false,
          cameraTrackingEnabled: false,
        },
      },
      constraints: {
        altitude: { min: -500, max: 25_000_000 },
      },
    } as never) as SceneHandle;

    await scene.view.when?.();

    if (disposedRef.current) {
      destroySceneView(scene);
      return null;
    }

    sceneRef.current = scene;
    bindSceneExperience(scene.view);
    setSceneReady(true);
    return scene;
  }, [bindSceneExperience, mapView]);

  const activate3D = useCallback(async (): Promise<void> => {
    if (!mapView || activeModeRef.current === '3d') {
      if (activeModeRef.current === '3d') publishMode('3d', 'map-runtime-current');
      return;
    }

    const bridge = MapManager.GetViewStateBridge?.() as ViewStateBridgeLike | null;
    if (!bridge?.getState || !bridge?.setState) {
      announce('3B görünüm için harita durumu henüz hazır değil.', 'assertive');
      publishMode('2d', 'map-runtime-unavailable');
      return;
    }

    try {
      const scene = await ensureScene();
      if (!scene?.view || disposedRef.current) return;

      scene.view.padding = mapView.padding;
      const sceneState = normalizeSceneStateFromMap(mapView, bridge);
      if (modeRef) modeRef.current = '3d';
      activeModeRef.current = '3d';
      bridge.setState(sceneState);

      await applyViewStateToSceneView(scene.view, sceneState, {
        allowCrossMode: true,
        duration: prefersReducedMotion() ? 0 : SCENE_TRANSITION_DURATION_MS,
        animate: !prefersReducedMotion(),
      });

      unbindSceneRef.current?.();
      unbindSceneRef.current = bindSceneState(scene.view, bridge as never, undefined, {
        applyIncoming: true,
        goToOptions: {
          duration: prefersReducedMotion() ? 0 : 180,
          animate: !prefersReducedMotion(),
        },
        onApplyError: (error: unknown) => DebugHelper.Log(error),
      });

      sceneExperienceRef.current?.setActive(true);
      if (disposedRef.current) return;
      setMode('3d');
      publishMode('3d');
      announce('3B görünüm etkinleştirildi.');
    } catch (error) {
      DebugHelper.Log(error);
      sceneExperienceRef.current?.setActive(false);
      activeModeRef.current = '2d';
      if (modeRef) modeRef.current = '2d';
      setActiveMode('2d');
      publishMode('2d', 'map-runtime-recovery');
      announce('3B görünüm başlatılamadı. 2B harita korunuyor.', 'assertive');
    }
  }, [ensureScene, mapView, modeRef, setMode]);

  const activate2D = useCallback(async (): Promise<void> => {
    if (!mapView) return;
    if (activeModeRef.current === '2d') {
      publishMode('2d', 'map-runtime-current');
      return;
    }

    const bridge = MapManager.GetViewStateBridge?.() as ViewStateBridgeLike | null;
    try {
      const sceneView = sceneRef.current?.view;
      const fallbackMapState = bridge?.getState?.();
      const mapState = sceneView && bridge
        ? normalizeMapStateFromScene(sceneView, bridge)
        : createViewState(fallbackMapState
          ? Object.assign({}, fallbackMapState, { mode: '2d', tilt: 0 })
          : { mode: '2d', tilt: 0 });

      unbindSceneRef.current?.();
      unbindSceneRef.current = () => undefined;
      sceneExperienceRef.current?.setActive(false);
      activeModeRef.current = '2d';
      if (modeRef) modeRef.current = '2d';
      bridge?.setState?.(mapState);

      await applyViewStateToMapView(mapView as never, mapState, {
        allowCrossMode: true,
        duration: prefersReducedMotion() ? 0 : SCENE_TRANSITION_DURATION_MS,
        animate: !prefersReducedMotion(),
      });

      if (disposedRef.current) return;
      setMode('2d');
      publishMode('2d');
      announce('2B görünüm etkinleştirildi.');
    } catch (error) {
      DebugHelper.Log(error);
      sceneExperienceRef.current?.setActive(true);
      activeModeRef.current = '3d';
      if (modeRef) modeRef.current = '3d';
      setActiveMode('3d');
      publishMode('3d', 'map-runtime-recovery');
      announce('2B görünüme dönüş tamamlanamadı. 3B görünüm korunuyor.', 'assertive');
    }
  }, [mapView, modeRef, setMode]);

  const queueTransition = useCallback((mode: ExperienceMapMode): Promise<void> => {
    transitionRef.current = transitionRef.current
      .catch(() => undefined)
      .then(() => (mode === '3d' ? activate3D() : activate2D()));
    return transitionRef.current;
  }, [activate2D, activate3D]);

  const executeSceneCommand = useCallback(async (detail: ExperienceCommandDetail): Promise<boolean> => {
    if (activeModeRef.current !== '3d') return false;
    const view = sceneRef.current?.view;
    if (!view || view.destroyed) return false;
    const animation = {
      duration: prefersReducedMotion() ? 0 : 220,
      animate: !prefersReducedMotion(),
    };

    if (detail.name === 'map-home') {
      const home = sceneHomeStateRef.current;
      if (!home) return false;
      await applyViewStateToSceneView(view, home, {
        allowCrossMode: true,
        ...animation,
      });
      return true;
    }

    if (detail.name === 'map-zoom-in' || detail.name === 'map-zoom-out') {
      const scale = Number(view.scale);
      if (!Number.isFinite(scale) || !view.goTo) return false;
      const factor = detail.name === 'map-zoom-in' ? 0.5 : 2;
      await view.goTo({ scale: Math.max(25, scale * factor) }, animation);
      return true;
    }

    if (detail.name === 'focus-map') {
      const container = view.container instanceof HTMLElement ? view.container : sceneHostRef.current;
      const focusTarget = container?.querySelector<HTMLElement>('.esri-view-surface, [tabindex="0"]');
      focusTarget?.focus({ preventScroll: true });
      return Boolean(focusTarget);
    }

    return false;
  }, []);

  useEffect(() => {
    if (!mapView) return undefined;
    disposedRef.current = false;
    activeModeRef.current = '2d';
    if (modeRef) modeRef.current = '2d';
    publishMode('2d', 'map-runtime-ready');

    const bridge = MapManager.GetViewStateBridge?.() as ViewStateBridgeLike | null;
    if (bridge?.getState && !sceneHomeStateRef.current) {
      sceneHomeStateRef.current = normalizeSceneStateFromMap(mapView, bridge);
    }

    const onCommand = (event: Event) => {
      const detail = (event as CustomEvent<ExperienceCommandDetail>).detail;
      if (!detail) return;
      if (detail.name === 'map-mode') {
        if (detail.mode !== '2d' && detail.mode !== '3d') return;
        void queueTransition(detail.mode);
        return;
      }
      void executeSceneCommand(detail).catch((error: unknown) => DebugHelper.Log(error));
    };

    const onVisibilityChange = () => {
      const runtime = sceneExperienceRef.current;
      if (!runtime || activeModeRef.current !== '3d') return;
      runtime.setActive(document.visibilityState === 'visible');
    };

    window.addEventListener(EXPERIENCE_COMMAND_EVENT, onCommand as EventListener);
    document.addEventListener('visibilitychange', onVisibilityChange, { passive: true });
    return () => {
      window.removeEventListener(EXPERIENCE_COMMAND_EVENT, onCommand as EventListener);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [executeSceneCommand, mapView, modeRef, queueTransition]);

  useEffect(() => () => {
    disposedRef.current = true;
    unbindSceneRef.current?.();
    unbindSceneRef.current = () => undefined;
    unsubscribeExperienceRef.current?.();
    unsubscribeExperienceRef.current = () => false;
    sceneExperienceRef.current?.dispose();
    sceneExperienceRef.current = null;
    if (sceneRef.current) destroySceneView(sceneRef.current);
    sceneRef.current = null;
  }, []);

  return (
    <>
      <div
        ref={sceneHostRef}
        className={`experience-scene-host ${activeMode === '3d' ? 'is-active' : 'is-inactive'}`}
        aria-hidden={activeMode === '3d' ? 'false' : 'true'}
        data-scene-ready={sceneReady ? 'true' : 'false'}
        data-view-mode={activeMode}
        data-scene-profile={sceneUi.profileLabel}
        data-scene-status={sceneUi.statusLabel}
      />
      {activeMode === '3d' && (
        <output
          className="experience-scene-health"
          aria-live="polite"
          aria-label={`3B görünüm durumu: ${sceneUi.statusLabel}, ${sceneUi.profileLabel}`}
        >
          <span className="experience-scene-health__mode">3B</span>
          <span className="experience-scene-health__profile">{sceneUi.profileLabel}</span>
          {sceneUi.p95FrameMs > 0 && (
            <span className="experience-scene-health__metric" aria-hidden="true">
              p95 {Math.round(sceneUi.p95FrameMs)} ms
            </span>
          )}
          {sceneUi.recoveryAttempts > 0 && (
            <span className="experience-scene-health__recovery">{sceneUi.statusLabel}</span>
          )}
        </output>
      )}
    </>
  );
}

export default ExperienceMapModeBridge;