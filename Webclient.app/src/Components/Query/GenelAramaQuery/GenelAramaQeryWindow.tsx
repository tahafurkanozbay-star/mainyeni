import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import {
  FiChevronDown,
  FiFilter,
  FiMapPin,
  FiPhone,
  FiSearch,
  FiSliders,
  FiX,
} from 'react-icons/fi';
import { HiOutlineArrowNarrowLeft } from 'react-icons/hi';
import { GenelAramaQeryBusiness } from '../../../Business/GenelAramaQeryBusiness';
import { LoggingBusiness } from '../../../Business/LoggingBusiness';
import {
  Constants_MessageType,
  Constants_ServiceResultType,
} from '../../../Core/Constants';
import MapManager from '../../../Store/Managers/MapManager';
import { GisGraphicsHelper } from '../../../Toolbox/GisGraphicsHelper';
import { ExperiencePagination } from '../../Common/ExperiencePagination';
import { SharedGISIcon } from '../../Common/SharedGISIcon';
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
  createGeneralSearchWorkspaceController,
  type GeneralSearchWorkspaceController,
} from './generalSearchWorkspaceController';
import {
  generalSearchResultDomId,
  generalSearchSortLabel,
  type GeneralSearchFacetBucket,
  type GeneralSearchSortMode,
  type GeneralSearchSuggestion,
} from './generalSearchWorkspaceModel';
import './GenelAramaQeryWindow.css';

const WINDOW_TITLE = 'GENEL ARAMA';
const WINDOW_LOGO = 'images/search.svg';
const RESULTS_LIST_ID = 'general-search-results-list';
const SEARCH_INPUT_ID = 'general-search-refine-input';
const CATEGORY_FILTER_ID = 'general-search-category-filter';
const TYPE_FILTER_ID = 'general-search-type-filter';

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

const recordIcon = (item: NormalizedSearchRecord) => ({
  ...(typeof item.id === 'string' || typeof item.id === 'number' ? { id: item.id } : {}),
  title: item.title,
  category: item.category,
  type: item.type,
});

const selectedFilterCount = (
  categories: readonly string[],
  types: readonly string[],
): number => categories.length + types.length;

const resultCountLabel = (matchedCount: number, totalCount: number): string => {
  if (matchedCount === totalCount) return `${totalCount} sonuç`;
  return `${matchedCount} / ${totalCount} sonuç`;
};

const FacetGroup = ({
  id,
  title,
  facets,
  onToggle,
}: Readonly<{
  id: string;
  title: string;
  facets: readonly GeneralSearchFacetBucket[];
  onToggle: (value: string) => void;
}>): ReactNode => {
  if (facets.length === 0) return null;
  return (
    <fieldset className="general-search-filter-group" id={id}>
      <legend>{title}</legend>
      <div className="general-search-filter-chips">
        {facets.map((facet) => (
          <button
            type="button"
            key={facet.normalizedValue}
            className={`general-search-filter-chip ${facet.selected ? 'is-selected' : ''}`}
            aria-pressed={facet.selected}
            onClick={() => onToggle(facet.value)}
          >
            <span className="general-search-filter-chip__label">{facet.value}</span>
            <span className="general-search-filter-chip__count">{facet.count}</span>
          </button>
        ))}
      </div>
    </fieldset>
  );
};

const SuggestionList = ({
  open,
  suggestions,
  activeIndex,
  onPick,
}: Readonly<{
  open: boolean;
  suggestions: readonly GeneralSearchSuggestion[];
  activeIndex: number;
  onPick: (suggestion: GeneralSearchSuggestion) => void;
}>): ReactNode => {
  if (!open || suggestions.length === 0) return null;
  return (
    <div
      className="general-search-suggestions"
      id="general-search-suggestions"
      role="listbox"
      aria-label="Arama önerileri"
    >
      {suggestions.map((suggestion, index) => (
        <button
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          id={`general-search-suggestion-option-${index}`}
          className={`general-search-suggestion ${index === activeIndex ? 'is-active' : ''}`}
          key={suggestion.id}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onPick(suggestion)}
        >
          <span className="general-search-suggestion__label">{suggestion.label}</span>
          <span className="general-search-suggestion__detail">{suggestion.detail}</span>
          <span className="general-search-suggestion__kind">
            {suggestion.kind === 'record'
              ? 'Sonuç'
              : suggestion.kind === 'category'
                ? 'Kategori'
                : 'Tür'}
          </span>
        </button>
      ))}
    </div>
  );
};

export const GenelAramaQeryWindow = forwardRef<
  ManagedQueryWindowHandle,
  GenelAramaQeryWindowProps
>(({ id, windowManager }, ref): ReactNode => {
  const queryGateRef = useRef(createLatestRequestGate());
  const detailGateRef = useRef(createLatestRequestGate());
  const mountedRef = useRef(true);
  const workspaceRef = useRef<GeneralSearchWorkspaceController | null>(null);
  if (!workspaceRef.current) {
    workspaceRef.current = createGeneralSearchWorkspaceController({
      pageSize: 24,
      maximumResults: 5_000,
      maximumFacets: 24,
      maximumSuggestions: 8,
      maximumListeners: 8,
    });
  }
  const workspace = workspaceRef.current;
  const workspaceState = useSyncExternalStore(
    workspace.subscribe,
    workspace.getSnapshot,
    workspace.getSnapshot,
  );
  const snapshot = workspaceState.workspace;

  const generatedId = useId().replace(/:/g, '');
  const inputId = `${SEARCH_INPUT_ID}-${generatedId}`;
  const listId = `${RESULTS_LIST_ID}-${generatedId}`;
  const filterPanelId = `general-search-filters-${generatedId}`;
  const suggestionsId = `general-search-suggestions-${generatedId}`;

  const [query, setQuery] = useState<GenelAramaQueryState>(createEmptyQuery);
  const [detailLoadingKey, setDetailLoadingKey] = useState<string | null>(null);
  const [inlineActionError, setInlineActionError] = useState('');

  const visible = windowManager.IsVisible(id);
  const minimized = windowManager.IsMinimized(id);

  const resetWindow = useCallback((): void => {
    queryGateRef.current.invalidate();
    detailGateRef.current.invalidate();
    setQuery(createEmptyQuery());
    setDetailLoadingKey(null);
    setInlineActionError('');
    workspace.reset();
  }, [workspace]);

  const fetchQueryResults = useCallback(async (): Promise<void> => {
    const requestId = queryGateRef.current.next();
    const searchQuery = (windowManager.GetQueryParams(id) ?? query) as GenelAramaQueryState;
    const serverLabel = String(searchQuery.name || searchQuery.searchText || '').trim();

    setQuery(searchQuery);
    setDetailLoadingKey(null);
    setInlineActionError('');
    workspace.reset();
    workspace.beginLoading();
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

      const records = normalizeSearchCollection(result.data ?? []);
      workspace.replaceRecords(records);
      void safeClientLog(
        LoggingBusiness,
        'Genel Arama/Sonuç Hazır',
        `${serverLabel}/${records.length}`,
      );
    } catch (error) {
      if (!mountedRef.current || !queryGateRef.current.isCurrent(requestId)) return;
      const message = normalizeErrorMessage(
        error,
        'Arama sırasında beklenmeyen bir hata oluştu.',
      );
      workspace.setError(message);
      windowManager.ShowMessage(Constants_MessageType.Error, message);
    }
  }, [id, query, windowManager, workspace]);

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
    const controller = workspace;

    return () => {
      mountedRef.current = false;
      queryGate.invalidate();
      detailGate.invalidate();
      controller.dispose();
      windowManager.UnregisterWindow?.(id, ref);
    };
  }, [id, ref, windowManager, workspace]);

  useEffect(() => {
    const activeId = workspace.activeRecordDomId();
    if (!activeId) return;
    const element = document.getElementById(activeId);
    if (!element || document.activeElement === element) return;
    if (!element.closest(':focus-within')) return;
    element.scrollIntoView?.({ block: 'nearest' });
  }, [snapshot.activeKey, workspace]);

  const getItemDetails = useCallback(async (
    item: NormalizedSearchRecord,
  ): Promise<SearchDetailRecord | null> => {
    const objectId = normalizeQueryIdentifier(item.id);
    if (objectId === null) throw new Error('Kayıt kimliği bulunamadı.');

    const requestId = detailGateRef.current.next();
    const result: unknown = await GenelAramaQeryBusiness.Query(
      { ObjectId: objectId },
      true,
    );

    if (!mountedRef.current || !detailGateRef.current.isCurrent(requestId)) return null;
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
    setInlineActionError('');
    void safeClientLog(
      LoggingBusiness,
      'Genel Arama/Detay Göster',
      `${item.id ?? ''}/${item.address || item.title}`,
    );

    try {
      const itemDetails = await getItemDetails(item);
      if (!itemDetails?.geometry) throw new Error('Kayıt için harita geometrisi bulunamadı.');
      const mapView = MapManager.GetMapView();
      if (!mapView) throw new Error('Harita görünümü hazır değil.');
      GisGraphicsHelper.ZoomToGeometry(mapView, itemDetails.geometry, 18);
      if (isSmallViewport()) windowManager.ToggleMinimiseWindow(id);
    } catch (error) {
      const message = normalizeErrorMessage(error, 'Kayıt konumu gösterilemedi.');
      setInlineActionError(message);
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
    setInlineActionError('');
    void safeClientLog(
      LoggingBusiness,
      'Genel Arama/Yol Tarifi',
      `${item.id ?? ''}/${item.title}`,
    );

    try {
      const itemDetails = await getItemDetails(item);
      if (!itemDetails?.geometry) throw new Error('Yol tarifi için konum bilgisi bulunamadı.');
      const url = buildGoogleDirectionsUrl(itemDetails.geometry);
      if (!url) throw new Error('Yol tarifi için konum bilgisi bulunamadı.');
      if (!openExternalSafely(url)) {
        throw new Error('Tarayıcı yol tarifi penceresini açmayı engelledi.');
      }
    } catch (error) {
      const message = normalizeErrorMessage(error, 'Yol tarifi alınamadı.');
      setInlineActionError(message);
      windowManager.ShowMessage(Constants_MessageType.Error, message);
    } finally {
      if (mountedRef.current) setDetailLoadingKey(null);
    }
  }, [getItemDetails, windowManager]);

  const backToSidebar = useCallback((): void => {
    queryGateRef.current.invalidate();
    detailGateRef.current.invalidate();
    setDetailLoadingKey(null);
    setInlineActionError('');
    workspace.closeSuggestions();
    windowManager.ShowWindow('sidebar');
  }, [windowManager, workspace]);

  const focusActiveResult = useCallback((): void => {
    const activeId = workspace.activeRecordDomId();
    if (!activeId) return;
    const element = document.getElementById(activeId);
    element?.focus();
    element?.scrollIntoView?.({ block: 'nearest' });
  }, [workspace]);

  const activateSuggestion = useCallback((suggestion: GeneralSearchSuggestion): void => {
    const record = workspace.applySuggestion(suggestion);
    if (record) void showItemOnMap(record);
  }, [showItemOnMap, workspace]);

  const handleInputKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!workspaceState.suggestionOpen) workspace.openSuggestions();
      else workspace.moveSuggestion('next');
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (!workspaceState.suggestionOpen) workspace.openSuggestions();
      else workspace.moveSuggestion('previous');
      return;
    }
    if (event.key === 'Home' && workspaceState.suggestionOpen) {
      event.preventDefault();
      workspace.moveSuggestion('first');
      return;
    }
    if (event.key === 'End' && workspaceState.suggestionOpen) {
      event.preventDefault();
      workspace.moveSuggestion('last');
      return;
    }
    if (event.key === 'Enter' && workspaceState.suggestionOpen) {
      event.preventDefault();
      const record = workspace.applyActiveSuggestion();
      if (record) void showItemOnMap(record);
      return;
    }
    if (event.key === 'Escape') {
      if (workspaceState.suggestionOpen) {
        event.preventDefault();
        workspace.closeSuggestions();
      } else if (snapshot.filters.text) {
        event.preventDefault();
        workspace.clearText();
      }
    }
  }, [showItemOnMap, snapshot.filters.text, workspace, workspaceState.suggestionOpen]);

  const handleResultKeyDown = useCallback((
    event: KeyboardEvent<HTMLButtonElement>,
    item: NormalizedSearchRecord,
  ): void => {
    if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp'].includes(event.key)) {
      event.preventDefault();
      workspace.moveActive(event.key);
      queueMicrotask(focusActiveResult);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      void showItemOnMap(item);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      document.getElementById(inputId)?.focus();
    }
  }, [focusActiveResult, inputId, showItemOnMap, workspace]);

  const handleRefineChange = useCallback((event: ChangeEvent<HTMLInputElement>): void => {
    workspace.setText(event.target.value);
  }, [workspace]);

  const queryLabel = String(query.name || query.searchText || '').trim();
  const filterCount = selectedFilterCount(
    snapshot.filters.categories,
    snapshot.filters.types,
  );
  const hasFilters = snapshot.diagnostics.hasActiveFilters;
  const loading = snapshot.phase === 'loading';
  const errorMessage = workspaceState.errorMessage;
  const page = snapshot.page;

  const resultContent = useMemo((): ReactNode => {
    if (loading) {
      return (
        <div className="experience-search-state genel-arama-state" role="status" aria-live="polite">
          <ButtonLoading message="Aranıyor…" />
          <div className="experience-search-state__hint">Kent rehberi sonuçları getiriliyor.</div>
        </div>
      );
    }

    if (snapshot.phase === 'error') {
      return (
        <div className="general-search-state-card general-search-state-card--error" role="alert">
          <div className="general-search-state-card__icon" aria-hidden="true">!</div>
          <div>
            <h3>Arama tamamlanamadı</h3>
            <p>{errorMessage || 'Beklenmeyen bir sorun oluştu.'}</p>
            <button
              className="kr-btn kr-btn--secondary"
              type="button"
              onClick={() => { void fetchQueryResults(); }}
            >
              Tekrar dene
            </button>
          </div>
        </div>
      );
    }

    if (snapshot.matchedCount === 0) {
      return hasFilters ? (
        <div className="general-search-state-card" role="status">
          <FiSearch aria-hidden="true" />
          <div>
            <h3>Filtrelerle eşleşen sonuç yok</h3>
            <p>Arama ifadesini veya seçili filtreleri sadeleştirerek tekrar deneyin.</p>
            <button
              className="kr-btn kr-btn--secondary"
              type="button"
              onClick={() => workspace.clearFilters()}
            >
              Filtreleri temizle
            </button>
          </div>
        </div>
      ) : (
        <NoResultsFound message="Bu arama için kayıt bulunamadı. Daha genel bir ifade deneyin." />
      );
    }

    return page.items.map((ranked, index) => {
      const item = ranked.record;
      const busy = detailLoadingKey === item.key;
      const active = index === snapshot.activeIndex;
      return (
        <article
          className={`result-item-container genel-arama-result ${active ? 'is-active' : ''}`}
          key={item.key}
          aria-busy={busy || undefined}
          data-result-index={page.startIndex + index + 1}
        >
          <button
            type="button"
            id={generalSearchResultDomId(item.key)}
            role="option"
            aria-selected={active}
            aria-posinset={page.startIndex + index + 1}
            aria-setsize={snapshot.matchedCount}
            tabIndex={active ? 0 : -1}
            className="result-item-info general-search-result-main"
            onFocus={() => {
              if (!active) {
                const direction = index > snapshot.activeIndex ? 'ArrowDown' : 'ArrowUp';
                let attempts = Math.abs(index - snapshot.activeIndex);
                while (attempts > 0) {
                  workspace.moveActive(direction);
                  attempts -= 1;
                }
              }
            }}
            onKeyDown={(event) => handleResultKeyDown(event, item)}
            onClick={() => { void showItemOnMap(item); }}
            aria-label={`${item.title} kaydını haritada göster`}
            disabled={busy}
          >
            <span className="general-search-result-icon" aria-hidden="true">
              <SharedGISIcon record={recordIcon(item)} size={36} />
            </span>
            <span className="general-search-result-copy">
              <span className="result-item-info-title">{item.title}</span>
              <span className="general-search-result-meta">
                {item.category && item.category !== 'Diğer' ? (
                  <span className="genel-arama-result-category">{item.category}</span>
                ) : null}
                {item.type && item.type !== item.category ? (
                  <span className="general-search-result-type">{item.type}</span>
                ) : null}
              </span>
              {item.address ? (
                <span className="result-item-info-address">
                  <FiMapPin aria-hidden="true" />
                  <span>{item.address}</span>
                </span>
              ) : null}
              {item.phone ? (
                <span className="result-item-info-phone">
                  <FiPhone aria-hidden="true" />
                  <span>{item.phone}</span>
                </span>
              ) : null}
              {ranked.matchedFields.length > 0 && snapshot.filters.text ? (
                <span className="general-search-match-hint">
                  Eşleşme: {ranked.matchedFields.join(', ')}
                </span>
              ) : null}
              {busy ? (
                <span className="genel-arama-result-status" role="status">Konum hazırlanıyor…</span>
              ) : null}
            </span>
          </button>
          <CommonQueryResultItemTools
            item={item}
            zoomCallback={() => { void showItemOnMap(item); }}
            showRouteCallback={(event) => { void showRoute(event, item); }}
          />
        </article>
      );
    });
  }, [
    detailLoadingKey,
    errorMessage,
    fetchQueryResults,
    handleResultKeyDown,
    hasFilters,
    loading,
    page.items,
    page.startIndex,
    showItemOnMap,
    showRoute,
    snapshot.activeIndex,
    snapshot.filters.text,
    snapshot.matchedCount,
    snapshot.phase,
    workspace,
  ]);

  return (
    <section
      className="sidebar-container genel-arama-window"
      aria-label="Genel arama sonuçları"
      style={{ visibility: visible ? 'visible' : 'hidden' }}
    >
      <header className="common-query-window-header general-search-window-header">
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
        aria-busy={loading || undefined}
      >
        <div className="results-container-toolbar genel-arama-toolbar">
          <button
            className="results-container-back-button"
            type="button"
            onClick={backToSidebar}
          >
            <HiOutlineArrowNarrowLeft className="results-container-back-button-icon" aria-hidden="true" />
            <span>Geri</span>
          </button>
          <div className="general-search-toolbar-summary" aria-live="polite">
            <strong>{snapshot.matchedCount}</strong>
            <span>{snapshot.matchedCount === 1 ? 'sonuç' : 'sonuç'}</span>
          </div>
        </div>

        <div className="general-search-workspace">
          <div className="general-search-intro">
            <div>
              <h2>Arama sonuçlarını keşfet</h2>
              <p>
                Sonuçları ad, adres, kategori veya türe göre daraltın; seçtiğiniz kaydı haritada açın.
              </p>
            </div>
            {queryLabel ? (
              <div className="genel-arama-query-summary" role="status">
                <span>Sunucu sorgusu</span>
                <strong>{queryLabel}</strong>
              </div>
            ) : null}
          </div>

          <div className="general-search-controls" role="search" aria-label="Sonuçları daralt">
            <div className="general-search-input-wrap">
              <FiSearch className="general-search-input-icon" aria-hidden="true" />
              <label className="sr-only" htmlFor={inputId}>Sonuçlarda ara</label>
              <input
                id={inputId}
                className="general-search-input"
                type="search"
                value={snapshot.filters.text}
                placeholder="Sonuçlarda ad, adres veya kategori ara"
                autoComplete="off"
                spellCheck={false}
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={workspaceState.suggestionOpen}
                aria-controls={workspaceState.suggestionOpen ? suggestionsId : undefined}
                aria-activedescendant={workspaceState.suggestionOpen
                  ? `general-search-suggestion-option-${workspaceState.activeSuggestionIndex}`
                  : undefined}
                onChange={handleRefineChange}
                onKeyDown={handleInputKeyDown}
                onFocus={() => {
                  if (snapshot.filters.text) workspace.openSuggestions();
                }}
                onBlur={() => {
                  queueMicrotask(() => workspace.closeSuggestions());
                }}
              />
              {snapshot.filters.text ? (
                <button
                  type="button"
                  className="general-search-input-clear"
                  aria-label="Sonuç içi aramayı temizle"
                  onClick={() => {
                    workspace.clearText();
                    document.getElementById(inputId)?.focus();
                  }}
                >
                  <FiX aria-hidden="true" />
                </button>
              ) : null}
              <SuggestionList
                open={workspaceState.suggestionOpen}
                suggestions={snapshot.suggestions}
                activeIndex={workspaceState.activeSuggestionIndex}
                onPick={activateSuggestion}
              />
            </div>

            <div className="general-search-control-row">
              <button
                type="button"
                className={`general-search-filter-toggle ${workspaceState.filterPanelOpen ? 'is-open' : ''}`}
                aria-expanded={workspaceState.filterPanelOpen}
                aria-controls={filterPanelId}
                onClick={() => workspace.toggleFilterPanel()}
              >
                <FiFilter aria-hidden="true" />
                <span>Filtreler</span>
                {filterCount > 0 ? <span className="general-search-filter-badge">{filterCount}</span> : null}
                <FiChevronDown className="general-search-filter-chevron" aria-hidden="true" />
              </button>

              <label className="general-search-sort">
                <FiSliders aria-hidden="true" />
                <span className="sr-only">Sonuç sıralaması</span>
                <select
                  aria-label="Sonuç sıralaması"
                  value={snapshot.filters.sort}
                  onChange={(event) => workspace.setSort(event.target.value as GeneralSearchSortMode)}
                >
                  {(['relevance', 'title', 'category', 'address', 'source-order'] as const).map((mode) => (
                    <option key={mode} value={mode}>{generalSearchSortLabel(mode)}</option>
                  ))}
                </select>
              </label>
            </div>

            {workspaceState.filterPanelOpen ? (
              <div className="general-search-filter-panel" id={filterPanelId}>
                <div className="general-search-filter-panel__header">
                  <div>
                    <strong>Sonuç filtreleri</strong>
                    <span>{filterCount > 0 ? `${filterCount} filtre seçili` : 'Tüm kategoriler gösteriliyor'}</span>
                  </div>
                  {filterCount > 0 ? (
                    <button type="button" onClick={() => workspace.clearFilters({ keepText: true, keepSort: true })}>
                      Seçimleri temizle
                    </button>
                  ) : null}
                </div>
                <FacetGroup
                  id={`${CATEGORY_FILTER_ID}-${generatedId}`}
                  title="Kategori"
                  facets={snapshot.categoryFacets}
                  onToggle={(value) => workspace.toggleCategory(value)}
                />
                <FacetGroup
                  id={`${TYPE_FILTER_ID}-${generatedId}`}
                  title="Tür"
                  facets={snapshot.typeFacets}
                  onToggle={(value) => workspace.toggleType(value)}
                />
              </div>
            ) : null}
          </div>

          <div className="general-search-status-row">
            <div className="general-search-count" role="status" aria-live="polite">
              {resultCountLabel(snapshot.matchedCount, snapshot.totalCount)}
            </div>
            {hasFilters ? (
              <button
                type="button"
                className="general-search-reset-link"
                onClick={() => workspace.clearFilters()}
              >
                Tüm filtreleri sıfırla
              </button>
            ) : null}
          </div>

          <div className="sr-only" aria-live="polite" aria-atomic="true">
            {workspaceState.announcement}
          </div>

          {inlineActionError ? (
            <div className="kr-status-banner kr-status-banner--danger genel-arama-inline-error" role="alert">
              <span>{inlineActionError}</span>
              <button type="button" aria-label="Hata bildirimini kapat" onClick={() => setInlineActionError('')}>
                <FiX aria-hidden="true" />
              </button>
            </div>
          ) : null}

          <div
            className="genel-arama-result-list"
            id={listId}
            role={snapshot.matchedCount > 0 ? 'listbox' : undefined}
            aria-label={snapshot.matchedCount > 0 ? 'Genel arama sonuçları' : undefined}
            aria-activedescendant={snapshot.activeKey ? generalSearchResultDomId(snapshot.activeKey) : undefined}
            aria-busy={loading || undefined}
          >
            {resultContent}
          </div>

          {snapshot.matchedCount > 0 ? (
            <div className="general-search-pagination-shell">
              <ExperiencePagination
                page={page.page}
                pageCount={page.pageCount}
                onPageChange={(nextPage) => {
                  workspace.setPage(nextPage);
                  requestAnimationFrame(() => {
                    document.getElementById(listId)?.scrollTo?.({ top: 0, behavior: 'smooth' });
                    focusActiveResult();
                  });
                }}
                label="Genel arama sonuç sayfaları"
                disabled={loading}
              />
              <span className="general-search-page-summary">
                Sayfa {page.page} / {page.pageCount}
                {page.items.length > 0 ? ` · ${page.startIndex + 1}-${page.endIndex}` : ''}
              </span>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
});

GenelAramaQeryWindow.displayName = 'GenelAramaQeryWindow';
