import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type Ref,
} from 'react';
import { LoggingBusiness } from '../../../Business/LoggingBusiness';
import { NumberingQueryBusiness } from '../../../Business/NumberingQueryBusiness';
import { Constants_MessageType, Constants_ServiceResultType } from '../../../Core/Constants';
import MapManager from '../../../Store/Managers/MapManager';
import { DebugHelper } from '../../../Toolbox/DebugHelper';
import { GisGraphicsHelper } from '../../../Toolbox/GisGraphicsHelper';
import { ExperienceSelect } from '../../Common/ExperienceForm';
import { ExperienceStatus } from '../../Common/ExperienceStatus';
import { SharedGISIcon } from '../../Common/SharedGISIcon';
import {
  CommonQueryWindowTools,
  type QueryWindowManagerLike,
} from '../_Common/CommonQueryWindowTools';
import {
  createLatestRequestGate,
  normalizeErrorMessage,
  safeClientLog,
} from '../_Common/QueryInteractionRuntime';
import './NumberingQueryWindow.css';

type UnknownRecord = Record<string, unknown>;

export interface NumberingFeature {
  readonly attr?: UnknownRecord | null;
  readonly geometry?: unknown;
}

interface NumberingServiceResult {
  readonly type?: unknown;
  readonly data?: readonly NumberingFeature[] | null;
  readonly message?: unknown;
  readonly errorMessage?: unknown;
}

export interface NumberingQueryState {
  readonly district: string;
  readonly districtName: string;
  readonly nbhood: string;
  readonly nbhoodName: string;
  readonly street: string;
  readonly streetName: string;
  readonly door: string;
}

export interface NumberingWindowHandle {
  readonly id: string;
  readonly visible: boolean;
  readonly minimized: boolean;
  readonly OnShow: () => void;
  readonly OnClose: () => void;
}

export interface NumberingWindowManager extends QueryWindowManagerLike {
  RegisterWindow(ref: Ref<NumberingWindowHandle>): void;
  IsVisible(id: string): boolean;
  ShowWindow(id: string): void;
}

export interface NumberingQueryWindowProps {
  readonly id: string;
  readonly windowManager: NumberingWindowManager;
}

type AddressLevel = 'district' | 'neighborhood' | 'street' | 'door';

const INITIAL_QUERY: NumberingQueryState = Object.freeze({
  district: '',
  districtName: '',
  nbhood: '',
  nbhoodName: '',
  street: '',
  streetName: '',
  door: '',
});

export const createInitialNumberingQuery = (): NumberingQueryState => ({
  ...INITIAL_QUERY,
});

const getAttributes = (item: NumberingFeature): UnknownRecord =>
  item.attr ?? {};

export const readNumberingOption = (
  item: NumberingFeature,
  valueKey: string,
  labelKey: string,
): Readonly<{ value: string; label: string }> | null => {
  const attributes = getAttributes(item);
  const rawValue = attributes[valueKey];
  const rawLabel = attributes[labelKey];
  if (
    rawValue === null
    || rawValue === undefined
    || String(rawValue).trim() === ''
  ) {
    return null;
  }

  return Object.freeze({
    value: String(rawValue),
    label: rawLabel === null || rawLabel === undefined
      ? String(rawValue)
      : String(rawLabel).trim(),
  });
};

export const normalizeNumberingOptions = (
  items: readonly NumberingFeature[] | null | undefined,
  valueKey: string,
  labelKey: string,
): readonly Readonly<{ value: string; label: string }>[] => {
  if (!Array.isArray(items)) return [];

  const seen = new Set<string>();
  const result: Array<Readonly<{ value: string; label: string }>> = [];

  for (const item of items) {
    const option = readNumberingOption(item, valueKey, labelKey);
    if (!option || seen.has(option.value)) continue;
    seen.add(option.value);
    result.push(option);
  }
  return result;
};

const selectedText = (event: ChangeEvent<HTMLSelectElement>): string =>
  event.target.value
    ? event.target.selectedOptions.item(0)?.textContent?.trim() ?? ''
    : '';

export const NumberingQueryWindow = forwardRef<
  NumberingWindowHandle,
  NumberingQueryWindowProps
>(({ id, windowManager }, ref) => {
  const [districtList, setDistrictList] = useState<readonly NumberingFeature[]>([]);
  const [nbhoodList, setNbhoodList] = useState<readonly NumberingFeature[]>([]);
  const [streetList, setStreetList] = useState<readonly NumberingFeature[]>([]);
  const [doorList, setDoorList] = useState<readonly NumberingFeature[]>([]);
  const [query, setQuery] = useState<NumberingQueryState>(createInitialNumberingQuery);
  const [loadingLevel, setLoadingLevel] = useState<AddressLevel | null>(null);
  const [errorMessage, setErrorMessage] = useState('');

  const mapViewRef = useRef<unknown>(null);
  const highlightGraphicRef = useRef<readonly unknown[] | null>(null);
  const requestGateRef = useRef(createLatestRequestGate());
  const mountedRef = useRef(false);

  const clearHighlight = useCallback((): void => {
    if (highlightGraphicRef.current && mapViewRef.current) {
      GisGraphicsHelper.RemoveGraphics(
        mapViewRef.current,
        highlightGraphicRef.current,
      );
    }
    highlightGraphicRef.current = null;
  }, []);

  const reportError = useCallback((error: unknown, fallback: string): void => {
    const message = normalizeErrorMessage(error, fallback);
    DebugHelper.Log(error);
    setErrorMessage(message);
    windowManager.ShowMessage(Constants_MessageType.Error, message);
  }, [windowManager]);

  const resetDependentLists = useCallback((level: AddressLevel = 'district'): void => {
    if (level === 'district') setNbhoodList([]);
    if (level === 'district' || level === 'neighborhood') setStreetList([]);
    if (level !== 'door') setDoorList([]);
  }, []);

  const resetWindow = useCallback((): void => {
    requestGateRef.current.invalidate();
    clearHighlight();
    setQuery(createInitialNumberingQuery());
    resetDependentLists();
    setLoadingLevel(null);
    setErrorMessage('');
  }, [clearHighlight, resetDependentLists]);

  const zoomToObject = useCallback(async (
    geometries: readonly unknown[],
    zoomLevel: number | null,
    requestId: number,
  ): Promise<void> => {
    const mapView = mapViewRef.current;
    if (!mapView || geometries.length === 0) return;

    try {
      const projected = (await Promise.all(
        geometries.map((geometry) => GisGraphicsHelper.ProjectGeometry(geometry, '4326')),
      )).filter(Boolean);

      if (!mountedRef.current || !requestGateRef.current.isCurrent(requestId)) return;
      if (projected.length === 0) return;

      clearHighlight();
      await Promise.resolve(
        GisGraphicsHelper.ZoomToGeometry(mapView, projected, zoomLevel),
      );

      if (!mountedRef.current || !requestGateRef.current.isCurrent(requestId)) return;

      const graphics = (await Promise.all(
        projected.map((geometry) => GisGraphicsHelper.CreateGraphicFromGeometry(geometry)),
      )).filter(Boolean);

      if (!mountedRef.current || !requestGateRef.current.isCurrent(requestId)) return;

      highlightGraphicRef.current = graphics;
      GisGraphicsHelper.AddGraphics(mapView, graphics);
    } catch (error) {
      if (mountedRef.current && requestGateRef.current.isCurrent(requestId)) {
        reportError(error, 'Adres konumu haritada gösterilemedi.');
      }
    }
  }, [clearHighlight, reportError]);

  const beginRequest = useCallback((level: AddressLevel): number => {
    const requestId = requestGateRef.current.next();
    setLoadingLevel(level);
    setErrorMessage('');
    return requestId;
  }, []);

  const finishRequest = useCallback((requestId: number): void => {
    if (mountedRef.current && requestGateRef.current.isCurrent(requestId)) {
      setLoadingLevel(null);
    }
  }, []);

  const onDistrictChange = useCallback(async (
    event: ChangeEvent<HTMLSelectElement>,
  ): Promise<void> => {
    const districtId = event.target.value;
    const districtName = selectedText(event);
    const requestId = beginRequest('district');

    setQuery((current) => ({
      ...current,
      district: districtId,
      districtName,
      nbhood: '',
      nbhoodName: '',
      street: '',
      streetName: '',
      door: '',
    }));
    resetDependentLists('district');
    clearHighlight();

    if (!districtId) {
      finishRequest(requestId);
      return;
    }

    try {
      const [districtResult, neighborhoodsResult] = await Promise.all([
        NumberingQueryBusiness.GetDistrictById(districtId) as Promise<NumberingServiceResult>,
        NumberingQueryBusiness.GetNeighborhoodsOfDistrict(districtId) as Promise<NumberingServiceResult>,
      ]);

      if (!mountedRef.current || !requestGateRef.current.isCurrent(requestId)) return;

      const districtGeometry = districtResult?.data?.[0]?.geometry;
      if (
        districtResult?.type === Constants_ServiceResultType.Success
        && districtGeometry
      ) {
        void zoomToObject([districtGeometry], null, requestId);
      }

      if (neighborhoodsResult?.type === Constants_ServiceResultType.Success) {
        setNbhoodList(Array.isArray(neighborhoodsResult.data) ? neighborhoodsResult.data : []);
      } else {
        setNbhoodList([]);
        reportError(
          neighborhoodsResult?.message ?? neighborhoodsResult?.errorMessage,
          'Mahalle listesi alınamadı.',
        );
      }
    } catch (error) {
      if (requestGateRef.current.isCurrent(requestId)) {
        setNbhoodList([]);
        reportError(error, 'İlçe bilgileri alınamadı.');
      }
    } finally {
      finishRequest(requestId);
    }
  }, [
    beginRequest,
    clearHighlight,
    finishRequest,
    reportError,
    resetDependentLists,
    zoomToObject,
  ]);

  const onNeighborhoodChange = useCallback(async (
    event: ChangeEvent<HTMLSelectElement>,
  ): Promise<void> => {
    const nbhoodId = event.target.value;
    const nbhoodName = selectedText(event);
    const requestId = beginRequest('neighborhood');

    setQuery((current) => ({
      ...current,
      nbhood: nbhoodId,
      nbhoodName,
      street: '',
      streetName: '',
      door: '',
    }));
    resetDependentLists('neighborhood');
    clearHighlight();

    if (!nbhoodId) {
      finishRequest(requestId);
      return;
    }

    try {
      const [neighborhoodResult, streetsResult] = await Promise.all([
        NumberingQueryBusiness.GetNeighborhoodById(nbhoodId) as Promise<NumberingServiceResult>,
        NumberingQueryBusiness.GetStreets(nbhoodId) as Promise<NumberingServiceResult>,
      ]);

      if (!mountedRef.current || !requestGateRef.current.isCurrent(requestId)) return;

      const neighborhoodGeometry = neighborhoodResult?.data?.[0]?.geometry;
      if (
        neighborhoodResult?.type === Constants_ServiceResultType.Success
        && neighborhoodGeometry
      ) {
        void zoomToObject([neighborhoodGeometry], null, requestId);
      }

      if (streetsResult?.type === Constants_ServiceResultType.Success) {
        setStreetList(Array.isArray(streetsResult.data) ? streetsResult.data : []);
      } else {
        setStreetList([]);
        reportError(
          streetsResult?.message ?? streetsResult?.errorMessage,
          'Cadde ve sokak listesi alınamadı.',
        );
      }
    } catch (error) {
      if (requestGateRef.current.isCurrent(requestId)) {
        setStreetList([]);
        reportError(error, 'Mahalle bilgileri alınamadı.');
      }
    } finally {
      finishRequest(requestId);
    }
  }, [
    beginRequest,
    clearHighlight,
    finishRequest,
    reportError,
    resetDependentLists,
    zoomToObject,
  ]);

  const onStreetChange = useCallback(async (
    event: ChangeEvent<HTMLSelectElement>,
  ): Promise<void> => {
    const streetId = event.target.value;
    const streetName = selectedText(event);
    const requestId = beginRequest('street');

    setQuery((current) => ({
      ...current,
      street: streetId,
      streetName,
      door: '',
    }));
    resetDependentLists('street');
    clearHighlight();

    if (!streetId) {
      finishRequest(requestId);
      return;
    }

    try {
      const [centerLines, doorsResult] = await Promise.all([
        NumberingQueryBusiness.GetStreetCenterLines(streetId) as Promise<readonly NumberingFeature[]>,
        NumberingQueryBusiness.GetDoors(streetId) as Promise<NumberingServiceResult>,
      ]);

      if (!mountedRef.current || !requestGateRef.current.isCurrent(requestId)) return;

      const geometries = Array.isArray(centerLines)
        ? centerLines.map((item) => item.geometry).filter(Boolean)
        : [];
      if (geometries.length) void zoomToObject(geometries, null, requestId);

      if (doorsResult?.type === Constants_ServiceResultType.Success) {
        setDoorList(Array.isArray(doorsResult.data) ? doorsResult.data : []);
      } else {
        setDoorList([]);
        reportError(
          doorsResult?.message ?? doorsResult?.errorMessage,
          'Bina numarası listesi alınamadı.',
        );
      }
    } catch (error) {
      if (requestGateRef.current.isCurrent(requestId)) {
        setDoorList([]);
        reportError(error, 'Sokak bilgileri alınamadı.');
      }
    } finally {
      finishRequest(requestId);
    }
  }, [
    beginRequest,
    clearHighlight,
    finishRequest,
    reportError,
    resetDependentLists,
    zoomToObject,
  ]);

  const onDoorChange = useCallback(async (
    event: ChangeEvent<HTMLSelectElement>,
  ): Promise<void> => {
    const doorId = event.target.value;
    const requestId = beginRequest('door');
    setQuery((current) => ({ ...current, door: doorId }));
    clearHighlight();

    if (!doorId) {
      finishRequest(requestId);
      return;
    }

    await safeClientLog(
      LoggingBusiness,
      'Numarataj/Sorgu',
      query.districtName
        + '/'
        + query.nbhoodName
        + '/'
        + query.streetName
        + '/'
        + doorId,
      DebugHelper.Log,
    );

    try {
      const result = await NumberingQueryBusiness.GetDoorById(
        doorId,
      ) as NumberingServiceResult;

      if (!mountedRef.current || !requestGateRef.current.isCurrent(requestId)) return;

      const geometry = result?.data?.[0]?.geometry;
      if (result?.type === Constants_ServiceResultType.Success && geometry) {
        await zoomToObject([geometry], 18, requestId);
      } else {
        reportError(
          result?.message ?? result?.errorMessage,
          'Bina konumu bulunamadı.',
        );
      }
    } catch (error) {
      if (requestGateRef.current.isCurrent(requestId)) {
        reportError(error, 'Bina bilgisi alınamadı.');
      }
    } finally {
      finishRequest(requestId);
    }
  }, [
    beginRequest,
    clearHighlight,
    finishRequest,
    query.districtName,
    query.nbhoodName,
    query.streetName,
    reportError,
    zoomToObject,
  ]);

  useImperativeHandle(ref, () => ({
    id,
    visible: false,
    minimized: false,
    OnShow: () => windowManager.ShowWindow('sidebar'),
    OnClose: resetWindow,
  }), [id, resetWindow, windowManager]);

  useEffect(() => {
    mountedRef.current = true;
    windowManager.RegisterWindow(ref);
    mapViewRef.current = MapManager.GetMapView();

    const requestId = requestGateRef.current.next();
    setLoadingLevel('district');

    Promise.resolve(NumberingQueryBusiness.GetDistricts())
      .then((result: NumberingServiceResult) => {
        if (!mountedRef.current || !requestGateRef.current.isCurrent(requestId)) return;
        if (result?.type === Constants_ServiceResultType.Success) {
          setDistrictList(Array.isArray(result.data) ? result.data : []);
        } else {
          setDistrictList([]);
          reportError(
            result?.message ?? result?.errorMessage,
            'İlçe listesi alınamadı.',
          );
        }
      })
      .catch((error: unknown) => {
        if (!mountedRef.current || !requestGateRef.current.isCurrent(requestId)) return;
        setDistrictList([]);
        reportError(error, 'İlçe listesi alınamadı.');
      })
      .finally(() => {
        finishRequest(requestId);
      });

    return () => {
      mountedRef.current = false;
      requestGateRef.current.invalidate();
      clearHighlight();
      mapViewRef.current = null;
    };
  }, [clearHighlight, finishRequest, ref, reportError, windowManager]);

  const districtOptions = useMemo(
    () => normalizeNumberingOptions(districtList, 'id', 'ad'),
    [districtList],
  );
  const neighborhoodOptions = useMemo(
    () => normalizeNumberingOptions(nbhoodList, 'id', 'ad'),
    [nbhoodList],
  );
  const streetOptions = useMemo(
    () => normalizeNumberingOptions(streetList, 'yolid', 'ad'),
    [streetList],
  );
  const doorOptions = useMemo(
    () => normalizeNumberingOptions(doorList, 'id', 'kapino'),
    [doorList],
  );

  const visible = windowManager.IsVisible(id);
  const loadingMessage = loadingLevel === 'district'
    ? 'İlçeler yükleniyor…'
    : loadingLevel === 'neighborhood'
      ? 'Mahalleler yükleniyor…'
      : loadingLevel === 'street'
        ? 'Cadde, sokak ve bina numaraları yükleniyor…'
        : loadingLevel === 'door'
          ? 'Bina konumu yükleniyor…'
          : '';

  return (
    <section
      className="common-query-window common-query-window-right"
      aria-labelledby={id + '-title'}
      aria-busy={loadingLevel !== null}
      aria-hidden={!visible}
      style={{ visibility: visible ? 'visible' : 'hidden' }}
    >
      <header className="common-query-window-header">
        <SharedGISIcon
          record={{ type: 'adres', category: 'Adres Arama', title: 'Adres Arama' }}
          size={34}
          className="common-query-window-header-icon"
        />
        <h2 id={id + '-title'}>Adres Arama</h2>
        <CommonQueryWindowTools
          windowManager={windowManager}
          windowId={id}
          showNearbySearch={false}
          showMapSelect={false}
        />
      </header>

      <div className="common-query-window-body">
        {loadingMessage ? (
          <ExperienceStatus tone="info" live="polite" busy>
            {loadingMessage}
          </ExperienceStatus>
        ) : null}
        {errorMessage ? (
          <ExperienceStatus tone="danger" live="assertive">
            {errorMessage}
          </ExperienceStatus>
        ) : null}

        <form aria-label="Adres bileşenleri" onSubmit={(event) => event.preventDefault()}>
          <ExperienceSelect
            id={id + '-district'}
            label="İlçe"
            value={query.district}
            onChange={(event) => { void onDistrictChange(event); }}
            disabled={loadingLevel === 'district'}
          >
            <option value="">Seçiniz…</option>
            {districtOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </ExperienceSelect>

          <ExperienceSelect
            id={id + '-neighborhood'}
            label="Mahalle"
            value={query.nbhood}
            onChange={(event) => { void onNeighborhoodChange(event); }}
            disabled={!query.district || loadingLevel === 'neighborhood'}
          >
            <option value="">Seçiniz…</option>
            {neighborhoodOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </ExperienceSelect>

          <ExperienceSelect
            id={id + '-street'}
            label="Cadde / Sokak"
            value={query.street}
            onChange={(event) => { void onStreetChange(event); }}
            disabled={!query.nbhood || loadingLevel === 'street'}
          >
            <option value="">Seçiniz…</option>
            {streetOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </ExperienceSelect>

          <ExperienceSelect
            id={id + '-door'}
            label="Bina No"
            value={query.door}
            onChange={(event) => { void onDoorChange(event); }}
            disabled={!query.street || loadingLevel === 'door'}
          >
            <option value="">Seçiniz…</option>
            {doorOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </ExperienceSelect>
        </form>
      </div>
    </section>
  );
});

NumberingQueryWindow.displayName = 'NumberingQueryWindow';
