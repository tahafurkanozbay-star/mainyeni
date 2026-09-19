import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react';
import { Button, Form } from 'react-bootstrap';
import { BiSearch } from 'react-icons/bi';
import { FiMapPin } from 'react-icons/fi';
import { HiOutlineArrowNarrowLeft } from 'react-icons/hi';
import ReactDatePicker, { registerLocale } from 'react-datepicker';
import 'react-datepicker/dist/react-datepicker.css';
import { tr } from 'date-fns/locale';
import { CommonBusiness } from '../../../Business/CommonBusiness';
import { EventQueryBusiness } from '../../../Business/EventQueryBusiness';
import { LoggingBusiness } from '../../../Business/LoggingBusiness';
import { NumberingQueryBusiness } from '../../../Business/NumberingQueryBusiness';
import {
  Constants_MessageType,
  Constants_ServiceResultType,
} from '../../../Core/Constants';
import MapManager from '../../../Store/Managers/MapManager';
import { DatetimeHelper } from '../../../Toolbox/DatetimeHelper';
import { GisGraphicsHelper } from '../../../Toolbox/GisGraphicsHelper';
import {
  createPictureMarkerSymbol,
  resolveRecordIconUrl,
} from '../../../gis-engine/iconPresentation';
import { ButtonLoading } from '../../Common/Loading';
import { CommonQueryResultItemTools } from '../_Common/CommonQueryResultItemTools';
import { CommonQueryWindowTools } from '../_Common/CommonQueryWindowTools';
import {
  buildGoogleDirectionsUrl,
  createLatestRequestGate,
  normalizeErrorMessage,
  openExternalSafely,
  safeClientLog,
  type GeometryLike,
} from '../_Common/QueryInteractionRuntime';
import {
  normalizeQueryIdentifier,
  normalizeQueryText,
  readNestedQueryField,
  type ManagedQueryWindowHandle,
  type ManagedQueryWindowManager,
  type QueryFeatureLike,
  type QueryLayerEnvelope,
  type QueryMapViewLike,
  type QueryServiceResult,
  type UnknownRecord,
} from '../_Common/QuerySurfaceContracts';

registerLocale('tr', tr);

interface EventQueryState extends UnknownRecord {
  readonly name: string;
  readonly districtId: string;
  readonly districtName: string;
  readonly nbhoodId: string;
  readonly nbhoodName: string;
  readonly startDate: Date | null;
  readonly endDate: Date | null;
  readonly mapSelect: boolean;
  readonly showNearby: boolean;
  readonly userLocation: unknown;
  readonly bufferDistance: number;
}

interface DistrictRecord {
  readonly attr?: {
    readonly id?: string | number;
    readonly ad?: string;
  } | null;
}

interface EventListItem extends UnknownRecord {
  readonly ObjectId: string | number | null;
  readonly Title: string;
  readonly Address: string;
  readonly StartDate: string;
  readonly EndDate: string;
}

interface EventQueryWindowProps {
  readonly id: string;
  readonly windowManager: ManagedQueryWindowManager;
}

interface LayerLike {
  readonly [key: string]: unknown;
}

const WINDOW_TITLE = 'Etkinlik';
const SERVICE_KEY = 'EventQueryUrl';

const DEFAULT_QUERY: EventQueryState = Object.freeze({
  name: '',
  districtId: '',
  districtName: '',
  nbhoodId: '',
  nbhoodName: '',
  startDate: null,
  endDate: null,
  mapSelect: false,
  showNearby: false,
  userLocation: null,
  bufferDistance: 20,
});

const ICON_RECORD = Object.freeze({
  type: SERVICE_KEY,
  category: 'Etkinlikler',
  title: WINDOW_TITLE,
});
const WINDOW_LOGO = resolveRecordIconUrl(ICON_RECORD);
const MAP_SYMBOL = Object.freeze(
  createPictureMarkerSymbol(ICON_RECORD, 12, { minSize: 48, maxSize: 48 }),
);

const createDefaultQuery = (): EventQueryState => ({ ...DEFAULT_QUERY });

const formatEventDate = (value: unknown): string => {
  const dateValue = (
    typeof value === 'string'
    || typeof value === 'number'
    || value instanceof Date
  ) ? value : null;

  return normalizeQueryText(
    DatetimeHelper.ConvertFromEsriDate(dateValue),
    '',
  );
};

const normalizeEvent = (feature: QueryFeatureLike): EventListItem => Object.freeze({
  ObjectId: normalizeQueryIdentifier(
    readNestedQueryField(feature, ['objectid', 'OBJECTID', 'ObjectId']),
  ),
  Title: normalizeQueryText(
    readNestedQueryField(feature, ['adi', 'ADI', 'title', 'Title']),
    'İsimsiz etkinlik',
  ),
  Address: normalizeQueryText(
    readNestedQueryField(feature, ['adres', 'ADRES', 'address', 'Address']),
    'Adres bilgisi bulunmuyor',
  ),
  StartDate: formatEventDate(
    readNestedQueryField(feature, ['baslangictarihi', 'BASLANGICTARIHI']),
  ),
  EndDate: formatEventDate(
    readNestedQueryField(feature, ['bitistarihi', 'BITISTARIHI']),
  ),
});

export const EventQueryWindow = forwardRef<
  ManagedQueryWindowHandle,
  EventQueryWindowProps
>(({ id, windowManager }, ref) => {
  const mapViewRef = useRef<QueryMapViewLike<LayerLike> | null>(null);
  const clusterLayerRef = useRef<QueryLayerEnvelope<LayerLike> | LayerLike | null>(null);
  const mountedRef = useRef(true);
  const neighborhoodGateRef = useRef(createLatestRequestGate());
  const queryGateRef = useRef(createLatestRequestGate());

  const [districtList, setDistrictList] = useState<readonly DistrictRecord[]>([]);
  const [nbhoodList, setNbhoodList] = useState<readonly DistrictRecord[]>([]);
  const [query, setQuery] = useState<EventQueryState>(createDefaultQuery);
  const [resultList, setResultList] = useState<readonly EventListItem[] | null>(null);
  const [activeTab, setActiveTab] = useState<'form' | 'query'>('form');
  const [loading, setLoading] = useState(false);

  const visible = windowManager.IsVisible(id);
  const minimized = windowManager.IsMinimized(id);
  const isForm = activeTab === 'form';

  const setQueryField = useCallback((field: string, value: unknown): void => {
    setQuery((current) => ({ ...current, [field]: value }));
  }, []);

  const removeLastClusterLayer = useCallback((): void => {
    const current = clusterLayerRef.current;
    const layer = (
      current
      && typeof current === 'object'
      && 'layerObj' in current
    )
      ? (current as QueryLayerEnvelope<LayerLike>).layerObj
      : current as LayerLike | null;

    if (layer && mapViewRef.current?.map?.remove) {
      try {
        mapViewRef.current.map.remove(layer);
      } catch (error) {
        globalThis.reportError?.(error);
      }
    }
    clusterLayerRef.current = null;
  }, []);

  const resetWindow = useCallback((): void => {
    neighborhoodGateRef.current.invalidate();
    queryGateRef.current.invalidate();
    removeLastClusterLayer();
    setQuery(createDefaultQuery());
    setNbhoodList([]);
    setResultList(null);
    setActiveTab('form');
    setLoading(false);
  }, [removeLastClusterLayer]);

  useImperativeHandle(ref, () => ({
    id,
    visible,
    minimized,
    OnShow: () => undefined,
    OnClose: resetWindow,
  }), [id, minimized, resetWindow, visible]);

  useEffect(() => {
    mountedRef.current = true;
    windowManager.RegisterWindow(ref);
    mapViewRef.current = MapManager.GetMapView() as QueryMapViewLike<LayerLike> | null;

    let active = true;
    void Promise.resolve(NumberingQueryBusiness.GetDistricts())
      .then((rawResult: unknown) => {
        const result = rawResult as QueryServiceResult<DistrictRecord>;
        if (!active || !mountedRef.current) return;
        setDistrictList(
          result?.type === Constants_ServiceResultType.Success && Array.isArray(result.data)
            ? result.data
            : [],
        );
      })
      .catch((error: unknown) => {
        if (!active || !mountedRef.current) return;
        setDistrictList([]);
        globalThis.reportError?.(error);
      });

    return () => {
      active = false;
      mountedRef.current = false;
      neighborhoodGateRef.current.invalidate();
      queryGateRef.current.invalidate();
      removeLastClusterLayer();
      mapViewRef.current = null;
      windowManager.UnregisterWindow?.(id, ref);
    };
  }, [id, ref, removeLastClusterLayer, windowManager]);

  const onDistrictChange = useCallback(async (
    event: ChangeEvent<HTMLSelectElement>,
  ): Promise<void> => {
    const requestId = neighborhoodGateRef.current.next();
    const districtId = event.target.value;
    const districtName = districtId
      ? event.target.selectedOptions[0]?.text ?? ''
      : '';

    setQuery((current) => ({
      ...current,
      districtId,
      districtName,
      nbhoodId: '',
      nbhoodName: '',
    }));
    setNbhoodList([]);

    if (!districtId) return;

    try {
      const rawResult = await NumberingQueryBusiness.GetNeighborhoodsOfDistrict(districtId);
      const result = rawResult as QueryServiceResult<DistrictRecord>;
      if (
        !mountedRef.current
        || !neighborhoodGateRef.current.isCurrent(requestId)
      ) {
        return;
      }
      setNbhoodList(
        result?.type === Constants_ServiceResultType.Success && Array.isArray(result.data)
          ? result.data
          : [],
      );
    } catch (error) {
      if (
        mountedRef.current
        && neighborhoodGateRef.current.isCurrent(requestId)
      ) {
        setNbhoodList([]);
        globalThis.reportError?.(error);
      }
    }
  }, []);

  const onNeighborhoodChange = useCallback((
    event: ChangeEvent<HTMLSelectElement>,
  ): void => {
    const nbhoodId = event.target.value;
    const nbhoodName = nbhoodId
      ? event.target.selectedOptions[0]?.text ?? ''
      : '';
    setQuery((current) => ({ ...current, nbhoodId, nbhoodName }));
  }, []);

  const submitQuery = useCallback(async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();
    if (loading) return;

    const requestId = queryGateRef.current.next();
    setLoading(true);
    void safeClientLog(
      LoggingBusiness,
      'Etkinlikler/Sorgu',
      `${query.districtName}/${query.nbhoodName}/${query.name}`,
      globalThis.reportError,
    );

    try {
      const rawResult = await EventQueryBusiness.Query(query, false);
      const result = rawResult as QueryServiceResult<QueryFeatureLike>;

      if (
        !mountedRef.current
        || !queryGateRef.current.isCurrent(requestId)
      ) {
        return;
      }

      if (
        result?.type !== Constants_ServiceResultType.Success
        || !Array.isArray(result.data)
      ) {
        throw new Error(normalizeErrorMessage(
          result,
          'Etkinlik sorgusu tamamlanamadı.',
        ));
      }

      setResultList(result.data.map(normalizeEvent));
      setActiveTab('query');

      const nextClusterLayer = await CommonBusiness.Clustering.CreateClusterLayer(
        SERVICE_KEY,
        WINDOW_TITLE,
        query,
        MAP_SYMBOL,
        true,
        'EventQueryAttachmentUrl',
      ) as QueryLayerEnvelope<LayerLike> | null;

      if (
        !mountedRef.current
        || !queryGateRef.current.isCurrent(requestId)
      ) {
        if (nextClusterLayer?.layerObj && mapViewRef.current?.map?.remove) {
          try {
            mapViewRef.current.map.remove(nextClusterLayer.layerObj);
          } catch (error) {
            globalThis.reportError?.(error);
          }
        }
        return;
      }

      removeLastClusterLayer();
      if (nextClusterLayer?.layerObj && mapViewRef.current?.map?.add) {
        clusterLayerRef.current = nextClusterLayer;
        mapViewRef.current.map.add(nextClusterLayer.layerObj);
      }
    } catch (error) {
      if (
        mountedRef.current
        && queryGateRef.current.isCurrent(requestId)
      ) {
        windowManager.ShowMessage(
          Constants_MessageType.Error,
          normalizeErrorMessage(
            error,
            'Etkinlik sorgusu sırasında bir hata oluştu.',
          ),
        );
      }
    } finally {
      if (
        mountedRef.current
        && queryGateRef.current.isCurrent(requestId)
      ) {
        setLoading(false);
      }
    }
  }, [loading, query, removeLastClusterLayer, windowManager]);

  const getItemDetailsById = useCallback(async (
    item: EventListItem,
  ): Promise<QueryFeatureLike | null> => {
    if (item.ObjectId === null) return null;

    const rawResult = await EventQueryBusiness.Query(
      { ObjectId: item.ObjectId },
      true,
    );
    const result = rawResult as QueryServiceResult<QueryFeatureLike>;
    if (
      result?.type !== Constants_ServiceResultType.Success
      || !Array.isArray(result.data)
      || !result.data[0]
    ) {
      return null;
    }
    return result.data[0];
  }, []);

  const showItemOnMap = useCallback(async (
    item: EventListItem,
  ): Promise<void> => {
    void safeClientLog(
      LoggingBusiness,
      'Etkinlikler/Detay Göster',
      `${item.ObjectId ?? ''}/${item.Title}`,
      globalThis.reportError,
    );

    try {
      const details = await getItemDetailsById(item);
      if (!details?.geometry) {
        throw new Error('Etkinlik konumu bulunamadı.');
      }

      GisGraphicsHelper.ZoomToGeometry(mapViewRef.current, details.geometry, 18);
      if (window.matchMedia?.('(max-width: 959px)').matches) {
        windowManager.ToggleMinimiseWindow(id);
      }
    } catch (error) {
      windowManager.ShowMessage(
        Constants_MessageType.Error,
        normalizeErrorMessage(error, 'Etkinlik konumu açılamadı.'),
      );
    }
  }, [getItemDetailsById, id, windowManager]);

  const showRoute = useCallback(async (
    item: EventListItem,
  ): Promise<void> => {
    try {
      const details = await getItemDetailsById(item);
      const url = buildGoogleDirectionsUrl(details?.geometry as GeometryLike | null | undefined);
      if (!url || !openExternalSafely(url)) {
        throw new Error('Yol tarifi için konum bilgisi bulunamadı.');
      }
    } catch (error) {
      windowManager.ShowMessage(
        Constants_MessageType.Error,
        normalizeErrorMessage(error, 'Yol tarifi alınamadı.'),
      );
    }
  }, [getItemDetailsById, windowManager]);

  const backToForm = useCallback((): void => {
    queryGateRef.current.invalidate();
    removeLastClusterLayer();
    setActiveTab('form');
  }, [removeLastClusterLayer]);

  const startDateId = `${id}-event-start-date`;
  const endDateId = `${id}-event-end-date`;
  const nameId = `${id}-event-name`;
  const districtId = `${id}-event-district`;
  const neighborhoodId = `${id}-event-neighborhood`;

  return (
    <section
      className="common-query-window"
      aria-label={WINDOW_TITLE}
      aria-hidden={!visible}
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
          windowManager={windowManager}
          windowId={id}
          setQueryField={setQueryField}
          query={query}
          showNearbySearch={isForm}
          showMapSelect={isForm}
        />
      </header>

      <div
        className={`common-query-window-body ${minimized ? 'common-query-window-body-collapsed' : ''}`}
        aria-busy={loading}
      >
        {isForm ? (
          <Form onSubmit={submitQuery} aria-label="Etkinlik filtreleri">
            {!query.mapSelect && (
              <>
                <Form.Group>
                  <label className="form-label" htmlFor={nameId}>Adı</label>
                  <input
                    id={nameId}
                    className="form-control"
                    value={query.name}
                    autoComplete="off"
                    onChange={(event) => setQueryField('name', event.target.value)}
                  />
                </Form.Group>

                <div className="horizontal-layout">
                  <Form.Group className="vertical-layout">
                    <label className="form-label" htmlFor={startDateId}>
                      Başlangıç Tarihi
                    </label>
                    <ReactDatePicker
                      id={startDateId}
                      selected={query.startDate}
                      locale="tr"
                      dateFormat="dd.MM.yyyy"
                      className="form-control"
                      placeholderText="Seçiniz..."
                      onChange={(date: Date | null) => setQueryField('startDate', date)}
                    />
                  </Form.Group>

                  <Form.Group className="vertical-layout">
                    <label className="form-label" htmlFor={endDateId}>
                      Bitiş Tarihi
                    </label>
                    <ReactDatePicker
                      id={endDateId}
                      selected={query.endDate}
                      locale="tr"
                      dateFormat="dd.MM.yyyy"
                      className="form-control"
                      placeholderText="Seçiniz..."
                      onChange={(date: Date | null) => setQueryField('endDate', date)}
                    />
                  </Form.Group>
                </div>
              </>
            )}

            {!query.showNearby && !query.mapSelect && (
              <>
                <Form.Group>
                  <label className="form-label" htmlFor={districtId}>İlçe</label>
                  <select
                    id={districtId}
                    className="form-select form-control"
                    value={query.districtId}
                    onChange={(event) => void onDistrictChange(event)}
                  >
                    <option value="">Seçiniz..</option>
                    {districtList.map((item) => (
                      <option
                        key={String(item.attr?.id ?? item.attr?.ad)}
                        value={String(item.attr?.id ?? '')}
                      >
                        {item.attr?.ad ?? 'İsimsiz ilçe'}
                      </option>
                    ))}
                  </select>
                </Form.Group>

                <Form.Group>
                  <label className="form-label" htmlFor={neighborhoodId}>Mahalle</label>
                  <select
                    id={neighborhoodId}
                    className="form-select"
                    value={query.nbhoodId}
                    onChange={onNeighborhoodChange}
                    disabled={!query.districtId}
                  >
                    <option value="">Seçiniz..</option>
                    {nbhoodList.map((item) => (
                      <option
                        key={String(item.attr?.id ?? item.attr?.ad)}
                        value={String(item.attr?.id ?? '')}
                      >
                        {item.attr?.ad ?? 'İsimsiz mahalle'}
                      </option>
                    ))}
                  </select>
                </Form.Group>
              </>
            )}

            {!query.mapSelect && (
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
            )}
          </Form>
        ) : (
          <div className="results-container">
            <div className="results-container-toolbar">
              <button
                type="button"
                className="results-container-back-button"
                onClick={backToForm}
              >
                <HiOutlineArrowNarrowLeft
                  className="results-container-back-button-icon"
                  aria-hidden="true"
                />
                <span>Geri Dön</span>
              </button>
              <div className="results-container-count" aria-live="polite">
                <strong>{resultList?.length ?? 0}</strong> adet sonuç bulundu
              </div>
            </div>

            {resultList?.map((item) => (
              <article
                className="result-item-container"
                key={item.ObjectId ?? `${item.Title}-${item.StartDate}`}
              >
                <button
                  type="button"
                  className="result-item-info"
                  onClick={() => void showItemOnMap(item)}
                  aria-label={`${item.Title} konumunu haritada göster`}
                >
                  <span className="result-item-info-title">{item.Title}</span>
                  <span className="result-item-info-date">
                    {item.StartDate === item.EndDate
                      ? item.StartDate
                      : `${item.StartDate} - ${item.EndDate}`}
                  </span>
                  <span className="result-item-info-address">
                    <FiMapPin aria-hidden="true" />
                    <span>{item.Address}</span>
                  </span>
                </button>
                <CommonQueryResultItemTools
                  item={item}
                  zoomCallback={() => void showItemOnMap(item)}
                  showRouteCallback={() => void showRoute(item)}
                />
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
});

EventQueryWindow.displayName = 'EventQueryWindow';
