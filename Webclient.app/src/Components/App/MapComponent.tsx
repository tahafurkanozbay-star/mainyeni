import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import Store from '../../Store/Store';
import { MapReducer_ActionTypes } from '../../Store/Reducers/MapReducer';
import { NavigationBar } from './NavigationBar';
import { SidebarModern } from './SidebarModern';
import MapManager from '../../Store/Managers/MapManager';
import { ToolbarWidgetModern } from '../Widget/Toolbar/ToolbarWidgetModern';
import { BasemapWidget } from '../Widget/Basemap/BasemapWidget';
import { MeasurementWidget } from '../Widget/Measurement/MeasurementWidget';
import { SketchWidget } from '../Widget/Sketch/SketchWidget';
import { GlobalIdentifyWidget } from '../Widget/GlobalIdentify/GlobalIdentifyWidget';
import { StreetViewWidget } from '../Widget/StreetView/StreetViewWidget';
import { BookmarkWidget } from '../Widget/Bookmark/BookmarkWidget';
import { FeedbackWidget } from '../Widget/Feedback/FeedbackWidget';
import { ContextMenuWidget } from '../Widget/ContextMenu/ContextMenuWidget';
import { GoogleMapsBusiness } from '../../Business/GoogleMapsBusiness';
import { DebugHelper } from '../../Toolbox/DebugHelper';
import { LazyManagedWindow } from '../Common/LazyManagedWindow';
import { QUERY_WINDOW_DEFINITIONS } from '../Common/QueryWindowRegistry';
import { ExperienceMapModeBridge } from './ExperienceMapModeBridge';
import { MapWorkspaceAccessibilityModel } from './mapWorkspaceAccessibility';
import { MapWorkspaceHealthSurface } from './MapWorkspaceHealthSurface';
import { MapWorkspaceShortcutHelpLauncher, requestMapWorkspaceHelp } from './MapWorkspaceShortcutHelp';
import { handleMapWorkspaceKeyDown } from './mapWorkspaceShortcuts';
import {
  isMapWorkspaceReadinessFailure,
  mapWorkspaceReadinessMessage,
  waitForMapWorkspaceViewReady,
} from './mapWorkspaceViewReadiness';
import { loadArcgisModules } from '../../gis-engine/arcgisModuleRuntime';
import type { ArcgisAccessorWatch } from '../../gis-engine/arcgisReactiveRuntime';
import { createViewStateBridge } from '../../gis-engine/viewState';
import {
  bindMapViewState,
  createMapViewOptions,
  createResponsivePadding,
  createViewPerformanceMonitor,
} from '../../gis-engine/viewRuntime';
import type { ExperienceMapMode } from '../../experience/experienceRuntime';
import type { ManagedWindowHandle } from '../../experience/contracts';
import type { WindowManagerApi } from '../../Store/Managers/WindowManager';
import { openExternalUrl } from '../Widget/_shared/MapWidgetRuntime';
import {
  attachKentRehberiGeoJsonLayer,
  isKentRehberiAbortError,
  type KentRehberiLayerHandle,
  type KentRehberiMapLike,
} from '../../data-services/kentRehberiGeoJsonLayer';
import './MapComponent.css';
import '../Widget/_shared/ExperienceWidgetModernization.css';

type WindowManagerLike = WindowManagerApi;
interface MapComponentProps { windowManager: WindowManagerLike; }
interface RemovableHandle { remove?: () => void; }
interface PopupLike {
  selectedFeature?: { geometry?: unknown } | null;
  on?: (eventName: string, callback: (event: { action?: { id?: string } }) => void) => RemovableHandle;
}
interface MapViewLike {
  destroyed?: boolean;
  container?: HTMLElement | null;
  map?: unknown;
  popup: PopupLike;
  padding?: unknown;
  updating?: boolean;
  when?: () => Promise<unknown>;
  on?: (eventName: string, callback: (event: MapClickEvent) => void) => RemovableHandle;
  destroy?: () => void;
}
interface MapClickEvent { button?: number; [key: string]: unknown; }
interface WatchUtilsLike {
  watch: ArcgisAccessorWatch;
  whenTrue: (target: unknown, propertyName: string, callback: () => void) => RemovableHandle;
  whenFalse: (target: unknown, propertyName: string, callback: () => void) => RemovableHandle;
}
type ArcgisMapConstructor = new (options: unknown) => unknown;
type ArcgisMapViewConstructor = new (options: unknown) => MapViewLike;

const LegacySidebar = SidebarModern as React.ElementType;
const ModernToolbarWidget = ToolbarWidgetModern as React.ElementType;
const LegacyMeasurementWidget = MeasurementWidget as React.ElementType;
const safeRemove = (handle: RemovableHandle | null | undefined): void => {
  try { handle?.remove?.(); } catch (error) { DebugHelper.Log(error); }
};

export const MapComponent = ({ windowManager }: MapComponentProps) => {
  const mapDiv = useRef<HTMLDivElement | null>(null);
  const navigationLandmarkRef = useRef<HTMLElement | null>(null);
  const accessorWatchRef = useRef<ArcgisAccessorWatch | null>(null);
  const activeViewModeRef = useRef<ExperienceMapMode>('2d');
  const startedGenerationRef = useRef<number | null>(null);
  const accessibilityModelRef = useRef<MapWorkspaceAccessibilityModel | null>(null);
  if (!accessibilityModelRef.current) {
    accessibilityModelRef.current = new MapWorkspaceAccessibilityModel({
      onObserverError(error) {
        DebugHelper.Log(error);
      },
    });
  }
  const accessibilityModel = accessibilityModelRef.current;
  const accessibilitySnapshot = useSyncExternalStore(accessibilityModel.subscribe, accessibilityModel.getSnapshot, accessibilityModel.getSnapshot);
  const [workspaceGeneration, setWorkspaceGeneration] = useState(0);
  const [mapView, setMapView] = useState<MapViewLike | null>(null);
  const sidebarRef = useRef<unknown>(null);
  const basemapWidgetRef = useRef<ManagedWindowHandle | null>(null);
  const bookmarkWidgetRef = useRef<ManagedWindowHandle | null>(null);
  const contextMenuWidgetRef = useRef<ManagedWindowHandle | null>(null);
  const feedbackWidgetRef = useRef<ManagedWindowHandle | null>(null);
  const globalIdentifyWidgetRef = useRef<ManagedWindowHandle | null>(null);
  const measurementWidgetRef = useRef<unknown>(null);
  const sketchWidgetRef = useRef<ManagedWindowHandle | null>(null);
  const streetViewWidgetRef = useRef<ManagedWindowHandle | null>(null);

  const retryWorkspace = useCallback((): void => {
    if (!accessibilityModel.getSnapshot().canRetry) return;
    setMapView(null);
    setWorkspaceGeneration((generation) => generation + 1);
  }, [accessibilityModel]);

  const reloadWorkspacePage = useCallback((): void => {
    window.location.reload();
  }, []);

  useEffect(() => {
    const onWorkspaceKeyDown = (event: KeyboardEvent): void => {
      handleMapWorkspaceKeyDown(event, {
        mapElement: mapDiv.current,
        navigationElement: navigationLandmarkRef.current,
        windowManager,
      });
    };
    window.addEventListener('keydown', onWorkspaceKeyDown);
    return () => window.removeEventListener('keydown', onWorkspaceKeyDown);
  }, [windowManager]);

  useEffect(() => {
    if (startedGenerationRef.current !== workspaceGeneration) {
      const started = accessibilityModel.beginAttempt();
      if (!started) return undefined;
      startedGenerationRef.current = workspaceGeneration;
    }

    let disposed = false;
    let view: MapViewLike | null = null;
    let bridge: ReturnType<typeof createViewStateBridge> | null = null;
    let performanceMonitor: ReturnType<typeof createViewPerformanceMonitor> | null = null;
    let unbindViewState: () => void = () => undefined;
    let kentRehberiLayerHandle: KentRehberiLayerHandle | null = null;
    const workspaceAbortController = new AbortController();
    const handles: RemovableHandle[] = [];

    const initializeMap = async (): Promise<void> => {
      const mapConfig = MapManager.GetMapConfiguration?.() ?? {};
      const [MapCtor, MapViewCtor, watchUtils] = await loadArcgisModules<[ArcgisMapConstructor, ArcgisMapViewConstructor, WatchUtilsLike]>([
        'esri/Map', 'esri/views/MapView', 'esri/core/watchUtils',
      ]);
      if (disposed || !mapDiv.current) return;
      accessorWatchRef.current = watchUtils.watch;
      const map = new MapCtor({ basemap: 'osm' });
      view = new MapViewCtor(createMapViewOptions({ container: mapDiv.current, map, configuration: mapConfig, viewportWidth: window.innerWidth }));

      const readiness = await waitForMapWorkspaceViewReady(view, { signal: workspaceAbortController.signal });
      if (disposed || readiness.status === 'aborted') return;
      if (isMapWorkspaceReadinessFailure(readiness)) {
        throw new Error(mapWorkspaceReadinessMessage(readiness));
      }

      bridge = createViewStateBridge({ mode: '2d' }, { onListenerError: (error: unknown) => DebugHelper.Log(error) });
      MapManager.SetViewStateBridge?.(bridge as never);
      unbindViewState = bindMapViewState(view as never, bridge, {
        publishInitial: true, applyIncoming: true, goToOptions: { duration: 0, animate: false },
        onApplyError: (error: unknown) => DebugHelper.Log(error), accessorWatch: watchUtils.watch,
      });
      performanceMonitor = createViewPerformanceMonitor(view as never, {
        slowThresholdMs: 250, accessorWatch: watchUtils.watch, onError: (error: unknown) => DebugHelper.Log(error),
      });
      MapManager.SetViewPerformanceMonitor?.(performanceMonitor);
      handles.push(
        watchUtils.whenTrue(view, 'updating', () => { windowManager.SetMapUpdating(true); accessibilityModel.markUpdating(true); }),
        watchUtils.whenFalse(view, 'updating', () => { windowManager.SetMapUpdating(false); accessibilityModel.markUpdating(false); }),
      );
      const popupHandle = view.popup.on?.('trigger-action', (event) => {
        const feature = view?.popup.selectedFeature;
        if (!feature?.geometry) return;
        if (event.action?.id === 'show-on-google') openExternalUrl(GoogleMapsBusiness.CreateRoutesUrlFromPoint(feature.geometry));
        if (event.action?.id === 'show-on-streetview' || event.action?.id === 'show-details') openExternalUrl(GoogleMapsBusiness.CreateStreetViewUrlFromPoint(feature.geometry));
      });
      if (popupHandle) handles.push(popupHandle);
      const clickHandle = view.on?.('click', (event) => {
        if (event.button === 2 || MapManager.GetMobileRightClick?.()) {
          MapManager.SetMapClickEvent?.(event as never); windowManager.ShowWindow('context-menu-widget');
        } else windowManager.HideWindow('context-menu-widget');
      });
      if (clickHandle) handles.push(clickHandle);
      const updatePadding = (): void => { if (view && !view.destroyed) view.padding = createResponsivePadding(window.innerWidth, mapConfig); };
      window.addEventListener('resize', updatePadding, { passive: true });
      handles.push({ remove: () => window.removeEventListener('resize', updatePadding) });
      Store.dispatch({ type: MapReducer_ActionTypes.SetMapView, payload: view });
      setMapView(view);
      accessibilityModel.markReady();
      if (view.updating) accessibilityModel.markUpdating(true);

      accessibilityModel.markResourceLoading('kent-rehberi-data');
      void attachKentRehberiGeoJsonLayer({ map: map as KentRehberiMapLike, signal: workspaceAbortController.signal })
        .then((handle) => {
          if (disposed) {
            handle.dispose();
            return;
          }
          kentRehberiLayerHandle = handle;
          accessibilityModel.markResourceReady('kent-rehberi-data');
        })
        .catch((error: unknown) => {
          if (isKentRehberiAbortError(error) || disposed) return;
          accessibilityModel.markResourceFailed('kent-rehberi-data', error);
          DebugHelper.Log(error);
        });
    };

    void initializeMap().catch((error: unknown) => {
      if (disposed || workspaceAbortController.signal.aborted) return;
      accessibilityModel.markError(error);
      DebugHelper.Log(error);
    });

    return () => {
      disposed = true;
      workspaceAbortController.abort();
      activeViewModeRef.current = '2d';
      accessorWatchRef.current = null;
      kentRehberiLayerHandle?.dispose();
      kentRehberiLayerHandle = null;
      unbindViewState();
      performanceMonitor?.dispose?.();
      MapManager.ClearViewPerformanceMonitor?.(performanceMonitor);
      MapManager.ClearViewStateBridge?.(bridge as never);
      bridge?.destroy?.();
      handles.forEach(safeRemove);
      windowManager.SetMapUpdating(false);
      Store.dispatch({ type: MapReducer_ActionTypes.SetMapView, payload: null });
      if (view) {
        try {
          view.container = null;
          view.destroy?.();
        } catch (error) {
          DebugHelper.Log(error);
        }
      }
    };
  }, [accessibilityModel, windowManager, workspaceGeneration]);

  useEffect(() => () => accessibilityModel.dispose(), [accessibilityModel]);

  return (
    <div
      className="esri-map"
      id="esri-map-container"
      ref={mapDiv}
      tabIndex={-1}
      aria-label="Kent Rehberi ana harita çalışma alanı"
      aria-busy={accessibilitySnapshot.isBusy}
      data-workspace-phase={accessibilitySnapshot.phase}
      data-workspace-health={accessibilitySnapshot.health}
    >
      <MapWorkspaceShortcutHelpLauncher />
      <MapWorkspaceHealthSurface
        model={accessibilityModel}
        onRetry={retryWorkspace}
        onOpenHelp={requestMapWorkspaceHelp}
        onReloadPage={reloadWorkspacePage}
      />
      {mapView && <>
        <ExperienceMapModeBridge mapView={mapView as never} modeRef={activeViewModeRef} accessorWatch={accessorWatchRef.current ?? undefined} />
        <div ref={(node) => { navigationLandmarkRef.current = node?.querySelector('header') ?? null; }}><NavigationBar id="mainbar" windowManager={windowManager} /></div>
        <LegacySidebar id="sidebar" windowManager={windowManager} ref={sidebarRef} />
        <ModernToolbarWidget id="toolbar-widget" windowManager={windowManager} />
        <BasemapWidget id="basemap-widget" windowManager={windowManager} ref={basemapWidgetRef} />
        <BookmarkWidget id="bookmark-widget" windowManager={windowManager} ref={bookmarkWidgetRef} />
        <ContextMenuWidget id="context-menu-widget" windowManager={windowManager} ref={contextMenuWidgetRef} />
        <FeedbackWidget id="feedback-widget" windowManager={windowManager} ref={feedbackWidgetRef} />
        <GlobalIdentifyWidget id="global-identify-widget" windowManager={windowManager} ref={globalIdentifyWidgetRef} />
        <LegacyMeasurementWidget id="measurement-widget" windowManager={windowManager} ref={measurementWidgetRef} />
        <SketchWidget id="sketch-widget" windowManager={windowManager} ref={sketchWidgetRef} />
        <StreetViewWidget id="streetview-widget" windowManager={windowManager} ref={streetViewWidgetRef} />
        {QUERY_WINDOW_DEFINITIONS.map((definition) => <LazyManagedWindow key={definition.id} id={definition.id} label={definition.label} component={definition.component} componentProps={{}} windowManager={windowManager} />)}
      </>}
    </div>
  );
};
