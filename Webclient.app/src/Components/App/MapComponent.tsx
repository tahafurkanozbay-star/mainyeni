import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import Store from '../../Store/Store';
import { MapReducer_ActionTypes } from '../../Store/Reducers/MapReducer';
import { NavigationBar } from './NavigationBar';
import { SidebarModern } from './SidebarModern';
import MapManager from '../../Store/Managers/MapManager';
import { ToolbarWidgetModern } from '../Widget/Toolbar/ToolbarWidgetModern';
import { DebugHelper } from '../../Toolbox/DebugHelper';
import { LazyManagedWindow } from '../Common/LazyManagedWindow';
import { QUERY_WINDOW_DEFINITIONS } from '../Common/QueryWindowRegistry';
import { WIDGET_WINDOW_DEFINITIONS } from '../Common/WidgetWindowRegistry';
import { waitForArcgisView } from '../../gis-engine/viewReadiness';
import { withTimeout } from '../../platform/runtime/resilience';
import { ExperienceMapModeBridge } from './ExperienceMapModeBridge';
import { MapWorkspaceRecoverySurface } from './MapWorkspaceRecoverySurface';
import { MapWorkspaceRecoveryModel } from './mapWorkspaceRecoveryModel';
import { MapWorkspaceAccessibilityModel } from './mapWorkspaceAccessibility';
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
import type { WindowManagerApi } from '../../Store/Managers/WindowManager';
import type { KentRehberiMapLike } from '../../data-services/kentRehberiGeoJsonLayer';
import { searchAddressCandidates } from '../../data-services/addressGeocoding';
import type { AddressGeocodingResult } from '../../data-services/addressGeocoding';
import { KentRehberiDataLayer } from './KentRehberiDataLayer';
import './MapComponent.css';
import '../Widget/_shared/ExperienceWidgetModernization.css';

type WindowManagerLike = WindowManagerApi;
interface MapComponentProps { windowManager: WindowManagerLike; }
interface RemovableHandle { remove?: () => void; }
interface PopupLike {
  selectedFeature?: { geometry?: unknown } | null;
  on?: (eventName: string, callback: (event: { action?: { id?: string } }) => void) => RemovableHandle;
}
interface SearchGraphicsLayerLike {
  add?: (graphic: unknown) => void;
  removeAll?: () => void;
  destroy?: () => void;
}
interface SearchMapLike {
  add?: (layer: SearchGraphicsLayerLike) => void;
  remove?: (layer: SearchGraphicsLayerLike) => void;
}
type ArcgisGraphicsLayerConstructor = new (options: unknown) => SearchGraphicsLayerLike;
type ArcgisGraphicConstructor = new (options: unknown) => unknown;
interface MapViewLike {
  readonly ready?: boolean;
  readonly readyState?: string;
  readonly when?: () => PromiseLike<unknown>;
  destroyed?: boolean;
  container?: HTMLElement | null;
  map?: unknown;
  popup: PopupLike;
  padding?: unknown;
  goTo?: (target: unknown, options?: unknown) => PromiseLike<unknown> | unknown;
  toMap?: (screenPoint: { readonly x: number; readonly y: number }) => unknown;
  updating?: boolean;
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
const safeRemove = (handle: RemovableHandle | null | undefined): void => {
  try { handle?.remove?.(); } catch (error) { DebugHelper.Log(error); }
};

export const MapComponent = ({ windowManager }: MapComponentProps) => {
  const mapDiv = useRef<HTMLDivElement | null>(null);
  const searchMarkerLayerRef = useRef<SearchGraphicsLayerLike | null>(null);
  const searchMarkerMapRef = useRef<SearchMapLike | null>(null);
  const accessorWatchRef = useRef<ArcgisAccessorWatch | null>(null);
  const activeViewModeRef = useRef<ExperienceMapMode>('2d');
  const accessibilityModelRef = useRef<MapWorkspaceAccessibilityModel | null>(null);
  if (!accessibilityModelRef.current) accessibilityModelRef.current = new MapWorkspaceAccessibilityModel();
  const accessibilityModel = accessibilityModelRef.current;
  const accessibilitySnapshot = useSyncExternalStore(accessibilityModel.subscribe, accessibilityModel.getSnapshot, accessibilityModel.getSnapshot);
  const recoveryModelRef = useRef<MapWorkspaceRecoveryModel | null>(null);
  if (!recoveryModelRef.current) {
    recoveryModelRef.current = new MapWorkspaceRecoveryModel({
      onObserverError: (error) => DebugHelper.Log(error),
    });
  }
  const recoveryModel = recoveryModelRef.current;
  const [mapGeneration, setMapGeneration] = useState(0);
  const [initialModeResolved, setInitialModeResolved] = useState(false);
  const [mapView, setMapView] = useState<MapViewLike | null>(null);
  const [sidebarToolHost, setSidebarToolHost] = useState<HTMLDivElement | null>(null);
  const sidebarRef = useRef<unknown>(null);

  useEffect(() => {
    let disposed = false;
    let cleaned = false;
    const lifetime = new AbortController();
    let view: MapViewLike | null = null;
    let bridge: ReturnType<typeof createViewStateBridge> | null = null;
    let performanceMonitor: ReturnType<typeof createViewPerformanceMonitor> | null = null;
    let unbindViewState: () => void = () => undefined;
    const handles: RemovableHandle[] = [];
    accessibilityModel.reset();
    const recoveryAttemptId = recoveryModel.beginAttempt();

    const initializeMap = async (signal: AbortSignal): Promise<void> => {
      const mapConfig = MapManager.GetMapConfiguration?.() ?? {};
      const [MapCtor, MapViewCtor, watchUtils] = await loadArcgisModules<[ArcgisMapConstructor, ArcgisMapViewConstructor, WatchUtilsLike]>([
        'esri/Map', 'esri/views/MapView', 'esri/core/watchUtils',
      ]);
      if (disposed || signal.aborted || !mapDiv.current) return;
      accessorWatchRef.current = watchUtils.watch;
      // The no-key 3D scene uses OpenStreetMap tiles and extruded OSM building footprints.
      // Omit World Elevation so the default scene does not depend on an Esri credential.
      const map = new MapCtor({ basemap: 'osm' });
      view = new MapViewCtor(createMapViewOptions({ container: mapDiv.current, map, configuration: mapConfig, viewportWidth: window.innerWidth }));
      await waitForArcgisView(view, { signal, accessorWatch: watchUtils.watch });
      if (disposed || signal.aborted) return;
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
      const clickHandle = view.on?.('click', (event) => {
        if (MapManager.GetMobileRightClick?.()) {
          MapManager.SetMapClickEvent?.(event);
          windowManager.ShowWindow('global-identify-widget');
        } else {
          windowManager.HideWindow('context-menu-widget');
        }
      });
      if (clickHandle) handles.push(clickHandle);

      // Native contextmenu is more reliable than SDK click button values for a
      // secondary click. Resolve coordinates against the currently visible view.
      const mapRoot = mapDiv.current?.parentElement;
      const handleMapContextMenu = (event: MouseEvent): void => {
        const target = event.target;
        if (!(target instanceof Element)
          || !target.closest('.experience-mapview-host, .experience-scene-host')) return;
        event.preventDefault();

        const activeView = (
          MapManager.GetActiveMapView?.() ?? MapManager.GetMapView()
        ) as MapViewLike | null;
        if (!activeView || activeView.destroyed || typeof activeView.toMap !== 'function') return;

        const container = activeView.container instanceof HTMLElement ? activeView.container : mapRoot;
        const rect = container?.getBoundingClientRect();
        const x = event.clientX - (rect?.left ?? 0);
        const y = event.clientY - (rect?.top ?? 0);
        const mapPoint = activeView.toMap({ x, y });
        if (!mapPoint || typeof mapPoint !== 'object') return;

        MapManager.SetMapClickEvent?.({ x, y, mapPoint });
        windowManager.HideWindow('context-menu-widget');
        windowManager.ShowWindow('global-identify-widget');
      };
      mapRoot?.addEventListener('contextmenu', handleMapContextMenu);
      if (mapRoot) handles.push({ remove: () => mapRoot.removeEventListener('contextmenu', handleMapContextMenu) });
      const updatePadding = (): void => { if (view && !view.destroyed) view.padding = createResponsivePadding(window.innerWidth, mapConfig); };
      window.addEventListener('resize', updatePadding, { passive: true });
      handles.push({ remove: () => window.removeEventListener('resize', updatePadding) });
      Store.dispatch({ type: MapReducer_ActionTypes.SetMapView, payload: view });
      MapManager.SetActiveMapView?.(view);
      setMapView(view);
      accessibilityModel.markReady();
      if (recoveryAttemptId !== null) recoveryModel.succeed(recoveryAttemptId);
      if (view.updating) accessibilityModel.markUpdating(true);
    };
    const cleanupResources = (): void => {
      if (cleaned) return;
      cleaned = true;
      activeViewModeRef.current = '2d'; accessorWatchRef.current = null;
      try {
        const markerLayer = searchMarkerLayerRef.current;
        const markerMap = searchMarkerMapRef.current;
        if (markerLayer && markerMap?.remove) markerMap.remove(markerLayer);
        else markerLayer?.removeAll?.();
      } catch (error) { DebugHelper.Log(error); }
      searchMarkerLayerRef.current = null;
      searchMarkerMapRef.current = null;
      unbindViewState(); performanceMonitor?.dispose?.(); MapManager.ClearViewPerformanceMonitor?.(performanceMonitor);
      MapManager.ClearViewStateBridge?.(bridge as never); bridge?.destroy?.(); handles.forEach(safeRemove); windowManager.SetMapUpdating(false);
      Store.dispatch({ type: MapReducer_ActionTypes.SetMapView, payload: null });
      MapManager.SetActiveMapView?.(null);
      setMapView(null);
      if (view) { try { view.container = null; view.destroy?.(); } catch (error) { DebugHelper.Log(error); } }
    };
    void withTimeout(initializeMap, 20_000, lifetime.signal).catch((error: unknown) => {
      if (disposed) return;
      cleanupResources();
      accessibilityModel.markError('Harita çalışma alanı başlatılamadı. Yeniden deneyebilirsiniz.');
      if (recoveryAttemptId !== null) recoveryModel.fail(recoveryAttemptId, error);
      DebugHelper.Log(error);
    });
    return () => {
      disposed = true;
      lifetime.abort();
      cleanupResources();
    };
  }, [accessibilityModel, mapGeneration, recoveryModel, windowManager]);

  const markInitialModeResolved = useCallback((): void => {
    setInitialModeResolved(true);
  }, []);

  const restartMapWorkspace = useCallback((): void => {
    if (!recoveryModel.canRetry()) return;
    setInitialModeResolved(false);
    setMapGeneration((generation) => generation + 1);
  }, [recoveryModel]);

  const searchAddress = useCallback(async (
    query: string,
    signal: AbortSignal,
  ): Promise<readonly AddressGeocodingResult[]> => {
    if (signal.aborted) throw signal.reason ?? new DOMException('Adres araması iptal edildi.', 'AbortError');
    const view = (
      MapManager.GetActiveMapView?.() ?? MapManager.GetMapView()
    ) as MapViewLike | null;
    if (!view || view.destroyed || typeof view.goTo !== 'function') {
      throw new Error('Harita henüz hazır değil. Birkaç saniye sonra yeniden deneyin.');
    }
    return searchAddressCandidates(query, { signal });
  }, []);

  const selectAddress = useCallback(async (
    result: AddressGeocodingResult,
    signal: AbortSignal,
  ): Promise<void> => {
    if (signal.aborted) throw signal.reason ?? new DOMException('Adres seçimi iptal edildi.', 'AbortError');

    const getActiveNavigationView = (): MapViewLike | null => (
      (MapManager.GetActiveMapView?.() ?? MapManager.GetMapView()) as MapViewLike | null
    );
    const view = getActiveNavigationView();
    if (!view || view.destroyed || typeof view.goTo !== 'function') {
      throw new Error('Harita henüz hazır değil. Birkaç saniye sonra yeniden deneyin.');
    }
    const activeMap = view.map as SearchMapLike | null;
    if (!activeMap || typeof activeMap.add !== 'function') {
      throw new Error('Mevcut haritaya konum işaretçisi eklenemedi.');
    }

    const [GraphicsLayerCtor, GraphicCtor] = await loadArcgisModules<[
      ArcgisGraphicsLayerConstructor,
      ArcgisGraphicConstructor,
    ]>(['esri/layers/GraphicsLayer', 'esri/Graphic']);
    if (signal.aborted) throw signal.reason ?? new DOMException('Adres seçimi iptal edildi.', 'AbortError');
    if (view !== getActiveNavigationView() || view.destroyed) {
      throw new DOMException('Harita görünümü değişti.', 'AbortError');
    }

    let markerLayer = searchMarkerLayerRef.current;
    if (!markerLayer || searchMarkerMapRef.current !== activeMap) {
      if (markerLayer && searchMarkerMapRef.current?.remove) {
        searchMarkerMapRef.current.remove(markerLayer);
      }
      markerLayer = new GraphicsLayerCtor({
        title: 'Adres arama işaretçisi',
        listMode: 'hide',
      });
      activeMap.add(markerLayer);
      searchMarkerLayerRef.current = markerLayer;
      searchMarkerMapRef.current = activeMap;
    }

    if (typeof markerLayer.removeAll !== 'function' || typeof markerLayer.add !== 'function') {
      throw new Error('Konum işaretçisi harita katmanı kullanılamıyor.');
    }
    markerLayer.removeAll();

    const marker = new GraphicCtor({
      geometry: {
        type: 'point',
        longitude: result.longitude,
        latitude: result.latitude,
        spatialReference: { wkid: 4326 },
      },
      // Reuse the deployed local pin asset so the marker works in both 2D and 3D views.
      symbol: {
        type: 'picture-marker',
        url: 'images/icons/map/pictureMarker.png',
        width: '40px',
        height: '40px',
        yoffset: 20,
      },
      attributes: { address: result.displayName },
    });
    markerLayer.add(marker);

    await view.goTo(
      { center: [result.longitude, result.latitude], zoom: result.zoom },
      { duration: 650 },
    );
    if (signal.aborted) throw signal.reason ?? new DOMException('Adres seçimi iptal edildi.', 'AbortError');
    if (view !== getActiveNavigationView() || view.destroyed) {
      throw new DOMException('Harita görünümü değişti.', 'AbortError');
    }
  }, []);

  const modelsMountedRef = useRef(false);
  useEffect(() => {
    modelsMountedRef.current = true;
    return () => {
      modelsMountedRef.current = false;
      queueMicrotask(() => {
        if (modelsMountedRef.current) return;
        accessibilityModel.dispose();
        recoveryModel.dispose();
      });
    };
  }, [accessibilityModel, recoveryModel]);

  return (
    <div className="esri-map" id="esri-map-container" aria-label="Kent Rehberi ana harita çalışma alanı" aria-busy={accessibilitySnapshot.isBusy} data-workspace-phase={accessibilitySnapshot.phase} data-initial-mode-resolved={initialModeResolved ? 'true' : 'false'}>
      <div ref={mapDiv} className="experience-mapview-host" tabIndex={-1} aria-label="Kent Rehberi harita çizim alanı" />
      <div className="map-workspace-status" role={accessibilitySnapshot.phase === 'error' ? 'alert' : 'status'} aria-live={accessibilitySnapshot.phase === 'error' ? 'assertive' : 'polite'} aria-atomic="true">{accessibilitySnapshot.announcement}</div>
      <MapWorkspaceRecoverySurface model={recoveryModel} onRetry={restartMapWorkspace} />
      {mapView && <>
        <KentRehberiDataLayer map={mapView.map as KentRehberiMapLike} />
        <ExperienceMapModeBridge mapView={mapView as never} modeRef={activeViewModeRef} accessorWatch={accessorWatchRef.current ?? undefined} onInitialModeResolved={markInitialModeResolved} />
        <NavigationBar id="mainbar" onAddressSearch={searchAddress} onAddressSelect={selectAddress} />
        <LegacySidebar id="sidebar" windowManager={windowManager} ref={sidebarRef} onToolHostChange={setSidebarToolHost} />
        <ModernToolbarWidget
          id="toolbar-widget"
          windowManager={windowManager}
          accessorWatch={accessorWatchRef.current ?? undefined}
        />
        {WIDGET_WINDOW_DEFINITIONS.map((definition) => <LazyManagedWindow key={definition.id} {...definition} keepMounted windowManager={windowManager} />)}
        {sidebarToolHost ? createPortal(
          QUERY_WINDOW_DEFINITIONS.map((definition) => (
            <LazyManagedWindow key={definition.id} {...definition} windowManager={windowManager} />
          )),
          sidebarToolHost,
        ) : null}
      </>}
    </div>
  );
};
