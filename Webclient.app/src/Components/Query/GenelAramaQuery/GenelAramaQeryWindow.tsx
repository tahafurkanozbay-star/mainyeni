import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { FiFilter, FiMapPin, FiPhone, FiSearch, FiX } from 'react-icons/fi';
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
import { normalizeQueryIdentifier } from '../_Common/QuerySurfaceContracts';
import type {
  ManagedQueryWindowHandle,
  ManagedQueryWindowManager,
  UnknownRecord,
} from '../_Common/QuerySurfaceContracts';
import {
  GENERAL_SEARCH_SORT_LABELS_V10,
  GENERAL_SEARCH_SORT_MODES_V10,
  type GeneralSearchFacetModelV10,
  type GeneralSearchHighlightSegmentV10,
  type GeneralSearchPresentedRecordV10,
  type GeneralSearchWindowSnapshotV10,
} from './GenelAramaWindowContractsV10';
import {
  createGenelAramaWindowRuntimeV10,
  type GenelAramaWindowRuntimeV10,
} from './GenelAramaWindowRuntimeV10';
import { keyboardDecisionForGeneralSearchV10 } from './GenelAramaWindowPresentationV10';
import './GenelAramaQeryWindow.css';

const WINDOW_TITLE = 'ARAMA SONUÇLARI';
const WINDOW_LOGO = 'images/search.svg';
const RESULT_LIST_ID = 'genel-arama-governed-results';

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

const renderHighlightSegments = (
  segments: readonly GeneralSearchHighlightSegmentV10[],
  fallback: string,
): ReactNode => {
  if (segments.length === 0) return fallback;
  return segments.map((segment, index) => segment.matched ? (
    <mark className="genel-arama-highlight" key={`${index}:${segment.text}`}>
      {segment.text}
    </mark>
  ) : (
    <span key={`${index}:${segment.text}`}>{segment.text}</span>
  ));
};

const resultDomId = (windowId: string, item: GeneralSearchPresentedRecordV10): string =>
  `${windowId}-general-search-result-${item.sourceIndex}`;

const facetSelectionCount = (snapshot: GeneralSearchWindowSnapshotV10): number =>
  snapshot.selectedCategories.length + snapshot.selectedTypes.length;

const FacetSection = ({
  facet,
  onToggle,
}: {
  readonly facet: GeneralSearchFacetModelV10;
  readonly onToggle: (value: string) => void;
}): ReactNode => {
  if (facet.buckets.length === 0) return null;
  return (
    <fieldset className="genel-arama-facet">
      <legend>{facet.label}</legend>
      <div className="genel-arama-facet__buckets">
        {facet.buckets.map(bucket => (
          <button
            type="button"
            className={`genel-arama-facet-chip${bucket.selected ? ' is-selected' : ''}`}
            key={`${facet.kind}:${bucket.normalizedValue}`}
            aria-pressed={bucket.selected}
            disabled={bucket.disabled}
            onClick={() => onToggle(bucket.value)}
          >
            <span>{bucket.value}</span>
            <span className="genel-arama-facet-chip__count" aria-hidden="true">{bucket.count}</span>
          </button>
        ))}
      </div>
      {facet.truncated ? (
        <div className="genel-arama-facet__hint">
          En sık kullanılan {facet.buckets.length} seçenek gösteriliyor.
        </div>
      ) : null}
    </fieldset>
  );
};

export const GenelAramaQeryWindow = forwardRef<
  ManagedQueryWindowHandle,
  GenelAramaQeryWindowProps
>(({ id, windowManager }, ref): ReactNode => {
  const queryGateRef = useRef(createLatestRequestGate());
  const detailGateRef = useRef(createLatestRequestGate());
  const mountedRef = useRef(true);
  const runtimeRef = useRef<GenelAramaWindowRuntimeV10 | null>(null);
  if (runtimeRef.current === null) {
    runtimeRef.current = createGenelAramaWindowRuntimeV10([], {
      maxRecords: 50_000,
      maxFacetBuckets: 12,
      maxSelectedFacets: 10,
      renderWindowSize: 32,
      renderOverscan: 6,
      keyboardPageSize: 8,
    });
  }
  const runtime = runtimeRef.current;

  const [query, setQuery] = useState<GenelAramaQueryState>(createEmptyQuery);
  const [loading, setLoading] = useState(false);
  const [resultList, setResultList] = useState<readonly NormalizedSearchRecord[] | null>(null);
  const [presentation, setPresentation] = useState<GeneralSearchWindowSnapshotV10>(
    () => runtime.snapshot(),
  );
  const [detailLoadingKey, setDetailLoadingKey] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState('');

  const visible = windowManager.IsVisible(id);
  const minimized = windowManager.IsMinimized(id);

  const applyPresentation = useCallback((
    snapshot: GeneralSearchWindowSnapshotV10,
  ): void => {
    if (mountedRef.current) setPresentation(snapshot);
  }, []);

  const resetWindow = useCallback((): void => {
    queryGateRef.current.invalidate();
    detailGateRef.current.invalidate();
    setQuery(createEmptyQuery());
    setResultList(null);
    setLoading(false);
    setDetailLoadingKey(null);
    setErrorMessage('');
    applyPresentation(runtime.replaceRecords([]));
  }, [applyPresentation, runtime]);

  const fetchQueryResults = useCallback(async (): Promise<void> => {
    const requestId = queryGateRef.current.next();
    const searchQuery = (windowManager.GetQueryParams(id) ?? query) as GenelAramaQueryState;

    setQuery(searchQuery);
    setLoading(true);
    setErrorMessage('');
    setResultList(null);
    setDetailLoadingKey(null);
    applyPresentation(runtime.replaceRecords([]));
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

      const normalized = normalizeSearchCollection(result.data ?? []);
      setResultList(normalized);
      applyPresentation(runtime.replaceRecords(normalized));
    } catch (error) {
      if (!mountedRef.current || !queryGateRef.current.isCurrent(requestId)) return;
      const message = normalizeErrorMessage(
        error,
        'Arama sırasında beklenmeyen bir hata oluştu.',
      );
      setResultList([]);
      applyPresentation(runtime.replaceRecords([]));
      setErrorMessage(message);
      windowManager.ShowMessage(Constants_MessageType.Error, message);
    } finally {
      if (mountedRef.current && queryGateRef.current.isCurrent(requestId)) {
        setLoading(false);
      }
    }
  }, [applyPresentation, id, query, runtime, windowManager]);

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

  const clearLocalFilters = useCallback((): void => {
    applyPresentation(runtime.clearFilters());
  }, [applyPresentation, runtime]);

  const handleResultsKeyDown = useCallback((
    event: KeyboardEvent<HTMLDivElement>,
  ): void => {
    const decision = keyboardDecisionForGeneralSearchV10(event.key);
    if (!decision.handled || decision.command === null) return;
    if (decision.preventDefault) event.preventDefault();
    if (decision.command === 'activate') {
      void showItemOnMap(runtime.activeRecord());
      return;
    }
    if (decision.command === 'clear') {
      if (presentation.hasFilters) clearLocalFilters();
      return;
    }
    applyPresentation(runtime.moveActive(decision.command));
  }, [applyPresentation, clearLocalFilters, presentation.hasFilters, runtime, showItemOnMap]);

  const renderResult = useCallback((item: GeneralSearchPresentedRecordV10): ReactNode => {
    const record = item.record;
    const busy = detailLoadingKey === record.key;
    return (
      <article
        id={resultDomId(id, item)}
        className={`result-item-container genel-arama-result${item.active ? ' is-active' : ''}`}
        key={item.identity}
        role="listitem"
        aria-current={item.active ? 'true' : undefined}
        aria-busy={busy}
        onMouseEnter={() => {
          applyPresentation(runtime.setActiveIdentity(item.identity));
        }}
      >
        <button
          type="button"
          className="result-item-info"
          onFocus={() => {
            applyPresentation(runtime.setActiveIdentity(item.identity));
          }}
          onClick={() => {
            applyPresentation(runtime.setActiveIdentity(item.identity));
            void showItemOnMap(record);
          }}
          aria-label={`${record.title} kaydını haritada göster`}
          disabled={busy}
          tabIndex={item.active ? 0 : -1}
        >
          <span className="result-item-info-title">
            {renderHighlightSegments(item.titleSegments, record.title)}
          </span>
          {record.category && record.category !== 'Diğer' ? (
            <span className="genel-arama-result-category">{record.category}</span>
          ) : null}
          {record.address ? (
            <span className="result-item-info-address">
              <FiMapPin aria-hidden="true" />
              <span>{renderHighlightSegments(item.addressSegments, record.address)}</span>
            </span>
          ) : null}
          {record.phone ? (
            <span className="result-item-info-phone">
              <FiPhone aria-hidden="true" />
              <span>{record.phone}</span>
            </span>
          ) : null}
          {busy ? (
            <span className="genel-arama-result-status">İşlem sürüyor…</span>
          ) : null}
        </button>
        <CommonQueryResultItemTools
          item={record}
          zoomCallback={() => {
            applyPresentation(runtime.setActiveIdentity(item.identity));
            void showItemOnMap(record);
          }}
          showRouteCallback={(event) => {
            applyPresentation(runtime.setActiveIdentity(item.identity));
            void showRoute(event, record);
          }}
        />
      </article>
    );
  }, [applyPresentation, detailLoadingKey, id, runtime, showItemOnMap, showRoute]);

  const queryLabel = String(query.name || query.searchText || '').trim();
  const activeDomId = presentation.visibleItems.find(item => item.active);
  const selectedFacetTotal = facetSelectionCount(presentation);

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
  ) : presentation.totalCount === 0 ? (
    <NoResultsFound message="Bu arama için kayıt bulunamadı. Daha genel bir ifade deneyin." />
  ) : presentation.matchedCount === 0 ? (
    <div className="genel-arama-local-empty" role="status">
      <strong>{presentation.guidance.title}</strong>
      <span>{presentation.guidance.detail}</span>
      <button className="kr-btn kr-btn--secondary" type="button" onClick={clearLocalFilters}>
        Filtreleri temizle
      </button>
    </div>
  ) : (
    <>
      <div
        id={RESULT_LIST_ID}
        className="genel-arama-result-collection"
        role="list"
        tabIndex={0}
        aria-label="Arama sonuçları. Ok tuşlarıyla sonuçlar arasında ilerleyin, Enter ile haritada gösterin."
        aria-activedescendant={activeDomId ? resultDomId(id, activeDomId) : undefined}
        onKeyDown={handleResultsKeyDown}
      >
        {presentation.visibleItems.map(renderResult)}
      </div>
      {(presentation.renderWindow.hasBefore || presentation.renderWindow.hasAfter) ? (
        <nav className="genel-arama-window-pager" aria-label="Görünen sonuç aralığı">
          <button
            type="button"
            className="kr-btn kr-btn--secondary"
            disabled={!presentation.renderWindow.hasBefore}
            onClick={() => applyPresentation(runtime.moveWindow('previous'))}
          >
            Önceki sonuçlar
          </button>
          <span>
            {presentation.renderWindow.startIndex + 1}-{presentation.renderWindow.endIndexExclusive}
            {' / '}{presentation.matchedCount}
          </span>
          <button
            type="button"
            className="kr-btn kr-btn--secondary"
            disabled={!presentation.renderWindow.hasAfter}
            onClick={() => applyPresentation(runtime.moveWindow('next'))}
          >
            Sonraki sonuçlar
          </button>
        </nav>
      ) : null}
    </>
  );

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
          <div className="results-container-count" aria-live="polite">
            <strong>{presentation.matchedCount}</strong>
            {presentation.matchedCount === presentation.totalCount
              ? ' sonuç'
              : ` / ${presentation.totalCount} sonuç`}
          </div>
        </div>

        {queryLabel ? (
          <div className="genel-arama-query-summary">
            <span>Aranan ifade</span>
            <strong>{queryLabel}</strong>
          </div>
        ) : null}

        {resultList && resultList.length > 0 ? (
          <section className="genel-arama-controls" aria-label="Sonuçları daralt ve sırala">
            <label className="genel-arama-refinement">
              <span className="genel-arama-control-label">Sonuç içinde ara</span>
              <span className="genel-arama-refinement__input-wrap">
                <FiSearch aria-hidden="true" />
                <input
                  type="search"
                  value={presentation.refinement}
                  placeholder="Ad, adres, kategori veya telefon"
                  autoComplete="off"
                  maxLength={runtime.policy().maxRefinementLength}
                  aria-controls={RESULT_LIST_ID}
                  onChange={(event) => {
                    applyPresentation(runtime.setRefinement(event.target.value));
                  }}
                />
                {presentation.refinement ? (
                  <button
                    type="button"
                    className="genel-arama-refinement__clear"
                    aria-label="Sonuç içi aramayı temizle"
                    onClick={() => applyPresentation(runtime.setRefinement(''))}
                  >
                    <FiX aria-hidden="true" />
                  </button>
                ) : null}
              </span>
            </label>

            <label className="genel-arama-sort">
              <span className="genel-arama-control-label">Sıralama</span>
              <select
                value={presentation.sortMode}
                onChange={(event) => {
                  applyPresentation(runtime.setSortMode(event.target.value));
                }}
              >
                {GENERAL_SEARCH_SORT_MODES_V10.map(mode => (
                  <option key={mode} value={mode}>{GENERAL_SEARCH_SORT_LABELS_V10[mode]}</option>
                ))}
              </select>
            </label>

            <div className="genel-arama-filter-summary">
              <FiFilter aria-hidden="true" />
              <span>
                {selectedFacetTotal > 0
                  ? `${selectedFacetTotal} facet filtresi etkin`
                  : 'Facet filtresi yok'}
              </span>
              {presentation.hasFilters ? (
                <button type="button" onClick={clearLocalFilters}>Tümünü temizle</button>
              ) : null}
            </div>

            <div className="genel-arama-facets">
              {presentation.facets.map(facet => (
                <FacetSection
                  key={facet.kind}
                  facet={facet}
                  onToggle={(value) => {
                    applyPresentation(runtime.toggleFacet(facet.kind, value));
                  }}
                />
              ))}
            </div>
          </section>
        ) : null}

        <div
          className={`genel-arama-guidance genel-arama-guidance--${presentation.guidance.tone}`}
          role="status"
        >
          <strong>{presentation.guidance.title}</strong>
          <span>{presentation.guidance.detail}</span>
        </div>

        <div className="sr-only" aria-live="polite" aria-atomic="true">
          {presentation.announcement}
        </div>

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
