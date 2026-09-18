import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  BiChevronUp,
  BiInfoCircle,
  BiX,
} from 'react-icons/bi';
import { RiCloseCircleFill } from 'react-icons/ri';
import {
  Constants_MessageType,
  Constants_UserMesssages,
} from '../../../Core/Constants';
import MapManager from '../../../Store/Managers/MapManager';
import { GisGraphicsHelper } from '../../../Toolbox/GisGraphicsHelper';
import {
  DEFAULT_BUFFER_UNITS,
  MAX_BUFFER_UNITS,
  MIN_BUFFER_UNITS,
  bufferUnitsToMeters,
  createGeolocationRequest,
  metersToBufferUnits,
  normalizeBufferUnits,
} from './QueryInteractionRuntime';
import './CommonQueryWindowTools.css';

const LOCATION_GRAPHIC_LIFETIME_MS = 30_000;

export interface QueryWindowManagerLike {
  readonly IsMinimized: (id: string) => boolean;
  readonly ToggleMinimiseWindow: (id: string) => void;
  readonly HideWindow: (id: string) => void;
  readonly ShowMessage: (type: string | number, message: string, durationSeconds?: number) => void;
}

export interface CommonQueryWindowToolsProps {
  readonly setQueryField?: (field: string, value: unknown) => void;
  readonly showNearbySearch?: boolean;
  readonly showMapSelect?: boolean;
  readonly windowManager: QueryWindowManagerLike;
  readonly windowId: string;
  readonly query?: unknown;
}

export interface CommonQueryWindowToolsHandle {
  readonly OnClose: () => void;
}

export const CommonQueryWindowTools = forwardRef<
  CommonQueryWindowToolsHandle,
  CommonQueryWindowToolsProps
>(({
  setQueryField: onSetQueryField,
  showNearbySearch = false,
  showMapSelect = false,
  windowManager,
  windowId,
}, ref): ReactNode => {
  const [nearbyActive, setNearbyActive] = useState(false);
  const [mapSelectActive, setMapSelectActive] = useState(false);
  const [bufferDistance, setBufferDistance] = useState(DEFAULT_BUFFER_UNITS);
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);

  const locationGraphicRef = useRef<unknown>(null);
  const locationTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const locationRequestRef = useRef(0);

  const setQueryField = useCallback((field: string, value: unknown): void => {
    onSetQueryField?.(field, value);
  }, [onSetQueryField]);

  const clearLocationTimer = useCallback((): void => {
    if (locationTimerRef.current !== null) {
      window.clearTimeout(locationTimerRef.current);
      locationTimerRef.current = null;
    }
  }, []);

  const clearLocationGraphic = useCallback((): void => {
    clearLocationTimer();
    if (locationGraphicRef.current !== null) {
      MapManager.RemoveGraphics(locationGraphicRef.current);
      locationGraphicRef.current = null;
    }
  }, [clearLocationTimer]);

  const resetTools = useCallback((): void => {
    locationRequestRef.current += 1;
    clearLocationGraphic();
    setNearbyActive(false);
    setMapSelectActive(false);
    setBufferDistance(DEFAULT_BUFFER_UNITS);
    setLocating(false);
    setLocationError(null);
    setQueryField('showNearby', false);
    setQueryField('mapSelect', false);
    setQueryField('userLocation', null);
    setQueryField('bufferDistance', DEFAULT_BUFFER_UNITS);
  }, [clearLocationGraphic, setQueryField]);

  useImperativeHandle(ref, () => ({ OnClose: resetTools }), [resetTools]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      locationRequestRef.current += 1;
      clearLocationGraphic();
    };
  }, [clearLocationGraphic]);

  const createLocationGraphic = useCallback(async (
    coordinates: Readonly<{ longitude: number; latitude: number }>,
    requestId: number,
  ): Promise<unknown | null> => {
    const point = await GisGraphicsHelper.CreatePoint({
      x: coordinates.longitude,
      y: coordinates.latitude,
    });
    if (!mountedRef.current || requestId !== locationRequestRef.current) return null;

    const graphic = await GisGraphicsHelper.CreateGraphicFromGeometry(point, null);
    if (!mountedRef.current || requestId !== locationRequestRef.current || !graphic) {
      return null;
    }

    clearLocationGraphic();
    locationGraphicRef.current = graphic;
    MapManager.AddGraphics(graphic, true);
    const mapView = MapManager.GetMapView();
    await Promise.resolve(GisGraphicsHelper.ZoomToGeometry(mapView, point, 12));
    if (!mountedRef.current || requestId !== locationRequestRef.current) return point;

    locationTimerRef.current = window.setTimeout(() => {
      if (locationGraphicRef.current === graphic) clearLocationGraphic();
    }, LOCATION_GRAPHIC_LIFETIME_MS);

    return point;
  }, [clearLocationGraphic]);

  const disableNearby = useCallback((): void => {
    locationRequestRef.current += 1;
    clearLocationGraphic();
    setNearbyActive(false);
    setLocating(false);
    setQueryField('showNearby', false);
    setQueryField('userLocation', null);
  }, [clearLocationGraphic, setQueryField]);

  const enableNearby = useCallback(async (): Promise<void> => {
    if (!showNearbySearch || locating) return;
    const requestId = locationRequestRef.current + 1;
    locationRequestRef.current = requestId;

    setLocationError(null);
    setLocating(true);
    setNearbyActive(true);
    setMapSelectActive(false);
    setBufferDistance(DEFAULT_BUFFER_UNITS);
    setQueryField('bufferDistance', DEFAULT_BUFFER_UNITS);
    setQueryField('mapSelect', false);

    try {
      const coordinates = await createGeolocationRequest();
      if (!mountedRef.current || requestId !== locationRequestRef.current) return;
      const point = await createLocationGraphic(coordinates, requestId);
      if (!mountedRef.current || requestId !== locationRequestRef.current || !point) return;

      setQueryField('showNearby', true);
      setQueryField('userLocation', point);
      windowManager.ShowMessage(
        Constants_MessageType.Success,
        Constants_UserMesssages.LOCATION_ALLOWED,
      );
    } catch (error) {
      if (!mountedRef.current || requestId !== locationRequestRef.current) return;
      const message = error instanceof Error && error.message
        ? error.message
        : Constants_UserMesssages.LOCATION_REJECTED;
      disableNearby();
      setLocationError(message);
      windowManager.ShowMessage(Constants_MessageType.Error, message);
    } finally {
      if (mountedRef.current && requestId === locationRequestRef.current) {
        setLocating(false);
      }
    }
  }, [
    createLocationGraphic,
    disableNearby,
    locating,
    setQueryField,
    showNearbySearch,
    windowManager,
  ]);

  const changeSearchNearby = (value: boolean): void => {
    if (value) void enableNearby();
    else disableNearby();
  };

  const changeMapSelect = (value: boolean): void => {
    if (!showMapSelect) return;
    setLocationError(null);
    setMapSelectActive(value);
    setQueryField('mapSelect', value);
    if (value) disableNearby();
  };

  const updateBufferUnits = (value: unknown): void => {
    const next = normalizeBufferUnits(value);
    setBufferDistance(next);
    setQueryField('bufferDistance', next);
  };

  const updateBufferMeters = (value: unknown): void => {
    const next = metersToBufferUnits(value);
    setBufferDistance(next);
    setQueryField('bufferDistance', next);
  };

  const minimized = windowManager.IsMinimized(windowId);
  const bufferMeters = bufferUnitsToMeters(bufferDistance);
  const distanceId = `${windowId}-nearby-distance`;
  const meterId = `${windowId}-nearby-distance-meters`;

  return (
    <>
      <button type="button" className="common-query-window-tool-button" onClick={() => windowManager.ToggleMinimiseWindow(windowId)} title="Pencereyi küçült" aria-label="Pencereyi küçült" aria-expanded={!minimized}>
        <BiChevronUp className="common-query-window-tool-minimise-button" aria-hidden="true" />
      </button>
      <button type="button" className="common-query-window-tool-button" onClick={() => windowManager.HideWindow(windowId)} title="Pencereyi kapat" aria-label="Pencereyi kapat">
        <RiCloseCircleFill className="common-query-window-tool-close-button" aria-hidden="true" />
      </button>
      {!minimized ? <div className="common-query-window-tools" aria-label="Sorgu araçları">
        {showNearbySearch ? (nearbyActive ? <button type="button" className="common-query-window-tool danger" onClick={() => changeSearchNearby(false)} disabled={locating} aria-pressed="true"><BiX className="common-query-window-tool-icon" aria-hidden="true" /><span>{locating ? 'Konum alınıyor…' : 'Yakınımda aramayı kapat'}</span></button> : <button type="button" className="common-query-window-tool" onClick={() => changeSearchNearby(true)} disabled={locating} aria-pressed="false"><img src="images/icons/common/yakinimdaara.png" alt="" aria-hidden="true" /><span>{locating ? 'Konum alınıyor…' : 'Yakınımda Ara'}</span></button>) : null}
        {showMapSelect ? (mapSelectActive ? <button type="button" className="common-query-window-tool danger" onClick={() => changeMapSelect(false)} aria-pressed="true"><BiX className="common-query-window-tool-icon" aria-hidden="true" /><span>Harita seçimini iptal et</span></button> : <button type="button" className="common-query-window-tool" onClick={() => changeMapSelect(true)} aria-pressed="false"><img src="images/icons/common/haritadansec.png" alt="" aria-hidden="true" /><span>Haritadan Seç</span></button>) : null}
      </div> : null}
      {locationError ? <p className="common-query-window-tools-error" role="alert">{locationError}</p> : null}
      {showNearbySearch && nearbyActive && !locating ? <div className="common-query-window-tools-body"><div className="common-query-window-tools-distance-row"><div className="common-query-window-tools-distance-range"><label htmlFor={distanceId}>Yakınlık mesafesi</label><input id={distanceId} type="range" min={MIN_BUFFER_UNITS} max={MAX_BUFFER_UNITS} value={bufferDistance} onChange={(event) => updateBufferUnits(event.target.value)} aria-valuetext={`${bufferMeters} metre`} /></div><div className="common-query-window-tools-buffer-distance-indicator"><label htmlFor={meterId}>Metre</label><input id={meterId} type="number" min={MIN_BUFFER_UNITS * 100} max={MAX_BUFFER_UNITS * 100} step="100" inputMode="numeric" value={bufferMeters} onChange={(event) => updateBufferMeters(event.target.value)} /><span aria-hidden="true">m</span></div></div><p className="common-query-window-tools-distance-help">Seçilen konumun {bufferMeters.toLocaleString('tr-TR')} metre çevresindeki kayıtlar sorgulanır.</p></div> : null}
      {showMapSelect && mapSelectActive ? <div className="common-query-window-tools-body"><div className="common-query-window-tools-mapselect-message" role="status"><BiInfoCircle aria-hidden="true" /><span>Lütfen haritaya tıklayarak bir öğe seçin.</span></div></div> : null}
    </>
  );
});

CommonQueryWindowTools.displayName = 'CommonQueryWindowTools';
