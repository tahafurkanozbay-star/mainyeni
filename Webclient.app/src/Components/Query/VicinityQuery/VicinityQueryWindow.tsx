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
import { Accordion, Button, Form } from 'react-bootstrap';
import { BiLayer, BiSearch } from 'react-icons/bi';
import { FiMapPin } from 'react-icons/fi';
import { FulltextSearchQueryBusiness } from '../../../Business/FulltextSearchQueryBusiness';
import { GoogleMapsBusiness } from '../../../Business/GoogleMapsBusiness';
import { LoggingBusiness } from '../../../Business/LoggingBusiness';
import { NumberingQueryBusiness } from '../../../Business/NumberingQueryBusiness';
import { Constants_MessageType } from '../../../Core/Constants';
import { loadArcgisModules } from '../../../gis-engine/arcgisModuleRuntime';
import MapManager from '../../../Store/Managers/MapManager';
import { GisGraphicsHelper } from '../../../Toolbox/GisGraphicsHelper';
import { ContainerLoading, NoResultsFound } from '../../Common/Loading';
import { CommonQueryResultItemTools } from '../_Common/CommonQueryResultItemTools';
import { CommonQueryWindowTools } from '../_Common/CommonQueryWindowTools';
import {
  createLatestRequestGate,
  createOwnedResourceRegistry,
  normalizeErrorMessage,
  openExternalSafely,
  safeClientLog,
} from '../_Common/QueryInteractionRuntime';
import type {
  ManagedQueryWindowHandle,
  ManagedQueryWindowManager,
  UnknownRecord,
} from '../_Common/QuerySurfaceContracts';
import './VicinityQueryWindow.css';

const DEFAULT_BUFFER_DISTANCE = 20;
const MAX_RESULTS_PER_CATEGORY = 50;

interface VicinityQueryWindowProps {
  readonly id: string;
  readonly windowManager: ManagedQueryWindowManager;
}

interface MapPointLike extends UnknownRecord {
  readonly latitude?: number;
  readonly longitude?: number;
}

interface MapClickEventLike {
  readonly mapPoint?: MapPointLike | null;
}

interface NeighborhoodFeature extends UnknownRecord {
  readonly attr?: UnknownRecord | null;
}

interface SearchFeature extends UnknownRecord {
  readonly Id?: unknown;
  readonly Geometry?: unknown;
  readonly geometry?: unknown;
  readonly attr?: UnknownRecord | null;
}

interface VicinityResultItem extends SearchFeature {
  readonly Id: unknown;
  readonly Category: string;
  readonly Title: string;
  readonly Geometry?: unknown;
  readonly attr: UnknownRecord & {
    readonly _MAHALLE_ADI?: string;
  };
}

interface VicinityOptionGroup {
  readonly Title: string;
  readonly Count: number;
  readonly Options: readonly VicinityResultItem[];
}

interface QueryServiceEnvelope {
  readonly Data?: unknown;
  readonly Title?: unknown;
}

interface NeighborhoodEnvelope {
  readonly data?: unknown;
}

interface CircleConstructor {
  new(options: Readonly<Record<string, unknown>>): unknown;
}

interface GraphicConstructor {
  new(options: Readonly<Record<string, unknown>>): unknown;
}

const isRecord = (value: unknown): value is UnknownRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const readAttributes = (item: unknown): UnknownRecord => {
  if (!isRecord(item) || !isRecord(item.attr)) return {};
  return item.attr;
};

const getStableItemId = (item: unknown): unknown => {
  if (!isRecord(item)) return null;
  const attr = readAttributes(item);
  return item.Id ?? attr.id ?? attr.objectid ?? attr.ID ?? null;
};

const readText = (value: unknown, fallback = ''): string => {
  if (typeof value !== 'string' && typeof value !== 'number') return fallback;
  const normalized = String(value).replace(/\s+/g, ' ').trim();
  return normalized || fallback;
};

const readMapClickEvent = (): MapClickEventLike | null => {
  const value = MapManager.GetMapClickEvent() as unknown;
  return isRecord(value) ? value as unknown as MapClickEventLike : null;
};

export const VicinityQueryWindow = forwardRef<
  ManagedQueryWindowHandle,
  VicinityQueryWindowProps
>(({ id, windowManager }, ref): ReactNode => {
  const [loading, setLoading] = useState(false);
  const [neighborhoodList, setNeighborhoodList] = useState<readonly NeighborhoodFeature[]>([]);
  const [filteredOptions, setFilteredOptions] = useState<readonly VicinityOptionGroup[] | null>(null);
  const [bufferDistance, setBufferDistance] = useState(DEFAULT_BUFFER_DISTANCE);
  const [errorMessage, setErrorMessage] = useState('');

  const mapViewRef = useRef<unknown>(null);
  const bufferGraphicRef = useRef<unknown>(null);
  const selectedGraphicRef = useRef<unknown>(null);
  const mountedRef = useRef(true);
  const requestGateRef = useRef(createLatestRequestGate());
  const resourceRegistryRef = useRef(createOwnedResourceRegistry<never, unknown>({
    removeGraphic: (graphic) => {
      MapManager.RemoveGraphics(graphic);
    },
    onCleanupError: (error) => {
      globalThis.reportError?.(error);
    },
  }));

  const removeGraphic = useCallback((graphicRef: { current: unknown | null }): void => {
    if (graphicRef.current === null) return;
    resourceRegistryRef.current.removeGraphic(graphicRef.current);
    graphicRef.current = null;
  }, []);

  const clearOwnedGraphics = useCallback((): void => {
    resourceRegistryRef.current.clearGraphics();
    bufferGraphicRef.current = null;
    selectedGraphicRef.current = null;
  }, []);

  const resetWindow = useCallback((): void => {
    requestGateRef.current.invalidate();
    clearOwnedGraphics();
    setFilteredOptions(null);
    setBufferDistance(DEFAULT_BUFFER_DISTANCE);
    setLoading(false);
    setErrorMessage('');
  }, [clearOwnedGraphics]);

  const drawBuffer = useCallback(async (distance: number): Promise<void> => {
    const event = readMapClickEvent();
    if (!event?.mapPoint) return;

    try {
      const [Circle, Graphic] = await loadArcgisModules<
        readonly [CircleConstructor, GraphicConstructor]
      >([
        'esri/geometry/Circle',
        'esri/Graphic',
      ]);

      const circleGeometry = new Circle({
        center: event.mapPoint,
        geodesic: true,
        numberOfPoints: 100,
        radius: distance * 100,
        radiusUnit: 'meters',
      });
      const graphic = new Graphic({
        geometry: circleGeometry,
        symbol: {
          type: 'simple-fill',
          color: [255, 255, 255, 0.3],
          outline: { width: 3, color: '#8f06e7' },
        },
      });

      removeGraphic(bufferGraphicRef);
      bufferGraphicRef.current = graphic;
      resourceRegistryRef.current.trackGraphic(graphic);
      MapManager.AddGraphics(graphic, false);
    } catch (error) {
      const message = normalizeErrorMessage(
        error,
        'Arama alanı haritada çizilemedi.',
      );
      if (mountedRef.current) setErrorMessage(message);
    }
  }, [removeGraphic]);

  useImperativeHandle(ref, () => ({
    id,
    visible: windowManager.IsVisible(id),
    minimized: windowManager.IsMinimized(id),
    OnShow: () => {
      setBufferDistance(DEFAULT_BUFFER_DISTANCE);
      void drawBuffer(DEFAULT_BUFFER_DISTANCE);
    },
    OnClose: resetWindow,
  }), [drawBuffer, id, resetWindow, windowManager]);

  useEffect(() => {
    mountedRef.current = true;
    windowManager.RegisterWindow(ref);
    mapViewRef.current = MapManager.GetMapView();

    let active = true;
    void Promise.resolve(NumberingQueryBusiness.GetAllNeighborhoods())
      .then((results: unknown) => {
        if (!active || !mountedRef.current) return;
        const envelope = isRecord(results)
          ? results as NeighborhoodEnvelope
          : null;
        const list = Array.isArray(envelope?.data)
          ? envelope.data.filter(
              (item): item is NeighborhoodFeature => isRecord(item),
            )
          : [];
        setNeighborhoodList(list);
      })
      .catch((error: unknown) => {
        globalThis.reportError?.(error);
        if (active && mountedRef.current) setNeighborhoodList([]);
      });

    return () => {
      active = false;
      mountedRef.current = false;
      requestGateRef.current.invalidate();
      clearOwnedGraphics();
      mapViewRef.current = null;
      windowManager.UnregisterWindow?.(id, ref);
    };
  }, [clearOwnedGraphics, id, ref, windowManager]);

  const bufferDistanceChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const value = Number.parseInt(event.target.value, 10);
    if (!Number.isFinite(value) || value < 1 || value > 100) return;
    setBufferDistance(value);
    void drawBuffer(value);
  };

  const resolveNeighborhoodName = useCallback((item: unknown): string => {
    const attr = readAttributes(item);
    const direct = readText(attr.mahalle_adi);
    if (direct) return direct;

    const neighborhoodId = attr.mahalleid;
    const match = neighborhoodList.find((candidate) => {
      const candidateAttr = readAttributes(candidate);
      return String(candidateAttr.id ?? '') === String(neighborhoodId ?? '');
    });
    return readText(readAttributes(match).ad);
  }, [neighborhoodList]);

  const createOption = useCallback((
    results: unknown,
    titleValue: unknown,
    categoryValue: unknown,
    idField: string,
    titleField: string,
  ): VicinityOptionGroup => {
    const source = Array.isArray(results)
      ? results.filter((item): item is SearchFeature => isRecord(item))
      : [];
    const title = readText(titleValue, 'Sonuçlar');
    const category = readText(categoryValue, title);

    const options = source.slice(0, MAX_RESULTS_PER_CATEGORY).map((item) => {
      const attr = readAttributes(item);
      const itemTitle = readText(
        attr[titleField] ?? attr.adi ?? attr.ad,
        title,
      );
      return {
        ...item,
        Id: attr[idField] ?? getStableItemId(item),
        Category: category,
        Title: itemTitle,
        Geometry: item.geometry,
        attr: {
          ...attr,
          _MAHALLE_ADI: resolveNeighborhoodName(item),
        },
      } satisfies VicinityResultItem;
    });

    return {
      Title: title,
      Count: source.length,
      Options: options,
    };
  }, [resolveNeighborhoodName]);

  const showItemOnMap = useCallback(async (
    event: MouseEvent<HTMLButtonElement>,
    item: VicinityResultItem,
  ): Promise<void> => {
    event.preventDefault();
    event.stopPropagation();
    void safeClientLog(
      LoggingBusiness,
      'Yakınımda Ara/Tıklama',
      `${String(item.Id ?? '')}/${item.Title}`,
    );

    try {
      const sourceGeometry = item.geometry ?? item.Geometry;
      if (!sourceGeometry) throw new Error('Sonuç konumu bulunamadı.');

      const projectedGeometry = await GisGraphicsHelper.ProjectGeometry(
        sourceGeometry,
        '4326',
      );
      const graphic = await GisGraphicsHelper.CreateGraphicFromGeometry(
        projectedGeometry,
      );

      removeGraphic(selectedGraphicRef);
      selectedGraphicRef.current = graphic;
      resourceRegistryRef.current.trackGraphic(graphic);
      GisGraphicsHelper.AddGraphics(mapViewRef.current, graphic);
      GisGraphicsHelper.ZoomToGeometry(
        mapViewRef.current,
        projectedGeometry,
        15,
      );

      if (window.matchMedia?.('(max-width: 767px)').matches) {
        windowManager.ToggleMinimiseWindow(id);
      }
    } catch (error) {
      windowManager.ShowMessage(
        Constants_MessageType.Error,
        normalizeErrorMessage(error, 'Sonuç haritada gösterilemedi.'),
      );
    }
  }, [id, removeGraphic, windowManager]);

  const showRoute = useCallback((
    event: MouseEvent<HTMLButtonElement>,
    item: VicinityResultItem,
  ): void => {
    event.preventDefault();
    event.stopPropagation();

    const geometry = item.geometry ?? item.Geometry;
    if (!geometry) {
      windowManager.ShowMessage(
        Constants_MessageType.Error,
        'Yol tarifi için konum bilgisi bulunamadı.',
      );
      return;
    }

    void safeClientLog(
      LoggingBusiness,
      'Yakınımda Ara/Yol Tarifi',
      `${String(item.Id ?? '')}/${item.Title}`,
    );

    const candidate: unknown = GoogleMapsBusiness.CreateRoutesUrlFromPoint(geometry);
    const url = typeof candidate === 'string' ? candidate : null;
    if (!openExternalSafely(url)) {
      windowManager.ShowMessage(
        Constants_MessageType.Error,
        'Yol tarifi penceresi güvenli biçimde açılamadı.',
      );
    }
  }, [windowManager]);

  const runSearch = useCallback(async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();

    const mapEvent = readMapClickEvent();
    if (!mapEvent?.mapPoint) {
      const message = 'Yakın çevre araması için önce haritada bir konum seçin.';
      setErrorMessage(message);
      windowManager.ShowMessage(Constants_MessageType.Error, message);
      return;
    }

    const requestId = requestGateRef.current.next();
    setLoading(true);
    setErrorMessage('');
    void safeClientLog(
      LoggingBusiness,
      'Yakınımda Ara/Sorgu',
      `${String(mapEvent.mapPoint.latitude ?? '')}/${String(mapEvent.mapPoint.longitude ?? '')}/${bufferDistance}`,
    );

    try {
      const services = MapManager
        .GetConfigurationServices()
        .filter((service) => service.showInSearch === true);
      const query = {
        showNearby: true,
        userLocation: mapEvent.mapPoint,
        bufferDistance,
      };

      const settled = await Promise.allSettled(
        services.map((service) => (
          FulltextSearchQueryBusiness.QueryService(service, query, true)
        )),
      );
      if (!mountedRef.current || !requestGateRef.current.isCurrent(requestId)) {
        return;
      }

      const successfulResults = settled
        .filter(
          (result): result is PromiseFulfilledResult<unknown> =>
            result.status === 'fulfilled' && Boolean(result.value),
        )
        .map((result) => result.value)
        .filter((item): item is QueryServiceEnvelope => isRecord(item));

      const searchOptions = successfulResults
        .map((item) => createOption(
          item.Data,
          item.Title,
          item.Title,
          'ID',
          'AD',
        ))
        .filter((option) => option.Count > 0);

      setFilteredOptions(searchOptions);
      if (
        searchOptions.length === 0
        && settled.some((result) => result.status === 'rejected')
      ) {
        setErrorMessage(
          'Bazı servisler yanıt vermedi; kullanılabilir servislerde sonuç bulunamadı.',
        );
      }
    } catch (error) {
      if (!mountedRef.current || !requestGateRef.current.isCurrent(requestId)) {
        return;
      }
      const message = normalizeErrorMessage(
        error,
        'Yakın çevre araması tamamlanamadı.',
      );
      setErrorMessage(message);
      windowManager.ShowMessage(Constants_MessageType.Error, message);
    } finally {
      if (mountedRef.current && requestGateRef.current.isCurrent(requestId)) {
        setLoading(false);
      }
    }
  }, [bufferDistance, createOption, windowManager]);

  const visible = windowManager.IsVisible(id);
  const minimized = windowManager.IsMinimized(id);

  return (
    <section
      className="common-query-window"
      aria-label="Yakınımda Ara"
      aria-hidden={!visible}
      style={{ visibility: visible ? 'visible' : 'hidden' }}
    >
      <header className="common-query-window-header">
        <img
          className="common-query-window-header-icon"
          src="images/icons/toolbar/bilgi.png"
          alt=""
          aria-hidden="true"
          decoding="async"
        />
        <span>Yakınımda Ara</span>
        <CommonQueryWindowTools
          windowManager={windowManager}
          windowId={id}
          showNearbySearch={false}
          showMapSelect={false}
        />
      </header>

      <div
        className={`common-query-window-body layer-list-window-body ${minimized
          ? 'common-query-window-body-collapsed'
          : ''}`}
      >
        {!loading ? (
          <form
            className="vicinity-query-controls"
            onSubmit={(event) => {
              void runSearch(event);
            }}
            aria-label="Yakın çevre arama seçenekleri"
          >
            <div className="vicinity-query-range-control">
              <label
                htmlFor={`${id}-vicinity-distance`}
                className="visually-hidden"
              >
                Arama mesafesi
              </label>
              <Form.Range
                id={`${id}-vicinity-distance`}
                min={1}
                max={100}
                value={bufferDistance}
                onChange={bufferDistanceChange}
                aria-valuetext={`${bufferDistance * 100} metre`}
              />
            </div>
            <output
              className="common-query-window-tools-buffer-distance-indicator"
              htmlFor={`${id}-vicinity-distance`}
              aria-live="polite"
            >
              {bufferDistance * 100} m
            </output>
            <Button
              className="form-button"
              style={{ marginTop: 0 }}
              type="submit"
            >
              <BiSearch aria-hidden="true" />
              <span>Ara</span>
            </Button>
          </form>
        ) : null}

        {errorMessage ? (
          <div
            className="kr-status-banner kr-status-banner--warning"
            role="status"
            aria-live="polite"
          >
            {errorMessage}
          </div>
        ) : null}

        <div
          className="vicinity-query-results-container"
          aria-live="polite"
          aria-busy={loading}
        >
          {loading ? (
            <ContainerLoading />
          ) : filteredOptions?.length === 0 ? (
            <NoResultsFound />
          ) : (
            <Accordion defaultActiveKey={[]} alwaysOpen>
              {filteredOptions?.map((optionGroup, groupIndex) => (
                <Accordion.Item
                  eventKey={String(groupIndex)}
                  className="vicinity-query-results-accordion-item"
                  key={`${optionGroup.Title}-${groupIndex}`}
                >
                  <Accordion.Header className="vicinity-query-results-accordion-item-header">
                    <BiLayer aria-hidden="true" />
                    <span>
                      {optionGroup.Title} ({optionGroup.Count})
                    </span>
                  </Accordion.Header>
                  <Accordion.Body>
                    <div className="vicinity-query-results-accordion-item-body">
                      {optionGroup.Options.map((item, itemIndex) => {
                        const itemKey = getStableItemId(item)
                          ?? `${optionGroup.Title}-${itemIndex}`;
                        const neighborhood = readText(item.attr._MAHALLE_ADI);
                        const address = readText(item.attr.adres);
                        return (
                          <article
                            className="result-item-container"
                            key={String(itemKey)}
                          >
                            <button
                              type="button"
                              className="result-item-info"
                              onClick={(event) => {
                                void showItemOnMap(event, item);
                              }}
                              aria-label={`${item.Title} sonucunu haritada göster`}
                            >
                              <span className="result-item-info-title">
                                {item.Title}
                              </span>
                              {neighborhood ? (
                                <span className="result-item-info-address">
                                  <FiMapPin aria-hidden="true" />
                                  <span>{neighborhood}</span>
                                </span>
                              ) : null}
                              {address ? (
                                <span className="result-item-info-address-description">
                                  <FiMapPin aria-hidden="true" />
                                  <span>{address}</span>
                                </span>
                              ) : null}
                            </button>
                            <CommonQueryResultItemTools
                              item={item}
                              zoomCallback={(event) => {
                                void showItemOnMap(event, item);
                              }}
                              showRouteCallback={showRoute}
                            />
                          </article>
                        );
                      })}
                    </div>
                  </Accordion.Body>
                </Accordion.Item>
              ))}
            </Accordion>
          )}
        </div>
      </div>
    </section>
  );
});

VicinityQueryWindow.displayName = 'VicinityQueryWindow';
