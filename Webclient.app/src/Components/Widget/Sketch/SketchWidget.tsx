import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { loadArcgisModules } from '../../../gis-engine/arcgisModuleRuntime';
import { runtimeDiagnostics } from '../../../platform/runtime/runtimeDiagnostics';
import MapManager from '../../../Store/Managers/MapManager';
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
  removeAll?: () => void;
  destroy?: () => void;
}

interface MapLike {
  add: (layer: GraphicsLayerLike) => void;
  remove: (layer: GraphicsLayerLike) => void;
}

interface MapViewLike {
  readonly map?: MapLike;
}

interface SketchLike {
  cancel?: () => void;
  destroy?: () => void;
}

type SketchConstructor = new (options: Readonly<{
  layer: GraphicsLayerLike;
  view: MapViewLike;
  container: HTMLDivElement;
  activeTool: null;
  iconClass: string;
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

export const SketchWidget = forwardRef<ManagedWindowHandle, SketchWidgetProps>(
  ({ id, windowManager }, ref): ReactNode => {
    useMapWidgetFocus(id, windowManager.IsVisible(id));
    const sketchRef = useRef<SketchLike | null>(null);
    const sketchLayerRef = useRef<GraphicsLayerLike | null>(null);
    const attachedMapRef = useRef<MapLike | null>(null);
    const boundViewRef = useRef<MapViewLike | null>(null);
    const mountedRef = useRef(false);
    const operationRevisionRef = useRef(0);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const hostRef = useRef<OwnedArcgisWidgetHost | null>(null);
    const gateRef = useRef<LatestOperationGate | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [ready, setReady] = useState(false);

    if (gateRef.current === null) {
      gateRef.current = createLatestOperationGate((snapshot) => {
        setLoading(snapshot.phase === 'running');
      });
    }

    const clearSketch = useCallback((): void => {
      try { sketchRef.current?.cancel?.(); } catch (error) { reportSketchError(error); }
      try { sketchLayerRef.current?.removeAll?.(); } catch (error) { reportSketchError(error); }
    }, []);

    const disposeSketch = useCallback((): void => {
      const layer = sketchLayerRef.current;
      const map = attachedMapRef.current;
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
      if (mountedRef.current) setReady(false);
    }, [clearSketch]);

    const initialize = useCallback(async (): Promise<void> => {
      const mapView = MapManager.GetMapView() as MapViewLike | null;
      if (!containerRef.current) return;
      if (boundViewRef.current === mapView && (sketchRef.current || gateRef.current?.snapshot().phase === 'running')) return;
      if (boundViewRef.current !== mapView) {
        operationRevisionRef.current += 1;
        gateRef.current?.cancel('map-view-changed');
        disposeSketch();
      }
      if (!mapView?.map) {
        setError('Çizim araçları için harita görünümü henüz hazır değil.');
        return;
      }

      setError(null);
      boundViewRef.current = mapView;
      const revision = ++operationRevisionRef.current;
      try {
        await gateRef.current?.run(async (operation) => {
          const [Sketch, GraphicsLayer] = await loadArcgisModules<[
            SketchConstructor,
            GraphicsLayerConstructor,
          ]>([
            'esri/widgets/Sketch',
            'esri/layers/GraphicsLayer',
          ]);
          if (!operation.isCurrent() || !containerRef.current) return;
          if (MapManager.GetMapView() !== mapView) throw new Error('Map view changed before sketch admission.');

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
          });

          sketchRef.current = sketch;
          setReady(true);
        });
      } catch (caught) {
        if (!mountedRef.current || revision !== operationRevisionRef.current || isAbortLikeError(caught)) return;
        disposeSketch();
        reportSketchError(caught);
        setError('Çizim araçları başlatılamadı. Harita hazır olduğunda yeniden deneyin.');
      }
    }, [disposeSketch]);

    useImperativeHandle(ref, () => ({
      id,
      visible: false,
      minimized: false,
      OnShow: () => {
        void initialize();
      },
      OnClose: () => {
        operationRevisionRef.current += 1;
        gateRef.current?.cancel('widget-closed');
        clearSketch();
      },
    }), [clearSketch, id, initialize, windowManager]);

    useEffect(() => {
      mountedRef.current = true;
      windowManager.RegisterWindow(ref as RefObject<ManagedWindowHandle | null>);
      return () => {
        mountedRef.current = false;
        operationRevisionRef.current += 1;
        gateRef.current?.cancel('widget-unmounted');
        disposeSketch();
        windowManager.UnregisterWindow?.(id, ref as RefObject<ManagedWindowHandle | null>);
        queueMicrotask(() => {
          if (!mountedRef.current) gateRef.current?.dispose();
        });
      };
    }, [disposeSketch, id, ref, windowManager]);

    return (
      <MapWidgetSurface
        id={id}
        title="Çizim Araçları"
        iconSrc="images/icons/toolbar/cizimaraci.png"
        windowManager={windowManager}
        busy={loading}
        error={error}
        status={ready ? 'Çizim katmanı hazır' : null}
        statusTone="success"
        bodyClassName="layer-list-window-body"
        footer={ready ? (
          <button type="button" className="map-widget-action map-widget-action--danger" onClick={clearSketch}>
            Çizimleri temizle
          </button>
        ) : null}
      >
        {loading ? <MapWidgetSkeleton rows={4} label="Çizim araçları hazırlanıyor" /> : null}
        {!loading && error ? (
          <MapWidgetEmptyState
            title="Çizim araçları kullanılamıyor"
            description={error}
            action={(
              <button type="button" className="map-widget-action map-widget-action--primary" onClick={() => void initialize()}>
                Yeniden dene
              </button>
            )}
          />
        ) : null}
        <div ref={containerRef} className="map-widget-arcgis-host" aria-label="ArcGIS çizim araçları" />
      </MapWidgetSurface>
    );
  },
);

SketchWidget.displayName = 'SketchWidget';
