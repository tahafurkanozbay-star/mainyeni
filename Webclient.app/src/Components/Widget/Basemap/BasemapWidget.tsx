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

const BASEMAP_IDS = Object.freeze([
  'topo',
  'streets',
  'satellite',
  'hybrid',
  'dark-gray',
  'gray',
  'national-geographic',
  'oceans',
  'osm',
  'terrain',
  'dark-gray-vector',
  'gray-vector',
  'streets-vector',
  'streets-night-vector',
  'streets-navigation-vector',
  'topo-vector',
  'streets-relief-vector',
] as const);

interface BasemapLike {
  readonly id?: string;
}

interface BasemapConstructor {
  fromId: (id: string) => BasemapLike | null | undefined;
}

interface BasemapGalleryLike {
  destroy?: () => void;
}

type BasemapGalleryConstructor = new (options: Readonly<{
  view: unknown;
  container: HTMLDivElement;
  source: readonly BasemapLike[];
}>) => BasemapGalleryLike;

export interface BasemapWidgetProps {
  readonly id: string;
  readonly windowManager: MapWidgetManagerLike;
}

export const BasemapWidget = forwardRef<ManagedWindowHandle, BasemapWidgetProps>(
  ({ id, windowManager }, ref): ReactNode => {
    const galleryContainerRef = useRef<HTMLDivElement | null>(null);
    const galleryRef = useRef<BasemapGalleryLike | null>(null);
    const gateRef = useRef<LatestOperationGate | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [readyCount, setReadyCount] = useState(0);

    if (gateRef.current === null) {
      gateRef.current = createLatestOperationGate((snapshot) => {
        setLoading(snapshot.phase === 'running');
        if (snapshot.phase === 'error') setError(snapshot.error);
      });
    }

    const destroyGallery = useCallback((): void => {
      try {
        galleryRef.current?.destroy?.();
      } finally {
        galleryRef.current = null;
        setReadyCount(0);
      }
    }, []);

    const initialize = useCallback(async (): Promise<void> => {
      const container = galleryContainerRef.current;
      if (!container) return;
      setError(null);

      try {
        await gateRef.current?.run(async (operation) => {
          const [BasemapGallery, Basemap] = await loadArcgisModules<[
            BasemapGalleryConstructor,
            BasemapConstructor,
          ]>([
            'esri/widgets/BasemapGallery',
            'esri/Basemap',
          ]);
          if (!operation.isCurrent() || !galleryContainerRef.current) return;

          const source = BASEMAP_IDS
            .map((basemapId) => Basemap.fromId(basemapId))
            .filter((item): item is BasemapLike => Boolean(item));

          destroyGallery();
          if (!operation.isCurrent() || !galleryContainerRef.current) return;

          galleryRef.current = new BasemapGallery({
            view: MapManager.GetMapView(),
            container: galleryContainerRef.current,
            source,
          });
          setReadyCount(source.length);
        });
      } catch (caught) {
        if (gateRef.current?.snapshot().phase === 'cancelled') return;
        setError(normalizeWidgetError(caught, 'Altlık haritalar yüklenemedi.'));
      }
    }, [destroyGallery]);

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
        destroyGallery();
        setError(null);
      },
    }), [destroyGallery, id, initialize, windowManager]);

    useEffect(() => {
      windowManager.RegisterWindow(ref as RefObject<ManagedWindowHandle | null>);
      return () => {
        gateRef.current?.dispose();
        destroyGallery();
        windowManager.UnregisterWindow?.(id, ref as RefObject<ManagedWindowHandle | null>);
      };
    }, [destroyGallery, id, ref, windowManager]);

    useEffect(() => {
      if (!windowManager.IsVisible(id) || galleryRef.current) return;
      void initialize();
    }, [id, initialize, windowManager]);

    return (
      <MapWidgetSurface
        id={id}
        title="Altlık Haritalar"
        iconSrc="images/icons/toolbar/basemap.png"
        windowManager={windowManager}
        busy={loading}
        error={error}
        status={readyCount > 0 ? `${readyCount} altlık harita kullanıma hazır` : null}
        statusTone="info"
        bodyClassName="layer-list-window-body"
      >
        {loading && readyCount === 0 ? <MapWidgetSkeleton rows={6} label="Altlık haritalar hazırlanıyor" /> : null}
        {!loading && error ? (
          <MapWidgetEmptyState
            title="Altlık harita galerisi açılamadı"
            description="Harita görünümü hazır olduğunda tekrar deneyebilirsiniz."
            action={(
              <button type="button" className="map-widget-action map-widget-action--primary" onClick={() => void initialize()}>
                Yeniden dene
              </button>
            )}
          />
        ) : null}
        <div
          ref={galleryContainerRef}
          className="map-widget-arcgis-host"
          aria-label="Altlık harita galerisi"
        />
      </MapWidgetSurface>
    );
  },
);

BasemapWidget.displayName = 'BasemapWidget';
