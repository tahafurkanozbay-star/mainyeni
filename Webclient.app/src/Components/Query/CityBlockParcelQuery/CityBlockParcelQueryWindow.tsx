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
import { TkgmQueryBusiness } from '../../../Business/TkgmQueryBusiness';
import { LoggingBusiness } from '../../../Business/LoggingBusiness';
import { AppConfig } from '../../../Core/AppConfig';
import { Constants_MessageType } from '../../../Core/Constants';
import MapManager from '../../../Store/Managers/MapManager';
import { GisGraphicsHelper } from '../../../Toolbox/GisGraphicsHelper';
import { ButtonLoading } from '../../Common/Loading';
import { CommonQueryWindowTools } from '../_Common/CommonQueryWindowTools';
import {
  createLatestRequestGate,
  normalizeErrorMessage,
  safeClientLog,
} from '../_Common/QueryInteractionRuntime';
import {
  normalizeQueryOptions,
  type ManagedQueryWindowHandle,
  type ManagedQueryWindowManager,
  type QueryOption,
  type UnknownRecord,
} from '../_Common/QuerySurfaceContracts';
import './CityBlockParcelQueryWindow.css';

interface CityBlockParcelQueryState extends UnknownRecord {
  readonly district: string;
  readonly districtName: string;
  readonly nbhood: string;
  readonly nbhoodName: string;
  readonly cityblock: string;
  readonly parcel: string;
}

interface ParcelGeometry {
  readonly coordinates?: unknown;
}

interface ParcelResult {
  readonly geometry?: ParcelGeometry | null;
}

interface CityBlockParcelQueryWindowProps {
  readonly id: string;
  readonly windowManager: ManagedQueryWindowManager;
}

const INITIAL_QUERY: CityBlockParcelQueryState = Object.freeze({
  district: '',
  districtName: '',
  nbhood: '',
  nbhoodName: '',
  cityblock: '',
  parcel: '',
});

const createInitialQuery = (): CityBlockParcelQueryState => ({ ...INITIAL_QUERY });

const isParcelResult = (value: unknown): value is ParcelResult =>
  value !== null
  && typeof value === 'object'
  && 'geometry' in value;

export const CityBlockParcelQueryWindow = forwardRef<
  ManagedQueryWindowHandle,
  CityBlockParcelQueryWindowProps
>(({ id, windowManager }, ref) => {
  const mapViewRef = useRef<unknown>(null);
  const parcelGraphicRef = useRef<unknown>(null);
  const districtGateRef = useRef(createLatestRequestGate());
  const parcelGateRef = useRef(createLatestRequestGate());
  const mountedRef = useRef(true);

  const [districtList, setDistrictList] = useState<readonly QueryOption[]>([]);
  const [nbhoodList, setNbhoodList] = useState<readonly QueryOption[]>([]);
  const [query, setQuery] = useState<CityBlockParcelQueryState>(createInitialQuery);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const visible = windowManager.IsVisible(id);
  const minimized = windowManager.IsMinimized(id);

  const clearParcelGraphic = useCallback((): void => {
    if (parcelGraphicRef.current === null) return;
    try {
      GisGraphicsHelper.RemoveGraphics(mapViewRef.current, parcelGraphicRef.current);
    } catch (error) {
      globalThis.reportError?.(error);
    } finally {
      parcelGraphicRef.current = null;
    }
  }, []);

  const resetWindow = useCallback((): void => {
    districtGateRef.current.invalidate();
    parcelGateRef.current.invalidate();
    clearParcelGraphic();
    setQuery(createInitialQuery());
    setNbhoodList([]);
    setLoading(false);
    setErrorMessage('');
  }, [clearParcelGraphic]);

  useImperativeHandle(ref, () => ({
    id,
    visible,
    minimized,
    OnShow: () => windowManager.ShowWindow('sidebar'),
    OnClose: resetWindow,
  }), [id, minimized, resetWindow, visible, windowManager]);

  useEffect(() => {
    mountedRef.current = true;
    windowManager.RegisterWindow(ref);
    mapViewRef.current = MapManager.GetMapView();

    let active = true;
    void Promise.resolve(TkgmQueryBusiness.GetDistricts(AppConfig.Api.TkgmCityId))
      .then((result: unknown) => {
        if (!active || !mountedRef.current) return;
        const options = normalizeQueryOptions(result);
        if (options.length === 0 && Array.isArray(result) && result.length > 0) {
          throw new Error('TKGM ilçe listesi doğrulanamadı.');
        }
        setDistrictList(options);
      })
      .catch((error: unknown) => {
        if (!active || !mountedRef.current) return;
        setDistrictList([]);
        const message = normalizeErrorMessage(error, 'TKGM ilçe listesi alınamadı.');
        setErrorMessage(message);
        windowManager.ShowMessage(Constants_MessageType.Error, message);
      });

    return () => {
      active = false;
      mountedRef.current = false;
      districtGateRef.current.invalidate();
      parcelGateRef.current.invalidate();
      clearParcelGraphic();
      mapViewRef.current = null;
      windowManager.UnregisterWindow?.(id, ref);
    };
  }, [clearParcelGraphic, id, ref, windowManager]);

  const setQueryField = useCallback((field: string, value: unknown): void => {
    if (!['district', 'districtName', 'nbhood', 'nbhoodName', 'cityblock', 'parcel'].includes(field)) {
      return;
    }
    setQuery((current) => ({
      ...current,
      [field]: typeof value === 'string' || typeof value === 'number'
        ? String(value)
        : '',
    }));
  }, []);

  const onDistrictChange = useCallback(async (
    event: ChangeEvent<HTMLSelectElement>,
  ): Promise<void> => {
    const district = event.target.value;
    const districtName = district ? event.target.selectedOptions[0]?.text ?? '' : '';
    const requestId = districtGateRef.current.next();

    setQuery((current) => ({
      ...current,
      district,
      districtName,
      nbhood: '',
      nbhoodName: '',
    }));
    setNbhoodList([]);
    setErrorMessage('');

    if (!district) return;

    try {
      const result = await TkgmQueryBusiness.GetNeighborhoodsOfDistrict(district);
      if (
        !mountedRef.current
        || !districtGateRef.current.isCurrent(requestId)
      ) {
        return;
      }

      const options = normalizeQueryOptions(result);
      if (options.length === 0 && Array.isArray(result) && result.length > 0) {
        throw new Error('TKGM mahalle listesi doğrulanamadı.');
      }
      setNbhoodList(options);
    } catch (error) {
      if (
        !mountedRef.current
        || !districtGateRef.current.isCurrent(requestId)
      ) {
        return;
      }

      setNbhoodList([]);
      const message = normalizeErrorMessage(error, 'TKGM mahalle listesi alınamadı.');
      setErrorMessage(message);
      windowManager.ShowMessage(Constants_MessageType.Error, message);
    }
  }, [windowManager]);

  const onNeighborhoodChange = useCallback((
    event: ChangeEvent<HTMLSelectElement>,
  ): void => {
    const nbhood = event.target.value;
    const nbhoodName = nbhood ? event.target.selectedOptions[0]?.text ?? '' : '';
    setQuery((current) => ({ ...current, nbhood, nbhoodName }));
  }, []);

  const getValidationMessage = useCallback((): string => {
    if (!query.district.trim()) return 'Lütfen ilçe seçiniz.';
    if (!query.nbhood.trim()) return 'Lütfen mahalle seçiniz.';
    if (!query.cityblock.trim() || query.cityblock.trim() === '0') {
      return 'Lütfen geçerli bir ada no giriniz.';
    }
    if (!query.parcel.trim() || query.parcel.trim() === '0') {
      return 'Lütfen geçerli bir parsel no giriniz.';
    }
    return '';
  }, [query]);

  const showParcel = useCallback(async (item: ParcelResult): Promise<void> => {
    const coordinates = item.geometry?.coordinates;
    if (coordinates === undefined || coordinates === null) {
      throw new Error('Parsel geometrisi bulunamadı.');
    }

    const geometry = await GisGraphicsHelper.CreatePolygonFromXYPoints(coordinates);
    const graphic = await GisGraphicsHelper.CreateGraphicFromGeometry(geometry);

    if (!mountedRef.current) return;

    clearParcelGraphic();
    parcelGraphicRef.current = graphic;
    GisGraphicsHelper.AddGraphics(mapViewRef.current, graphic);
    GisGraphicsHelper.ZoomToGeometryExtent(mapViewRef.current, geometry, 3);
  }, [clearParcelGraphic]);

  const submitQuery = useCallback(async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();
    if (loading) return;

    const validationMessage = getValidationMessage();
    if (validationMessage) {
      setErrorMessage(validationMessage);
      windowManager.ShowMessage(Constants_MessageType.Error, validationMessage);
      return;
    }

    const requestId = parcelGateRef.current.next();
    const logPayload = `${query.districtName}/${query.nbhoodName}/${query.cityblock}/${query.parcel}`;
    setLoading(true);
    setErrorMessage('');

    void safeClientLog(
      LoggingBusiness,
      'Ada Parsel/Sorgu',
      logPayload,
      globalThis.reportError,
    );

    try {
      const result: unknown = await TkgmQueryBusiness.GetParcels(query);
      if (
        !mountedRef.current
        || !parcelGateRef.current.isCurrent(requestId)
      ) {
        return;
      }

      if (!isParcelResult(result) || !result.geometry?.coordinates) {
        throw new Error('Parsel bulunamadı.');
      }

      void safeClientLog(
        LoggingBusiness,
        'Ada Parsel/Detay Göster',
        logPayload,
        globalThis.reportError,
      );
      await showParcel(result);
    } catch (error) {
      if (
        !mountedRef.current
        || !parcelGateRef.current.isCurrent(requestId)
      ) {
        return;
      }

      const message = normalizeErrorMessage(error, 'Parsel sorgusu tamamlanamadı.');
      setErrorMessage(message);
      windowManager.ShowMessage(Constants_MessageType.Error, message);
    } finally {
      if (
        mountedRef.current
        && parcelGateRef.current.isCurrent(requestId)
      ) {
        setLoading(false);
      }
    }
  }, [
    getValidationMessage,
    loading,
    query,
    showParcel,
    windowManager,
  ]);

  const districtId = `${id}-district`;
  const neighborhoodId = `${id}-neighborhood`;
  const cityBlockId = `${id}-cityblock`;
  const parcelId = `${id}-parcel`;
  const errorId = `${id}-error`;

  return (
    <section
      className="common-query-window common-query-window-right"
      aria-label="Ada-Parsel Arama"
      aria-hidden={!visible}
      style={{ visibility: visible ? 'visible' : 'hidden' }}
    >
      <header className="common-query-window-header">
        <img
          className="common-query-window-header-icon"
          src="images/icons/toolbar/adaparsel.png"
          alt=""
          aria-hidden="true"
        />
        <span>Ada-Parsel Arama</span>
        <CommonQueryWindowTools
          windowManager={windowManager}
          windowId={id}
          showNearbySearch={false}
          showMapSelect={false}
          setQueryField={() => undefined}
          query={null}
        />
      </header>

      <div
        className={`common-query-window-body ${minimized ? 'common-query-window-body-collapsed' : ''}`}
        aria-busy={loading}
      >
        <Form
          onSubmit={submitQuery}
          aria-label="Ada parsel filtreleri"
          aria-describedby={errorMessage ? errorId : undefined}
          noValidate
        >
          <Form.Group>
            <label className="form-label form-label-white" htmlFor={districtId}>
              İlçe
            </label>
            <select
              id={districtId}
              className="form-select"
              onChange={(event) => void onDistrictChange(event)}
              value={query.district}
              aria-invalid={!query.district && Boolean(errorMessage)}
            >
              <option value="">Seçiniz..</option>
              {districtList.map((item) => (
                <option key={item.id} value={item.id}>{item.label}</option>
              ))}
            </select>
          </Form.Group>

          <Form.Group>
            <label className="form-label form-label-white" htmlFor={neighborhoodId}>
              Mahalle
            </label>
            <select
              id={neighborhoodId}
              className="form-select"
              value={query.nbhood}
              onChange={onNeighborhoodChange}
              disabled={!query.district}
            >
              <option value="">Seçiniz..</option>
              {nbhoodList.map((item) => (
                <option key={item.id} value={item.id}>{item.label}</option>
              ))}
            </select>
          </Form.Group>

          <Form.Group>
            <label className="form-label form-label-white" htmlFor={cityBlockId}>
              Ada
            </label>
            <input
              id={cityBlockId}
              type="text"
              inputMode="numeric"
              autoComplete="off"
              className="form-control"
              value={query.cityblock}
              onChange={(event) => setQueryField('cityblock', event.target.value)}
            />
          </Form.Group>

          <Form.Group>
            <label className="form-label form-label-white" htmlFor={parcelId}>
              Parsel
            </label>
            <input
              id={parcelId}
              type="text"
              inputMode="numeric"
              autoComplete="off"
              className="form-control"
              value={query.parcel}
              onChange={(event) => setQueryField('parcel', event.target.value)}
            />
          </Form.Group>

          {errorMessage && (
            <div
              id={errorId}
              className="kr-status-banner kr-status-banner--danger"
              role="alert"
            >
              {errorMessage}
            </div>
          )}

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
        </Form>
      </div>
    </section>
  );
});

CityBlockParcelQueryWindow.displayName = 'CityBlockParcelQueryWindow';
