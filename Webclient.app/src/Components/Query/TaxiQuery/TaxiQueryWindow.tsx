import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
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
import { TaxiQueryBusiness } from '../../../Business/TaxiQueryBusiness';
import { CommonBusiness } from '../../../Business/CommonBusiness';
import { LoggingBusiness } from '../../../Business/LoggingBusiness';
import { Constants_MessageType, Constants_ServiceResultType } from '../../../Core/Constants';
import MapManager from '../../../Store/Managers/MapManager';
import { GisGraphicsHelper } from '../../../Toolbox/GisGraphicsHelper';
import { createPictureMarkerSymbol } from '../../../gis-engine/iconPresentation';
import { ButtonLoading } from '../../Common/Loading';
import { CommonQueryResultItemTools } from '../_Common/CommonQueryResultItemTools';
import { CommonQueryWindowTools } from '../_Common/CommonQueryWindowTools';
import type {
  ManagedQueryWindowHandle,
  ManagedQueryWindowManager,
} from '../_Common/QuerySurfaceContracts';
import {
  buildGoogleDirectionsUrl,
  createLatestRequestGate,
  normalizeErrorMessage,
  openExternalSafely,
  safeClientLog,
  type GeometryLike,
} from '../_Common/QueryInteractionRuntime';

type UnknownRecord = Record<string, unknown>;

interface ServiceResult<T> {
  readonly type?: unknown;
  readonly data?: readonly T[] | null;
  readonly message?: unknown;
  readonly errorMessage?: unknown;
}

interface DistrictAttribute {
  readonly id?: string | number;
  readonly ad?: string;
}

interface DistrictRecord {
  readonly attr?: DistrictAttribute | null;
}

interface TaxiFeature {
  readonly attr?: {
    readonly objectid?: string | number;
    readonly adi?: string;
    readonly telefon?: string;
    readonly adres?: string;
  } | null;
  readonly geometry?: GeometryLike | null;
}

interface TaxiListItem extends UnknownRecord {
  readonly ObjectId: string | number | null;
  readonly Title: string;
  readonly Phone: string;
  readonly Address: string;
}

interface TaxiQueryState extends UnknownRecord {
  readonly name: string;
  readonly districtId: string;
  readonly districtName: string;
  readonly nbhoodId: string;
  readonly nbhoodName: string;
  readonly showMapSelect: boolean;
  readonly showNearby: boolean;
  readonly mapSelect?: boolean;
}

interface LayerLike {
  readonly [key: string]: unknown;
}

interface LayerEnvelope {
  readonly layerObj?: LayerLike | null;
}

interface MapLike {
  add?: (layer: LayerLike) => unknown;
  remove?: (layer: LayerLike) => unknown;
}

interface MapViewLike {
  readonly map?: MapLike | null;
}

interface TaxiQueryWindowProps {
  readonly id: string;
  readonly windowTitle?: string;
  readonly windowManager: ManagedQueryWindowManager;
}

const DEFAULT_QUERY: TaxiQueryState = Object.freeze({
  name: '',
  districtId: '',
  districtName: '',
  nbhoodId: '',
  nbhoodName: '',
  showMapSelect: false,
  showNearby: false,
});

const TAXI_ICON_RECORD = Object.freeze({
  type: 'TaxiQueryUrl',
  category: 'Taksi',
  title: 'Taksi Durağı',
});

const TAXI_SYMBOL = Object.freeze(
  createPictureMarkerSymbol(TAXI_ICON_RECORD, 12, { minSize: 48, maxSize: 48 }),
);

const normalizeOptionId = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : '';

const normalizeText = (value: unknown, fallback = ''): string => {
  if (typeof value !== 'string') return fallback;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized || fallback;
};

const mapTaxiRecord = (feature: TaxiFeature): TaxiListItem => Object.freeze({
  ObjectId: (
    typeof feature.attr?.objectid === 'string'
    || typeof feature.attr?.objectid === 'number'
  ) ? feature.attr.objectid : null,
  Title: normalizeText(feature.attr?.adi, 'İsimsiz taksi durağı'),
  Phone: normalizeText(feature.attr?.telefon),
  Address: normalizeText(feature.attr?.adres, 'Adres bilgisi bulunmuyor'),
});

export const TaxiQueryWindow = forwardRef<ManagedQueryWindowHandle, TaxiQueryWindowProps>(
  ({ id, windowTitle, windowManager }, ref) => {
    const [mapView, setMapView] = useState<MapViewLike | null>(null);
    const [districtList, setDistrictList] = useState<readonly DistrictRecord[]>([]);
    const [nbhoodList, setNbhoodList] = useState<readonly DistrictRecord[]>([]);
    const [query, setQuery] = useState<TaxiQueryState>({ ...DEFAULT_QUERY });
    const [clusterLayer, setClusterLayer] = useState<LayerEnvelope | null>(null);
    const [resultList, setResultList] = useState<readonly TaxiListItem[] | null>(null);
    const [activeTab, setActiveTab] = useState<'form' | 'query'>('form');
    const [loading, setLoading] = useState(false);
    const mountedRef = useRef(true);
    const neighborhoodGateRef = useRef(createLatestRequestGate());
    const queryGateRef = useRef(createLatestRequestGate());

    const isForm = activeTab === 'form';
    const visible = windowManager.IsVisible(id);
    const minimized = windowManager.IsMinimized(id);

    const removeLastClusterLayer = useCallback((): void => {
      setClusterLayer((current) => {
        if (current?.layerObj && mapView?.map?.remove) {
          try {
            mapView.map.remove(current.layerObj);
          } catch (error) {
            globalThis.reportError?.(error);
          }
        }
        return null;
      });
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
      setMapView(MapManager.GetMapView() as MapViewLike | null);

      let active = true;
      void Promise.resolve(NumberingQueryBusiness.GetDistricts())
        .then((rawResult: unknown) => {
          const result = rawResult as ServiceResult<DistrictRecord>;
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
        const result = rawResult as ServiceResult<DistrictRecord>;
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

    const submitQuery = useCallback(async (
      event?: FormEvent<HTMLFormElement>,
    ): Promise<void> => {
      event?.preventDefault();
      if (loading) return;

      const requestId = queryGateRef.current.next();
      setLoading(true);
      void safeClientLog(
        LoggingBusiness,
        'Taksi/Sorgu',
        `${query.districtName}/${query.nbhoodName}/${query.name}`,
        globalThis.reportError,
      );

      try {
        const rawResult = await TaxiQueryBusiness.Query(query, false);
        const result = rawResult as ServiceResult<TaxiFeature>;

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
            'Taksi durakları alınamadı.',
          ));
        }

        const nextResults = result.data.map(mapTaxiRecord);
        setResultList(nextResults);
        setActiveTab('query');

        const nextCluster = await CommonBusiness.Clustering.CreateClusterLayer(
          'TaxiQueryUrl',
          windowTitle || 'Taksi',
          query,
          TAXI_SYMBOL,
        ) as LayerEnvelope | null;

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
          setClusterLayer(nextCluster);
          mapView.map.add(nextCluster.layerObj);
        }
      } catch (error) {
        if (
          mountedRef.current
          && queryGateRef.current.isCurrent(requestId)
        ) {
          windowManager.ShowMessage(
            Constants_MessageType.Error,
            normalizeErrorMessage(error, 'Taksi sorgusu tamamlanamadı.'),
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
      windowManager,
      windowTitle,
    ]);

    const getItemDetails = useCallback(async (
      item: TaxiListItem,
    ): Promise<TaxiFeature | null> => {
      if (item.ObjectId === null) return null;

      const rawResult = await TaxiQueryBusiness.Query(
        { ObjectId: item.ObjectId },
        true,
      );
      const result = rawResult as ServiceResult<TaxiFeature>;
      if (
        result?.type !== Constants_ServiceResultType.Success
        || !Array.isArray(result.data)
        || !result.data[0]
      ) {
        return null;
      }
      return result.data[0];
    }, []);

    const showItem = useCallback(async (item: TaxiListItem): Promise<void> => {
      void safeClientLog(
        LoggingBusiness,
        'Taksi/Detay Göster',
        `${item.ObjectId ?? ''}/${item.Title}`,
        globalThis.reportError,
      );

      try {
        const details = await getItemDetails(item);
        if (!details?.geometry) return;
        GisGraphicsHelper.ZoomToGeometry(mapView, details.geometry, 18);
        if (window.matchMedia?.('(max-width: 959px)').matches) {
          windowManager.ToggleMinimiseWindow(id);
        }
      } catch (error) {
        windowManager.ShowMessage(
          Constants_MessageType.Error,
          normalizeErrorMessage(error, 'Taksi durağı haritada gösterilemedi.'),
        );
      }
    }, [getItemDetails, id, mapView, windowManager]);

    const showRoute = useCallback(async (item: TaxiListItem): Promise<void> => {
      try {
        const details = await getItemDetails(item);
        const url = buildGoogleDirectionsUrl(details?.geometry);
        if (!url || !openExternalSafely(url)) {
          throw new Error('Yol tarifi alınamadı - öğe detayları bulunamadı.');
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

    const resultCountLabel = useMemo(
      () => `${resultList?.length ?? 0} adet sonuç bulundu`,
      [resultList],
    );

    return (
      <section
        className="common-query-window"
        aria-label="Taksi"
        aria-hidden={!visible}
        style={{ visibility: visible ? 'visible' : 'hidden' }}
      >
        <header className="common-query-window-header">
          <img
            className="common-query-window-header-icon"
            src="images/icons/sidebar/taksi.png"
            alt=""
            aria-hidden="true"
          />
          <span>Taksi</span>
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
            <Form onSubmit={submitQuery} aria-label="Taksi durağı filtreleri">
              {!query.mapSelect && (
                <Form.Group>
                  <label className="form-label" htmlFor={`${id}-name`}>Adı</label>
                  <input
                    id={`${id}-name`}
                    className="form-control"
                    value={query.name}
                    autoComplete="off"
                    onChange={(event) => setQueryField('name', event.target.value)}
                  />
                </Form.Group>
              )}

              {!query.showNearby && !query.mapSelect && (
                <>
                  <Form.Group>
                    <label className="form-label" htmlFor={`${id}-district`}>İlçe</label>
                    <select
                      id={`${id}-district`}
                      className="form-select form-control"
                      value={query.districtId}
                      onChange={(event) => void onDistrictChange(event)}
                    >
                      <option value="">Seçiniz..</option>
                      {districtList.map((item) => {
                        const optionId = normalizeOptionId(item.attr?.id);
                        return (
                          <option key={optionId || item.attr?.ad} value={optionId}>
                            {normalizeText(item.attr?.ad, 'İsimsiz ilçe')}
                          </option>
                        );
                      })}
                    </select>
                  </Form.Group>

                  <Form.Group>
                    <label className="form-label" htmlFor={`${id}-neighborhood`}>Mahalle</label>
                    <select
                      id={`${id}-neighborhood`}
                      className="form-select"
                      value={query.nbhoodId}
                      onChange={onNeighborhoodChange}
                      disabled={!query.districtId}
                    >
                      <option value="">Seçiniz..</option>
                      {nbhoodList.map((item) => {
                        const optionId = normalizeOptionId(item.attr?.id);
                        return (
                          <option key={optionId || item.attr?.ad} value={optionId}>
                            {normalizeText(item.attr?.ad, 'İsimsiz mahalle')}
                          </option>
                        );
                      })}
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
                  {resultCountLabel}
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
  },
);

TaxiQueryWindow.displayName = 'TaxiQueryWindow';
