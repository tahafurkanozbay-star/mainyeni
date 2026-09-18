import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type Ref,
} from 'react';
import { Constants_MessageType, Constants_ServiceResultType } from '../../../Core/Constants';
import MapManager from '../../../Store/Managers/MapManager';
import { ParklarQeryBusiness } from '../../../Business/ParklarQeryBusiness';
import { CommonBusiness } from '../../../Business/CommonBusiness';
import { DebugHelper } from '../../../Toolbox/DebugHelper';
import { GisGraphicsHelper } from '../../../Toolbox/GisGraphicsHelper';
import { LoggingBusiness } from '../../../Business/LoggingBusiness';
import { loadArcgisModules } from '../../../gis-engine/arcgisModuleRuntime';
import {
  createDisposableBag,
  createLayerOwner,
  type DisposableBag,
  type LayerOwner,
  type RemovableHandle,
} from '../../../gis-engine/layerOwnership';
import { createPictureMarkerSymbol } from '../../../gis-engine/iconPresentation';
import type { GeometryLike } from '../_Common/QueryInteractionRuntime';
import {
  buildGoogleDirectionsUrl,
  createLatestRequestGate,
  normalizeErrorMessage,
  openExternalSafely,
  safeClientLog,
} from '../_Common/QueryInteractionRuntime';
import { ExperienceStatus } from '../../Common/ExperienceStatus';
import { SharedGISIcon } from '../../Common/SharedGISIcon';

const OWNER_ID = 'parklar-query-window';
const MAX_EXTENT_HISTORY = 30;
const PARK_SERVICE_KEY = 'YeniParklarQeryUrl';
const PARK_ICON_TYPE = 'parklar';

type UnknownRecord = Record<string, unknown>;

export interface ParkFeature {
  readonly attr?: UnknownRecord | null;
  readonly attributes?: UnknownRecord | null;
  readonly geometry?: GeometryLike | null;
}

export interface ParkRecord {
  readonly objectId: unknown;
  readonly title: string;
  readonly phone: string;
  readonly address: string;
  readonly addressDescription: string;
}

interface ServiceResult {
  readonly type?: unknown;
  readonly data?: readonly ParkFeature[] | null;
  readonly message?: unknown;
  readonly errorMessage?: unknown;
}

interface ExtentLike {
  readonly xmin?: number;
  readonly ymin?: number;
  readonly xmax?: number;
  readonly ymax?: number;
  readonly spatialReference?: unknown;
  clone?: () => ExtentLike;
}

interface RendererLike {
  symbol?: unknown;
}

interface ParkLayerLike {
  renderer?: RendererLike | null;
  refresh?: () => unknown;
  queryExtent?: () => Promise<{ readonly extent?: ExtentLike | null } | null>;
  destroy?: () => unknown;
}

interface LayerEnvelope {
  readonly layerObj?: ParkLayerLike | null;
}

interface MapLike {
  add?: (layer: ParkLayerLike) => unknown;
  remove?: (layer: ParkLayerLike) => unknown;
}

interface MapViewLike {
  readonly map?: MapLike | null;
  readonly extent?: ExtentLike | null;
  readonly zoom?: number;
  readonly goTo?: (target: unknown, options?: Readonly<Record<string, unknown>>) => Promise<unknown> | unknown;
  readonly watch?: (property: string, callback: (value: unknown) => void) => RemovableHandle;
}

interface WatchUtilsLike {
  when(
    target: unknown,
    property: string,
    callback: () => void,
  ): RemovableHandle;
  whenOnce(
    target: unknown,
    property: string,
    callback: () => void,
  ): RemovableHandle;
  whenTrue(
    target: unknown,
    property: string,
    callback: (value: boolean) => void,
  ): RemovableHandle;
}

export interface ParkWindowHandle {
  readonly id: string;
  readonly visible: boolean;
  readonly minimized: boolean;
  readonly OnShow: () => void | Promise<void>;
  readonly OnClose: () => void;
}

export interface ParkWindowManager {
  RegisterWindow(ref: Ref<ParkWindowHandle>): void;
  IsVisible(id: string): boolean;
  ShowMessage(type: string, message: string): void;
  ToggleMinimiseWindow(id: string): void;
  ShowWindow(id: string): void;
  GetQueryParams?: (id: string) => Readonly<Record<string, unknown>> | null | undefined;
}

export interface ParklarQueryWindowProps {
  readonly id: string;
  readonly windowManager: ParkWindowManager;
  readonly windowTitle?: string;
}

const defaultQuery = Object.freeze({
  name: null,
  districtId: null,
  districtName: null,
  nbhoodId: null,
  nbhoodName: null,
  showMapSelect: false,
  showNearby: false,
}) satisfies Readonly<Record<string, unknown>>;

const asMapView = (value: unknown): MapViewLike | null =>
  value !== null && typeof value === 'object' ? value as MapViewLike : null;

const attributesOf = (feature: ParkFeature): UnknownRecord =>
  feature.attr ?? feature.attributes ?? {};

const readText = (
  attributes: UnknownRecord,
  keys: readonly string[],
  fallback: string,
): string => {
  for (const key of keys) {
    const value = attributes[key];
    if (value !== null && value !== undefined && String(value).trim()) {
      return String(value).trim();
    }
  }
  return fallback;
};

const readId = (attributes: UnknownRecord): unknown =>
  attributes.objectid
  ?? attributes.objectId
  ?? attributes.OBJECTID
  ?? attributes.id
  ?? null;

export const normalizeParkRecord = (
  feature: ParkFeature,
  index = 0,
): ParkRecord => {
  const attributes = attributesOf(feature);
  return Object.freeze({
    objectId: readId(attributes),
    title: readText(attributes, ['adi', 'ADI', 'ad', 'name'], 'Park ' + String(index + 1)),
    phone: readText(attributes, ['telefon', 'TELEFON', 'phone'], ''),
    address: readText(attributes, ['adres', 'ADRES', 'address'], 'Adres bilgisi bulunmuyor'),
    addressDescription: readText(
      attributes,
      ['adres_tarifi', 'ADRES_TARIFI', 'addressDescription'],
      'Adres tarifi bulunmuyor',
    ),
  });
};

export const createParkMarkerSymbol = (zoom: unknown) => createPictureMarkerSymbol(
  { type: PARK_ICON_TYPE, category: 'Parklar', title: 'Park' },
  Number.isFinite(Number(zoom)) ? Number(zoom) : 12,
  { minSize: 30, maxSize: 56, zoomThreshold: 10 },
);

export const createParkDirectionsUrl = (
  geometry: GeometryLike | null | undefined,
): string | null => buildGoogleDirectionsUrl(geometry);

const createExpandedExtent = (extent: ExtentLike): ExtentLike => {
  const { xmin, ymin, xmax, ymax } = extent;
  if (
    !Number.isFinite(xmin)
    || !Number.isFinite(ymin)
    || !Number.isFinite(xmax)
    || !Number.isFinite(ymax)
  ) {
    return extent;
  }

  const xPadding = (Number(xmax) - Number(xmin)) * 0.05;
  const yPadding = (Number(ymax) - Number(ymin)) * 0.1;
  return {
    xmin: Number(xmin) - xPadding,
    ymin: Number(ymin) - yPadding,
    xmax: Number(xmax) + xPadding,
    ymax: Number(ymax) + yPadding,
    spatialReference: extent.spatialReference,
  };
};

const isActivationKey = (event: KeyboardEvent<HTMLElement>): boolean =>
  event.key === 'Enter' || event.key === ' ';

export const ParklarQueryWindow = forwardRef<ParkWindowHandle, ParklarQueryWindowProps>(
  ({ id, windowManager, windowTitle = 'Parklar' }, ref) => {
    const [query, setQuery] = useState<Readonly<Record<string, unknown>>>(defaultQuery);
    const [resultList, setResultList] = useState<readonly ParkRecord[]>([]);
    const [loading, setLoading] = useState(false);
    const [errorMessage, setErrorMessage] = useState('');

    const mountedRef = useRef(false);
    const mapViewRef = useRef<MapViewLike | null>(null);
    const extentHistoryRef = useRef<ExtentLike[]>([]);
    const allowExtentHistoryRef = useRef(true);
    const clusterLayerRef = useRef<LayerEnvelope | null>(null);
    const ownerRef = useRef<Readonly<LayerOwner<ParkLayerLike>> | null>(null);
    const lifecycleRef = useRef<DisposableBag>(createDisposableBag());
    const requestGateRef = useRef(createLatestRequestGate());

    const getOwner = useCallback((
      view = mapViewRef.current ?? asMapView(MapManager.GetMapView()),
    ): Readonly<LayerOwner<ParkLayerLike>> | null => {
      if (!view?.map) return null;
      if (!ownerRef.current) {
        ownerRef.current = createLayerOwner<ParkLayerLike>(view, OWNER_ID);
      }
      return ownerRef.current;
    }, []);

    const removeLastClusterLayer = useCallback((): void => {
      getOwner()?.clear();
      clusterLayerRef.current = null;
    }, [getOwner]);

    const reportError = useCallback((error: unknown, fallback: string): string => {
      const message = normalizeErrorMessage(error, fallback);
      DebugHelper.Log(error);
      setErrorMessage(message);
      windowManager.ShowMessage(Constants_MessageType.Error, message);
      return message;
    }, [windowManager]);

    const rememberExtent = useCallback((): void => {
      if (!allowExtentHistoryRef.current) return;
      const extent = mapViewRef.current?.extent;
      if (!extent) return;

      const snapshot = extent.clone?.() ?? extent;
      const history = [...extentHistoryRef.current, snapshot];
      extentHistoryRef.current = history.slice(-MAX_EXTENT_HISTORY);
    }, []);

    const installViewWatchers = useCallback(async (view: MapViewLike): Promise<void> => {
      try {
        const [watchUtilsModule] = await loadArcgisModules(['esri/core/watchUtils']);
        const watchUtils = watchUtilsModule as WatchUtilsLike;

        if (!mountedRef.current || mapViewRef.current !== view) return;
        if (view.extent) {
          extentHistoryRef.current = [view.extent.clone?.() ?? view.extent];
        }

        lifecycleRef.current.add(watchUtils.when(view, 'ready', () => {
          lifecycleRef.current.add(watchUtils.whenOnce(view, 'extent', () => {
            lifecycleRef.current.add(watchUtils.whenTrue(view, 'stationary', (stationary) => {
              if (stationary) rememberExtent();
            }));
          }));
        }));

        if (typeof view.watch === 'function') {
          lifecycleRef.current.add(view.watch('zoom', (newZoomLevel) => {
            const layer = clusterLayerRef.current?.layerObj;
            if (!layer?.renderer) return;
            layer.renderer.symbol = createParkMarkerSymbol(newZoomLevel);
            layer.refresh?.();
          }));
        }
      } catch (error) {
        DebugHelper.Log(error);
      }
    }, [rememberExtent]);

    const reset = useCallback((): void => {
      requestGateRef.current.invalidate();
      setQuery(defaultQuery);
      setResultList([]);
      setLoading(false);
      setErrorMessage('');
      removeLastClusterLayer();
      allowExtentHistoryRef.current = true;
    }, [removeLastClusterLayer]);

    const fetchQueryResults = useCallback(async (): Promise<void> => {
      const view = mapViewRef.current ?? asMapView(MapManager.GetMapView());
      if (!view?.map) {
        reportError(null, 'Harita hazır olmadığı için park sorgusu başlatılamadı.');
        return;
      }

      mapViewRef.current = view;
      const requestId = requestGateRef.current.next();
      const latestQuery = windowManager.GetQueryParams?.(id) ?? query;

      setQuery(latestQuery);
      setLoading(true);
      setErrorMessage('');

      await safeClientLog(
        LoggingBusiness,
        'Parklar/Sorgu',
        String(latestQuery.districtName ?? '')
          + '/'
          + String(latestQuery.nbhoodName ?? '')
          + '/'
          + String(latestQuery.name ?? ''),
        DebugHelper.Log,
      );

      try {
        const result = await ParklarQeryBusiness.Query(latestQuery, false) as ServiceResult;

        if (!mountedRef.current || !requestGateRef.current.isCurrent(requestId)) return;
        if (result?.type !== Constants_ServiceResultType.Success) {
          setResultList([]);
          reportError(
            result?.message ?? result?.errorMessage,
            'Park sorgusu tamamlanamadı.',
          );
          return;
        }

        const records = Array.isArray(result.data)
          ? result.data.map(normalizeParkRecord)
          : [];
        setResultList(records);

        allowExtentHistoryRef.current = false;
        const initialExtent = extentHistoryRef.current[0];
        if (initialExtent && view.goTo) {
          try {
            await view.goTo(initialExtent, { animate: false });
          } catch (error) {
            DebugHelper.Log(error);
          }
        }

        if (!mountedRef.current || !requestGateRef.current.isCurrent(requestId)) return;

        const clusterLayer = await CommonBusiness.Clustering.CreateLayerWithoutClustering(
          PARK_SERVICE_KEY,
          windowTitle,
          latestQuery,
          createParkMarkerSymbol(view.zoom),
        ) as LayerEnvelope | null;

        if (!mountedRef.current || !requestGateRef.current.isCurrent(requestId)) {
          clusterLayer?.layerObj?.destroy?.();
          return;
        }

        removeLastClusterLayer();
        clusterLayerRef.current = clusterLayer;
        const layer = clusterLayer?.layerObj;
        if (layer) getOwner(view)?.add(layer);

        try {
          const extentResponse = await layer?.queryExtent?.();
          const extent = extentResponse?.extent;
          if (
            extent
            && mountedRef.current
            && requestGateRef.current.isCurrent(requestId)
            && view.goTo
          ) {
            await view.goTo(createExpandedExtent(extent), { animate: false });
          }
        } catch (error) {
          DebugHelper.Log(error);
        }
      } catch (error) {
        if (mountedRef.current && requestGateRef.current.isCurrent(requestId)) {
          setResultList([]);
          reportError(error, 'Park sorgusu başarısız oldu.');
        }
      } finally {
        if (mountedRef.current && requestGateRef.current.isCurrent(requestId)) {
          setLoading(false);
        }
      }
    }, [getOwner, id, query, removeLastClusterLayer, reportError, windowManager, windowTitle]);

    const getItemDetailsById = useCallback(async (
      item: ParkRecord,
    ): Promise<ParkFeature> => {
      if (
        item.objectId === null
        || item.objectId === undefined
        || item.objectId === ''
      ) {
        throw new Error('Öğe kimliği bulunamadı.');
      }

      const result = await ParklarQeryBusiness.Query(
        { ObjectId: item.objectId },
        true,
      ) as ServiceResult;

      if (
        result?.type !== Constants_ServiceResultType.Success
        || !Array.isArray(result.data)
        || !result.data[0]
      ) {
        throw new Error('Öğe detayları bulunamadı.');
      }
      return result.data[0];
    }, []);

    const showItem = useCallback(async (item: ParkRecord): Promise<void> => {
      await safeClientLog(
        LoggingBusiness,
        'Parklar/Detay Göster',
        String(item.objectId ?? '') + '/' + item.address,
        DebugHelper.Log,
      );

      try {
        const itemDetails = await getItemDetailsById(item);
        const view = mapViewRef.current;
        if (!view || !itemDetails.geometry) {
          throw new Error('Konum bilgisi bulunamadı.');
        }

        await Promise.resolve(GisGraphicsHelper.ZoomToGeometry(
          view,
          itemDetails.geometry,
          18,
        ));

        if (window.matchMedia?.('(max-width: 959px)').matches) {
          windowManager.ToggleMinimiseWindow(id);
        }
      } catch (error) {
        reportError(error, 'Park konumu gösterilemedi.');
      }
    }, [getItemDetailsById, id, reportError, windowManager]);

    const showRoute = useCallback(async (item: ParkRecord): Promise<void> => {
      try {
        const itemDetails = await getItemDetailsById(item);
        const routeUrl = createParkDirectionsUrl(itemDetails.geometry);
        if (!routeUrl) throw new Error('Koordinat bilgisi bulunamadı.');
        if (!openExternalSafely(routeUrl)) {
          throw new Error('Yol tarifi penceresi açılamadı.');
        }

        await safeClientLog(
          LoggingBusiness,
          'Parklar/Yol Tarifi',
          String(item.objectId ?? '') + '/' + item.address,
          DebugHelper.Log,
        );
      } catch (error) {
        reportError(error, 'Yol tarifi alınamadı.');
      }
    }, [getItemDetailsById, reportError]);

    const returnToServices = useCallback(async (): Promise<void> => {
      requestGateRef.current.invalidate();
      removeLastClusterLayer();
      allowExtentHistoryRef.current = false;

      const targetExtent = extentHistoryRef.current[0];
      const view = mapViewRef.current;
      if (view?.goTo && targetExtent) {
        try {
          await view.goTo(targetExtent, { animate: false });
        } catch (error) {
          DebugHelper.Log(error);
        }
      }

      windowManager.ShowWindow('sidebar');
    }, [removeLastClusterLayer, windowManager]);

    useImperativeHandle(ref, () => ({
      id,
      visible: false,
      minimized: false,
      OnShow: fetchQueryResults,
      OnClose: reset,
    }), [fetchQueryResults, id, reset]);

    useEffect(() => {
      mountedRef.current = true;
      const view = asMapView(MapManager.GetMapView());
      mapViewRef.current = view;
      windowManager.RegisterWindow(ref);

      if (view) void installViewWatchers(view);

      const lifecycle = lifecycleRef.current;
      return () => {
        mountedRef.current = false;
        requestGateRef.current.invalidate();
        lifecycle.dispose();
        ownerRef.current?.clear();
        ownerRef.current = null;
        clusterLayerRef.current = null;
      };
    }, [installViewWatchers, ref, windowManager]);

    const visible = windowManager.IsVisible(id);
    const status = useMemo(() => {
      if (loading) return {
        tone: 'info' as const,
        live: 'polite' as const,
        message: 'Parklar ve harita katmanı yükleniyor…',
      };
      if (errorMessage) return {
        tone: 'danger' as const,
        live: 'assertive' as const,
        message: errorMessage,
      };
      if (resultList.length === 0) return {
        tone: 'neutral' as const,
        live: 'polite' as const,
        message: 'Gösterilecek park kaydı bulunamadı.',
      };
      return {
        tone: 'success' as const,
        live: 'polite' as const,
        message: resultList.length + ' park bulundu.',
      };
    }, [errorMessage, loading, resultList.length]);

    return (
      <section
        className="sidebar-container kr-park-query"
        aria-labelledby={id + '-title'}
        aria-busy={loading}
        aria-hidden={!visible}
        style={{ visibility: visible ? 'visible' : 'hidden' }}
      >
        <header className="common-query-window-header">
          <SharedGISIcon
            record={{ type: PARK_ICON_TYPE, category: 'Parklar', title: windowTitle }}
            size={34}
            className="common-query-window-header-icon"
          />
          <h2 id={id + '-title'}>{windowTitle}</h2>
        </header>

        <div className="results-container-toolbar">
          <button
            type="button"
            className="results-container-back-button"
            onClick={() => { void returnToServices(); }}
          >
            <span aria-hidden="true">←</span>
            <span>Hizmetlere dön</span>
          </button>
          <div className="results-container-count" aria-live="polite">
            <strong>{resultList.length}</strong> adet sonuç
          </div>
        </div>

        <ExperienceStatus
          tone={status.tone}
          live={status.live}
          busy={loading}
          className="kr-park-query__status"
        >
          {status.message}
        </ExperienceStatus>

        {!loading && errorMessage ? (
          <button
            type="button"
            className="experience-query-action"
            onClick={() => { void fetchQueryResults(); }}
          >
            Tekrar dene
          </button>
        ) : null}

        <ul className="results-container kr-park-query__results" aria-label="Park sonuçları">
          {resultList.map((item, index) => {
            const itemKey = item.objectId !== null && item.objectId !== undefined
              ? String(item.objectId)
              : item.title + '-' + String(index);

            return (
              <li className="result-item-container kr-park-query__item" key={itemKey}>
                <SharedGISIcon
                  record={{ type: PARK_ICON_TYPE, category: 'Parklar', title: item.title }}
                  size={30}
                  className="kr-park-query__item-icon"
                />
                <button
                  type="button"
                  className="result-item-info kr-park-query__primary"
                  onClick={() => { void showItem(item); }}
                  onKeyDown={(event) => {
                    if (!isActivationKey(event)) return;
                    event.preventDefault();
                    void showItem(item);
                  }}
                  aria-label={item.title + ' konumunu haritada göster'}
                >
                  <span className="result-item-info-title">{item.title}</span>
                  <span className="result-item-info-address">{item.address}</span>
                  {item.phone ? <span>{item.phone}</span> : null}
                </button>
                <div className="kr-park-query__actions" aria-label={item.title + ' işlemleri'}>
                  <button type="button" onClick={() => { void showItem(item); }}>
                    Haritada göster
                  </button>
                  <button type="button" onClick={() => { void showRoute(item); }}>
                    Yol tarifi
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    );
  },
);

ParklarQueryWindow.displayName = 'ParklarQueryWindow';
