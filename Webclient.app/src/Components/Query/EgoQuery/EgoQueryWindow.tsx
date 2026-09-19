import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Tab, Tabs } from 'react-bootstrap';
import { EgoQueryBusiness } from '../../../Business/EgoQueryBusiness';
import {
  Constants_MessageType,
  Constants_ServiceResultType,
} from '../../../Core/Constants';
import { ContainerLoading } from '../../Common/Loading';
import {
  CommonQueryWindowTools,
  type CommonQueryWindowToolsHandle,
} from '../_Common/CommonQueryWindowTools';
import { normalizeErrorMessage } from '../_Common/QueryInteractionRuntime';
import type {
  ManagedQueryWindowHandle,
  ManagedQueryWindowManager,
  UnknownRecord,
} from '../_Common/QuerySurfaceContracts';
import './EgoQueryWindow.css';
import { EgoLinesQuery } from './EgoLinesQuery';
import { EgoStopsQuery } from './EgoStopsQuery';

const WINDOW_TITLE = 'EGO / Otobüs Durakları';
const WINDOW_LOGO = 'images/icons/sidebar/ulasimaglari.png';

interface EgoQueryState extends UnknownRecord {
  readonly name: string;
  readonly districtId: string;
  readonly nbhoodId: string;
  readonly mapSelect: boolean;
  readonly showNearby: boolean;
}

interface EgoQueryWindowProps {
  readonly id: string;
  readonly windowManager: ManagedQueryWindowManager;
}

interface ServiceEnvelope {
  readonly type?: unknown;
  readonly data?: unknown;
}

const DEFAULT_QUERY: EgoQueryState = Object.freeze({
  name: '',
  districtId: '',
  nbhoodId: '',
  mapSelect: false,
  showNearby: false,
});

const createDefaultQuery = (): EgoQueryState => ({ ...DEFAULT_QUERY });

const isServiceEnvelope = (value: unknown): value is ServiceEnvelope =>
  value !== null && typeof value === 'object';

const readSuccessfulCollection = (
  value: unknown,
): readonly UnknownRecord[] | null => {
  if (!isServiceEnvelope(value)) return null;
  if (value.type !== Constants_ServiceResultType.Success) return null;
  return Array.isArray(value.data)
    ? value.data.filter(
        (item): item is UnknownRecord =>
          item !== null && typeof item === 'object' && !Array.isArray(item),
      )
    : [];
};

export const EgoQueryWindow = forwardRef<
  ManagedQueryWindowHandle,
  EgoQueryWindowProps
>(({ id, windowManager }, ref): ReactNode => {
  const commonToolsComponentRef = useRef<CommonQueryWindowToolsHandle | null>(null);
  const mountedRef = useRef(true);
  const loadSequenceRef = useRef(0);

  const [lineList, setLineList] = useState<readonly UnknownRecord[] | null>(null);
  const [stopList, setStopList] = useState<readonly UnknownRecord[] | null>(null);
  const [query, setQuery] = useState<EgoQueryState>(createDefaultQuery);
  const [activeTab, setActiveTab] = useState('activeLines');
  const [errorMessage, setErrorMessage] = useState('');

  const visible = windowManager.IsVisible(id);
  const minimized = windowManager.IsMinimized(id);

  const setQueryField = useCallback((field: string, value: unknown): void => {
    if (!['name', 'districtId', 'nbhoodId', 'mapSelect', 'showNearby'].includes(field)) {
      return;
    }
    setQuery((current) => ({
      ...current,
      [field]: field === 'mapSelect' || field === 'showNearby'
        ? Boolean(value)
        : typeof value === 'string' || typeof value === 'number'
          ? String(value)
          : '',
    }));
  }, []);

  const resetWindow = useCallback((): void => {
    loadSequenceRef.current += 1;
    setQuery(createDefaultQuery());
    setActiveTab('activeLines');
    setErrorMessage('');
    commonToolsComponentRef.current?.OnClose();
  }, []);

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
    const sequence = ++loadSequenceRef.current;
    const commonTools = commonToolsComponentRef.current;

    const load = async (): Promise<void> => {
      const [linesResponse, stopsResponse] = await Promise.allSettled([
        EgoQueryBusiness.GetActiveLines(),
        EgoQueryBusiness.GetActiveStops(),
      ]);

      if (!mountedRef.current || sequence !== loadSequenceRef.current) return;

      const lineCollection = linesResponse.status === 'fulfilled'
        ? readSuccessfulCollection(linesResponse.value)
        : null;
      const stopCollection = stopsResponse.status === 'fulfilled'
        ? readSuccessfulCollection(stopsResponse.value)
        : null;

      setLineList(lineCollection ?? []);
      setStopList(stopCollection ?? []);

      if (lineCollection === null && stopCollection === null) {
        const rejectedReason = linesResponse.status === 'rejected'
          ? linesResponse.reason
          : stopsResponse.status === 'rejected'
            ? stopsResponse.reason
            : null;
        const message = normalizeErrorMessage(
          rejectedReason,
          'EGO hat ve durak bilgileri alınamadı.',
        );
        setErrorMessage(message);
        windowManager.ShowMessage(Constants_MessageType.Error, message);
      } else if (lineCollection === null || stopCollection === null) {
        setErrorMessage(
          'EGO verilerinin bir bölümü şu anda kullanılamıyor; erişilebilen kayıtlar gösteriliyor.',
        );
      }
    };

    void load();

    return () => {
      mountedRef.current = false;
      loadSequenceRef.current += 1;
      commonTools?.OnClose();
      windowManager.UnregisterWindow?.(id, ref);
    };
  }, [id, ref, windowManager]);

  const loading = lineList === null || stopList === null;

  return (
    <section
      className="common-query-window ego-query-window"
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
          showNearbySearch={false}
          showMapSelect={false}
        />
      </header>

      <div
        className={`common-query-window-body ${minimized ? 'common-query-window-body-collapsed' : ''}`}
      >
        {errorMessage ? (
          <div className="kr-status-banner kr-status-banner--warning" role="status">
            {errorMessage}
          </div>
        ) : null}

        {loading ? (
          <ContainerLoading />
        ) : (
          <Tabs
            activeKey={activeTab}
            onSelect={(key) => setActiveTab(key || 'activeLines')}
            className="ego-query-window-tabs"
            aria-label="EGO sorgu türü"
          >
            <Tab title={`Hatlar (${lineList.length})`} eventKey="activeLines">
              <EgoLinesQuery lines={lineList} showAll={false} />
            </Tab>
            <Tab title={`Duraklar (${stopList.length})`} eventKey="activeStops">
              <EgoStopsQuery stops={stopList} showAll={false} />
            </Tab>
          </Tabs>
        )}
      </div>
    </section>
  );
});

EgoQueryWindow.displayName = 'EgoQueryWindow';
