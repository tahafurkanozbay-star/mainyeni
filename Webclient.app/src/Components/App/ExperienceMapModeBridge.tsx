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
  synchronizeSceneViewSize,
  waitForSceneContainer,
  type SceneViewLike,
} from '../../gis-engine/sceneRuntime';
import type { ArcgisAccessorWatch } from '../../gis-engine/arcgisReactiveRuntime';
import { waitForArcgisView } from '../../gis-engine/viewReadiness';
import { SceneBasemapRuntime, type SceneBasemapMap } from '../../gis-engine/sceneBasemapRuntime';
import { OSM3DBuildingsRuntime } from '../../gis-engine/osm3DBuildingsRuntime';
import './OpenStreetMap3DAttribution.css';
import {
  createSceneExperienceRuntime,
  type SceneExperienceRuntime,
  type SceneExperienceSnapshot,
  type SceneExperienceView,
} from '../../gis-engine/sceneExperienceRuntime';
import {
  createSceneNavigationRuntime,
  type SceneNavigationRuntime,
} from '../../gis-engine/sceneNavigationRuntime';
import { createViewState } from '../../gis-engine/viewState';
import {
  EXPERIENCE_ANNOUNCEMENT_EVENT,
  EXPERIENCE_COMMAND_EVENT,
  EXPERIENCE_MAP_MODE_EVENT,
  type ExperienceCommandDetail,
  type ExperienceMapMode,
} from '../../experience/experienceRuntime';
import { executeSceneCommand as executeSceneRuntimeCommand } from '../../experience/sceneCommandRuntime';

const DEFAULT_SCENE_TILT = 48;
const SCENE_TRANSITION_DURATION_MS = 320;

const basemapIdForMap = (map: unknown): string | null => {
  const basemap = (map as { basemap?: { id?: unknown; portalItem?: { id?: unknown } | null; title?: unknown } | string | null } | null)?.basemap;
  if (typeof basemap === 'string' && basemap.trim()) return basemap.trim();
  if (!basemap || typeof basemap !== 'object') return null;
  const candidate = basemap.id ?? basemap.portalItem?.id ?? basemap.title;
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null;
};

const synchronizeBasemapId = (bridge: ViewStateBridgeLike | null | undefined, map: unknown): void => {
  if (!bridge?.getState || !bridge?.setState) return;
  bridge.setState(createViewState({ ...bridge.getState(), basemapId: basemapIdForMap(map) }));
};

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
  accessorWatch?: ArcgisAccessorWatch | undefined;
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

const nextBrowserFrame = (): Promise<void> => new Promise((resolve) => {
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => resolve());
    return;
  }
  queueMicrotask(resolve);
});

/**
 * Type-safe ownership boundary for the application's 2D/3D transition.
 *
 * The SceneView is lazy and shares the exact ArcGIS Map used by the MapView.
 * This preserves layer visibility, basemap and selection state while avoiding a
 * second data model. Dedicated scene experience and navigation runtimes adapt
 * quality, own WebGL recovery, and bound camera movement/history.
 */
export function ExperienceMapModeBridge({
  mapView,
  modeRef,
  accessorWatch,
}: ExperienceMapModeBridgeProps) {
  const sceneHostRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<SceneHandle | null>(null);
  const sceneBasemapRuntimeRef = useRef<SceneBasemapRuntime | null>(null);
  if (!sceneBasemapRuntimeRef.current) sceneBasemapRuntimeRef.current = new SceneBasemapRuntime();
  const osmBuildingsRuntimeRef = useRef<OSM3DBuildingsRuntime | null>(null);
  if (!osmBuildingsRuntimeRef.current) osmBuildingsRuntimeRef.current = new OSM3DBuildingsRuntime();
  const pendingSceneRef = useRef<SceneHandle | null>(null);
  const sceneLifetimeRef = useRef(new AbortController());
  const sceneExperienceRef = useRef<SceneExperienceRuntime | null>(null);
  const sceneNavigationRef = useRef<SceneNavigationRuntime | null>(null);
  const sceneNavigationHomeSetRef = useRef(false);
  const unbindSceneRef = useRef<() => void>(() => undefined);
  const unsubscribeExperienceRef = useRef<() => boolean>(() => false);
  const disposedRef = useRef(false);
  const transitionRef = useRef<Promise<void>>(Promise.resolve());
  const activeModeRef = useRef<ExperienceMapMode>('2d');
  const [activeMode, setActiveMode] = useState<ExperienceMapMode>('2d');
  const [sceneHostActive, setSceneHostActive] = useState(false);
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

    const attemptLimit = 3;
    const runtime = createSceneExperienceRuntime(view, {
      onError: (error, context) => DebugHelper.Log({ context, error }),
      accessorWatch,
      maximumRecoveryAttempts: attemptLimit,
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
  }, [accessorWatch, syncSceneUi]);

  const bindSceneNavigation = useCallback((view: SceneExperienceView) => {
    sceneNavigationRef.current?.dispose();
    sceneNavigationHomeSetRef.current = false;
    const runtime = createSceneNavigationRuntime(view as never, {
      reducedMotion: prefersReducedMotion,
      defaultDurationMs: 220,
      onError: (error, context) => DebugHelper.Log({ context, error }),
    });
    sceneNavigationRef.current = runtime;
    return runtime;
  }, []);

  const ensureScene = useCallback(async (): Promise<SceneHandle | null> => {
    const current = sceneRef.current;
    if (current?.view && !current.view.destroyed) return current;
    if (!mapView || !sceneHostRef.current) return null;

    sceneNavigationRef.current?.dispose();
    sceneNavigationRef.current = null;
    sceneNavigationHomeSetRef.current = false;

    const lifetime = sceneLifetimeRef.current;
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

    if (disposedRef.current || lifetime.signal.aborted) {
      destroySceneView(scene, (error) => DebugHelper.Log({ context: 'scene-destroy', error }));
      return null;
    }
    pendingSceneRef.current = scene;
    try {
      synchronizeSceneViewSize(scene.view);
      await waitForArcgisView(scene.view, { signal: lifetime.signal, ...(accessorWatch ? { accessorWatch } : {}) });
      synchronizeSceneViewSize(scene.view);
    } catch (error) {
      if (!scene.view.destroyed) destroySceneView(scene, (caught) => DebugHelper.Log({ context: 'scene-destroy', error: caught }));
      throw error;
    } finally {
      if (pendingSceneRef.current === scene) pendingSceneRef.current = null;
    }
    if (disposedRef.current || lifetime.signal.aborted) {
      if (!scene.view.destroyed) destroySceneView(scene, (error) => DebugHelper.Log({ context: 'scene-destroy', error }));
      return null;
    }

    sceneRef.current = scene;
    bindSceneExperience(scene.view);
    bindSceneNavigation(scene.view);
    setSceneReady(true);
    return scene;
  }, [accessorWatch, bindSceneExperience, bindSceneNavigation, mapView]);

  const activate3D = useCallback(async (): Promise<void> => {
    if (!mapView || activeModeRef.current === '3d') {
      if (activeModeRef.current === '3d') {
        setSceneHostActive(true);
        synchronizeSceneViewSize(sceneRef.current?.view);
        publishMode('3d', 'map-runtime-current');
      }
      return;
    }

    const bridge = MapManager.GetViewStateBridge?.() as ViewStateBridgeLike | null;
    if (!bridge?.getState || !bridge?.setState) {
      announce('3B görünüm için harita durumu henüz hazır değil.', 'assertive');
      publishMode('2d', 'map-runtime-unavailable');
      return;
    }

    try {
      // Keep the 3B host visually inactive while reattaching its renderer. This
      // avoids revealing a stale/blank frame when returning from the 2B view.
      await nextBrowserFrame();
      const sceneHost = sceneHostRef.current;
      await waitForSceneContainer(sceneHost);

      const scene = await ensureScene();
      if (!scene?.view || disposedRef.current) return;
      if (!sceneHost) throw new Error('3B harita kapsayıcısı kullanılamıyor.');
      if (scene.view.destroyed) throw new Error('3B harita görünümü kapatılmış.');

      // Keep the SceneView attached to its measurable host for its entire
      // lifetime. Detaching the WebGL view between 2B/3B transitions can leave
      // the renderer blank even after the same container is attached again.
      if (scene.view.container !== sceneHost) {
        scene.view.container = sceneHost;
      }
      if (disposedRef.current || sceneLifetimeRef.current.signal.aborted) return;
      await nextBrowserFrame();
      synchronizeSceneViewSize(scene.view);
      await nextBrowserFrame();
      synchronizeSceneViewSize(scene.view);

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

      if (!sceneNavigationHomeSetRef.current) {
        sceneNavigationRef.current?.setHome();
        sceneNavigationHomeSetRef.current = true;
      }

      unbindSceneRef.current?.();
      unbindSceneRef.current = bindSceneState(scene.view, bridge as never, undefined, {
        applyIncoming: true,
        goToOptions: {
          duration: prefersReducedMotion() ? 0 : 180,
          animate: !prefersReducedMotion(),
        },
        onApplyError: (error: unknown) => DebugHelper.Log(error),
        accessorWatch,
      });

      try {
        await sceneBasemapRuntimeRef.current?.activate(scene.map as SceneBasemapMap, sceneLifetimeRef.current.signal);
        synchronizeBasemapId(bridge, scene.map);
      } catch (error) {
        // SceneView stays usable if the keyless OpenStreetMap tile layer is unavailable.
        DebugHelper.Log({ context: 'scene-free-osm-basemap', error });
      }
      if (disposedRef.current || sceneLifetimeRef.current.signal.aborted) return;
      try {
        await osmBuildingsRuntimeRef.current?.activate(scene.view as never);
      } catch (error) {
        // Overpass availability must not block 2D/3D navigation.
        DebugHelper.Log({ context: 'scene-osm-3d-buildings', error });
      }
      if (disposedRef.current || sceneLifetimeRef.current.signal.aborted) return;
      setSceneHostActive(true);
      await nextBrowserFrame();
      synchronizeSceneViewSize(scene.view);
      await nextBrowserFrame();
      synchronizeSceneViewSize(scene.view);
      sceneExperienceRef.current?.setActive(true);
      if (disposedRef.current) return;
      setMode('3d');
      publishMode('3d');
      announce('3B görünüm etkinleştirildi.');
    } catch (error) {
      DebugHelper.Log(error);
      osmBuildingsRuntimeRef.current?.deactivate();
      sceneBasemapRuntimeRef.current?.restore(mapView.map as SceneBasemapMap);
      synchronizeBasemapId(bridge, mapView.map);
      sceneExperienceRef.current?.setActive(false);
      setSceneHostActive(false);
      activeModeRef.current = '2d';
      if (modeRef) modeRef.current = '2d';
      setActiveMode('2d');

      // A failed SceneView is not safe to cache for the next retry. Dispose its
      // bindings and recreate it on demand instead of reusing a blank renderer.
      unbindSceneRef.current?.();
      unbindSceneRef.current = () => undefined;
      unsubscribeExperienceRef.current?.();
      unsubscribeExperienceRef.current = () => false;
      sceneExperienceRef.current?.dispose();
      sceneExperienceRef.current = null;
      sceneNavigationRef.current?.dispose();
      sceneNavigationRef.current = null;
      sceneNavigationHomeSetRef.current = false;
      const failedScene = sceneRef.current;
      sceneRef.current = null;
      if (failedScene) destroySceneView(failedScene, (caught) => DebugHelper.Log({ context: 'scene-recovery-destroy', error: caught }));
      setSceneReady(false);

      publishMode('2d', 'map-runtime-recovery');
      announce('3B görünüm başlatılamadı. 2B harita korunuyor.', 'assertive');
    }
  }, [accessorWatch, ensureScene, mapView, modeRef, setMode]);

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
      setSceneHostActive(false);
      osmBuildingsRuntimeRef.current?.deactivate();
      sceneBasemapRuntimeRef.current?.restore(mapView.map as SceneBasemapMap);
      synchronizeBasemapId(bridge, mapView.map);
      setMode('2d');
      publishMode('2d');
      announce('2B görünüm etkinleştirildi.');
    } catch (error) {
      DebugHelper.Log(error);
      sceneExperienceRef.current?.setActive(true);
      setSceneHostActive(true);
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

  const executeActiveSceneCommand = useCallback(async (detail: ExperienceCommandDetail): Promise<boolean> => {
    if (activeModeRef.current !== '3d') return false;
    const view = sceneRef.current?.view;
    const navigation = sceneNavigationRef.current;
    if (!view || view.destroyed || !navigation) return false;

    return executeSceneRuntimeCommand(detail, {
      navigation,
      reducedMotion: prefersReducedMotion,
      durationMs: 220,
      focusMap: () => {
        const container = view.container instanceof HTMLElement ? view.container : sceneHostRef.current;
        const focusTarget = container?.querySelector<HTMLElement>('.esri-view-surface, [tabindex="0"]');
        focusTarget?.focus({ preventScroll: true });
        return Boolean(focusTarget);
      },
    });
  }, []);

  useEffect(() => {
    if (!sceneReady || !sceneHostActive) return undefined;
    const host = sceneHostRef.current;
    const view = sceneRef.current?.view;
    if (!host || !view || view.destroyed) return undefined;

    const resizeScene = () => synchronizeSceneViewSize(view);
    resizeScene();

    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(resizeScene);
      observer.observe(host);
      return () => observer.disconnect();
    }

    window.addEventListener('resize', resizeScene, { passive: true });
    return () => window.removeEventListener('resize', resizeScene);
  }, [sceneHostActive, sceneReady]);

  useEffect(() => {
    if (!mapView) return undefined;
    disposedRef.current = false;
    if (sceneLifetimeRef.current.signal.aborted) sceneLifetimeRef.current = new AbortController();
    activeModeRef.current = '2d';
    if (modeRef) modeRef.current = '2d';

    const onCommand = (event: Event) => {
      const detail = (event as CustomEvent<ExperienceCommandDetail>).detail;
      if (!detail) return;
      if (detail.name === 'map-mode') {
        if (detail.mode !== '2d' && detail.mode !== '3d') return;
        void queueTransition(detail.mode);
        return;
      }
      void executeActiveSceneCommand(detail).catch((error: unknown) => DebugHelper.Log(error));
    };

    const onVisibilityChange = () => {
      const runtime = sceneExperienceRef.current;
      if (!runtime || activeModeRef.current !== '3d') return;
      const visible = document.visibilityState === 'visible';
      runtime.setActive(visible);
      if (visible) synchronizeSceneViewSize(sceneRef.current?.view);
    };

    window.addEventListener(EXPERIENCE_COMMAND_EVENT, onCommand as EventListener);
    document.addEventListener('visibilitychange', onVisibilityChange, { passive: true });

    // Make first-load 3D activation explicit and deterministic. Previously this
    // depended on another component observing a transient 2D runtime event and
    // dispatching a second command; if that hand-off was missed, the SceneView
    // stayed hidden and the map appeared blank in the requested 3D experience.
    void queueTransition('3d');

    return () => {
      window.removeEventListener(EXPERIENCE_COMMAND_EVENT, onCommand as EventListener);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [executeActiveSceneCommand, mapView, modeRef, queueTransition]);

  useEffect(() => () => {
    disposedRef.current = true;
    sceneLifetimeRef.current.abort();
    osmBuildingsRuntimeRef.current?.dispose();
    sceneBasemapRuntimeRef.current?.dispose();
    if (pendingSceneRef.current) destroySceneView(pendingSceneRef.current, (error) => DebugHelper.Log({ context: 'pending-scene-destroy', error }));
    pendingSceneRef.current = null;
    unbindSceneRef.current?.();
    unbindSceneRef.current = () => undefined;
    unsubscribeExperienceRef.current?.();
    unsubscribeExperienceRef.current = () => false;
    sceneExperienceRef.current?.dispose();
    sceneExperienceRef.current = null;
    sceneNavigationRef.current?.dispose();
    sceneNavigationRef.current = null;
    sceneNavigationHomeSetRef.current = false;
    if (sceneRef.current) destroySceneView(sceneRef.current, (error) => DebugHelper.Log({ context: 'scene-destroy', error }));
    sceneRef.current = null;
  }, []);

  return (
    <>
      <div
        ref={sceneHostRef}
        className={`experience-scene-host ${sceneHostActive ? 'is-active' : 'is-inactive'}`}
        aria-hidden={sceneHostActive ? 'false' : 'true'}
        data-scene-ready={sceneReady ? 'true' : 'false'}
        data-view-mode={activeMode}
        data-scene-profile={sceneUi.profileLabel}
        data-scene-status={sceneUi.statusLabel}
      />
      {sceneHostActive && (
        <div className="osm3d-attribution" role="note" aria-label="OpenStreetMap bina verisi atfı">
          3B bina verisi: <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer noopener">© OpenStreetMap contributors</a>
        </div>
      )}
      {activeMode === '3d' && (
        <output className="experience-sr-only" aria-live="polite">
          3B görünüm durumu: {sceneUi.statusLabel}, {sceneUi.profileLabel}
          {sceneUi.p95FrameMs > 0 ? `, kare süresi p95 ${Math.round(sceneUi.p95FrameMs)} ms` : ''}
          {sceneUi.recoveryAttempts > 0 ? `, kurtarma durumu: ${sceneUi.statusLabel}` : ''}
        </output>
      )}
    </>
  );
}

export default ExperienceMapModeBridge;
