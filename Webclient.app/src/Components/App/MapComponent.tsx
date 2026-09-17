import React, { useEffect, useRef, useState } from 'react';
import { loadModules } from 'esri-loader';
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
import { createViewStateBridge } from '../../gis-engine/viewState';
import {
  bindMapViewState,
  createMapViewOptions,
  createResponsivePadding,
  createViewPerformanceMonitor,
} from '../../gis-engine/viewRuntime';
import type { ExperienceMapMode } from '../../experience/experienceRuntime';
import './MapComponent.css';

interface WindowManagerLike {
  SetMapUpdating: (updating: boolean) => void;
  ShowWindow: (id: string) => void;
  HideWindow: (id: string) => void;
}

interface MapComponentProps {
  windowManager: WindowManagerLike;
}

interface RemovableHandle {
  remove?: () => void;
}

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
  on?: (eventName: string, callback: (event: MapClickEvent) => void) => RemovableHandle;
  destroy?: () => void;
}

interface MapClickEvent {
  button?: number;
  [key: string]: unknown;
}

interface WatchUtilsLike {
  whenTrue: (target: unknown, propertyName: string, callback: () => void) => RemovableHandle;
  whenFalse: (target: unknown, propertyName: string, callback: () => void) => RemovableHandle;
}

const LegacyNavigationBar = NavigationBar as React.ElementType;
const LegacySidebar = SidebarModern as React.ElementType;
const ModernToolbarWidget = ToolbarWidgetModern as React.ElementType;
const LegacyBasemapWidget = BasemapWidget as React.ElementType;
const LegacyBookmarkWidget = BookmarkWidget as React.ElementType;
const LegacyContextMenuWidget = ContextMenuWidget as React.ElementType;
const LegacyFeedbackWidget = FeedbackWidget as React.ElementType;
const LegacyGlobalIdentifyWidget = GlobalIdentifyWidget as React.ElementType;
const LegacyMeasurementWidget = MeasurementWidget as React.ElementType;
const LegacySketchWidget = SketchWidget as React.ElementType;
const LegacyStreetViewWidget = StreetViewWidget as React.ElementType;

const openExternalMapUrl = (url: unknown): void => {
  if (typeof url !== 'string' || !url) return;
  const opened = window.open(url, '_blank', 'noopener,noreferrer');
  if (opened) opened.opener = null;
};

const safeRemove = (handle: RemovableHandle | null | undefined): void => {
  try {
    handle?.remove?.();
  } catch (error) {
    DebugHelper.Log(error);
  }
};

/**
 * Main map shell.
 *
 * The application starts with a lightweight MapView. The 3D SceneView is owned
 * by ExperienceMapModeBridge and is created lazily only when requested. Both
 * views share one ArcGIS Map and one view-state bridge, which keeps the data
 * model stable while allowing independent 2D/3D render lifecycles.
 */
export const MapComponent = ({ windowManager }: MapComponentProps) => {
  const mapDiv = useRef<HTMLDivElement | null>(null);
  const activeViewModeRef = useRef<ExperienceMapMode>('2d');
  const [mapView, setMapView] = useState<MapViewLike | null>(null);
  const sidebarRef = useRef<unknown>(null);

  const basemapWidgetRef = useRef<unknown>(null);
  const bookmarkWidgetRef = useRef<unknown>(null);
  const contextMenuWidgetRef = useRef<unknown>(null);
  const feedbackWidgetRef = useRef<unknown>(null);
  const globalIdentifyWidgetRef = useRef<unknown>(null);
  const measurementWidgetRef = useRef<unknown>(null);
  const sketchWidgetRef = useRef<unknown>(null);
  const streetViewWidgetRef = useRef<unknown>(null);

  useEffect(() => {
    let disposed = false;
    let view: MapViewLike | null = null;
    let bridge: ReturnType<typeof createViewStateBridge> | null = null;
    let performanceMonitor: ReturnType<typeof createViewPerformanceMonitor> | null = null;
    let unbindViewState: () => void = () => undefined;
    const handles: RemovableHandle[] = [];

    const initializeMap = async (): Promise<void> => {
      const mapConfig = MapManager.GetMapConfiguration?.() ?? {};
      const [MapCtor, MapViewCtor, watchUtils] = await loadModules([
        'esri/Map',
        'esri/views/MapView',
        'esri/core/watchUtils',
      ]) as [new (options: unknown) => unknown, new (options: unknown) => MapViewLike, WatchUtilsLike];

      if (disposed || !mapDiv.current) return;

      const map = new MapCtor({ basemap: 'osm' });
      view = new MapViewCtor(createMapViewOptions({
        container: mapDiv.current,
        map,
        configuration: mapConfig,
        viewportWidth: window.innerWidth,
      }));

      bridge = createViewStateBridge({ mode: '2d' }, {
        onListenerError: (error: unknown) => DebugHelper.Log(error),
      });
      MapManager.SetViewStateBridge?.(bridge as never);

      unbindViewState = bindMapViewState(view as never, bridge, {
        publishInitial: true,
        applyIncoming: true,
        goToOptions: { duration: 0, animate: false },
        onApplyError: (error: unknown) => DebugHelper.Log(error),
      });

      performanceMonitor = createViewPerformanceMonitor(view as never, {
        slowThresholdMs: 250,
      });
      MapManager.SetViewPerformanceMonitor?.(performanceMonitor);

      handles.push(
        watchUtils.whenTrue(view, 'updating', () => windowManager.SetMapUpdating(true)),
        watchUtils.whenFalse(view, 'updating', () => windowManager.SetMapUpdating(false)),
      );

      const popupHandle = view.popup.on?.('trigger-action', (event) => {
        const feature = view?.popup.selectedFeature;
        if (!feature?.geometry) return;

        if (event.action?.id === 'show-on-google') {
          openExternalMapUrl(GoogleMapsBusiness.CreateRoutesUrlFromPoint(feature.geometry));
        }

        if (event.action?.id === 'show-on-streetview' || event.action?.id === 'show-details') {
          openExternalMapUrl(GoogleMapsBusiness.CreateStreetViewUrlFromPoint(feature.geometry));
        }
      });
      if (popupHandle) handles.push(popupHandle);

      const clickHandle = view.on?.('click', (event) => {
        if (event.button === 2 || MapManager.GetMobileRightClick?.()) {
          MapManager.SetMapClickEvent?.(event as never);
          windowManager.ShowWindow('context-menu-widget');
        } else {
          windowManager.HideWindow('context-menu-widget');
        }
      });
      if (clickHandle) handles.push(clickHandle);

      const updatePadding = (): void => {
        if (view && !view.destroyed) {
          view.padding = createResponsivePadding(window.innerWidth, mapConfig);
        }
      };
      window.addEventListener('resize', updatePadding, { passive: true });
      handles.push({ remove: () => window.removeEventListener('resize', updatePadding) });

      Store.dispatch({
        type: MapReducer_ActionTypes.SetMapView,
        payload: view,
      });
      setMapView(view);
    };

    void initializeMap().catch((error: unknown) => DebugHelper.Log(error));

    return () => {
      disposed = true;
      activeViewModeRef.current = '2d';
      unbindViewState();
      performanceMonitor?.dispose?.();
      MapManager.ClearViewPerformanceMonitor?.(performanceMonitor);
      MapManager.ClearViewStateBridge?.(bridge as never);
      bridge?.destroy?.();
      handles.forEach(safeRemove);
      windowManager.SetMapUpdating(false);

      Store.dispatch({
        type: MapReducer_ActionTypes.SetMapView,
        payload: null,
      });

      if (view) {
        try {
          view.container = null;
          view.destroy?.();
        } catch (error) {
          DebugHelper.Log(error);
        }
      }
    };
  }, [windowManager]);

  return (
    <div
      className="esri-map"
      id="esri-map-container"
      ref={mapDiv}
      tabIndex={-1}
      aria-label="Kent Rehberi ana harita çalışma alanı"
    >
      {mapView && (
        <>
          <ExperienceMapModeBridge mapView={mapView as never} modeRef={activeViewModeRef} />
          <LegacyNavigationBar id="mainbar" windowManager={windowManager} />
          <LegacySidebar id="sidebar" windowManager={windowManager} ref={sidebarRef} />
          <ModernToolbarWidget id="toolbar-widget" windowManager={windowManager} />

          <LegacyBasemapWidget id="basemap-widget" windowManager={windowManager} ref={basemapWidgetRef} />
          <LegacyBookmarkWidget id="bookmark-widget" windowManager={windowManager} ref={bookmarkWidgetRef} />
          <LegacyContextMenuWidget id="context-menu-widget" windowManager={windowManager} ref={contextMenuWidgetRef} />
          <LegacyFeedbackWidget id="feedback-widget" windowManager={windowManager} ref={feedbackWidgetRef} />
          <LegacyGlobalIdentifyWidget id="global-identify-widget" windowManager={windowManager} ref={globalIdentifyWidgetRef} />
          <LegacyMeasurementWidget id="measurement-widget" windowManager={windowManager} ref={measurementWidgetRef} />
          <LegacySketchWidget id="sketch-widget" windowManager={windowManager} ref={sketchWidgetRef} />
          <LegacyStreetViewWidget id="streetview-widget" windowManager={windowManager} ref={streetViewWidgetRef} />

          {QUERY_WINDOW_DEFINITIONS.map((definition) => (
            <LazyManagedWindow
              key={definition.id}
              id={definition.id}
              label={definition.label}
              component={definition.component}
              componentProps={{}}
              windowManager={windowManager}
            />
          ))}
        </>
      )}
    </div>
  );
};
