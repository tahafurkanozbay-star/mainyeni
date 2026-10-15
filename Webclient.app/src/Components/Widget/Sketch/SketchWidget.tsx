import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { loadArcgisModules } from '../../../gis-engine/arcgisModuleRuntime';
import { runtimeDiagnostics } from '../../../platform/runtime/runtimeDiagnostics';
import MapManager from '../../../Store/Managers/MapManager';
import Store from '../../../Store/Store';
import type { ArcgisAccessorWatch, ArcgisReactiveHandle } from '../../../gis-engine/arcgisReactiveRuntime';
import { useMapWidgetFocus } from '../_shared/useMapWidgetFocus';
import type { ManagedWindowHandle } from '../../../experience/contracts';
import {
  MapWidgetEmptyState,
  MapWidgetSkeleton,
  MapWidgetSurface,
  type MapWidgetManagerLike,
} from '../_shared/MapWidgetSurface';
import {
  createLatestOperationGate,
  isAbortLikeError,
  type LatestOperationGate,
} from '../_shared/MapWidgetRuntime';
import './SketchWidget.css';
import { createArcgisWidgetHost, type OwnedArcgisWidgetHost } from '../../../gis-engine/arcgisWidgetHost';

interface GraphicsLayerLike {
  readonly graphics?: { readonly length: number };
  removeAll?: () => void;
  destroy?: () => void;
}

interface MapLike {
  add: (layer: GraphicsLayerLike) => void;
  remove: (layer: GraphicsLayerLike) => void;
}

interface MapViewLike {
  readonly map?: MapLike;
  readonly ready?: boolean;
  readonly destroyed?: boolean;
}

interface SketchLike {
  readonly activeTool?: string | null;
  cancel?: () => void;
  destroy?: () => void;
}

type SketchConstructor = new (options: Readonly<{
  layer: GraphicsLayerLike;
  view: MapViewLike;
  container: HTMLDivElement;
  activeTool: null;
  iconClass: string;
  scale: 'l';
  toolbarKind: 'docked';
}>) => SketchLike;

type GraphicsLayerConstructor = new (options: Readonly<{ title: string }>) => GraphicsLayerLike;

export interface SketchWidgetProps {
  readonly id: string;
  readonly windowManager: MapWidgetManagerLike;
}

const reportSketchError = (error: unknown): void => {
  try { runtimeDiagnostics.captureError(error, { source: 'experience.sketch' }, 'warn'); }
  catch { console.warn('Sketch diagnostic reporting failed.'); }
};

const isViewReady = (view: MapViewLike | null): view is MapViewLike & { readonly map: MapLike } =>
  Boolean(view?.map && typeof view.map.add === 'function' && typeof view.map.remove === 'function'
    && view.ready !== false && view.destroyed !== true);

const SKETCH_OPERATION_POLICY = Object.freeze({ timeout: 15_000 });

const releaseHandles = (handles: ArcgisReactiveHandle[]): void => {
  for (const handle of handles.splice(0)) {
    try { handle.remove?.(); } catch (error) { reportSketchError(error); }
  }
};

export const SketchWidget = forwardRef<ManagedWindowHandle, SketchWidgetProps>(
  ({ id, windowManager }, ref): ReactNode => {
    const visible = windowManager.IsVisible(id);
    useMapWidgetFocus(id, visible);
    const sketchRef = useRef<SketchLike | null>(null);
    const sketchLayerRef = useRef<GraphicsLayerLike | null>(null);
    const attachedMapRef = useRef<MapLike | null>(null);
    const boundViewRef = useRef<MapViewLike | null>(null);
    const mountedRef = useRef(false);
    const operationRevisionRef = useRef(0);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const hostRef = useRef<OwnedArcgisWidgetHost | null>(null);
    const gateRef = useRef<LatestOperationGate | null>(null);
    const openedRef = useRef(false);
    const visibleRef = useRef(visible);
    visibleRef.current = visible;
    const initializeRef = useRef<() => Promise<void>>(async () => undefined);
    const watcherRef = useRef<ArcgisAccessorWatch | null>(null);
    const observedViewRef = useRef<MapViewLike | null>(null);
    const viewHandlesRef = useRef<ArcgisReactiveHandle[]>([]);
    const drawingHandlesRef = useRef<ArcgisReactiveHandle[]>([]);
    const clearButtonRef = useRef<HTMLButtonElement>(null);
    const cancelClearRef = useRef<HTMLButtonElement>(null);
    const summaryRef = useRef<HTMLDivElement>(null);
    const clearFocusRef = useRef(false);
    const actionFocusRef = useRef(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [ready, setReady] = useState(false);
    const [drawingCount, setDrawingCount] = useState(0);
    const [drawingActive, setDrawingActive] = useState(false);
    const [confirmClear, setConfirmClear] = useState(false);

    if (gateRef.current === null) {
      gateRef.current = createLatestOperationGate((snapshot) => {
        setLoading(snapshot.phase === 'running');
      });
    }

    const synchronizeDrawing = useCallback((): void => {
      if (!mountedRef.current) return;
      const count = sketchLayerRef.current?.graphics?.length ?? 0;
      setDrawingCount(Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0);
      setDrawingActive(Boolean(sketchRef.current?.activeTool));
    }, []);

    const cancelDrawing = useCallback((): void => {
      try { sketchRef.current?.cancel?.(); } catch (error) { reportSketchError(error); }
      synchronizeDrawing();
    }, [synchronizeDrawing]);

    const clearSketch = useCallback((): void => {
      cancelDrawing();
      try { sketchLayerRef.current?.removeAll?.(); } catch (error) { reportSketchError(error); }
      synchronizeDrawing();
    }, [cancelDrawing, synchronizeDrawing]);

    const observeView = useCallback((view: MapViewLike | null): void => {
      if (observedViewRef.current === view && viewHandlesRef.current.length > 0) return;
      releaseHandles(viewHandlesRef.current);
      observedViewRef.current = view;
      const watch = watcherRef.current;
      if (!view || !watch) return;
      const refresh = (): void => {
        if (openedRef.current && visibleRef.current) void initializeRef.current();
      };
      for (const property of ['ready', 'destroyed']) {
        try { viewHandlesRef.current.push(watch(view, property, refresh)); }
        catch (error) { reportSketchError(error); }
      }
    }, []);

    const observeDrawing = useCallback((): void => {
      releaseHandles(drawingHandlesRef.current);
      const watch = watcherRef.current;
      const sketch = sketchRef.current;
      const layer = sketchLayerRef.current;
      if (watch && sketch && layer) {
        const refresh = (): void => {
          if (openedRef.current && sketchRef.current === sketch && sketchLayerRef.current === layer) synchronizeDrawing();
        };
        for (const [target, property] of [[layer.graphics, 'length'], [sketch, 'activeTool']] as const) {
          if (!target) continue;
          try { drawingHandlesRef.current.push(watch(target, property, refresh)); }
          catch (error) { reportSketchError(error); }
        }
      }
      synchronizeDrawing();
    }, [synchronizeDrawing]);

    const disposeSketch = useCallback((): void => {
      const layer = sketchLayerRef.current;
      const map = attachedMapRef.current;
      releaseHandles(drawingHandlesRef.current);
      clearSketch();
      try {
        sketchRef.current?.destroy?.();
      } catch (error) {
        reportSketchError(error);
      } finally {
        sketchRef.current = null;
        hostRef.current?.dispose();
        hostRef.current = null;
      }
      if (layer && map) {
        try {
          map.remove(layer);
        } catch (error) {
          reportSketchError(error);
        }
      }
      sketchLayerRef.current = null;
      attachedMapRef.current = null;
      boundViewRef.current = null;
      try { layer?.destroy?.(); } catch (error) { reportSketchError(error); }
      if (mountedRef.current) {
        setReady(false);
        setDrawingCount(0);
        setDrawingActive(false);
        setConfirmClear(false);
      }
    }, [clearSketch]);

    const initialize = useCallback(async (): Promise<void> => {
      const mapView = MapManager.GetMapView() as MapViewLike | null;
      if (!containerRef.current || !openedRef.current) return;
      observeView(mapView);
      if (boundViewRef.current === mapView && gateRef.current?.snapshot().phase === 'running') return;
      if (boundViewRef.current === mapView && sketchRef.current && isViewReady(mapView)) {
        if (drawingHandlesRef.current.length === 0) observeDrawing();
        return;
      }
      if (boundViewRef.current !== mapView || !isViewReady(mapView)) {
        operationRevisionRef.current += 1;
        gateRef.current?.cancel('map-view-changed');
        disposeSketch();
      }
      if (!mapView?.map) {
        setError('Çizim araçları için harita görünümü henüz hazır değil.');
        return;
      }
      if (!isViewReady(mapView) && watcherRef.current) {
        setError('Çizim araçları için harita görünümü henüz hazır değil.');
        return;
      }

      setError(null);
      boundViewRef.current = mapView;
      const revision = ++operationRevisionRef.current;
      try {
        await gateRef.current?.run(async (operation) => {
          const [Sketch, GraphicsLayer, reactive] = await loadArcgisModules<[
            SketchConstructor,
            GraphicsLayerConstructor,
            { readonly watch?: ArcgisAccessorWatch } | undefined,
          ]>([
            'esri/widgets/Sketch',
            'esri/layers/GraphicsLayer',
            'esri/core/watchUtils',
          ]);
          if (!operation.isCurrent() || !containerRef.current) return;
          if (MapManager.GetMapView() !== mapView) throw new Error('Map view changed before sketch admission.');
          watcherRef.current = reactive?.watch ?? null;
          observeView(mapView);
          if (!isViewReady(mapView)) {
            setError('Çizim araçları için harita görünümü henüz hazır değil.');
            return;
          }

          const layer = new GraphicsLayer({ title: 'Kullanıcı çizimleri' });
          sketchLayerRef.current = layer;
          attachedMapRef.current = mapView.map ?? null;
          mapView.map?.add(layer);
          if (!operation.isCurrent() || !containerRef.current) {
            disposeSketch();
            return;
          }

          hostRef.current = createArcgisWidgetHost(containerRef.current);
          const sketch = new Sketch({
            layer,
            view: mapView,
            container: hostRef.current.container,
            activeTool: null,
            iconClass: 'sketch-icon',
            scale: 'l',
            toolbarKind: 'docked',
          });

          sketchRef.current = sketch;
          observeDrawing();
          setReady(true);
        }, { timeoutMs: SKETCH_OPERATION_POLICY.timeout });
      } catch (caught) {
        if (!mountedRef.current || revision !== operationRevisionRef.current || isAbortLikeError(caught)) return;
        disposeSketch();
        reportSketchError(caught);
        setError('Çizim araçları başlatılamadı. Harita hazır olduğunda yeniden deneyin.');
      }
    }, [disposeSketch, observeDrawing, observeView]);
    initializeRef.current = initialize;

    useImperativeHandle(ref, () => ({
      id,
      visible: false,
      minimized: false,
      OnShow: () => {
        openedRef.current = true;
        void initialize();
      },
      OnClose: () => {
        openedRef.current = false;
        clearFocusRef.current = false;
        actionFocusRef.current = false;
        setConfirmClear(false);
        operationRevisionRef.current += 1;
        gateRef.current?.cancel('widget-closed');
        clearSketch();
        releaseHandles(viewHandlesRef.current);
        releaseHandles(drawingHandlesRef.current);
      },
    }), [clearSketch, id, initialize, windowManager]);

    useEffect(() => {
      mountedRef.current = true;
      windowManager.RegisterWindow(ref as RefObject<ManagedWindowHandle | null>);
      return () => {
        mountedRef.current = false;
        openedRef.current = false;
        operationRevisionRef.current += 1;
        gateRef.current?.cancel('widget-unmounted');
        disposeSketch();
        releaseHandles(viewHandlesRef.current);
        windowManager.UnregisterWindow?.(id, ref as RefObject<ManagedWindowHandle | null>);
        queueMicrotask(() => {
          if (!mountedRef.current) gateRef.current?.dispose();
        });
      };
    }, [disposeSketch, id, ref, windowManager]);

    useEffect(() => {
      if (!visible) return undefined;
      const unsubscribe = Store.subscribe(() => {
        if (openedRef.current) void initialize();
      });
      return () => {
        openedRef.current = false;
        clearFocusRef.current = false;
        actionFocusRef.current = false;
        operationRevisionRef.current += 1;
        gateRef.current?.cancel('widget-hidden');
        if (mountedRef.current) setConfirmClear(false);
        unsubscribe();
        releaseHandles(viewHandlesRef.current);
        releaseHandles(drawingHandlesRef.current);
      };
    }, [initialize, visible]);

    useLayoutEffect(() => {
      if (!clearFocusRef.current || !visible || windowManager.IsMinimized(id)) return;
      if (confirmClear) {
        cancelClearRef.current?.focus();
        return;
      }
      clearFocusRef.current = false;
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== document.body && active.isConnected) return;
      const target = clearButtonRef.current?.disabled
        ? containerRef.current?.querySelector<HTMLElement>('button:not(:disabled):not([aria-disabled="true"]), [role="button"][tabindex="0"]:not([aria-disabled="true"])') ?? summaryRef.current
        : clearButtonRef.current;
      target?.focus();
    }, [confirmClear, id, visible, windowManager]);

    useLayoutEffect(() => {
      if (!actionFocusRef.current || loading) return;
      actionFocusRef.current = false;
      if (!visible || windowManager.IsMinimized(id)) return;
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== document.body && active.isConnected) return;
      const target = error
        ? document.getElementById(`${id}-sketch-retry`)
        : containerRef.current?.querySelector<HTMLElement>('button:not(:disabled):not([aria-disabled="true"]), [role="button"][tabindex="0"]:not([aria-disabled="true"])');
      (target ?? summaryRef.current)?.focus();
    }, [drawingActive, error, id, loading, ready, visible, windowManager]);

    useEffect(() => { if (drawingCount === 0) setConfirmClear(false); }, [drawingCount]);

    return (
      <MapWidgetSurface
        id={id}
        title="Çizim Araçları"
        iconSrc="images/icons/toolbar/cizimaraci.png"
        windowManager={windowManager}
        className="sketch-widget"
        busy={loading}
        error={error}
        status={ready ? 'Çizim katmanı hazır' : null}
        statusTone="success"
        bodyClassName="sketch-widget__body"
        footer={ready ? (
          confirmClear ? (
            <div className="sketch-widget__confirmation" role="group" aria-label="Çizimleri temizleme onayı" onKeyDown={event => {
              if (event.key !== 'Escape') return;
              event.preventDefault(); event.stopPropagation(); setConfirmClear(false);
            }}>
              <p>{drawingCount} çizimin tamamı silinsin mi? Bu işlem geri alınamaz.</p>
              <div className="sketch-widget__actions">
                <button ref={cancelClearRef} type="button" className="map-widget-action" onClick={() => setConfirmClear(false)}>Vazgeç</button>
                <button type="button" className="map-widget-action map-widget-action--danger" onClick={() => { clearSketch(); setConfirmClear(false); }}>Tümünü sil</button>
              </div>
            </div>
          ) : (
            <div className="sketch-widget__actions">
              {drawingActive ? <button type="button" className="map-widget-action" onClick={event => {
                actionFocusRef.current = document.activeElement === event.currentTarget;
                cancelDrawing();
              }}>Aktif işlemi iptal et</button> : null}
              <button ref={clearButtonRef} type="button" className="map-widget-action map-widget-action--danger" disabled={drawingCount === 0} onClick={() => {
                clearFocusRef.current = document.activeElement === clearButtonRef.current;
                setConfirmClear(true);
              }}>Çizimleri temizle</button>
            </div>
          )
        ) : null}
      >
        <div ref={summaryRef} className="sketch-widget__summary" tabIndex={-1}>
          <p>Bir çizim aracı seçin, ardından haritada çizin. Düzenlemek için çizimin üzerine dokunun.</p>
          <span className="sketch-widget__count" aria-live="polite" aria-atomic="true">{drawingCount} çizim</span>
        </div>
        <p className="sketch-widget__session-note">Çizimler geçicidir; pencere kapanınca veya harita görünümü değişince silinir.</p>
        {loading ? <MapWidgetSkeleton rows={4} label="Çizim araçları hazırlanıyor" /> : null}
        {!loading && error ? (
          <MapWidgetEmptyState
            title="Çizim araçları kullanılamıyor"
            description="Harita hazır olduğunda aşağıdaki düğmeyle tekrar deneyebilirsiniz."
            action={(
              <button id={`${id}-sketch-retry`} type="button" className="map-widget-action map-widget-action--primary" onClick={event => {
                actionFocusRef.current = document.activeElement === event.currentTarget;
                void initialize();
              }}>
                Yeniden dene
              </button>
            )}
          />
        ) : null}
        <div ref={containerRef} className="map-widget-arcgis-host sketch-widget__tools" aria-label="Çizim ve düzenleme araçları" aria-describedby={ready ? `${id}-sketch-tools-hint` : undefined} hidden={!ready} />
        {ready ? <p id={`${id}-sketch-tools-hint`} className="sketch-widget__tools-hint">Dar alanda diğer araçlara ulaşmak için araç çubuğunu yatay kaydırın.</p> : null}
        <details className="sketch-widget__help">
          <summary>Çizim nasıl kullanılır?</summary>
          <p>Nokta için haritaya dokunun. Çizgi ve alan için köşeleri işaretleyip son noktaya çift tıklayın. Aktif çizim veya düzenlemeyi iptal etmek için Esc tuşunu kullanın.</p>
        </details>
      </MapWidgetSurface>
    );
  },
);

SketchWidget.displayName = 'SketchWidget';
