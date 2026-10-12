import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useSyncExternalStore,
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
  isAbortLikeError,
  type LatestOperationGate,
} from '../_shared/MapWidgetRuntime';
import { createBasemapExperienceModel } from './basemapExperienceModel';

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
    const initialLoadRequestedRef = useRef(false);
    const model = useMemo(() => createBasemapExperienceModel({ maxAttempts: 3 }), []);
    const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);

    if (gateRef.current === null) gateRef.current = createLatestOperationGate();

    const destroyGallery = useCallback((): void => {
      try {
        galleryRef.current?.destroy?.();
      } finally {
        galleryRef.current = null;
      }
    }, []);

    const initialize = useCallback(async (): Promise<void> => {
      const container = galleryContainerRef.current;
      if (!container || !model.beginLoad()) return;
      const gate = gateRef.current;
      if (!gate) {
        model.fail('Altlık harita yükleme altyapısı hazır değil.');
        return;
      }

      try {
        await gate.run(async (operation) => {
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
          model.succeed(source.length);
        });
      } catch (caught) {
        if (gate.snapshot().phase === 'cancelled' || isAbortLikeError(caught)) {
          model.cancel();
          return;
        }
        model.fail(caught);
      }
    }, [destroyGallery, model]);

    useImperativeHandle(ref, () => ({
      id,
      visible: false,
      minimized: false,
      OnShow: () => {
        windowManager.ShowWindow('sidebar');
        if (model.getSnapshot().phase === 'error' && !model.getSnapshot().canReload) {
          model.resetAttempts();
        }
        void initialize();
      },
      OnClose: () => {
        gateRef.current?.cancel('widget-closed');
        destroyGallery();
        model.resetAttempts();
      },
    }), [destroyGallery, id, initialize, model, windowManager]);

    useEffect(() => {
      windowManager.RegisterWindow(ref as RefObject<ManagedWindowHandle | null>);
      return () => {
        gateRef.current?.dispose();
        destroyGallery();
        model.dispose();
        windowManager.UnregisterWindow?.(id, ref as RefObject<ManagedWindowHandle | null>);
      };
    }, [destroyGallery, id, model, ref, windowManager]);

    useEffect(() => {
      if (initialLoadRequestedRef.current || !windowManager.IsVisible(id)) return;
      initialLoadRequestedRef.current = true;
      void initialize();
    }, [id, initialize, windowManager]);

    const status = snapshot.phase === 'ready'
      ? `${snapshot.readyCount} altlık harita kullanıma hazır`
      : snapshot.phase === 'loading'
        ? `Altlık haritalar hazırlanıyor · deneme ${snapshot.attempt}/${snapshot.maxAttempts}`
        : null;

    return (
      <MapWidgetSurface
        id={id}
        title="Altlık Haritalar"
        windowManager={windowManager}
        busy={snapshot.busy}
        busyLabel={`Altlık haritalar hazırlanıyor · ${snapshot.attempt}/${snapshot.maxAttempts}`}
        error={snapshot.error}
        status={status}
        statusTone="info"
        bodyClassName="layer-list-window-body"
      >
        <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {snapshot.announcement}
        </p>

        {snapshot.busy && snapshot.readyCount === 0 ? (
          <MapWidgetSkeleton rows={6} label="Altlık haritalar hazırlanıyor" />
        ) : null}

        {snapshot.phase === 'error' ? (
          <MapWidgetEmptyState
            title="Altlık harita galerisi açılamadı"
            description={snapshot.canReload
              ? `Harita görünümü hazır olduğunda yeniden yükleyebilirsiniz. ${snapshot.maxAttempts - snapshot.attempt} deneme hakkı kaldı.`
              : 'Bu açılış oturumu için yükleme sınırına ulaşıldı. Pencereyi kapatıp yeniden açarak güvenli bir oturum başlatabilirsiniz.'}
            action={snapshot.canReload ? (
              <button
                type="button"
                className="map-widget-action map-widget-action--primary"
                onClick={() => void initialize()}
              >
                Galeriyi yeniden yükle
              </button>
            ) : undefined}
          />
        ) : null}

        <div
          ref={galleryContainerRef}
          className="map-widget-arcgis-host"
          aria-label="Altlık harita galerisi"
          aria-busy={snapshot.busy || undefined}
        />
      </MapWidgetSurface>
    );
  },
);

BasemapWidget.displayName = 'BasemapWidget';
