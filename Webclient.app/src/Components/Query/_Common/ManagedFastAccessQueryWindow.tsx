import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
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
import { OperationTimeoutError, withTimeout } from '../../../platform/runtime/resilience';
import {
  createKentRehberiGeoJsonLayer,
  type KentRehberiGeoJsonFeatureCollection,
} from '../../../data-services/kentRehberiGeoJsonLayer';
import { SharedGISIcon } from '../../Common/SharedGISIcon';
import { createManagedWindowFocusLifecycle } from './ManagedWindowFocus';
import { scheduleOwnedResultFocus } from './ResultPageFocus';
import { ServiceWindowActions } from './ServiceWindowActions';
import {
  QUERY_RESULT_PAGE_POLICY,
  matchesQueryResultTerms,
  normalizeQueryResultPageSize,
  normalizeQueryResultText,
  queryResultSearchTerms,
} from './QueryResultPaging';
import {
  buildGoogleDirectionsUrl,
  createLatestRequestGate,
  normalizeErrorMessage,
  openExternalSafely,
  safeClientLog,
  type GeometryLike,
} from './QueryInteractionRuntime';
import './ManagedFastAccessQueryWindow.css';

const DEFAULT_PAGE_SIZE = QUERY_RESULT_PAGE_POLICY.defaultPageSize;
const SERVICE_WINDOW_POLICY = Object.freeze({ layerTimeoutMs: 15_000, actionTimeoutMs: 15_000 });
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
    options?: { readonly signal?: AbortSignal },
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
  readonly IsVisible?: (id: string) => boolean;
  readonly IsMinimized?: (id: string) => boolean;
  readonly UnregisterWindow?: (id: string, ref: Ref<ManagedWindowHandle>) => void;
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

const normalizeText = normalizeQueryResultText;

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
  const terms = queryResultSearchTerms(query);
  if (!terms.length) return records;
  return records.filter((record) => matchesQueryResultTerms(normalizeText(
    record.title + ' ' + record.address + ' ' + record.phone,
  ), terms));
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

const normalizePageSize = (value: number | undefined): number =>
  normalizeQueryResultPageSize(value ?? DEFAULT_PAGE_SIZE);

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
    const actionGateRef = useRef(createLatestRequestGate());
    const queryAbortRef = useRef<AbortController | null>(null);
    const actionAbortRef = useRef<AbortController | null>(null);
    const rootRef = useRef<HTMLElement | null>(null);
    const pageFocusCancelRef = useRef<(() => void) | null>(null);
    const initialExtentRef = useRef<unknown>(null);
    const visible = windowManager.IsVisible?.(id) ?? true;
    const minimized = windowManager.IsMinimized?.(id) ?? false;

    const [records, setRecords] = useState<readonly FastAccessRecord[]>([]);
    const [filterText, setFilterText] = useState('');
    const [visibleCount, setVisibleCount] = useState(pageSize);
    const [pageStart, setPageStart] = useState(0);
    const [loading, setLoading] = useState(false);
    const [errorMessage, setErrorMessage] = useState('');
    const [activeActionKey, setActiveActionKey] = useState('');

    const cancelPageFocus = useCallback((): void => {
      pageFocusCancelRef.current?.();
      pageFocusCancelRef.current = null;
    }, []);

    const schedulePageFocus = (event: React.MouseEvent<HTMLButtonElement>, index: number): void => {
      cancelPageFocus();
      const requestId = requestGateRef.current.current();
      pageFocusCancelRef.current = scheduleOwnedResultFocus({
        trigger: event.currentTarget,
        detail: event.detail,
        isCurrent: () => mountedRef.current
          && requestGateRef.current.isCurrent(requestId)
          && rootRef.current?.getAttribute('aria-hidden') !== 'true'
          && !rootRef.current?.hasAttribute('data-minimized'),
        resolveTarget: () => rootRef.current
          ?.querySelectorAll<HTMLElement>('.kr-fast-query__item')[index]
          ?.querySelector<HTMLElement>('button') ?? null,
      });
    };

    const clearOwnedLayer = useCallback((): void => {
      const envelope = layerRef.current as LayerEnvelope | null;
      const layer = envelope?.layerObj ?? layerRef.current as LayerLike | null;
      safeRemoveLayer(mapViewRef.current, layer);
      layerRef.current = null;
    }, []);

    const resetSurface = useCallback((): void => {
      cancelPageFocus();
      requestGateRef.current.invalidate();
      actionGateRef.current.invalidate();
      queryAbortRef.current?.abort();
      actionAbortRef.current?.abort();
      clearOwnedLayer();
      setRecords([]);
      setFilterText('');
      setVisibleCount(pageSize);
      setPageStart(0);
      setLoading(false);
      setErrorMessage('');
      setActiveActionKey('');
    }, [cancelPageFocus, clearOwnedLayer, pageSize]);

    const showError = useCallback((error: unknown): string => {
      const detail = normalizeErrorMessage(
        error,
        'Sorgu tamamlanamadı. Lütfen tekrar deneyin.',
      );
      const message = error instanceof OperationTimeoutError
        ? 'İşlem beklenenden uzun sürdü. Lütfen tekrar deneyin.'
        : /HTTP\s[45]\d\d|Failed to fetch|Network request failed/i.test(detail)
        ? 'Hizmet verisi alınamadı. Bağlantınızı kontrol edip tekrar deneyin.'
        : /Servis bulunamadı|service.*(?:not found|not configured)/i.test(detail)
          ? 'Bu hizmet şu anda kullanılamıyor. Daha sonra tekrar deneyebilirsiniz.'
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

      let nextLayer: LayerEnvelope | null = null;
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
          signal,
        );
        nextLayer = Object.freeze({ layerObj: layer as LayerLike });
      } else {
        nextLayer = await CommonBusiness.Clustering.CreateLayerWithoutClustering(
          serviceKey,
          title,
          query,
          symbol,
        ) as LayerEnvelope | null;
      }

      if (!mountedRef.current || signal.aborted || !requestGateRef.current.isCurrent(requestId) || !nextLayer?.layerObj) {
        safeRemoveLayer(null, nextLayer?.layerObj);
        return;
      }

      clearOwnedLayer();
      layerRef.current = nextLayer;
      try {
        mapView.map.add?.(nextLayer.layerObj);
      } catch (error) {
        clearOwnedLayer();
        throw error;
      }

      try {
        const extentResult = await nextLayer.layerObj.queryExtent?.();
        const extent = extentResult?.extent;
        if (extent && mountedRef.current && !signal.aborted && requestGateRef.current.isCurrent(requestId) && layerRef.current === nextLayer && mapView.goTo) {
          const target = typeof extent.expand === 'function' ? extent.expand(1.12) : extent;
          await mapView.goTo(target, { animate: false });
        }
      } catch (error) {
        DebugHelper.Log(error);
      }
    }, [clearOwnedLayer, iconType, serviceKey, title]);

    const fetchQueryResults = useCallback(async (): Promise<void> => {
      cancelPageFocus();
      const requestId = requestGateRef.current.next();
      queryAbortRef.current?.abort();
      actionAbortRef.current?.abort();
      actionGateRef.current.invalidate();
      const controller = new AbortController();
      queryAbortRef.current = controller;
      const query = windowManager.GetQueryParams?.(id) ?? DEFAULT_QUERY;

      setLoading(true);
      setErrorMessage('');
      setFilterText('');
      setVisibleCount(pageSize);
      setPageStart(0);
      setRecords([]);
      setActiveActionKey('');
      clearOwnedLayer();

      void safeClientLog(LoggingBusiness, logName + '/Sorgu', `query-fields:${Math.min(Object.keys(query).length, 99)}`, DebugHelper.Log);

      try {
        const result = await business.Query(query, false, { signal: controller.signal });
        if (!mountedRef.current || !requestGateRef.current.isCurrent(requestId)) return;

        if (result?.type !== Constants_ServiceResultType.Success) {
          showError(result?.message ?? result?.errorMessage);
          return;
        }

        const nextRecords = Array.isArray(result.data)
          ? result.data.map(normalizeFastAccessRecord)
          : [];

        setRecords(nextRecords);
        await withTimeout((signal) => renderLayer(query, result, requestId, signal), SERVICE_WINDOW_POLICY.layerTimeoutMs, controller.signal);
      } catch (error) {
        if (mountedRef.current && requestGateRef.current.isCurrent(requestId)) {
          showError(error);
        }
      } finally {
        if (mountedRef.current && requestGateRef.current.isCurrent(requestId)) {
          setLoading(false);
        }
      }
    }, [business, cancelPageFocus, clearOwnedLayer, id, logName, pageSize, renderLayer, showError, windowManager]);

    const getItemDetails = useCallback(async (
      item: FastAccessRecord,
      signal: AbortSignal,
    ): Promise<FastAccessFeature | null> => {
      if (item.objectId === null || item.objectId === undefined || item.objectId === '') {
        return item.raw;
      }

      const result = await business.Query({ ObjectId: item.objectId }, true, { signal });
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
      callback: (signal: AbortSignal, isCurrent: () => boolean) => Promise<Result | null>,
    ): Promise<Result | null> => {
      if (actionAbortRef.current && !actionAbortRef.current.signal.aborted) return null;
      const actionId = actionGateRef.current.next();
      const controller = new AbortController();
      actionAbortRef.current = controller;
      const isCurrent = (): boolean => mountedRef.current && !controller.signal.aborted && actionGateRef.current.isCurrent(actionId);
      const key = getFastAccessRecordKey(item) + '-' + action;
      setActiveActionKey(key);
      setErrorMessage('');
      try {
        return await withTimeout((signal) => callback(signal, () => isCurrent() && !signal.aborted), SERVICE_WINDOW_POLICY.actionTimeoutMs, controller.signal);
      } catch (error) {
        if (isCurrent()) showError(error);
        return null;
      } finally {
        if (isCurrent()) {
          setActiveActionKey((current) => current === key ? '' : current);
        }
        if (actionAbortRef.current === controller) actionAbortRef.current = null;
      }
    }, [showError]);

    const zoomToItem = useCallback((item: FastAccessRecord) => runItemAction(
      item,
      'zoom',
      async (signal, isCurrent) => {
        const detail = await getItemDetails(item, signal);
        if (!isCurrent()) return null;
        const geometry = getFeatureGeometry(detail);
        if (!geometry) throw new Error('Konum bilgisi bulunamadı.');

        await Promise.resolve(GisGraphicsHelper.ZoomToGeometry(mapViewRef.current, geometry, 18));
        if (!isCurrent()) return null;
        void safeClientLog(
          LoggingBusiness,
          logName + '/Detay Göster',
          'record-detail-opened',
        );

        if (window.matchMedia?.('(max-width: 959px)').matches) {
          windowManager.ToggleMinimiseWindow?.(id);
        }
        return detail;
      },
    ), [getItemDetails, id, logName, runItemAction, windowManager]);

    const showRoute = useCallback((item: FastAccessRecord) => runItemAction(
      item,
      'route',
      async (signal, isCurrent) => {
        const detail = await getItemDetails(item, signal);
        if (!isCurrent()) return null;
        const routeUrl = buildGoogleDirectionsUrl(getFeatureGeometry(detail));
        if (!routeUrl) throw new Error('Yol tarifi için konum bilgisi bulunamadı.');
        if (!openExternalSafely(routeUrl)) {
          throw new Error('Yol tarifi penceresi açılamadı.');
        }

        void safeClientLog(
          LoggingBusiness,
          logName + '/Yol Tarifi',
          'external-route-requested',
        );
        return true;
      },
    ), [getItemDetails, logName, runItemAction]);

    useImperativeHandle(ref, () => ({
      id,
      visible,
      minimized,
      OnShow: fetchQueryResults,
      OnClose: resetSurface,
    }), [fetchQueryResults, id, minimized, resetSurface, visible]);

    useEffect(() => {
      mountedRef.current = true;
      const mapView = getMapView();
      mapViewRef.current = mapView;
      initialExtentRef.current = mapView?.extent?.clone?.() ?? mapView?.extent ?? null;
      windowManager.RegisterWindow?.(ref);

      return () => {
        mountedRef.current = false;
        cancelPageFocus();
        requestGateRef.current.invalidate();
        actionGateRef.current.invalidate();
        queryAbortRef.current?.abort();
        actionAbortRef.current?.abort();
        clearOwnedLayer();
        windowManager.UnregisterWindow?.(id, ref);
      };
    }, [cancelPageFocus, clearOwnedLayer, id, ref, windowManager]);

    useEffect(() => {
      if (!visible) return;
      const focus = createManagedWindowFocusLifecycle();
      focus.open({ root: rootRef.current, initialFocusSelector: 'input[type="search"], .kr-fast-query__back' });
      return () => { focus.close(); focus.dispose(); };
    }, [visible]);

    // Normalize large service result sets once per query, not on every filter keystroke.
    const searchIndex = useMemo(
      () => records.map((record) => ({
        record,
        searchText: normalizeText(record.title + ' ' + record.address + ' ' + record.phone),
      })),
      [records],
    );

    const filteredRecords = useMemo(() => {
      const terms = queryResultSearchTerms(filterText);
      return terms.length
        ? searchIndex.filter(({ searchText }) => matchesQueryResultTerms(searchText, terms)).map(({ record }) => record)
        : records;
    }, [filterText, records, searchIndex]);

    // The display index changes after filtering; fallback React keys must not.
    const sourceIndices = useMemo(
      () => new Map(records.map((record, index) => [record, index] as const)),
      [records],
    );

    const visibleRecords = useMemo(
      () => filteredRecords.slice(pageStart, pageStart + visibleCount),
      [filteredRecords, pageStart, visibleCount],
    );

    const returnToServices = useCallback((): void => {
      const initialExtent = initialExtentRef.current;
      const mapView = mapViewRef.current;
      resetSurface();
      windowManager.HideWindow?.(id);
      windowManager.ShowWindow?.('sidebar');
      if (initialExtent && mapView?.goTo) {
        Promise.resolve(mapView.goTo(initialExtent, { animate: false })).catch(DebugHelper.Log);
      }
    }, [id, resetSurface, windowManager]);

    const retry = useCallback((): void => {
      if (!loading) void fetchQueryResults();
    }, [fetchQueryResults, loading]);

    return (
      <section
        ref={rootRef}
        className="sidebar-container kr-fast-query"
        data-minimized={minimized || undefined}
        aria-hidden={!visible}
        style={{ visibility: visible ? 'visible' : 'hidden' }}
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
          <ServiceWindowActions title={title} minimized={minimized} onMinimize={() => windowManager.ToggleMinimiseWindow?.(id)} onClose={returnToServices} />
        </header>

        <div className="kr-fast-query__toolbar">
          <button type="button" className="kr-fast-query__back" onClick={returnToServices}>
            <span aria-hidden="true">←</span><span>Hizmetlere dön</span>
          </button>
          <span className="kr-fast-query__count" aria-live="polite">
            {loading ? 'Yükleniyor…' : <><strong>{filteredRecords.length.toLocaleString('tr-TR')}</strong> sonuç</>}
          </span>
        </div>

        {records.length > 12 ? (
          <div className="kr-fast-query__filter">
            <label htmlFor={id + '-filter'}>Sonuçlarda filtrele</label>
            <input
              id={id + '-filter'}
              type="search"
              aria-label="Sonuçlarda filtrele"
              value={filterText}
              onChange={(event) => {
                setFilterText(event.target.value);
                setVisibleCount(pageSize);
                setPageStart(0);
                cancelPageFocus();
              }}
              placeholder="Ad, adres veya telefon…"
              autoComplete="off"
              disabled={loading}
              aria-controls={id + '-results'}
            />
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
          {!loading && !errorMessage && records.length > 0 && filteredRecords.length === 0 ? (
            <div className="kr-fast-query__empty">
              <strong>Aramanızla eşleşen sonuç yok.</strong>
              <span>Başka bir ad, adres veya telefon deneyin.</span>
              <button type="button" onClick={() => { setFilterText(''); setVisibleCount(pageSize); setPageStart(0); cancelPageFocus(); rootRef.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus(); }}>Filtreyi temizle</button>
            </div>
          ) : null}
        </div>

        <ul id={id + '-results'} className="results-container kr-fast-query__results" aria-label={title + ' sonuçları'}>
          {visibleRecords.map((item, index) => {
            const recordKey = getFastAccessRecordKey(item, sourceIndices.get(item) ?? index);
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
                    disabled={loading || Boolean(activeActionKey)}
                    aria-label={item.title + ' — Haritada göster'}
                  >
                    {activeActionKey === zoomKey ? 'Açılıyor…' : 'Haritada göster'}
                  </button>
                  <button
                    type="button"
                    onClick={() => { void showRoute(item); }}
                    disabled={loading || Boolean(activeActionKey)}
                    aria-label={item.title + ' — Yol tarifi (yeni pencere)'}
                  >
                    {activeActionKey === routeKey ? 'Açılıyor…' : 'Yol tarifi'}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>

        {!loading && filteredRecords.length > 0 ? (
          <nav className="kr-fast-query__paging" aria-label={title + ' sonuç gezinme'}>
            <p className="kr-fast-query__range" aria-live="polite" aria-atomic="true">
              {pageStart + 1}–{pageStart + visibleRecords.length} / {filteredRecords.length} kayıt
            </p>
            <div className="kr-fast-query__paging-actions">
              {pageStart > 0 ? (
                <button
                  type="button"
                  className="kr-fast-query__more"
                  aria-controls={id + '-results'}
                  onClick={(event) => {
                    const previousStart = Math.max(0, pageStart - QUERY_RESULT_PAGE_POLICY.maxPageSize);
                    setPageStart(previousStart);
                    setVisibleCount(Math.min(QUERY_RESULT_PAGE_POLICY.maxPageSize, filteredRecords.length - previousStart));
                    schedulePageFocus(event, 0);
                  }}
                >
                  Önceki sonuçlara dön
                </button>
              ) : null}
              {pageStart + visibleCount < filteredRecords.length ? (
                visibleCount < QUERY_RESULT_PAGE_POLICY.maxPageSize ? (
                  <button
                    type="button"
                    className="kr-fast-query__more"
                    aria-controls={id + '-results'}
                    onClick={(event) => {
                      setVisibleCount((count) => Math.min(
                        count + pageSize,
                        QUERY_RESULT_PAGE_POLICY.maxPageSize,
                        filteredRecords.length - pageStart,
                      ));
                      schedulePageFocus(event, visibleCount);
                    }}
                  >
                    Daha fazla sonuç göster ({filteredRecords.length - pageStart - visibleCount} kaldı)
                  </button>
                ) : (
                  <button
                    type="button"
                    className="kr-fast-query__more"
                    aria-controls={id + '-results'}
                    onClick={(event) => {
                      setPageStart(pageStart + visibleCount);
                      setVisibleCount(pageSize);
                      schedulePageFocus(event, 0);
                    }}
                  >
                    Sonraki sonuçlara geç
                  </button>
                )
              ) : null}
            </div>
          </nav>
        ) : null}
      </section>
    );
  });

  ManagedFastAccessQueryWindow.displayName = 'ManagedFastAccessQueryWindow(' + title + ')';
  return ManagedFastAccessQueryWindow;
}
