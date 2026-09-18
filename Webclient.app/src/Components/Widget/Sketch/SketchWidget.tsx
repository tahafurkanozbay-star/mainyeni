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
import MapManager from '../../../Store/Managers/MapManager';
import type { ManagedWindowHandle } from '../../../experience/contracts';
import {
  MapWidgetEmptyState,
  MapWidgetSkeleton,
  MapWidgetSurface,
  type MapWidgetManagerLike,
} from '../_shared/MapWidgetSurface';
import {
  createLatestOperationGate,
  normalizeWidgetError,
  type LatestOperationGate,
} from '../_shared/MapWidgetRuntime';
import './SketchWidget.css';

interface GraphicsLayerLike {
  removeAll?: () => void;
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

export const SketchWidget = forwardRef<ManagedWindowHandle, SketchWidgetProps>(
  ({ id, windowManager }, ref): ReactNode => {
    const sketchRef = useRef<SketchLike | null>(null);
    const sketchLayerRef = useRef<GraphicsLayerLike | null>(null);
    const containerRef = useRef<HTMLDivElement | null>(null);
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
      sketchRef.current?.cancel?.();
      sketchLayerRef.current?.removeAll?.();
    }, []);

    const disposeSketch = useCallback((): void => {
      const layer = sketchLayerRef.current;
      const map = (MapManager.GetMapView() as MapViewLike | null)?.map;
      clearSketch();
      try {
        sketchRef.current?.destroy?.();
      } finally {
        sketchRef.current = null;
      }
      if (layer && map) {
        try {
          map.remove(layer);
        } catch {
          // The ArcGIS map may already have released the layer during view teardown.
        }
      }
      sketchLayerRef.current = null;
      setReady(false);
    }, [clearSketch]);

    const initialize = useCallback(async (): Promise<void> => {
      if (sketchRef.current || !containerRef.current) return;
      const mapView = MapManager.GetMapView() as MapViewLike | null;
      if (!mapView?.map) {
        setError('Çizim araçları için harita görünümü henüz hazır değil.');
        return;
      }

      setError(null);
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

          const layer = new GraphicsLayer({ title: 'Kullanıcı çizimleri' });
          mapView.map?.add(layer);
          if (!operation.isCurrent() || !containerRef.current) {
            mapView.map?.remove(layer);
            return;
          }

          const sketch = new Sketch({
            layer,
            view: mapView,
            container: containerRef.current,
            activeTool: null,
            iconClass: 'sketch-icon',
          });

          sketchLayerRef.current = layer;
          sketchRef.current = sketch;
          setReady(true);
        });
      } catch (caught) {
        if (gateRef.current?.snapshot().phase === 'cancelled') return;
        disposeSketch();
        setError(normalizeWidgetError(caught, 'Çizim araçları başlatılamadı.'));
      }
    }, [disposeSketch]);

    useImperativeHandle(ref, () => ({
      id,
      visible: false,
      minimized: false,
      OnShow: () => {
        windowManager.ShowWindow('sidebar');
        void initialize();
      },
      OnClose: () => {
        gateRef.current?.cancel('widget-closed');
        clearSketch();
      },
    }), [clearSketch, id, initialize, windowManager]);

    useEffect(() => {
      windowManager.RegisterWindow(ref as RefObject<ManagedWindowHandle | null>);
      return () => {
        gateRef.current?.dispose();
        disposeSketch();
        windowManager.UnregisterWindow?.(id, ref as RefObject<ManagedWindowHandle | null>);
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
