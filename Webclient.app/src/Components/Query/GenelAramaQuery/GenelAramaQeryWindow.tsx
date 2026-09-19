import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { FiMapPin, FiPhone } from 'react-icons/fi';
import { HiOutlineArrowNarrowLeft } from 'react-icons/hi';
import { GenelAramaQeryBusiness } from '../../../Business/GenelAramaQeryBusiness';
import { LoggingBusiness } from '../../../Business/LoggingBusiness';
import {
  Constants_MessageType,
  Constants_ServiceResultType,
} from '../../../Core/Constants';
import MapManager from '../../../Store/Managers/MapManager';
import { GisGraphicsHelper } from '../../../Toolbox/GisGraphicsHelper';
import { ButtonLoading, NoResultsFound } from '../../Common/Loading';
import { CommonQueryResultItemTools } from '../_Common/CommonQueryResultItemTools';
import {
  buildGoogleDirectionsUrl,
  createLatestRequestGate,
  isSmallViewport,
  normalizeErrorMessage,
  openExternalSafely,
  safeClientLog,
  type GeometryLike,
} from '../_Common/QueryInteractionRuntime';
import {
  normalizeSearchCollection,
  type NormalizedSearchRecord,
  type SearchRecordInput,
} from '../_Common/QuerySearchRuntime';
import type {
  ManagedQueryWindowHandle,
  ManagedQueryWindowManager,
  normalizeQueryIdentifier,
  UnknownRecord,
} from '../_Common/QuerySurfaceContracts';
import './GenelAramaQeryWindow.css';

const WINDOW_TITLE = 'ARAMA SONUÇLARI';
const WINDOW_LOGO = 'images/search.svg';

interface GenelAramaQueryState extends UnknownRecord {
  readonly name?: string;
  readonly searchText?: string;
}

interface GenelAramaQeryWindowProps {
  readonly id: string;
  readonly windowManager: ManagedQueryWindowManager;
}

interface SearchDetailRecord extends SearchRecordInput {
  readonly geometry?: GeometryLike | null;
}

interface ServiceResult {
  readonly type?: unknown;
  readonly data?: readonly unknown[] | null;
  readonly message?: unknown;
}

const EMPTY_QUERY: GenelAramaQueryState = Object.freeze({ name: '' });

const createEmptyQuery = (): GenelAramaQueryState => ({ ...EMPTY_QUERY });

const isServiceResult = (value: unknown): value is ServiceResult =>
  value !== null && typeof value === 'object';

const asDetailRecord = (value: unknown): SearchDetailRecord | null =>
  value !== null && typeof value === 'object'
    ? value as SearchDetailRecord
    : null;

export const GenelAramaQeryWindow = forwardRef<
  ManagedQueryWindowHandle,
  GenelAramaQeryWindowProps
>(({ id, windowManager }, ref): ReactNode => {
  const queryGateRef = useRef(createLatestRequestGate());
  const detailGateRef = useRef(createLatestRequestGate());
  const mountedRef = useRef(true);

  const [query, setQuery] = useState<GenelAramaQueryState>(createEmptyQuery);
  const [loading, setLoading] = useState(false);
  const [resultList, setResultList] = useState<
    readonly NormalizedSearchRecord[] | null
  >(null);
  const [detailLoadingKey, setDetailLoadingKey] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState('');

  const visible = windowManager.IsVisible(id);
  const minimized = windowManager.IsMinimized(id);

  const resetWindow = useCallback((): void => {
    queryGateRef.current.invalidate();
    detailGateRef.current.invalidate();
    setQuery(createEmptyQuery());
    setResultList(null);
    setLoading(false);
    setDetailLoadingKey(null);
    setErrorMessage('');
  }, []);

  const fetchQueryResults = useCallback(async (): Promise<void> => {
    const requestId = queryGateRef.current.next();
    const searchQuery = (windowManager.GetQueryParams(id) ?? query) as GenelAramaQueryState;

    setQuery(searchQuery);
    setLoading(true);
    setErrorMessage('');
    setResultList(null);
    setDetailLoadingKey(null);
    void safeClientLog(LoggingBusiness, 'Genel Arama/Sorgu', searchQuery);

    try {
      const result: unknown = await GenelAramaQeryBusiness.Query(searchQuery, false);
      if (!mountedRef.current || !queryGateRef.current.isCurrent(requestId)) return;

      if (!isServiceResult(result) || result.type !== Constants_ServiceResultType.Success) {
        const message = isServiceResult(result) && typeof result.message === 'string'
          ? result.message
          : 'Arama sonuçları alınamadı. Lütfen tekrar deneyin.';
        throw new Error(message);
      }

      setResultList(normalizeSearchCollection(result.data ?? []));
    } catch (error) {
      if (!mountedRef.current || !queryGateRef.current.isCurrent(requestId)) return;
      const message = normalizeErrorMessage(
        error,
        'Arama sırasında beklenmeyen bir hata oluştu.',
      );
      setResultList([]);
      setErrorMessage(message);
      windowManager.ShowMessage(Constants_MessageType.Error, message);
    } finally {
      if (mountedRef.current && queryGateRef.current.isCurrent(requestId)) {
        setLoading(false);
      }
    }
  }, [id, query, windowManager]);

  useImperativeHandle(ref, () => ({
    id,
    visible,
    minimized,
    OnShow: fetchQueryResults,
    OnClose: resetWindow,
  }), [fetchQueryResults, id, minimized, resetWindow, visible]);

  useEffect(() => {
    mountedRef.current = true;
    windowManager.RegisterWindow(ref);
    const queryGate = queryGateRef.current;
    const detailGate = detailGateRef.current;

    return () => {
      mountedRef.current = false;
      queryGate.invalidate();
      detailGate.invalidate();
      windowManager.UnregisterWindow?.(id, ref);
    };
  }, [id, ref, windowManager]);

  const getItemDetails = useCallback(async (
    item: NormalizedSearchRecord,
  ): Promise<SearchDetailRecord | null> => {
    const objectId = normalizeQueryIdentifier(item.id);
    if (objectId === null) {
      throw new Error('Kayıt kimliği bulunamadı.');
    }

    const requestId = detailGateRef.current.next();
    const result: unknown = await GenelAramaQeryBusiness.Query(
      { ObjectId: objectId },
      true,
    );

    if (!mountedRef.current || !detailGateRef.current.isCurrent(requestId)) {
      return null;
    }

    if (
      !isServiceResult(result)
      || result.type !== Constants_ServiceResultType.Success
      || !Array.isArray(result.data)
      || !result.data[0]
    ) {
      const message = isServiceResult(result) && typeof result.message === 'string'
        ? result.message
        : 'Kayıt ayrıntıları bulunamadı.';
      throw new Error(message);
    }

    return asDetailRecord(result.data[0]);
  }, []);

  const showItemOnMap = useCallback(async (
    item: NormalizedSearchRecord | null,
  ): Promise<void> => {
    if (!item) return;

    setDetailLoadingKey(item.key);
    setErrorMessage('');
    void safeClientLog(
      LoggingBusiness,
      'Genel Arama/Detay Göster',
      `${item.id ?? ''}/${item.address || item.title}`,
    );

    try {
      const itemDetails = await getItemDetails(item);
      if (!itemDetails?.geometry) return;

      const mapView = MapManager.GetMapView();
      if (!mapView) throw new Error('Harita görünümü hazır değil.');

      GisGraphicsHelper.ZoomToGeometry(mapView, itemDetails.geometry, 18);
      if (isSmallViewport()) windowManager.ToggleMinimiseWindow(id);
    } catch (error) {
      const message = normalizeErrorMessage(error, 'Kayıt konumu gösterilemedi.');
      setErrorMessage(message);
      windowManager.ShowMessage(Constants_MessageType.Error, message);
    } finally {
      if (mountedRef.current) setDetailLoadingKey(null);
    }
  }, [getItemDetails, id, windowManager]);

  const showRoute = useCallback(async (
    event: MouseEvent<HTMLElement>,
    item: NormalizedSearchRecord,
  ): Promise<void> => {
    event.preventDefault();
    event.stopPropagation();

    setDetailLoadingKey(item.key);
    setErrorMessage('');
    void safeClientLog(
      LoggingBusiness,
      'Genel Arama/Yol Tarifi',
      `${item.id ?? ''}/${item.title}`,
    );

    try {
      const itemDetails = await getItemDetails(item);
      if (!itemDetails?.geometry) return;

      const url = buildGoogleDirectionsUrl(itemDetails.geometry);
      if (!url) throw new Error('Yol tarifi için konum bilgisi bulunamadı.');
      if (!openExternalSafely(url)) {
        throw new Error('Tarayıcı yol tarifi penceresini açmayı engelledi.');
      }
    } catch (error) {
      const message = normalizeErrorMessage(error, 'Yol tarifi alınamadı.');
      setErrorMessage(message);
      windowManager.ShowMessage(Constants_MessageType.Error, message);
    } finally {
      if (mountedRef.current) setDetailLoadingKey(null);
    }
  }, [getItemDetails, windowManager]);

  const backToSidebar = useCallback((): void => {
    queryGateRef.current.invalidate();
    detailGateRef.current.invalidate();
    setDetailLoadingKey(null);
    setErrorMessage('');
    windowManager.ShowWindow('sidebar');
  }, [windowManager]);

  const resultContent: ReactNode = loading ? (
    <div
      className="experience-search-state genel-arama-state"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <ButtonLoading message="Aranıyor…" />
      <div className="experience-search-state__hint">Sonuçlar getiriliyor.</div>
    </div>
  ) : errorMessage && resultList === null ? (
    <div
      className="kr-status-banner kr-status-banner--danger genel-arama-error"
      role="alert"
    >
      <div>
        <strong>Arama tamamlanamadı.</strong>
        <div>{errorMessage}</div>
        <button
          className="kr-btn kr-btn--secondary"
          type="button"
          onClick={() => {
            void fetchQueryResults();
          }}
        >
          Tekrar dene
        </button>
      </div>
    </div>
  ) : resultList?.length === 0 ? (
    <NoResultsFound message="Bu arama için kayıt bulunamadı. Daha genel bir ifade deneyin." />
  ) : resultList?.map((item) => {
    const busy = detailLoadingKey === item.key;
    return (
      <article
        className="result-item-container genel-arama-result"
        key={item.key}
        aria-busy={busy}
      >
        <button
          type="button"
          className="result-item-info"
          onClick={() => {
            void showItemOnMap(item);
          }}
          aria-label={`${item.title} kaydını haritada göster`}
          disabled={busy}
        >
          <span className="result-item-info-title">{item.title}</span>
          {item.category && item.category !== 'Diğer' ? (
            <span className="genel-arama-result-category">{item.category}</span>
          ) : null}
          {item.address ? (
            <span className="result-item-info-address">
              <FiMapPin aria-hidden="true" />&nbsp;{item.address}
            </span>
          ) : null}
          {item.phone ? (
            <span className="result-item-info-phone">
              <FiPhone aria-hidden="true" />&nbsp;{item.phone}
            </span>
          ) : null}
          {busy ? (
            <span className="genel-arama-result-status">İşlem sürüyor…</span>
          ) : null}
        </button>
        <CommonQueryResultItemTools
          item={item}
          zoomCallback={() => {
            void showItemOnMap(item);
          }}
          showRouteCallback={(event) => {
            void showRoute(event, item);
          }}
        />
      </article>
    );
  }) ?? null;

  const queryLabel = String(query.name || query.searchText || '').trim();

  return (
    <section
      className="sidebar-container genel-arama-window"
      aria-label="Genel arama sonuçları"
      style={{ visibility: visible ? 'visible' : 'hidden' }}
    >
      <header className="common-query-window-header">
        <img
          className="common-query-window-header-icon"
          src={WINDOW_LOGO}
          alt=""
          aria-hidden="true"
        />
        <span>{WINDOW_TITLE}</span>
      </header>

      <div
        className={`results-container genel-arama-results ${minimized ? 'common-query-window-body-collapsed' : ''}`}
        aria-live="polite"
        aria-busy={loading}
      >
        <div className="results-container-toolbar genel-arama-toolbar">
          <button
            className="results-container-back-button"
            type="button"
            onClick={backToSidebar}
          >
            <HiOutlineArrowNarrowLeft
              className="results-container-back-button-icon"
              aria-hidden="true"
            />
            <span>Geri Dön</span>
          </button>
          <div className="results-container-count">
            <strong>{resultList?.length ?? 0}</strong> adet sonuç bulundu
          </div>
        </div>

        {queryLabel ? (
          <div className="genel-arama-query-summary" role="status">
            <span>Aranan ifade</span>
            <strong>{queryLabel}</strong>
          </div>
        ) : null}

        {errorMessage && resultList !== null ? (
          <div
            className="kr-status-banner kr-status-banner--danger genel-arama-inline-error"
            role="alert"
          >
            {errorMessage}
          </div>
        ) : null}

        <div className="genel-arama-result-list">
          {resultContent}
        </div>
      </div>
    </section>
  );
});

GenelAramaQeryWindow.displayName = 'GenelAramaQeryWindow';
