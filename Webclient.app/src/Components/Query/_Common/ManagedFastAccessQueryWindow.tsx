import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ForwardRefExoticComponent,
  type Ref,
  type RefAttributes,
} from 'react';
import { CommonBusiness } from '../../../Business/CommonBusiness';
import { LoggingBusiness } from '../../../Business/LoggingBusiness';
import { Constants_MessageType, Constants_ServiceResultType } from '../../../Core/Constants';
import MapManager from '../../../Store/Managers/MapManager';
import { DebugHelper } from '../../../Toolbox/DebugHelper';
import { GisGraphicsHelper } from '../../../Toolbox/GisGraphicsHelper';
import { createPictureMarkerSymbol } from '../../../gis-engine/iconPresentation';
import {
  createKentRehberiGeoJsonLayer,
  type KentRehberiGeoJsonFeatureCollection,
} from '../../../data-services/kentRehberiGeoJsonLayer';
import { SharedGISIcon } from '../../Common/SharedGISIcon';
import {
  buildGoogleDirectionsUrl,
  createLatestRequestGate,
  normalizeErrorMessage,
  openExternalSafely,
  safeClientLog,
  type GeometryLike,
} from './QueryInteractionRuntime';
import { withTimeout } from '../../../platform/runtime/resilience';
import { throwIfAborted, isAbortLike } from '../../../platform/runtime/contracts';
import { normalizeQueryResultText as normalizeText, QueryResultPagination, useQueryResultPage } from './QueryResultPaging';
import './ManagedFastAccessQueryWindow.css';

const DEFAULT_PAGE_SIZE = 60;
const QUERY_PRESENTATION_TIMEOUT_MS = 15_000;
const DEFAULT_QUERY: Readonly<Record<string, unknown>> = Object.freeze({});

const ATTRIBUTE_CANDIDATES = Object.freeze({
  objectId: ['objectid', 'object_id', 'id', 'fid', 'globalid'],
  title: ['adi', 'ad', 'name', 'isim', 'baslik', 'başlık', 'tesis_adi', 'unvan'],
  address: ['adres', 'address', 'adres_tarifi', 'acik_adres', 'açık_adres', 'lokasyon'],
  phone: ['telefon', 'phone', 'tel', 'telefon_no', 'iletisim', 'iletişim'],
} as const);

type UnknownRecord = Record<string, unknown>;

export interface FastAccessFeature {
  readonly attr?: UnknownRecord | null;
  readonly attributes?: UnknownRecord | null;
  readonly geometry?: GeometryLike | null;
  readonly raw?: {
    readonly geometry?: GeometryLike | null;
  } | null;
}

export interface FastAccessRecord {
  readonly objectId: unknown;
  readonly title: string;
  readonly address: string;
  readonly phone: string;
  readonly raw: FastAccessFeature;
}

export interface FastAccessServiceResult {
  readonly type?: unknown;
  readonly data?: readonly FastAccessFeature[] | null;
  readonly message?: unknown;
  readonly errorMessage?: unknown;
  readonly source?: unknown;
  readonly featureCollection?: KentRehberiGeoJsonFeatureCollection | null;
}

export interface FastAccessBusiness {
  readonly Query: (
    query: Readonly<Record<string, unknown>>,
    single: boolean,
    options?: Readonly<{ signal?: AbortSignal; deduplicate?: boolean }>,
  ) => Promise<FastAccessServiceResult>;
}

interface MapLike {
  add?: (layer: unknown) => unknown;
  remove?: (layer: unknown) => unknown;
}

interface ExtentLike {
  expand?: (factor: number) => unknown;
}

interface MapViewLike {
  readonly map?: MapLike | null;
  readonly zoom?: number;
  readonly extent?: (ExtentLike & { clone?: () => unknown }) | null;
  readonly goTo?: (target: unknown, options?: Readonly<Record<string, unknown>>) => unknown;
}

interface LayerLike {
  readonly queryExtent?: () => Promise<{ readonly extent?: ExtentLike | null } | null>;
  readonly destroy?: () => void;
}

interface LayerEnvelope {
  readonly layerObj?: LayerLike | null;
}

export interface ManagedWindowHandle {
  readonly id: string;
  readonly visible: boolean;
  readonly minimized: boolean;
  readonly OnShow: () => void | Promise<void>;
  readonly OnClose: () => void;
}

export interface FastAccessWindowManager {
  readonly GetQueryParams?: (id: string) => Readonly<Record<string, unknown>> | null | undefined;
  readonly ShowMessage?: (type: string, message: string) => void;
  readonly ToggleMinimiseWindow?: (id: string) => void;
  readonly RegisterWindow?: (ref: Ref<ManagedWindowHandle>) => void;
  readonly ShowWindow?: (id: string) => void;
  readonly HideWindow?: (id: string) => void;
}

export interface ManagedFastAccessQueryWindowProps {
  readonly id: string;
  readonly windowManager: FastAccessWindowManager;
}

export interface ManagedFastAccessQueryWindowOptions {
  readonly title: string;
  readonly serviceKey: string;
  readonly iconType?: string;
  readonly business: FastAccessBusiness;
  readonly logName?: string;
  readonly pageSize?: number;
}

const normalizeAttributeKey = (value: unknown): string => String(value ?? '')
  .trim()
  .toLowerCase()
  .replace(/ı/g, 'i')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '');

const toSearchableEntries = (
  attributes: UnknownRecord | null | undefined,
): readonly (readonly [string, unknown])[] => Object.entries(attributes ?? {}).map(
  ([key, value]) => [normalizeAttributeKey(key), value] as const,
);

const readAttribute = (
  attributes: UnknownRecord | null | undefined,
  candidates: readonly string[],
): unknown => {
  const entries = toSearchableEntries(attributes);
  for (const candidate of candidates) {
    const normalizedCandidate = normalizeAttributeKey(candidate);
    const entry = entries.find(([key]) => key === normalizedCandidate);
    if (
      entry
      && entry[1] !== null
      && entry[1] !== undefined
      && String(entry[1]).trim() !== ''
    ) {
      return entry[1];
    }
  }
  return null;
};

const getFeatureGeometry = (feature: FastAccessFeature | null | undefined): GeometryLike | null =>
  feature?.geometry ?? feature?.raw?.geometry ?? null;

const getRawAttributes = (
  feature: FastAccessFeature | null | undefined,
): UnknownRecord => feature?.attr ?? feature?.attributes ?? {};

export const normalizeFastAccessRecord = (
  feature: FastAccessFeature,
  index = 0,
): FastAccessRecord => {
  const attributes = getRawAttributes(feature);
  const objectId = readAttribute(attributes, ATTRIBUTE_CANDIDATES.objectId);
  const title = readAttribute(attributes, ATTRIBUTE_CANDIDATES.title);
  const address = readAttribute(attributes, ATTRIBUTE_CANDIDATES.address);
  const phone = readAttribute(attributes, ATTRIBUTE_CANDIDATES.phone);

  return Object.freeze({
    objectId,
    title: title ? String(title) : 'Kayıt ' + String(index + 1),
    address: address ? String(address) : 'Adres bilgisi bulunmuyor',
    phone: phone ? String(phone) : '',
    raw: feature,
  });
};

export const filterFastAccessRecords = (
  records: readonly FastAccessRecord[],
  query: unknown,
): readonly FastAccessRecord[] => {
  const needle = normalizeText(query);
  if (!needle) return records;
  return records.filter((record) => normalizeText(
    record.title + ' ' + record.address + ' ' + record.phone,
  ).includes(needle));
};

export const buildGoogleRouteUrl = (
  geometry: GeometryLike | null | undefined,
): string | null => buildGoogleDirectionsUrl(geometry);

export const getFastAccessRecordKey = (
  record: FastAccessRecord | null | undefined,
  index = 0,
): string => {
  if (record?.objectId !== null && record?.objectId !== undefined && record.objectId !== '') {
    return String(record.objectId);
  }

  const attributes = getRawAttributes(record?.raw);
  const globalId = attributes.globalid ?? attributes.GLOBALID ?? attributes.GlobalID;
  if (globalId) return String(globalId);

  return normalizeText(record?.title)
    + '-'
    + normalizeText(record?.address)
    + '-'
    + String(index);
};

const safeRemoveLayer = (
  mapView: MapViewLike | null,
  layer: LayerLike | null | undefined,
): void => {
  if (!layer) return;
  try {
    mapView?.map?.remove?.(layer);
  } catch (error) {
    DebugHelper.Log(error);
  }
  try {
    layer?.destroy?.();
  } catch (error) {
    DebugHelper.Log(error);
  }
};

const getMapView = (): MapViewLike | null => {
  const value = MapManager.GetMapView();
  return value && typeof value === 'object' ? value as MapViewLike : null;
};

const normalizePageSize = (value: number | undefined): number => {
  if (!Number.isFinite(value)) return DEFAULT_PAGE_SIZE;
  return Math.min(200, Math.max(10, Math.trunc(Number(value))));
};

export function createManagedFastAccessQueryWindow({
  title,
  serviceKey,
  iconType,
  business,
  logName = title,
  pageSize: requestedPageSize = DEFAULT_PAGE_SIZE,
}: ManagedFastAccessQueryWindowOptions): ForwardRefExoticComponent<
  ManagedFastAccessQueryWindowProps & RefAttributes<ManagedWindowHandle>
> {
  const pageSize = normalizePageSize(requestedPageSize);

  const ManagedFastAccessQueryWindow = forwardRef<
    ManagedWindowHandle,
    ManagedFastAccessQueryWindowProps
  >(({ id, windowManager }, ref) => {
    const mountedRef = useRef(false);
    const mapViewRef = useRef<MapViewLike | null>(null);
    const layerRef = useRef<LayerEnvelope | LayerLike | null>(null);
    const requestGateRef = useRef(createLatestRequestGate());
    const initialExtentRef = useRef<unknown>(null);
    const queryAbortRef = useRef<AbortController | null>(null);
    const actionAbortRef = useRef<AbortController | null>(null);
    const surfaceRef = useRef<HTMLElement | null>(null);
    const resultsRef = useRef<HTMLUListElement | null>(null);
    const filterRef = useRef<HTMLInputElement | null>(null);

    const [records, setRecords] = useState<readonly FastAccessRecord[]>([]);
    const { filterText, setFilterText, setPage, filteredRecords, visibleRecords, pageCount, currentPage, pageStart } = useQueryResultPage(records, pageSize);
    const [loading, setLoading] = useState(false);
    const [errorMessage, setErrorMessage] = useState('');
    const [activeActionKey, setActiveActionKey] = useState('');

    const clearOwnedLayer = useCallback((): void => {
      const envelope = layerRef.current as LayerEnvelope | null;
      const layer = envelope?.layerObj ?? layerRef.current as LayerLike | null;
      safeRemoveLayer(mapViewRef.current, layer);
      layerRef.current = null;
    }, []);

    const resetSurface = useCallback((): void => {
      requestGateRef.current.invalidate();
      queryAbortRef.current?.abort();
      actionAbortRef.current?.abort();
      clearOwnedLayer();
      setRecords([]);
      setFilterText('');
      setPage(0);
      setLoading(false);
      setErrorMessage('');
      setActiveActionKey('');
    }, [clearOwnedLayer, pageSize]);

    const showError = useCallback((error: unknown): string => {
      const detail = normalizeErrorMessage(
        error,
        'Sorgu tamamlanamadı. Lütfen tekrar deneyin.',
      );
      const message = /HTTP\s[45]\d\d|Failed to fetch|Network request failed/i.test(detail)
        ? 'Hizmet verisi alınamadı. Bağlantınızı kontrol edip tekrar deneyin.'
        : detail;
      setErrorMessage(message);
      windowManager.ShowMessage?.(Constants_MessageType.Error, message);
      return message;
    }, [windowManager]);

    const renderLayer = useCallback(async (
      query: Readonly<Record<string, unknown>>,
      result: FastAccessServiceResult,
      requestId: number,
      signal: AbortSignal,
    ): Promise<void> => {
      const mapView = mapViewRef.current;
      if (!mapView?.map) return;

      const symbol = createPictureMarkerSymbol(
        { type: iconType ?? serviceKey, title, category: title },
        Number(mapView.zoom ?? 12),
        { minSize: 28, maxSize: 44 },
      );

      const nextLayer = await withTimeout(async (operationSignal) => {
        let candidate: LayerEnvelope | null = null;
        if (result.source === 'kent-rehberi' && result.featureCollection) {
          const layer = await createKentRehberiGeoJsonLayer(
            result.featureCollection,
            undefined,
            {
              id: `kent-rehberi-${serviceKey}`,
              title,
              renderer: Object.freeze({
                type: 'simple',
                symbol,
              }),
            },
          );
          candidate = Object.freeze({ layerObj: layer as LayerLike });
        } else {
          candidate = await CommonBusiness.Clustering.CreateLayerWithoutClustering(
            serviceKey,
            title,
            query,
            symbol,
          ) as LayerEnvelope | null;
        }

        if (!mountedRef.current || operationSignal.aborted || !requestGateRef.current.isCurrent(requestId)) {
          candidate?.layerObj?.destroy?.();
          throwIfAborted(operationSignal);
          return null;
        }
        return candidate;
      }, QUERY_PRESENTATION_TIMEOUT_MS, signal);
      throwIfAborted(signal);
      if (!nextLayer?.layerObj || !requestGateRef.current.isCurrent(requestId)) return;
      try {
        mapView.map.add?.(nextLayer.layerObj);
      } catch (error) {
        nextLayer.layerObj.destroy?.();
        throw error;
      }
      clearOwnedLayer();
      layerRef.current = nextLayer;

      try {
        const extentResult = await withTimeout(() => nextLayer.layerObj?.queryExtent?.(), QUERY_PRESENTATION_TIMEOUT_MS, signal);
        throwIfAborted(signal);
        const extent = extentResult?.extent;
        if (extent && mountedRef.current && requestGateRef.current.isCurrent(requestId) && mapView.goTo) {
          const target = typeof extent.expand === 'function' ? extent.expand(1.12) : extent;
          await withTimeout((operationSignal) => Promise.resolve(mapView.goTo!(target, { animate: false, signal: operationSignal })), QUERY_PRESENTATION_TIMEOUT_MS, signal);
        }
      } catch (error) {
        if (!signal.aborted) DebugHelper.Log(error);
      }
    }, [clearOwnedLayer, iconType, serviceKey, title]);

    const fetchQueryResults = useCallback(async (): Promise<void> => {
      queryAbortRef.current?.abort();
      actionAbortRef.current?.abort();
      const lifetime = new AbortController();
      queryAbortRef.current = lifetime;
      const requestId = requestGateRef.current.next();
      const query = windowManager.GetQueryParams?.(id) ?? DEFAULT_QUERY;

      setLoading(true);
      setErrorMessage('');
      setFilterText('');
      setPage(0);

      // Client logging must not delay the visible query or map layer.
      void safeClientLog(LoggingBusiness, logName + '/Sorgu', JSON.stringify(query));

      try {
        const result = await business.Query(query, false, { signal: lifetime.signal, deduplicate: false });
        if (!mountedRef.current || !requestGateRef.current.isCurrent(requestId)) return;

        if (result?.type !== Constants_ServiceResultType.Success) {
          showError(result?.message ?? result?.errorMessage);
          return;
        }

        const nextRecords = Array.isArray(result.data)
          ? result.data.map(normalizeFastAccessRecord)
          : [];

        setRecords(nextRecords);
        await renderLayer(query, result, requestId, lifetime.signal);
      } catch (error) {
        if (mountedRef.current && requestGateRef.current.isCurrent(requestId) && !lifetime.signal.aborted) {
          showError(error);
        }
      } finally {
        if (mountedRef.current && requestGateRef.current.isCurrent(requestId)) {
          setLoading(false);
        }
      }
    }, [business, id, logName, pageSize, renderLayer, showError, windowManager]);

    const getItemDetails = useCallback(async (
      item: FastAccessRecord,
      signal: AbortSignal,
    ): Promise<FastAccessFeature | null> => {
      if (item.objectId === null || item.objectId === undefined || item.objectId === '') {
        return item.raw;
      }

      const result = await withTimeout((operationSignal) => business.Query({ ObjectId: item.objectId }, true, { signal: operationSignal, deduplicate: false }), QUERY_PRESENTATION_TIMEOUT_MS, signal);
      throwIfAborted(signal);
      if (
        result?.type !== Constants_ServiceResultType.Success
        || !Array.isArray(result.data)
      ) {
        return null;
      }
      return result.data[0] ?? null;
    }, [business]);

    const runItemAction = useCallback(async <Result,>(
      item: FastAccessRecord,
      action: string,
      callback: (signal: AbortSignal) => Promise<Result>,
    ): Promise<Result | null> => {
      actionAbortRef.current?.abort();
      const lifetime = new AbortController();
      actionAbortRef.current = lifetime;
      const key = getFastAccessRecordKey(item) + '-' + action;
      setActiveActionKey(key);
      setErrorMessage('');
      try {
        return await callback(lifetime.signal);
      } catch (error) {
        if (mountedRef.current && !lifetime.signal.aborted && !isAbortLike(error)) showError(error);
        return null;
      } finally {
        if (mountedRef.current && actionAbortRef.current === lifetime) {
          setActiveActionKey((current) => current === key ? '' : current);
        }
      }
    }, [showError]);

    const zoomToItem = useCallback((item: FastAccessRecord) => runItemAction(
      item,
      'zoom',
      async (signal) => {
        const detail = await getItemDetails(item, signal);
        throwIfAborted(signal);
        const geometry = getFeatureGeometry(detail);
        if (!geometry) throw new Error('Konum bilgisi bulunamadı.');

        GisGraphicsHelper.ZoomToGeometry(mapViewRef.current, geometry, 18);
        void safeClientLog(
          LoggingBusiness,
          logName + '/Detay Göster',
          String(item.objectId ?? '') + '/' + item.address,
        );

        if (!signal.aborted && window.matchMedia?.('(max-width: 959px)').matches) {
          windowManager.ToggleMinimiseWindow?.(id);
        }
        return detail;
      },
    ), [getItemDetails, id, logName, runItemAction, windowManager]);

    const showRoute = useCallback((item: FastAccessRecord) => runItemAction(
      item,
      'route',
      async (signal) => {
        const detail = await getItemDetails(item, signal);
        throwIfAborted(signal);
        const routeUrl = buildGoogleDirectionsUrl(getFeatureGeometry(detail));
        if (!routeUrl) throw new Error('Yol tarifi için konum bilgisi bulunamadı.');
        if (!openExternalSafely(routeUrl)) {
          throw new Error('Yol tarifi penceresi açılamadı.');
        }

        void safeClientLog(
          LoggingBusiness,
          logName + '/Yol Tarifi',
          String(item.objectId ?? '') + '/' + item.address,
        );
        return true;
      },
    ), [getItemDetails, logName, runItemAction]);

    useImperativeHandle(ref, () => ({
      id,
      visible: false,
      minimized: false,
      OnShow: fetchQueryResults,
      OnClose: resetSurface,
    }), [fetchQueryResults, id, resetSurface]);

    useEffect(() => {
      mountedRef.current = true;
      const mapView = getMapView();
      mapViewRef.current = mapView;
      initialExtentRef.current = mapView?.extent?.clone?.() ?? mapView?.extent ?? null;
      windowManager.RegisterWindow?.(ref);

      return () => {
        mountedRef.current = false;
        requestGateRef.current.invalidate();
      queryAbortRef.current?.abort();
      actionAbortRef.current?.abort();
        clearOwnedLayer();
      };
    }, [clearOwnedLayer, ref, windowManager]);

    const changePage = (next: number): void => {
      setPage(Math.max(0, Math.min(pageCount - 1, next)));
      // The result heading receives focus only after an explicit page action;
      // filtering preserves the edited input and its caret.
      surfaceRef.current?.scrollTo?.({ top: 0, behavior: 'instant' });
      resultsRef.current?.focus({ preventScroll: true });
    };

    const returnToServices = useCallback((): void => {
      requestGateRef.current.invalidate();
      queryAbortRef.current?.abort();
      actionAbortRef.current?.abort();
      clearOwnedLayer();

      const initialExtent = initialExtentRef.current;
      const mapView = mapViewRef.current;
      if (initialExtent && mapView?.goTo) {
        Promise.resolve(mapView.goTo(initialExtent, { animate: false })).catch(DebugHelper.Log);
      }

      windowManager.HideWindow?.(id);
      windowManager.ShowWindow?.('sidebar');
    }, [clearOwnedLayer, id, windowManager]);

    const retry = useCallback((): void => {
      if (!loading) void fetchQueryResults();
    }, [fetchQueryResults, loading]);

    return (
      <section
        ref={surfaceRef}
        className="sidebar-container kr-fast-query"
        aria-labelledby={id + '-title'}
        aria-busy={loading}
      >
        <header className="common-query-window-header kr-fast-query__header">
          <SharedGISIcon
            record={{ type: iconType ?? serviceKey, title, category: title }}
            size={34}
            className="common-query-window-header-icon"
          />
          <h2 id={id + '-title'}>{title}</h2>
          <button
            type="button"
            className="kr-fast-query__close"
            onClick={returnToServices}
            aria-label={title + ' penceresini kapat'}
          >
            ×
          </button>
        </header>

        <div className="kr-fast-query__toolbar">
          <button type="button" className="kr-fast-query__back" onClick={returnToServices}>
            <span aria-hidden="true">←</span><span>Hizmetlere dön</span>
          </button>
          <span className="kr-fast-query__count" aria-live="polite">
            <strong>{filteredRecords.length}</strong> sonuç
          </span>
        </div>

        {records.length > 12 ? (
          <div className="kr-fast-query__filter">
            <label htmlFor={id + '-filter'}>Sonuçlarda filtrele</label>
            <input
              ref={filterRef}
              id={id + '-filter'}
              type="search"
              value={filterText}
              onChange={(event) => {
                setFilterText(event.target.value);
                setPage(0);
              }}
              placeholder="Ad, adres veya telefon…"
              autoComplete="off"
              aria-controls={id + '-results'}
            />
            {filterText ? <button type="button" className="kr-fast-query__clear" onClick={() => { setFilterText(''); setPage(0); filterRef.current?.focus({ preventScroll: true }); }}>Filtreyi temizle</button> : null}
          </div>
        ) : null}

        <div className="kr-fast-query__status" role="status" aria-live="polite">
          {loading ? <span>Sonuçlar ve harita katmanı yükleniyor…</span> : null}
          {!loading && errorMessage ? (
            <div className="kr-fast-query__error">
              <span>{errorMessage}</span>
              <button type="button" onClick={retry}>Tekrar dene</button>
            </div>
          ) : null}
          {!loading && !errorMessage && records.length === 0
            ? <span>Gösterilecek kayıt bulunamadı.</span>
            : null}
        </div>

        {!loading && !errorMessage && records.length > 0 && filteredRecords.length === 0 ? (
          <p className="kr-fast-query__empty" role="status">Filtreye uygun sonuç bulunamadı. Filtreyi temizleyerek tüm kayıtlara dönebilirsiniz.</p>
        ) : null}
        <ul ref={resultsRef} id={id + '-results'} tabIndex={-1} className="results-container kr-fast-query__results" aria-label={title + ' sonuçları'}>
          {visibleRecords.map((item, index) => {
            const recordKey = getFastAccessRecordKey(item, pageStart + index);
            const zoomKey = recordKey + '-zoom';
            const routeKey = recordKey + '-route';

            return (
              <li className="result-item-container kr-fast-query__item" key={recordKey}>
                <SharedGISIcon
                  record={{ type: iconType ?? serviceKey, title: item.title, category: title }}
                  size={30}
                  className="kr-fast-query__item-icon"
                />
                <div className="result-item-info kr-fast-query__copy">
                  <h3 className="result-item-info-title">{item.title}</h3>
                  <p className="result-item-info-address">{item.address}</p>
                  {item.phone ? (
                    <a href={'tel:' + item.phone.replace(/[^+\d]/g, '')}>{item.phone}</a>
                  ) : null}
                </div>
                <div className="kr-fast-query__actions" aria-label={item.title + ' işlemleri'}>
                  <button
                    type="button"
                    onClick={() => { void zoomToItem(item); }}
                    disabled={activeActionKey === zoomKey}
                  >
                    {activeActionKey === zoomKey ? 'Açılıyor…' : 'Haritada göster'}
                  </button>
                  <button
                    type="button"
                    onClick={() => { void showRoute(item); }}
                    disabled={activeActionKey === routeKey}
                  >
                    {activeActionKey === routeKey ? 'Açılıyor…' : 'Yol tarifi'}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>

        <QueryResultPagination title={title} listId={id + '-results'} page={currentPage} pageCount={pageCount}
          start={pageStart} shown={visibleRecords.length} total={filteredRecords.length} onPageChange={changePage} />
      </section>
    );
  });

  ManagedFastAccessQueryWindow.displayName = 'ManagedFastAccessQueryWindow(' + title + ')';
  return ManagedFastAccessQueryWindow;
}
