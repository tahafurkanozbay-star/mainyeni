import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from 'react';
import { Accordion, InputGroup } from 'react-bootstrap';
import { BiSearch } from 'react-icons/bi';
import { EgoQueryBusiness } from '../../../Business/EgoQueryBusiness';
import { LoggingBusiness } from '../../../Business/LoggingBusiness';
import { Constants_ServiceResultType } from '../../../Core/Constants';
import MapManager from '../../../Store/Managers/MapManager';
import { GisGraphicsHelper } from '../../../Toolbox/GisGraphicsHelper';
import { ContainerLoading, NoResultsFound } from '../../Common/Loading';
import {
  createLatestRequestGate,
  createOwnedResourceRegistry,
  normalizeErrorMessage,
  safeClientLog,
} from '../_Common/QueryInteractionRuntime';
import {
  filterEgoLines,
  parseRouteCoordinatePairs,
  type EgoLine,
} from '../_Common/QuerySearchRuntime';
import type { UnknownRecord } from '../_Common/QuerySurfaceContracts';
import { EgoStopsQuery } from './EgoStopsQuery';

const RESULT_LIMIT = 40;

interface EgoLinesQueryProps {
  readonly lines: readonly UnknownRecord[] | null | undefined;
  readonly showAll?: boolean;
}

interface EgoLineDetails {
  readonly duraklar?: readonly UnknownRecord[] | null;
  readonly guzergah?: unknown;
}

const readLineDetails = (value: unknown): EgoLineDetails => {
  if (value === null || typeof value !== 'object') return {};
  return value as EgoLineDetails;
};

export const EgoLinesQuery = ({
  lines,
  showAll = false,
}: EgoLinesQueryProps): ReactNode => {
  const requestGateRef = useRef(createLatestRequestGate());
  const resourceRegistryRef = useRef(createOwnedResourceRegistry<never, unknown>({
    removeGraphic: (graphic: unknown) => {
      MapManager.RemoveGraphics(graphic);
    },
  }));
  const mountedRef = useRef(true);

  const [searchText, setSearchText] = useState('');
  const [stopsList, setStopsList] = useState<readonly UnknownRecord[]>([]);
  const [activeLineKey, setActiveLineKey] = useState<string | null>(null);
  const [loadingLineKey, setLoadingLineKey] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState('');

  const filteredList = useMemo(
    () => filterEgoLines(lines, searchText, showAll).slice(0, RESULT_LIMIT),
    [lines, searchText, showAll],
  );

  const clearOwnedGraphics = useCallback((): void => {
    resourceRegistryRef.current.clearGraphics();
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const requestGate = requestGateRef.current;
    return () => {
      mountedRef.current = false;
      requestGate.invalidate();
      clearOwnedGraphics();
    };
  }, [clearOwnedGraphics]);

  useEffect(() => {
    requestGateRef.current.invalidate();
    clearOwnedGraphics();
    setSearchText('');
    setStopsList([]);
    setActiveLineKey(null);
    setLoadingLineKey(null);
    setErrorMessage('');
  }, [clearOwnedGraphics, lines]);

  const showDetails = useCallback(async (line: EgoLine): Promise<void> => {
    if (!line.lineNo) return;

    const lineKey = `${line.lineNo}:${line.lineName}`;
    const requestId = requestGateRef.current.next();

    setActiveLineKey(lineKey);
    setLoadingLineKey(lineKey);
    setStopsList([]);
    setErrorMessage('');
    void safeClientLog(
      LoggingBusiness,
      'EGO/Hat/Detay Göster',
      `${line.lineNo}/${line.lineName}`,
    );

    try {
      const response = await EgoQueryBusiness.GetLineInfo(line.lineNo);
      if (!mountedRef.current || !requestGateRef.current.isCurrent(requestId)) return;

      if (response?.type !== Constants_ServiceResultType.Success) {
        throw new Error(
          typeof response?.message === 'string'
            ? response.message
            : 'Hat ayrıntıları alınamadı.',
        );
      }

      const details = readLineDetails(response?.data);
      setStopsList(Array.isArray(details.duraklar) ? details.duraklar : []);

      const points = parseRouteCoordinatePairs(details.guzergah);
      clearOwnedGraphics();
      if (points.length < 2) return;

      const mapView = MapManager.GetMapView();
      if (!mapView) throw new Error('Harita görünümü hazır değil.');

      const polyline = await GisGraphicsHelper.CreatePolylineFromXYPoints([points]);
      if (!mountedRef.current || !requestGateRef.current.isCurrent(requestId)) return;

      const graphic = await GisGraphicsHelper.CreateGraphicFromGeometry(polyline);
      if (!mountedRef.current || !requestGateRef.current.isCurrent(requestId)) return;

      resourceRegistryRef.current.trackGraphic(graphic);
      MapManager.AddGraphics(graphic, true);
      GisGraphicsHelper.ZoomToGeometryExtent(mapView, polyline, 1.5);
    } catch (error) {
      if (!mountedRef.current || !requestGateRef.current.isCurrent(requestId)) return;
      setErrorMessage(normalizeErrorMessage(error, 'Hat ayrıntıları gösterilemedi.'));
    } finally {
      if (mountedRef.current && requestGateRef.current.isCurrent(requestId)) {
        setLoadingLineKey(null);
      }
    }
  }, [clearOwnedGraphics]);

  const closeLine = useCallback((lineKey: string): void => {
    if (activeLineKey !== lineKey) return;
    requestGateRef.current.invalidate();
    setActiveLineKey(null);
    setLoadingLineKey(null);
    setStopsList([]);
    setErrorMessage('');
    clearOwnedGraphics();
  }, [activeLineKey, clearOwnedGraphics]);

  if (lines === null || lines === undefined) return <ContainerLoading />;
  if (!Array.isArray(lines) || lines.length === 0) {
    return <NoResultsFound message="Aktif EGO hattı bulunamadı." />;
  }

  const visibleCount = filteredList.length;
  const totalCount = lines.length;
  const searchActive = searchText.trim().length > 0;

  return (
    <section
      className="ego-query-window-items-container"
      aria-label="EGO hatları"
    >
      <div className="ego-query-window-items-search">
        <InputGroup className="fulltextsearch-text-group ego-query-window-items-search-group">
          <label className="visually-hidden" htmlFor="ego-line-search">
            EGO hattı ara
          </label>
          <input
            id="ego-line-search"
            type="search"
            className="fulltextsearch-text-input"
            placeholder="Hat adıyla ya da numarasıyla arayın"
            value={searchText}
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              setSearchText(event.target.value);
            }}
            aria-describedby="ego-line-search-status"
            autoComplete="off"
          />
          <InputGroup.Text className="fulltextsearch-text-icon">
            <BiSearch size="2rem" aria-hidden="true" />
          </InputGroup.Text>
        </InputGroup>
        <div
          id="ego-line-search-status"
          className="ego-query-window-items-status"
          aria-live="polite"
        >
          {searchActive
            ? `${visibleCount} hat eşleşti`
            : showAll
              ? `${Math.min(totalCount, RESULT_LIMIT)} hat gösteriliyor`
              : 'Aramak için hat adı veya numarası yazın'}
        </div>
      </div>

      {errorMessage ? (
        <div className="kr-status-banner kr-status-banner--danger" role="alert">
          {errorMessage}
        </div>
      ) : null}

      {visibleCount === 0 ? (
        <NoResultsFound
          message={searchActive
            ? 'Aramanızla eşleşen hat bulunamadı.'
            : 'Hat aramak için en az bir karakter yazın.'}
        />
      ) : (
        <Accordion
          activeKey={activeLineKey ?? undefined}
          alwaysOpen={false}
        >
          {filteredList.map((line: EgoLine, index: number) => {
            const lineKey = `${line.lineNo || 'line'}:${line.lineName || ''}:${index}`;
            const identityKey = `${line.lineNo || 'line'}:${line.lineName || ''}`;
            const active = activeLineKey === identityKey;
            const busy = loadingLineKey === identityKey;

            return (
              <Accordion.Item eventKey={identityKey} key={lineKey}>
                <Accordion.Header
                  onClick={() => {
                    if (active) closeLine(identityKey);
                    else void showDetails(line);
                  }}
                >
                  <span className="ego-query-window-item">
                    <span className="ego-query-window-item-no">
                      {line.lineNo || '—'}
                    </span>
                    <span className="ego-query-window-item-name">
                      {line.lineName || 'İsimsiz hat'}
                    </span>
                    <span className="ego-query-window-item-type">
                      {busy ? 'Yükleniyor…' : line.lineType || 'Hat'}
                    </span>
                  </span>
                </Accordion.Header>
                <Accordion.Body>
                  <div
                    className="ego-query-window-item-details"
                    aria-busy={busy}
                  >
                    <div className="ego-query-window-item-details-header">
                      Hattın geçtiği duraklar
                    </div>
                    {busy ? (
                      <ContainerLoading />
                    ) : stopsList.length === 0 ? (
                      <NoResultsFound message="Bu hat için durak bilgisi bulunamadı." />
                    ) : (
                      <EgoStopsQuery stops={stopsList} showAll />
                    )}
                  </div>
                </Accordion.Body>
              </Accordion.Item>
            );
          })}
        </Accordion>
      )}
    </section>
  );
};
