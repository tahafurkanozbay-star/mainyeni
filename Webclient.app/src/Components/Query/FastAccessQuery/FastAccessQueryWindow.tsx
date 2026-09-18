import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { BiSearch } from 'react-icons/bi';
import { Constants_MessageType } from '../../../Core/Constants';
import { NumberingQueryBusiness } from '../../../Business/NumberingQueryBusiness';
import { FastAccessQueryBusiness } from '../../../Business/FastAccessQueryBusiness';
import { CommonBusiness } from '../../../Business/CommonBusiness';
import { LoggingBusiness } from '../../../Business/LoggingBusiness';
import MapManager from '../../../Store/Managers/MapManager';
import { GisGraphicsHelper } from '../../../Toolbox/GisGraphicsHelper';
import { ExperienceDataTable, type ExperienceDataColumn } from '../../Common/ExperienceDataTable';
import {
  ExperienceInput,
  ExperienceSelect,
} from '../../Common/ExperienceForm';
import { ExperiencePagination } from '../../Common/ExperiencePagination';
import { ExperienceQuerySurface } from '../../Common/ExperienceQuerySurface';
import { ExperienceStatus } from '../../Common/ExperienceStatus';
import {
  CommonQueryResultItemTools,
} from '../_Common/CommonQueryResultItemTools';
import {
  CommonQueryWindowTools,
  type CommonQueryWindowToolsHandle,
  type QueryWindowManagerLike,
} from '../_Common/CommonQueryWindowTools';
import {
  createManagedWindowFocusLifecycle,
  type ManagedWindowFocusLifecycle,
} from '../_Common/ManagedWindowFocus';
import {
  buildGoogleDirectionsUrl,
  createLatestRequestGate,
  normalizeErrorMessage,
  openExternalSafely,
  safeClientLog,
} from '../_Common/QueryInteractionRuntime';
import {
  DEFAULT_FAST_ACCESS_QUERY,
  createQueryLogDescription,
  fastAccessResultKey,
  fastAccessResultLabel,
  normalizeFastAccessDetail,
  normalizeFastAccessEnvelope,
  normalizeFastAccessResults,
  normalizeLookupOptions,
  paginateFastAccessResults,
  toBusinessQuery,
  updateFastAccessQuery,
  type FastAccessFilterState,
  type FastAccessLookupOption,
  type FastAccessResultItem,
} from './FastAccessQueryModel';
import './FastAccessQueryWindow.css';

interface MapLike {
  readonly add?: (layer: unknown) => void;
  readonly remove?: (layer: unknown) => void;
}

interface MapViewLike {
  readonly map?: MapLike;
}

interface ClusterLayerLike {
  readonly layerObj?: unknown;
}

export interface FastAccessWindowManager extends QueryWindowManagerLike {
  readonly RegisterWindow: (ref: unknown) => void;
  readonly IsVisible: (id: string) => boolean;
}

export interface FastAccessQueryWindowProps {
  readonly id: string;
  readonly windowManager: FastAccessWindowManager;
  readonly windowTitle: string;
  readonly windowLogo: string;
  readonly queryServiceTitle: string;
}

export interface FastAccessQueryWindowHandle {
  readonly id: string;
  readonly visible: boolean;
  readonly minimized: boolean;
  readonly OnShow: () => void;
  readonly OnClose: () => void;
}

type ActiveView = 'form' | 'results';

const asMapView = (value: unknown): MapViewLike | null =>
  value !== null && typeof value === 'object' ? value as MapViewLike : null;

const asClusterLayer = (value: unknown): ClusterLayerLike | null =>
  value !== null && typeof value === 'object' ? value as ClusterLayerLike : null;

const errorTone = (
  error: string | null,
  loading: boolean,
  count: number,
): 'danger' | 'info' | 'success' => {
  if (error) return 'danger';
  if (loading) return 'info';
  return count > 0 ? 'success' : 'info';
};

export const FastAccessQueryWindow = forwardRef<
  FastAccessQueryWindowHandle,
  FastAccessQueryWindowProps
>(({
  id,
  windowManager,
  windowTitle,
  windowLogo,
  queryServiceTitle,
}, ref): ReactNode => {
  const rootRef = useRef<HTMLElement>(null);
  const commonToolsRef = useRef<CommonQueryWindowToolsHandle>(null);
  const focusLifecycleRef = useRef<ManagedWindowFocusLifecycle | null>(null);
  const mapViewRef = useRef<MapViewLike | null>(null);
  const clusterLayerRef = useRef<unknown>(null);
  const searchAbortRef = useRef<AbortController | null>(null);
  const detailAbortRef = useRef<AbortController | null>(null);
  const queryGateRef = useRef(createLatestRequestGate());
  const clusterGateRef = useRef(createLatestRequestGate());
  const mountedRef = useRef(true);

  const [query, setQuery] = useState<FastAccessFilterState>(DEFAULT_FAST_ACCESS_QUERY);
  const [districts, setDistricts] = useState<readonly FastAccessLookupOption[]>([]);
  const [neighborhoods, setNeighborhoods] = useState<readonly FastAccessLookupOption[]>([]);
  const [results, setResults] = useState<readonly FastAccessResultItem[]>([]);
  const [activeView, setActiveView] = useState<ActiveView>('form');
  const [loading, setLoading] = useState(false);
  const [lookupLoading, setLookupLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | number | null>(null);
  const [page, setPage] = useState(1);

  const focusLifecycle = useCallback((): ManagedWindowFocusLifecycle | null => {
    if (typeof document === 'undefined') return null;
    focusLifecycleRef.current ??= createManagedWindowFocusLifecycle(document);
    return focusLifecycleRef.current;
  }, []);

  const removeClusterLayer = useCallback((layer = clusterLayerRef.current): void => {
    if (!layer) return;
    const view = mapViewRef.current;
    view?.map?.remove?.(layer);
    if (layer === clusterLayerRef.current) clusterLayerRef.current = null;
  }, []);

  const cancelOutstandingWork = useCallback((): void => {
    searchAbortRef.current?.abort();
    detailAbortRef.current?.abort();
    searchAbortRef.current = null;
    detailAbortRef.current = null;
    queryGateRef.current.invalidate();
    clusterGateRef.current.invalidate();
  }, []);

  const resetWindowState = useCallback((): void => {
    cancelOutstandingWork();
    removeClusterLayer();
    commonToolsRef.current?.OnClose();
    setQuery(DEFAULT_FAST_ACCESS_QUERY);
    setNeighborhoods([]);
    setResults([]);
    setActiveView('form');
    setLoading(false);
    setError(null);
    setSelectedKey(null);
    setPage(1);
  }, [cancelOutstandingWork, removeClusterLayer]);

  useImperativeHandle(ref, () => ({
    id,
    visible: false,
    minimized: false,
    OnShow: () => {
      focusLifecycle()?.open({
        root: rootRef.current,
        initialFocusSelector: 'input, select, button',
        restorePolicy: 'if-focus-within',
      });
    },
    OnClose: () => {
      resetWindowState();
      focusLifecycle()?.close();
    },
  }), [focusLifecycle, id, resetWindowState]);

  useEffect(() => {
    mountedRef.current = true;
    windowManager.RegisterWindow(ref);
    mapViewRef.current = asMapView(MapManager.GetMapView());

    const loadDistricts = async (): Promise<void> => {
      setLookupLoading(true);
      try {
        const response: unknown = await NumberingQueryBusiness.GetDistricts();
        if (!mountedRef.current) return;
        setDistricts(normalizeLookupOptions(response));
      } catch (loadError) {
        if (!mountedRef.current) return;
        setError(normalizeErrorMessage(loadError, 'İlçe listesi yüklenemedi.'));
      } finally {
        if (mountedRef.current) setLookupLoading(false);
      }
    };

    void loadDistricts();

    return () => {
      mountedRef.current = false;
      cancelOutstandingWork();
      removeClusterLayer();
      focusLifecycleRef.current?.dispose();
      focusLifecycleRef.current = null;
    };
  }, [cancelOutstandingWork, ref, removeClusterLayer, windowManager]);

  const setQueryField = useCallback((field: string, value: unknown): void => {
    setQuery((current) => updateFastAccessQuery(current, field, value));
  }, []);

  const loadNeighborhoods = useCallback(async (
    districtId: string,
  ): Promise<void> => {
    if (!districtId) {
      setNeighborhoods([]);
      return;
    }

    setLookupLoading(true);
    try {
      const response: unknown = await NumberingQueryBusiness.GetNeighborhoodsOfDistrict(
        districtId,
      );
      if (!mountedRef.current) return;
      setNeighborhoods(normalizeLookupOptions(response));
    } catch (loadError) {
      if (!mountedRef.current) return;
      setNeighborhoods([]);
      setError(normalizeErrorMessage(loadError, 'Mahalle listesi yüklenemedi.'));
    } finally {
      if (mountedRef.current) setLookupLoading(false);
    }
  }, []);

  const handleDistrictChange = (districtId: string): void => {
    const district = districts.find((item) => item.id === districtId);
    setQuery((current) => ({
      ...updateFastAccessQuery(current, 'districtId', districtId),
      districtName: district?.label ?? '',
      nbhoodId: '',
      nbhoodName: '',
    }));
    setNeighborhoods([]);
    void loadNeighborhoods(districtId);
  };

  const handleNeighborhoodChange = (nbhoodId: string): void => {
    const neighborhood = neighborhoods.find((item) => item.id === nbhoodId);
    setQuery((current) => ({
      ...updateFastAccessQuery(current, 'nbhoodId', nbhoodId),
      nbhoodName: neighborhood?.label ?? '',
    }));
  };

  const createCluster = useCallback(async (
    requestId: number,
    activeQuery: FastAccessFilterState,
  ): Promise<void> => {
    const symbol = {
      type: 'picture-marker',
      url: windowLogo,
      width: '48px',
      height: '48px',
    };
    const clusterCandidate: unknown = await CommonBusiness.Clustering.CreateClusterLayer(
      queryServiceTitle,
      windowTitle,
      toBusinessQuery(activeQuery),
      symbol,
    );
    const layerObj = asClusterLayer(clusterCandidate)?.layerObj;
    if (!layerObj) return;

    if (
      !mountedRef.current
      || !clusterGateRef.current.isCurrent(requestId)
    ) {
      mapViewRef.current?.map?.remove?.(layerObj);
      return;
    }

    removeClusterLayer();
    clusterLayerRef.current = layerObj;
    mapViewRef.current?.map?.add?.(layerObj);
  }, [queryServiceTitle, removeClusterLayer, windowLogo, windowTitle]);

  const runQuery = useCallback(async (
    event?: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event?.preventDefault();
    searchAbortRef.current?.abort();
    const abortController = new AbortController();
    searchAbortRef.current = abortController;
    const requestId = queryGateRef.current.next();
    const clusterRequestId = clusterGateRef.current.next();
    const submittedQuery = query;

    setLoading(true);
    setError(null);
    setSelectedKey(null);
    setPage(1);

    void safeClientLog(
      LoggingBusiness,
      `Hızlı Erişim/Sorgu/${windowTitle}`,
      createQueryLogDescription(submittedQuery),
    );

    try {
      const response = await FastAccessQueryBusiness.QueryFastAccessService(
        queryServiceTitle,
        toBusinessQuery(submittedQuery),
        false,
        { signal: abortController.signal },
      );
      if (!mountedRef.current || !queryGateRef.current.isCurrent(requestId)) return;

      const envelope = normalizeFastAccessEnvelope(response);
      if (envelope.type !== 10) {
        throw new Error(envelope.message ?? 'Sorgu servisi geçerli bir sonuç döndürmedi.');
      }

      const normalizedResults = normalizeFastAccessResults(response);
      setResults(normalizedResults);
      setActiveView('results');

      void createCluster(clusterRequestId, submittedQuery).catch((clusterError: unknown) => {
        if (!mountedRef.current || !clusterGateRef.current.isCurrent(clusterRequestId)) {
          return;
        }
        setError(normalizeErrorMessage(
          clusterError,
          'Sonuçlar listelendi ancak harita katmanı oluşturulamadı.',
        ));
      });
    } catch (queryError) {
      if (abortController.signal.aborted) return;
      if (!mountedRef.current || !queryGateRef.current.isCurrent(requestId)) return;
      const message = normalizeErrorMessage(queryError);
      setError(message);
      windowManager.ShowMessage(Constants_MessageType.Error, message);
    } finally {
      if (mountedRef.current && queryGateRef.current.isCurrent(requestId)) {
        setLoading(false);
      }
    }
  }, [
    createCluster,
    query,
    queryServiceTitle,
    windowManager,
    windowTitle,
  ]);

  const loadDetail = useCallback(async (
    item: FastAccessResultItem,
  ): Promise<ReturnType<typeof normalizeFastAccessDetail>> => {
    detailAbortRef.current?.abort();
    const abortController = new AbortController();
    detailAbortRef.current = abortController;

    const response = await FastAccessQueryBusiness.QueryFastAccessService(
      queryServiceTitle,
      { ObjectId: item.objectId },
      true,
      { signal: abortController.signal },
    );
    if (abortController.signal.aborted) return null;
    return normalizeFastAccessDetail(response);
  }, [queryServiceTitle]);

  const showItemOnMap = useCallback(async (
    item: FastAccessResultItem,
  ): Promise<void> => {
    setSelectedKey(fastAccessResultKey(item));
    setError(null);

    void safeClientLog(
      LoggingBusiness,
      `Hızlı Erişim/Detay Göster/${windowTitle}`,
      `${String(item.objectId)}/${item.title}`,
    );

    try {
      const detail = await loadDetail(item);
      if (!detail?.geometry) throw new Error('Kayıt geometrisi bulunamadı.');
      await Promise.resolve(
        GisGraphicsHelper.ZoomToGeometry(MapManager.GetMapView(), detail.geometry, 18),
      );
      if (
        typeof window !== 'undefined'
        && window.matchMedia?.('(max-width: 959px)').matches
      ) {
        windowManager.ToggleMinimiseWindow(id);
      }
    } catch (detailError) {
      if (detailAbortRef.current?.signal.aborted) return;
      const message = normalizeErrorMessage(
        detailError,
        'Kayıt haritada gösterilemedi.',
      );
      setError(message);
      windowManager.ShowMessage(Constants_MessageType.Error, message);
    }
  }, [id, loadDetail, windowManager, windowTitle]);

  const showRoute = useCallback(async (
    item: FastAccessResultItem,
  ): Promise<void> => {
    setSelectedKey(fastAccessResultKey(item));
    setError(null);
    try {
      const detail = await loadDetail(item);
      const url = buildGoogleDirectionsUrl(
        detail?.geometry as Parameters<typeof buildGoogleDirectionsUrl>[0],
      );
      if (!url || !openExternalSafely(url)) {
        throw new Error('Yol tarifi açılamadı.');
      }
      void safeClientLog(
        LoggingBusiness,
        `Hızlı Erişim/Yol Tarifi/${windowTitle}`,
        `${String(item.objectId)}/${item.title}`,
      );
    } catch (routeError) {
      if (detailAbortRef.current?.signal.aborted) return;
      const message = normalizeErrorMessage(
        routeError,
        'Yol tarifi alınamadı - öğe detayları bulunamadı.',
      );
      setError(message);
      windowManager.ShowMessage(Constants_MessageType.Error, message);
    }
  }, [loadDetail, windowManager, windowTitle]);

  const returnToForm = (): void => {
    detailAbortRef.current?.abort();
    removeClusterLayer();
    setActiveView('form');
    setSelectedKey(null);
    setError(null);
  };

  const pageData = useMemo(
    () => paginateFastAccessResults(results, page, 20),
    [page, results],
  );

  useEffect(() => {
    if (page !== pageData.page) setPage(pageData.page);
  }, [page, pageData.page]);

  const columns = useMemo<readonly ExperienceDataColumn<FastAccessResultItem>[]>(() => [
    {
      id: 'title',
      header: 'Ad',
      cell: (item) => (
        <div className="fast-access-result-primary">
          <strong>{item.title}</strong>
          {item.phone ? <span>{item.phone}</span> : null}
        </div>
      ),
    },
    {
      id: 'address',
      header: 'Adres',
      cell: (item) => (
        <span className="fast-access-result-address">{item.address}</span>
      ),
    },
    {
      id: 'actions',
      header: 'İşlemler',
      align: 'end',
      width: '7rem',
      cell: (item) => (
        <CommonQueryResultItemTools
          item={item}
          zoomCallback={() => void showItemOnMap(item)}
          showRouteCallback={() => void showRoute(item)}
        />
      ),
    },
  ], [showItemOnMap, showRoute]);

  const visible = windowManager.IsVisible(id);
  const minimized = windowManager.IsMinimized(id);
  const statusMessage = error
    ?? (loading
      ? 'Sorgu çalıştırılıyor…'
      : activeView === 'results'
        ? `${results.length.toLocaleString('tr-TR')} sonuç bulundu.`
        : 'Arama ölçütlerini girip sorguyu çalıştırın.');

  return (
    <section
      ref={rootRef}
      className="common-query-window fast-access-query-window"
      hidden={!visible}
      aria-labelledby={`${id}-title`}
      aria-busy={loading || lookupLoading || undefined}
    >
      <div className="common-query-window-header">
        <img
          className="common-query-window-header-icon"
          src={windowLogo}
          alt=""
          aria-hidden="true"
        />
        <span id={`${id}-title`}>{windowTitle}</span>
        <CommonQueryWindowTools
          ref={commonToolsRef}
          windowManager={windowManager}
          windowId={id}
          setQueryField={setQueryField}
          showNearbySearch={activeView === 'form'}
          showMapSelect={activeView === 'form'}
          query={query}
        />
      </div>

      <div
        className={[
          'common-query-window-body',
          'fast-access-query-window__body',
          minimized ? 'common-query-window-body-collapsed' : '',
        ].filter(Boolean).join(' ')}
      >
        <ExperienceQuerySurface
          title={activeView === 'form' ? 'Arama ölçütleri' : 'Sorgu sonuçları'}
          description={activeView === 'form'
            ? 'Ad, ilçe ve mahalleye göre arayın; isterseniz konum veya harita seçimini kullanın.'
            : 'Bir kaydı Enter ile veya çift tıklayarak haritada açabilirsiniz.'}
          busy={loading || lookupLoading}
          status={(
            <ExperienceStatus
              tone={errorTone(error, loading || lookupLoading, results.length)}
              live={error ? 'assertive' : 'polite'}
              busy={loading || lookupLoading}
            >
              {statusMessage}
            </ExperienceStatus>
          )}
          footer={activeView === 'results' ? (
            <ExperiencePagination
              page={pageData.page}
              pageCount={pageData.pageCount}
              onPageChange={setPage}
              label="Sorgu sonucu sayfaları"
              disabled={loading}
            />
          ) : undefined}
        >
          {activeView === 'form' ? (
            <form className="fast-access-query-form" onSubmit={(event) => void runQuery(event)}>
              {!query.showMapSelect ? (
                <ExperienceInput
                  id={`${id}-name`}
                  label="Adı"
                  value={query.name}
                  maxLength={160}
                  autoComplete="off"
                  onChange={(event) => setQueryField('name', event.target.value)}
                  hint="İsim içinde geçen kelimelerle arama yapabilirsiniz."
                />
              ) : null}

              {!query.showNearby && !query.showMapSelect ? (
                <div className="fast-access-query-form__grid">
                  <ExperienceSelect
                    id={`${id}-district`}
                    label="İlçe"
                    value={query.districtId}
                    disabled={lookupLoading}
                    onChange={(event) => handleDistrictChange(event.target.value)}
                  >
                    <option value="">Tüm ilçeler</option>
                    {districts.map((item) => (
                      <option key={item.id} value={item.id}>{item.label}</option>
                    ))}
                  </ExperienceSelect>
                  <ExperienceSelect
                    id={`${id}-neighborhood`}
                    label="Mahalle"
                    value={query.nbhoodId}
                    disabled={lookupLoading || !query.districtId}
                    onChange={(event) => handleNeighborhoodChange(event.target.value)}
                  >
                    <option value="">Tüm mahalleler</option>
                    {neighborhoods.map((item) => (
                      <option key={item.id} value={item.id}>{item.label}</option>
                    ))}
                  </ExperienceSelect>
                </div>
              ) : null}

              {!query.showMapSelect ? (
                <button
                  type="submit"
                  className="experience-query-action fast-access-query-submit"
                  disabled={loading || lookupLoading}
                >
                  <BiSearch aria-hidden="true" />
                  <span>{loading ? 'Sorgulanıyor…' : 'Sorgula'}</span>
                </button>
              ) : (
                <p className="fast-access-query-map-hint" role="status">
                  Haritada bir öğe seçerek sorguyu tamamlayın.
                </p>
              )}
            </form>
          ) : (
            <div className="fast-access-results">
              <div className="fast-access-results__toolbar">
                <button
                  type="button"
                  className="experience-query-action"
                  data-variant="secondary"
                  onClick={returnToForm}
                >
                  Arama ölçütlerine dön
                </button>
                <span className="fast-access-results__count">
                  {pageData.totalCount.toLocaleString('tr-TR')} kayıt
                  {pageData.totalCount > 0
                    ? ` · ${pageData.startIndex + 1}–${pageData.endIndex} gösteriliyor`
                    : ''}
                </span>
              </div>
              <ExperienceDataTable
                caption={`${windowTitle} sorgu sonuçları`}
                rows={pageData.items}
                columns={columns}
                getRowKey={(item) => fastAccessResultKey(item)}
                selectedRowKey={selectedKey}
                getRowLabel={(item) => fastAccessResultLabel(item)}
                onRowActivate={(item) => void showItemOnMap(item)}
                busy={loading}
                busyLabel="Sorgu sonuçları yükleniyor"
                emptyTitle="Sonuç bulunamadı"
                emptyDescription="Arama ölçütlerini değiştirip tekrar deneyin."
              />
            </div>
          )}
        </ExperienceQuerySurface>
      </div>
    </section>
  );
});

FastAccessQueryWindow.displayName = 'FastAccessQueryWindow';
