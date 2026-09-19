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
import { NumberingQueryBusiness } from '../../../Business/NumberingQueryBusiness';
import { PodQueryBusiness } from '../../../Business/PodQueryBusiness';
import { CommonBusiness } from '../../../Business/CommonBusiness';
import { GoogleMapsBusiness } from '../../../Business/GoogleMapsBusiness';
import { LoggingBusiness } from '../../../Business/LoggingBusiness';
import {
  Constants_LayerType,
  Constants_MessageType,
  Constants_ServiceResultType,
} from '../../../Core/Constants';
import MapManager from '../../../Store/Managers/MapManager';
import { GisGraphicsHelper } from '../../../Toolbox/GisGraphicsHelper';
import { TextHelper } from '../../../Toolbox/TextHelper';
import {
  createPictureMarkerSymbol,
  resolveRecordIconUrl,
} from '../../../gis-engine/iconPresentation';
import { ButtonLoading } from '../../Common/Loading';
import {
  CommonQueryWindowTools,
  type CommonQueryWindowToolsHandle,
} from '../_Common/CommonQueryWindowTools';
import { CommonQueryResultItemTools } from '../_Common/CommonQueryResultItemTools';
import {
  createLatestRequestGate,
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
  type QueryLayerEnvelope,
  type QueryMapViewLike,
  type QueryServiceResult,
  type UnknownRecord,
} from '../_Common/QuerySurfaceContracts';

interface PharmacyQueryState extends UnknownRecord {
  readonly name: string;
  readonly districtId: string;
  readonly districtName: string;
  readonly nbhoodId: string;
  readonly nbhoodName: string;
  readonly showPodOnDuty: boolean;
  readonly showMapSelect: boolean;
  readonly showNearby: boolean;
  readonly mapSelect?: boolean;
}

interface PharmacyListItem extends UnknownRecord {
  readonly ObjectId: string | number | null;
  readonly Title: string;
  readonly Phone: string;
  readonly Address: string;
  readonly AddressDescription: string;
  readonly Lat: number | null;
  readonly Lng: number | null;
  readonly onDuty: boolean;
  readonly raw: QueryFeatureLike;
}

interface DistrictRecord {
  readonly attr?: {
    readonly id?: string | number;
    readonly ad?: string;
  } | null;
}

interface PharmacyQueryWindowProps {
  readonly id: string;
  readonly windowManager: ManagedQueryWindowManager;
}

interface LayerLike {
  readonly [key: string]: unknown;
}

const DEFAULT_QUERY: PharmacyQueryState = Object.freeze({
  name: '',
  districtId: '',
  districtName: '',
  nbhoodId: '',
  nbhoodName: '',
  showPodOnDuty: false,
  showMapSelect: false,
  showNearby: false,
});

const PHARMACY_ICON_RECORD = Object.freeze({
  type: 'PharmacyQueryUrl',
  category: 'Eczaneler',
  title: 'Eczane',
});

const PHARMACY_SYMBOL = Object.freeze(
  createPictureMarkerSymbol(PHARMACY_ICON_RECORD, 12, { minSize: 48, maxSize: 48 }),
);
const PHARMACY_WINDOW_LOGO = resolveRecordIconUrl(
  PHARMACY_ICON_RECORD,
  { fallback: 'images/icons/sidebar/eczane.png' },
);

const normalizeFiniteCoordinate = (value: unknown): number | null => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const asFeature = (value: unknown): QueryFeatureLike => {
  if (!isUnknownRecord(value)) return {};
  return value as QueryFeatureLike;
};

const normalizePharmacy = (
  value: unknown,
  onDuty = false,
): PharmacyListItem => {
  const feature = asFeature(value);
  const objectId = normalizeQueryIdentifier(
    readNestedQueryField(feature, ['objectid', 'ObjectId', 'id', 'Id']),
  );
  const latitude = normalizeFiniteCoordinate(
    readNestedQueryField(feature, ['lat', 'latitude', 'Lat', 'Latitude']),
  );
  const longitude = normalizeFiniteCoordinate(
    readNestedQueryField(feature, ['lng', 'longitude', 'Lng', 'Longitude']),
  );

  return Object.freeze({
    ObjectId: objectId,
    Title: normalizeQueryText(
      readNestedQueryField(feature, ['adi', 'title', 'name', 'Ad', 'Title', 'Name']),
      'İsimsiz eczane',
    ),
    Phone: normalizeQueryText(
      readNestedQueryField(feature, ['telefon', 'phone', 'Telefon', 'Phone']),
    ),
    Address: normalizeQueryText(
      readNestedQueryField(feature, ['adres', 'address', 'Adres', 'Address']),
      'Adres bilgisi bulunmuyor',
    ),
    AddressDescription: normalizeQueryText(
      readNestedQueryField(feature, ['adrestarifi', 'addressDescription', 'AddressDescription']),
      'Adres tarifi bulunmuyor',
    ),
    Lat: latitude,
    Lng: longitude,
    onDuty,
    raw: feature,
  });
};

const isFinitePharmacyPoint = (
  item: PharmacyListItem,
): item is PharmacyListItem & { readonly Lat: number; readonly Lng: number } =>
  item.Lat !== null
  && item.Lng !== null
  && item.Lat >= -90
  && item.Lat <= 90
  && item.Lng >= -180
  && item.Lng <= 180;

export const PodQueryWindow = forwardRef<
  ManagedQueryWindowHandle,
  PharmacyQueryWindowProps
>(({ id, windowManager }, ref) => {
  const commonToolsComponentRef = useRef<CommonQueryWindowToolsHandle | null>(null);
  const mountedRef = useRef(true);
  const neighborhoodGateRef = useRef(createLatestRequestGate());
  const queryGateRef = useRef(createLatestRequestGate());

  const [mapView, setMapView] = useState<QueryMapViewLike<LayerLike> | null>(null);
  const [districtList, setDistrictList] = useState<readonly DistrictRecord[]>([]);
  const [nbhoodList, setNbhoodList] = useState<readonly DistrictRecord[]>([]);
  const [query, setQuery] = useState<PharmacyQueryState>({ ...DEFAULT_QUERY });
  const clusterLayerRef = useRef<LayerLike | null>(null);
  const [resultList, setResultList] = useState<readonly PharmacyListItem[] | null>(null);
  const [activeTab, setActiveTab] = useState<'form' | 'query'>('form');
  const [loading, setLoading] = useState(false);

  const visible = windowManager.IsVisible(id);
  const minimized = windowManager.IsMinimized(id);
  const isForm = activeTab === 'form';

  const removeLastClusterLayer = useCallback((): void => {
    const current = clusterLayerRef.current;
    clusterLayerRef.current = null;
    if (current && mapView?.map?.remove) {
      try {
        mapView.map.remove(current);
      } catch (error) {
        globalThis.reportError?.(error);
      }
    }
  }, [mapView]);

  const resetSurface = useCallback((): void => {
    neighborhoodGateRef.current.invalidate();
    queryGateRef.current.invalidate();
    setQuery({ ...DEFAULT_QUERY });
    setNbhoodList([]);
    setActiveTab('form');
    setResultList(null);
    setLoading(false);
    removeLastClusterLayer();
    commonToolsComponentRef.current?.OnClose();
  }, [removeLastClusterLayer]);

  useImperativeHandle(ref, () => ({
    id,
    visible,
    minimized,
    OnShow: () => undefined,
    OnClose: resetSurface,
  }), [id, minimized, resetSurface, visible]);

  useEffect(() => {
    mountedRef.current = true;
    windowManager.RegisterWindow(ref);
    setMapView(MapManager.GetMapView() as QueryMapViewLike<LayerLike> | null);

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
      windowManager.UnregisterWindow?.(id, ref);
    };
  }, [id, ref, removeLastClusterLayer, windowManager]);

  const setQueryField = useCallback((field: string, value: unknown): void => {
    setQuery((current) => ({ ...current, [field]: value }));
  }, []);

  const onDistrictChange = useCallback(async (
    event: ChangeEvent<HTMLSelectElement>,
  ): Promise<void> => {
    const requestId = neighborhoodGateRef.current.next();
    const districtId = event.target.value;
    const districtName = event.target.selectedOptions[0]?.text ?? '';

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
    setQuery((current) => ({
      ...current,
      nbhoodId: event.target.value,
      nbhoodName: event.target.selectedOptions[0]?.text ?? '',
    }));
  }, []);

  const showOnDutyLayer = useCallback(async (
    rawItems: readonly unknown[],
    requestId: number,
  ): Promise<void> => {
    const validItems = rawItems
      .map((item) => normalizePharmacy(item, true))
      .filter(isFinitePharmacyPoint);

    const points = await Promise.all(validItems.map((item) =>
      GisGraphicsHelper.CreatePoint({
        latitude: item.Lat,
        longitude: item.Lng,
      })));

    if (
      !mountedRef.current
      || !queryGateRef.current.isCurrent(requestId)
    ) {
      return;
    }

    const geoJson = {
      type: 'FeatureCollection',
      features: points.map((point: { readonly x?: unknown; readonly y?: unknown }, index: number) => ({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [Number(point.x), Number(point.y)],
        },
        id: TextHelper.CreateGuid(),
        properties: validItems[index]?.raw ?? {},
      })),
      layerType: Constants_LayerType.GeoJSONLayer,
    };

    const layer = await CommonBusiness.Clustering.CreateGeoJsonClusterLayer(
      geoJson,
      'Nöbetçi Eczaneler',
      PHARMACY_SYMBOL,
    ) as LayerLike | null;

    if (
      !mountedRef.current
      || !queryGateRef.current.isCurrent(requestId)
    ) {
      if (layer && mapView?.map?.remove) {
        try {
          mapView.map.remove(layer);
        } catch (error) {
          globalThis.reportError?.(error);
        }
      }
      return;
    }

    removeLastClusterLayer();
    if (layer && mapView?.map?.add) {
      clusterLayerRef.current = layer;
      mapView.map.add(layer);
    }
  }, [mapView, removeLastClusterLayer]);

  const submitQuery = useCallback(async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();
    if (loading) return;

    const requestId = queryGateRef.current.next();
    setLoading(true);

    try {
      if (query.showPodOnDuty) {
        void safeClientLog(
          LoggingBusiness,
          'Eczaneler/Sorgu (Nöbetçi)',
          query.name,
          globalThis.reportError,
        );

        const rawResult = await PodQueryBusiness.QueryPodOnDuty(query);
        const result = rawResult as QueryServiceResult<QueryFeatureLike>;
        if (
          result?.type !== Constants_ServiceResultType.Success
          || !Array.isArray(result.data)
        ) {
          throw new Error(normalizeErrorMessage(result, 'Nöbetçi eczaneler alınamadı.'));
        }

        if (
          !mountedRef.current
          || !queryGateRef.current.isCurrent(requestId)
        ) {
          return;
        }

        setResultList(result.data.map((item) => normalizePharmacy(item, true)));
        setActiveTab('query');
        await showOnDutyLayer(result.data, requestId);
      } else {
        void safeClientLog(
          LoggingBusiness,
          'Eczaneler/Sorgu (Tüm)',
          `${query.districtName}/${query.nbhoodName}/${query.name}`,
          globalThis.reportError,
        );

        const rawResult = await PodQueryBusiness.Query(query, false);
        const result = rawResult as QueryServiceResult<QueryFeatureLike>;
        if (
          result?.type !== Constants_ServiceResultType.Success
          || !Array.isArray(result.data)
        ) {
          throw new Error(normalizeErrorMessage(result, 'Eczaneler alınamadı.'));
        }

        if (
          !mountedRef.current
          || !queryGateRef.current.isCurrent(requestId)
        ) {
          return;
        }

        setResultList(result.data.map((item) => normalizePharmacy(item, false)));
        setActiveTab('query');

        const nextCluster = await CommonBusiness.Clustering.CreateClusterLayer(
          'PharmacyQueryUrl',
          'eczaneler',
          query,
          PHARMACY_SYMBOL,
        ) as QueryLayerEnvelope<LayerLike> | null;

        if (
          !mountedRef.current
          || !queryGateRef.current.isCurrent(requestId)
        ) {
          if (nextCluster?.layerObj && mapView?.map?.remove) {
            try {
              mapView.map.remove(nextCluster.layerObj);
            } catch (error) {
              globalThis.reportError?.(error);
            }
          }
          return;
        }

        removeLastClusterLayer();
        if (nextCluster?.layerObj && mapView?.map?.add) {
          clusterLayerRef.current = nextCluster.layerObj;
          mapView.map.add(nextCluster.layerObj);
        }
      }
    } catch (error) {
      if (
        mountedRef.current
        && queryGateRef.current.isCurrent(requestId)
      ) {
        windowManager.ShowMessage(
          Constants_MessageType.Error,
          normalizeErrorMessage(error, 'Eczane sorgusu tamamlanamadı.'),
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
  }, [
    loading,
    mapView,
    query,
    removeLastClusterLayer,
    showOnDutyLayer,
    windowManager,
  ]);

  const getItemDetails = useCallback(async (
    item: PharmacyListItem,
  ): Promise<QueryFeatureLike | null> => {
    if (item.onDuty) return item.raw;
    if (item.ObjectId === null) return null;

    const rawResult = await PodQueryBusiness.Query(
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

  const showItem = useCallback(async (
    item: PharmacyListItem,
  ): Promise<void> => {
    void safeClientLog(
      LoggingBusiness,
      'Eczaneler/Detay Göster',
      `${item.ObjectId ?? ''}/${item.Title}`,
      globalThis.reportError,
    );

    try {
      if (isFinitePharmacyPoint(item) && item.onDuty) {
        const point = await GisGraphicsHelper.CreatePoint({
          latitude: item.Lat,
          longitude: item.Lng,
        });
        const graphic = await GisGraphicsHelper.CreateGraphicFromGeometry(
          point,
          PHARMACY_SYMBOL,
        );
        MapManager.AddGraphics(graphic, true);
        GisGraphicsHelper.ZoomToGeometry(mapView, point, 16);
      } else {
        const details = await getItemDetails(item);
        if (!details?.geometry) return;
        GisGraphicsHelper.ZoomToGeometry(mapView, details.geometry, 18);
      }

      if (window.matchMedia?.('(max-width: 959px)').matches) {
        windowManager.ToggleMinimiseWindow(id);
      }
    } catch (error) {
      windowManager.ShowMessage(
        Constants_MessageType.Error,
        normalizeErrorMessage(error, 'Eczane haritada gösterilemedi.'),
      );
    }
  }, [getItemDetails, id, mapView, windowManager]);

  const showRoute = useCallback(async (
    item: PharmacyListItem,
  ): Promise<void> => {
    void safeClientLog(
      LoggingBusiness,
      'Eczaneler/Yol Tarifi',
      `${item.ObjectId ?? ''}/${item.Title}`,
      globalThis.reportError,
    );

    try {
      let geometry: GeometryLike | null | undefined;
      if (isFinitePharmacyPoint(item) && item.onDuty) {
        geometry = await GisGraphicsHelper.CreatePoint({
          latitude: item.Lat,
          longitude: item.Lng,
        }) as GeometryLike;
      } else {
        geometry = (await getItemDetails(item))?.geometry;
      }

      if (!geometry) {
        throw new Error('Yol tarifi alınamadı - öğe detayları bulunamadı.');
      }

      const url = GoogleMapsBusiness.CreateRoutesUrlFromPoint(geometry);
      if (!openExternalSafely(url)) {
        throw new Error('Yol tarifi yeni sekmede açılamadı.');
      }
    } catch (error) {
      windowManager.ShowMessage(
        Constants_MessageType.Error,
        normalizeErrorMessage(
          error,
          'Yol tarifi alınamadı - öğe detayları bulunamadı.',
        ),
      );
    }
  }, [getItemDetails, windowManager]);

  const backToForm = useCallback((): void => {
    queryGateRef.current.invalidate();
    removeLastClusterLayer();
    setActiveTab('form');
  }, [removeLastClusterLayer]);

  return (
    <section
      className="common-query-window"
      aria-label="Eczane"
      aria-hidden={!visible}
      style={{ visibility: visible ? 'visible' : 'hidden' }}
    >
      <header className="common-query-window-header">
        <img
          className="common-query-window-header-icon"
          src={PHARMACY_WINDOW_LOGO}
          alt=""
          aria-hidden="true"
        />
        <span>Eczane</span>
        <CommonQueryWindowTools
          ref={commonToolsComponentRef}
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
          <Form onSubmit={submitQuery} aria-label="Eczane filtreleri">
            <Form.Group>
              <label className="form-checkbox">
                <span>Nöbetçi Eczane Ara</span>
                <input
                  type="checkbox"
                  aria-label="Nöbetçi Eczane Ara"
                  checked={query.showPodOnDuty}
                  onChange={(event) => setQueryField('showPodOnDuty', event.target.checked)}
                />
              </label>
            </Form.Group>

            {!query.mapSelect && (
              <Form.Group>
                <label className="form-label" htmlFor={`${id}-name`}>Adı</label>
                <input
                  id={`${id}-name`}
                  className="form-control"
                  value={query.name}
                  aria-label="Adı"
                  autoComplete="off"
                  onChange={(event) => setQueryField('name', event.target.value)}
                />
              </Form.Group>
            )}

            {!query.showPodOnDuty && !query.showNearby && !query.mapSelect && (
              <>
                <Form.Group>
                  <label className="form-label" htmlFor={`${id}-district`}>İlçe</label>
                  <select
                    id={`${id}-district`}
                    className="form-select form-control"
                    value={query.districtId}
                    aria-label="İlçe"
                    onChange={(event) => void onDistrictChange(event)}
                  >
                    <option value="">Seçiniz..</option>
                    {districtList.map((item) => (
                      <option key={String(item.attr?.id ?? item.attr?.ad)} value={String(item.attr?.id ?? '')}>
                        {item.attr?.ad ?? 'İsimsiz ilçe'}
                      </option>
                    ))}
                  </select>
                </Form.Group>

                <Form.Group>
                  <label className="form-label" htmlFor={`${id}-neighborhood`}>Mahalle</label>
                  <select
                    id={`${id}-neighborhood`}
                    className="form-select"
                    value={query.nbhoodId}
                    aria-label="Mahalle"
                    onChange={onNeighborhoodChange}
                    disabled={!query.districtId}
                  >
                    <option value="">Seçiniz..</option>
                    {nbhoodList.map((item) => (
                      <option key={String(item.attr?.id ?? item.attr?.ad)} value={String(item.attr?.id ?? '')}>
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

            {resultList?.map((item, index) => (
              <article
                className="result-item-container"
                key={`${item.ObjectId ?? item.Title}-${index}`}
              >
                <button
                  type="button"
                  className="result-item-info"
                  onClick={() => void showItem(item)}
                  aria-label={`${item.Title} konumunu haritada göster`}
                >
                  <span className="result-item-info-title">{item.Title}</span>
                  <span className="result-item-info-address">
                    <FiMapPin aria-hidden="true" />
                    <span>{item.Address}</span>
                  </span>
                  <span className="result-item-info-address-description">
                    <FiMapPin aria-hidden="true" />
                    <span>{item.AddressDescription}</span>
                  </span>
                </button>
                <CommonQueryResultItemTools
                  item={item}
                  zoomCallback={() => void showItem(item)}
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

PodQueryWindow.displayName = 'PodQueryWindow';
