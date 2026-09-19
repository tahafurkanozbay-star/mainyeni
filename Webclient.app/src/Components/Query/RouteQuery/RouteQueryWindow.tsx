import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { Button, Form } from 'react-bootstrap';
import { BiRadioCircle, BiRadioCircleMarked, BiSearch } from 'react-icons/bi';
import { BsToggleOff, BsToggleOn } from 'react-icons/bs';
import { FiArrowUp, FiMapPin } from 'react-icons/fi';
import { HiOutlineArrowNarrowLeft } from 'react-icons/hi';
import { RiRouteFill } from 'react-icons/ri';
import { CommonBusiness } from '../../../Business/CommonBusiness';
import { LoggingBusiness } from '../../../Business/LoggingBusiness';
import { NumberingQueryBusiness } from '../../../Business/NumberingQueryBusiness';
import { RouteQueryBusiness } from '../../../Business/RouteQueryBusiness';
import {
  Constants_MessageType,
  Constants_ServiceResultType,
} from '../../../Core/Constants';
import MapManager from '../../../Store/Managers/MapManager';
import { GisGraphicsHelper } from '../../../Toolbox/GisGraphicsHelper';
import { ButtonLoading, NoResultsFound } from '../../Common/Loading';
import { CommonQueryResultItemTools } from '../_Common/CommonQueryResultItemTools';
import {
  CommonQueryWindowTools,
  type CommonQueryWindowToolsHandle,
} from '../_Common/CommonQueryWindowTools';
import {
  buildGoogleDirectionsUrl,
  normalizeErrorMessage,
  openExternalSafely,
  safeClientLog,
  type GeometryLike,
} from '../_Common/QueryInteractionRuntime';
import {
  isUnknownRecord,
  normalizeQueryIdentifier,
  normalizeQueryText,
  readNestedQueryField,
  type ManagedQueryWindowHandle,
  type ManagedQueryWindowManager,
  type QueryFeatureLike,
  type UnknownRecord,
} from '../_Common/QuerySurfaceContracts';

const WINDOW_TITLE = 'Rotalar';
const WINDOW_LOGO = 'images/icons/sidebar/rotalar.png';

type RouteToggleField =
  | 'showCultureWalkingRoute'
  | 'showNatureWalkingRoute';

interface RouteQueryState extends UnknownRecord {
  readonly name: string;
  readonly districtId: string;
  readonly districtName: string;
  readonly mapSelect: boolean;
  readonly showNearby: boolean;
  readonly userLocation: unknown;
  readonly bufferDistance: number;
  readonly routeLevel: number;
  readonly showCultureWalkingRoute: boolean;
  readonly showNatureWalkingRoute: boolean;
}

interface RouteListItem extends UnknownRecord {
  readonly Id: string | number | null;
  readonly Title: string;
  readonly Description: string;
  readonly RouteLevel: string;
  readonly District: string;
  readonly RouteType: unknown;
}

interface RouteQueryWindowProps {
  readonly id: string;
  readonly queryServiceTitle?: string;
  readonly windowManager: ManagedQueryWindowManager;
}

interface ServiceResult {
  readonly type?: unknown;
  readonly data?: readonly unknown[] | null;
  readonly message?: unknown;
}

interface LayerEnvelope {
  readonly layerObj?: unknown;
}

interface MapLike {
  readonly add: (layer: unknown) => unknown;
  readonly remove: (layer: unknown) => unknown;
}

interface MapViewLike {
  readonly map?: MapLike | null;
}

interface DetailRecord extends QueryFeatureLike {
  readonly geometry?: GeometryLike | null;
}

const DEFAULT_QUERY: RouteQueryState = Object.freeze({
  name: '',
  districtId: '',
  districtName: '',
  mapSelect: false,
  showNearby: false,
  userLocation: null,
  bufferDistance: 20,
  routeLevel: 3,
  showCultureWalkingRoute: true,
  showNatureWalkingRoute: true,
});

const createDefaultQuery = (): RouteQueryState => ({ ...DEFAULT_QUERY });

const isServiceResult = (value: unknown): value is ServiceResult =>
  value !== null && typeof value === 'object';

const isLayerEnvelope = (value: unknown): value is LayerEnvelope =>
  value !== null && typeof value === 'object' && 'layerObj' in value;

const asDetailRecord = (value: unknown): DetailRecord | null =>
  value !== null && typeof value === 'object'
    ? value as DetailRecord
    : null;

const getRouteTypeLabel = (routeType: unknown): string =>
  Number(routeType) === 1 ? 'Kültürel Yürüyüş Rotası' : 'Doğa Yürüyüş Rotası';

const normalizeRoute = (value: unknown): RouteListItem | null => {
  if (!isUnknownRecord(value)) return null;
  const feature = value as QueryFeatureLike;
  const id = normalizeQueryIdentifier(
    readNestedQueryField(feature, ['id', 'ID', 'objectid', 'OBJECTID']),
  );

  return {
    ...value,
    Id: id,
    Title: normalizeQueryText(
      readNestedQueryField(feature, ['adi', 'ADI']),
      'İsimsiz rota',
    ),
    Description: normalizeQueryText(
      readNestedQueryField(feature, ['aciklama', 'ACIKLAMA']),
      'Açıklama bulunmuyor',
    ),
    RouteLevel: normalizeQueryText(
      readNestedQueryField(feature, ['zorlukderecesi', 'ZORLUKDERECESI']),
      '-',
    ),
    District: normalizeQueryText(
      readNestedQueryField(feature, ['ilce', 'ILCE']),
      'İlçe bilgisi bulunmuyor',
    ),
    RouteType: readNestedQueryField(feature, ['tip', 'TIP']),
  };
};

export const RouteQueryWindow = forwardRef<
  ManagedQueryWindowHandle,
  RouteQueryWindowProps
>(({ id, queryServiceTitle, windowManager }, ref): ReactNode => {
  const [districtList, setDistrictList] = useState<readonly QueryFeatureLike[]>([]);
  const [query, setQuery] = useState<RouteQueryState>(createDefaultQuery);
  const [resultList, setResultList] = useState<readonly RouteListItem[] | null>(null);
  const [activeTab, setActiveTab] = useState<'form' | 'query'>('form');
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const commonToolsComponentRef = useRef<CommonQueryWindowToolsHandle | null>(null);
  const mapViewRef = useRef<MapViewLike | null>(null);
  const clusterLayerRef = useRef<LayerEnvelope | null>(null);
  const routeGraphicRef = useRef<unknown>(null);
  const requestIdRef = useRef(0);

  const visible = windowManager.IsVisible(id);
  const minimized = windowManager.IsMinimized(id);

  const showMessage = useCallback((message: string): void => {
    windowManager.ShowMessage(Constants_MessageType.Error, message);
  }, [windowManager]);

  const removeLastClusterLayer = useCallback((): void => {
    const resource = clusterLayerRef.current;
    const layer = resource?.layerObj;
    if (mapViewRef.current?.map && layer) {
      mapViewRef.current.map.remove(layer);
    }
    clusterLayerRef.current = null;
  }, []);

  const removeRouteGraphic = useCallback((): void => {
    if (routeGraphicRef.current === null) return;
    MapManager.RemoveGraphics(routeGraphicRef.current);
    routeGraphicRef.current = null;
  }, []);

  const resetWindow = useCallback((): void => {
    requestIdRef.current += 1;
    removeLastClusterLayer();
    removeRouteGraphic();
    setQuery(createDefaultQuery());
    setResultList(null);
    setActiveTab('form');
    setLoading(false);
    setErrorMessage('');
    commonToolsComponentRef.current?.OnClose();
  }, [removeLastClusterLayer, removeRouteGraphic]);

  useImperativeHandle(ref, () => ({
    id,
    visible,
    minimized,
    OnShow: () => undefined,
    OnClose: resetWindow,
  }), [id, minimized, resetWindow, visible]);

  useEffect(() => {
    windowManager.RegisterWindow(ref);
    mapViewRef.current = MapManager.GetMapView() as MapViewLike | null;
    let active = true;

    void Promise.resolve(NumberingQueryBusiness.GetDistricts())
      .then((result: unknown) => {
        if (!active || !isServiceResult(result)) return;
        if (result.type !== Constants_ServiceResultType.Success) return;
        const districts = Array.isArray(result.data)
          ? result.data.filter(
              (item): item is QueryFeatureLike =>
                item !== null && typeof item === 'object',
            )
          : [];
        setDistrictList(districts);
      })
      .catch((error: unknown) => {
        if (active) {
          setErrorMessage(normalizeErrorMessage(error, 'İlçe listesi alınamadı.'));
        }
      });

    return () => {
      active = false;
      requestIdRef.current += 1;
      removeLastClusterLayer();
      removeRouteGraphic();
      mapViewRef.current = null;
      windowManager.UnregisterWindow?.(id, ref);
    };
  }, [
    id,
    ref,
    removeLastClusterLayer,
    removeRouteGraphic,
    windowManager,
  ]);

  const setQueryField = useCallback((field: string, value: unknown): void => {
    setQuery((current) => {
      switch (field) {
        case 'name':
        case 'districtId':
        case 'districtName':
          return {
            ...current,
            [field]: typeof value === 'string' || typeof value === 'number'
              ? String(value)
              : '',
          };
        case 'mapSelect':
        case 'showNearby':
        case 'showCultureWalkingRoute':
        case 'showNatureWalkingRoute':
          return { ...current, [field]: Boolean(value) };
        case 'userLocation':
          return { ...current, userLocation: value };
        case 'bufferDistance':
        case 'routeLevel': {
          const numeric = Number(value);
          return Number.isFinite(numeric)
            ? { ...current, [field]: numeric }
            : current;
        }
        default:
          return current;
      }
    });
  }, []);

  const districtOnChange = (event: ChangeEvent<HTMLSelectElement>): void => {
    const districtId = event.target.value;
    const districtName = districtId
      ? event.target.selectedOptions[0]?.text ?? ''
      : '';
    setQuery((current) => ({ ...current, districtId, districtName }));
  };

  const setRouteType = (field: RouteToggleField): void => {
    setQuery((current) => ({ ...current, [field]: !current[field] }));
  };

  const loadRouteLayer = async (
    requestId: number,
    activeQuery: RouteQueryState,
  ): Promise<void> => {
    const mapView = mapViewRef.current;
    if (!mapView?.map || !queryServiceTitle) return;

    try {
      const clusterLayer: unknown = await CommonBusiness.Clustering.CreateClusterLayer(
        queryServiceTitle,
        WINDOW_TITLE,
        activeQuery,
        null,
      );
      if (requestId !== requestIdRef.current) return;
      removeLastClusterLayer();

      if (isLayerEnvelope(clusterLayer) && clusterLayer.layerObj) {
        clusterLayerRef.current = clusterLayer;
        mapView.map.add(clusterLayer.layerObj);
      }
    } catch (error) {
      globalThis.reportError?.(error);
    }
  };

  const submitQuery = async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();
    if (loading) return;

    const requestId = ++requestIdRef.current;
    setLoading(true);
    setErrorMessage('');
    void safeClientLog(
      LoggingBusiness,
      'Rota/Sorgu',
      `${query.districtName}/${query.routeLevel}/${query.showCultureWalkingRoute}/${query.showNatureWalkingRoute}`,
    );

    try {
      const result: unknown = await RouteQueryBusiness.Query(query, false);
      if (requestId !== requestIdRef.current) return;

      if (!isServiceResult(result) || result.type !== Constants_ServiceResultType.Success) {
        throw new Error('Rota sonuçları alınamadı.');
      }

      const normalized = (Array.isArray(result.data) ? result.data : [])
        .map(normalizeRoute)
        .filter((item): item is RouteListItem => item !== null);
      setResultList(normalized);
      setActiveTab('query');
      await loadRouteLayer(requestId, query);
    } catch (error) {
      if (requestId !== requestIdRef.current) return;
      const message = normalizeErrorMessage(
        error,
        'Rota sorgusu sırasında bir hata oluştu.',
      );
      setErrorMessage(message);
      showMessage(message);
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  };

  const getItemDetailsById = async (
    item: RouteListItem,
  ): Promise<DetailRecord> => {
    if (item.Id === null) throw new Error('Rota kimliği bulunamadı.');

    const result: unknown = await RouteQueryBusiness.Query({ Id: item.Id }, true);
    if (
      isServiceResult(result)
      && result.type === Constants_ServiceResultType.Success
      && Array.isArray(result.data)
      && result.data[0]
    ) {
      const detail = asDetailRecord(result.data[0]);
      if (detail) return detail;
    }
    throw new Error('Rota ayrıntıları bulunamadı.');
  };

  const showRouteOnMap = async (
    event: MouseEvent<HTMLElement>,
    item: RouteListItem,
  ): Promise<void> => {
    event.preventDefault();
    event.stopPropagation();
    void safeClientLog(
      LoggingBusiness,
      'Rota/Detay Göster',
      `${item.Id ?? ''}/${item.Title}`,
    );

    try {
      const itemDetails = await getItemDetailsById(item);
      if (!itemDetails.geometry) throw new Error('Rota geometrisi bulunamadı.');

      const projectedGeometry = await GisGraphicsHelper.ProjectGeometry(
        itemDetails.geometry,
        '4326',
      );
      const graphic = await GisGraphicsHelper.CreateGraphicFromGeometry(
        projectedGeometry,
        null,
      );

      removeRouteGraphic();
      routeGraphicRef.current = graphic;
      MapManager.AddGraphics(graphic, true);
      GisGraphicsHelper.ZoomToGeometryExtent(
        mapViewRef.current,
        projectedGeometry,
        1.5,
      );

      if (window.matchMedia?.('(max-width: 959px)').matches) {
        windowManager.ToggleMinimiseWindow(id);
      }
    } catch (error) {
      showMessage(normalizeErrorMessage(error, 'Rota haritada gösterilemedi.'));
    }
  };

  const showDirections = async (
    event: MouseEvent<HTMLElement>,
    item: RouteListItem,
  ): Promise<void> => {
    event.preventDefault();
    event.stopPropagation();

    try {
      const itemDetails = await getItemDetailsById(item);
      const url = buildGoogleDirectionsUrl(itemDetails.geometry);
      if (!url) throw new Error('Yol tarifi için rota konumu bulunamadı.');

      void safeClientLog(
        LoggingBusiness,
        'Rota/Yol Tarifi',
        `${item.Id ?? ''}/${item.Title}`,
      );

      if (!openExternalSafely(url)) {
        throw new Error('Tarayıcı yol tarifi penceresini açmayı engelledi.');
      }
    } catch (error) {
      showMessage(normalizeErrorMessage(error, 'Yol tarifi alınamadı.'));
    }
  };

  const backToForm = (): void => {
    requestIdRef.current += 1;
    removeLastClusterLayer();
    removeRouteGraphic();
    setActiveTab('form');
  };

  const renderForm = (): ReactNode => (
    <Form onSubmit={submitQuery} aria-label="Rota filtreleri">
      <fieldset className="horizontal-layout">
        <legend className="visually-hidden">Rota türleri</legend>
        <button
          type="button"
          className="form-checkbox form-checkbox-vertical"
          aria-pressed={query.showCultureWalkingRoute}
          onClick={() => setRouteType('showCultureWalkingRoute')}
        >
          <span>Kültürel Rotalar</span>
          {query.showCultureWalkingRoute
            ? <BsToggleOn aria-hidden="true" />
            : <BsToggleOff aria-hidden="true" />}
        </button>
        <button
          type="button"
          className="form-checkbox form-checkbox-vertical"
          aria-pressed={query.showNatureWalkingRoute}
          onClick={() => setRouteType('showNatureWalkingRoute')}
        >
          <span>Doğal Yürüyüş Rotaları</span>
          {query.showNatureWalkingRoute
            ? <BsToggleOn aria-hidden="true" />
            : <BsToggleOff aria-hidden="true" />}
        </button>
      </fieldset>

      {!query.showNearby && !query.mapSelect ? (
        <Form.Group>
          <label className="form-label" htmlFor={`${id}-route-district`}>
            İlçe
          </label>
          <select
            id={`${id}-route-district`}
            className="form-select form-control"
            onChange={districtOnChange}
            value={query.districtId}
          >
            <option value="">Seçiniz..</option>
            {districtList.map((item, index) => {
              const districtId = normalizeQueryIdentifier(
                readNestedQueryField(item, ['id', 'ID']),
              );
              const districtName = normalizeQueryText(
                readNestedQueryField(item, ['ad', 'AD']),
                'İsimsiz ilçe',
              );
              if (districtId === null) return null;
              return (
                <option key={String(districtId)} value={String(districtId)}>
                  {districtName}
                </option>
              );
            })}
          </select>
        </Form.Group>
      ) : null}

      <Form.Group>
        <fieldset className="route-level-fieldset">
          <legend className="form-label">Zorluk Derecesi</legend>
          <div
            className="radio-group"
            role="radiogroup"
            aria-label="Zorluk derecesi"
          >
            {[1, 2, 3, 4, 5].map((level) => (
              <button
                type="button"
                role="radio"
                aria-checked={query.routeLevel === level}
                className="radio-group-item"
                key={level}
                onClick={() => setQueryField('routeLevel', level)}
              >
                {query.routeLevel === level
                  ? <BiRadioCircleMarked className="radio-group-item-icon" aria-hidden="true" />
                  : <BiRadioCircle className="radio-group-item-icon" aria-hidden="true" />}
                <span>{level}</span>
              </button>
            ))}
          </div>
        </fieldset>
      </Form.Group>

      {!query.mapSelect ? (
        <Form.Group>
          {loading ? (
            <ButtonLoading />
          ) : (
            <Button type="submit" className="form-button">
              <BiSearch className="form-button-icon" aria-hidden="true" />
              <span>Sorgula</span>
            </Button>
          )}
        </Form.Group>
      ) : null}

      {errorMessage ? (
        <div className="kr-status-banner kr-status-banner--danger" role="alert">
          {errorMessage}
        </div>
      ) : null}
    </Form>
  );

  const renderResults = (): ReactNode => (
    <div className="results-container">
      <div className="results-container-toolbar">
        <button
          className="results-container-back-button"
          type="button"
          onClick={backToForm}
        >
          <HiOutlineArrowNarrowLeft
            className="results-container-back-button-icon"
            aria-hidden="true"
          />
          &nbsp;Geri Dön
        </button>
        <div className="results-container-count" aria-live="polite">
          <strong>{resultList?.length ?? 0}</strong> adet sonuç bulundu
        </div>
      </div>

      {resultList?.length === 0 ? (
        <NoResultsFound />
      ) : (
        resultList?.map((item) => (
          <article
            className="result-item-container"
            key={item.Id ?? `${item.Title}-${item.District}`}
          >
            <button
              type="button"
              className="result-item-info"
              onClick={(event) => {
                void showRouteOnMap(event, item);
              }}
              aria-label={`${item.Title} rotasını haritada göster`}
            >
              <span className="result-item-info-title">{item.Title}</span>
              <span className="result-item-info-address">
                <FiMapPin aria-hidden="true" />&nbsp;{item.District}
              </span>
              <span className="result-item-info-address-description">
                <FiMapPin aria-hidden="true" />&nbsp;{item.Description}
              </span>
              <span className="result-item-info-phone">
                <FiArrowUp aria-hidden="true" />&nbsp;{item.RouteLevel}
                &nbsp;&nbsp;&nbsp;&nbsp;
                <RiRouteFill aria-hidden="true" />&nbsp;
                {getRouteTypeLabel(item.RouteType)}
              </span>
            </button>
            <CommonQueryResultItemTools
              item={item}
              zoomCallback={(event) => {
                void showRouteOnMap(event, item);
              }}
              showRouteCallback={(event) => {
                void showDirections(event, item);
              }}
            />
          </article>
        )) ?? null
      )}
    </div>
  );

  return (
    <section
      className="common-query-window"
      aria-label={WINDOW_TITLE}
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
        <CommonQueryWindowTools
          ref={commonToolsComponentRef}
          windowManager={windowManager}
          windowId={id}
          setQueryField={setQueryField}
          query={query}
          showNearbySearch={activeTab === 'form'}
          showMapSelect={activeTab === 'form'}
        />
      </header>
      <div
        className={`common-query-window-body ${minimized ? 'common-query-window-body-collapsed' : ''}`}
      >
        {activeTab === 'form' ? renderForm() : renderResults()}
      </div>
    </section>
  );
});

RouteQueryWindow.displayName = 'RouteQueryWindow';
