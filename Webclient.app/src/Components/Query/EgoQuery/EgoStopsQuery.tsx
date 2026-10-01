import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from 'react';
import { LoggingBusiness } from '../../../Business/LoggingBusiness';
import MapManager from '../../../Store/Managers/MapManager';
import { GisGraphicsHelper } from '../../../Toolbox/GisGraphicsHelper';
import {
  ExperienceResponsiveDataTable,
  type ExperienceResponsiveDataColumn,
} from '../../Common/ExperienceResponsiveDataTable';
import { ContainerLoading, NoResultsFound } from '../../Common/Loading';
import {
  createLatestRequestGate,
  createOwnedResourceRegistry,
  normalizeErrorMessage,
  safeClientLog,
} from '../_Common/QueryInteractionRuntime';
import {
  filterEgoStops,
  type EgoStop,
} from '../_Common/QuerySearchRuntime';
import type { UnknownRecord } from '../_Common/QuerySurfaceContracts';
import './EgoStopsQueryModern.css';

const RESULT_LIMIT = 100;
const TABLE_PAGE_SIZE = 25;

interface EgoStopsQueryProps {
  readonly stops: readonly UnknownRecord[] | null | undefined;
  readonly showAll?: boolean;
}

const stopIdentity = (stop: EgoStop): string => `${stop.stopNo || 'stop'}:${stop.stopName || ''}`;

const stopRowKey = (stop: EgoStop, index: number): string => `${stopIdentity(stop)}:${index}`;

const stopRowLabel = (stop: EgoStop): string => {
  const number = stop.stopNo?.trim() || 'Numarasız';
  const name = stop.stopName?.trim() || 'İsimsiz durak';
  return `${number} ${name} konumunu haritada göster`;
};

export const EgoStopsQuery = ({
  stops,
  showAll = false,
}: EgoStopsQueryProps): ReactNode => {
  const requestGateRef = useRef(createLatestRequestGate());
  const resourceRegistryRef = useRef(createOwnedResourceRegistry<never, unknown>({
    removeGraphic: (graphic: unknown) => {
      MapManager.RemoveGraphics(graphic);
    },
  }));
  const mountedRef = useRef(true);

  const [searchText, setSearchText] = useState('');
  const [loadingStopKey, setLoadingStopKey] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState('');

  const filteredList = useMemo(
    () => filterEgoStops(stops, searchText, showAll).slice(0, RESULT_LIMIT),
    [searchText, showAll, stops],
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
    setSearchText('');
    setErrorMessage('');
    requestGateRef.current.invalidate();
  }, [stops]);

  const showDetails = useCallback(async (stop: EgoStop): Promise<void> => {
    const stopKey = stopIdentity(stop);
    const requestId = requestGateRef.current.next();

    setLoadingStopKey(stopKey);
    setErrorMessage('');
    void safeClientLog(
      LoggingBusiness,
      'EGO/Durak/Detay Göster',
      `${stop.stopNo}/${stop.stopName}`,
    );

    try {
      if (!Number.isFinite(stop.latitude) || !Number.isFinite(stop.longitude)) {
        throw new Error('Durak konum bilgisi geçersiz.');
      }

      const mapView = MapManager.GetMapView();
      if (!mapView) throw new Error('Harita görünümü hazır değil.');

      const point = await GisGraphicsHelper.CreatePoint({
        latitude: stop.latitude,
        longitude: stop.longitude,
      });
      if (!mountedRef.current || !requestGateRef.current.isCurrent(requestId)) return;

      const graphic = await GisGraphicsHelper.CreateGraphicFromGeometry(point);
      if (!mountedRef.current || !requestGateRef.current.isCurrent(requestId)) return;

      clearOwnedGraphics();
      resourceRegistryRef.current.trackGraphic(graphic);
      MapManager.AddGraphics(graphic, true);
      GisGraphicsHelper.ZoomToGeometry(mapView, point, 17);
    } catch (error) {
      if (!mountedRef.current || !requestGateRef.current.isCurrent(requestId)) return;
      setErrorMessage(normalizeErrorMessage(error, 'Durak haritada gösterilemedi.'));
    } finally {
      if (mountedRef.current && requestGateRef.current.isCurrent(requestId)) {
        setLoadingStopKey(null);
      }
    }
  }, [clearOwnedGraphics]);

  const columns = useMemo<readonly ExperienceResponsiveDataColumn<EgoStop>[]>(() => Object.freeze([
    Object.freeze({
      id: 'stopNo',
      header: 'Durak no',
      cell: (stop: EgoStop) => stop.stopNo || '—',
      priority: 0,
      essential: true,
      minimumWidth: 96,
      preferredWidth: 120,
    }),
    Object.freeze({
      id: 'stopName',
      header: 'Durak adı',
      cell: (stop: EgoStop) => stop.stopName || 'İsimsiz durak',
      priority: 1,
      essential: true,
      minimumWidth: 160,
      preferredWidth: 300,
    }),
    Object.freeze({
      id: 'lineType',
      header: 'Tür',
      cell: (stop: EgoStop) => (
        loadingStopKey === stopIdentity(stop)
          ? <span className="ego-stops-modern__busy">Konum açılıyor…</span>
          : stop.lineType || 'Durak'
      ),
      priority: 2,
      hideOnPhone: true,
      minimumWidth: 96,
      preferredWidth: 150,
    }),
  ]), [loadingStopKey]);

  if (stops === null || stops === undefined) return <ContainerLoading />;
  if (!Array.isArray(stops) || stops.length === 0) {
    return <NoResultsFound message="Aktif durak bulunamadı." />;
  }

  const visibleCount = filteredList.length;
  const totalCount = stops.length;
  const searchActive = searchText.trim().length > 0;

  return (
    <section
      className="ego-stops-modern"
      aria-labelledby="ego-stops-modern-title"
    >
      <header className="ego-stops-modern__header">
        <div>
          <h3 id="ego-stops-modern-title" className="ego-stops-modern__title">EGO durakları</h3>
          <p className="ego-stops-modern__description">
            Durakları arayın, tabloyu klavyeyle gezin ve Enter ile seçili durağı haritada açın.
          </p>
        </div>
        <output className="ego-stops-modern__count" aria-label="Durak sonuç sayısı">
          {visibleCount}/{Math.min(totalCount, RESULT_LIMIT)}
        </output>
      </header>

      <div className="ego-stops-modern__search-shell">
        <label className="ego-stops-modern__search-label" htmlFor="ego-stop-search">
          Durak ara
        </label>
        <div className="ego-stops-modern__search-row">
          <input
            id="ego-stop-search"
            type="search"
            className="ego-stops-modern__search"
            placeholder="Durak adıyla ya da numarasıyla arayın"
            value={searchText}
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              setSearchText(event.target.value);
            }}
            aria-describedby="ego-stop-search-status"
            autoComplete="off"
            spellCheck={false}
          />
          {searchText ? (
            <button
              type="button"
              className="ego-stops-modern__clear"
              onClick={() => setSearchText('')}
            >
              Temizle
            </button>
          ) : null}
        </div>
        <div
          id="ego-stop-search-status"
          className="ego-stops-modern__search-status"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {searchActive
            ? `${visibleCount} durak eşleşti`
            : showAll
              ? `${Math.min(totalCount, RESULT_LIMIT)} durak gösteriliyor`
              : 'Aramak için durak adı veya numarası yazın'}
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
            ? 'Aramanızla eşleşen durak bulunamadı.'
            : 'Durak aramak için en az bir karakter yazın.'}
        />
      ) : (
        <ExperienceResponsiveDataTable<EgoStop>
          rows={filteredList}
          columns={columns}
          getRowKey={stopRowKey}
          getRowLabel={(stop) => stopRowLabel(stop)}
          caption="EGO durak sonuçları"
          description="Yön tuşlarıyla satırlar arasında ilerleyin. Enter veya boşluk tuşuyla durağı haritada açın."
          selectionMode="none"
          onRowActivate={(stop) => {
            if (loadingStopKey === stopIdentity(stop)) return;
            void showDetails(stop);
          }}
          pageSize={TABLE_PAGE_SIZE}
          emptyTitle="Durak bulunamadı"
          emptyDescription="Arama ifadesini değiştirip yeniden deneyin."
          projectionStatusLabel="Durak tablosu sütun görünümü"
        />
      )}
    </section>
  );
};
