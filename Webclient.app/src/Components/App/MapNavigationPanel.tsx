import { useEffect, useId, useRef, useState } from 'react';
import type { AddressGeocodingResult } from '../../data-services/addressGeocoding';
import type {
  InAppNavigationResult,
  InAppTravelMode,
} from '../../gis-engine/inAppNavigationRuntime';

type RouteField = 'origin' | 'destination';
type FieldState = Readonly<{
  query: string;
  selection: AddressGeocodingResult | null;
  candidates: readonly AddressGeocodingResult[];
  busy: boolean;
  error: string;
}>;

const EMPTY_FIELD: FieldState = Object.freeze({
  query: '',
  selection: null,
  candidates: Object.freeze([]),
  busy: false,
  error: '',
});

interface MapNavigationPanelProps {
  readonly onAddressSearch: (
    query: string,
    signal: AbortSignal,
  ) => Promise<readonly AddressGeocodingResult[]>;
  readonly onPlanRoute: (
    origin: AddressGeocodingResult,
    destination: AddressGeocodingResult,
    mode: InAppTravelMode,
    signal: AbortSignal,
  ) => Promise<InAppNavigationResult>;
  readonly onClearRoute: () => void;
  readonly onClose: () => void;
}

const formatDistance = (kilometers: number): string => (
  kilometers < 1
    ? `${Math.round(kilometers * 1000)} m`
    : `${new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 1 }).format(kilometers)} km`
);

const formatDuration = (minutes: number): string => {
  const roundedMinutes = Math.max(0, Math.round(minutes));
  if (roundedMinutes < 60) return `${roundedMinutes} dk`;
  const hours = Math.floor(roundedMinutes / 60);
  const remainder = roundedMinutes % 60;
  return remainder > 0 ? `${hours} sa ${remainder} dk` : `${hours} sa`;
};

export function MapNavigationPanel({
  onAddressSearch,
  onPlanRoute,
  onClearRoute,
  onClose,
}: MapNavigationPanelProps) {
  const id = useId().replace(/:/gu, '');
  const originInputRef = useRef<HTMLInputElement | null>(null);
  const searchControllersRef = useRef<Partial<Record<RouteField, AbortController>>>({});
  const routeControllerRef = useRef<AbortController | null>(null);
  const requestSequenceRef = useRef(0);
  const [fields, setFields] = useState<Record<RouteField, FieldState>>({
    origin: EMPTY_FIELD,
    destination: EMPTY_FIELD,
  });
  const [mode, setMode] = useState<InAppTravelMode>('driving');
  const [route, setRoute] = useState<InAppNavigationResult | null>(null);
  const [routeBusy, setRouteBusy] = useState(false);
  const [routeError, setRouteError] = useState('');

  useEffect(() => {
    originInputRef.current?.focus();
    return () => {
      searchControllersRef.current.origin?.abort();
      searchControllersRef.current.destination?.abort();
      routeControllerRef.current?.abort();
    };
  }, []);

  const updateField = (field: RouteField, update: Partial<FieldState>): void => {
    setFields((current) => ({
      ...current,
      [field]: { ...current[field], ...update },
    }));
  };

  const searchField = async (field: RouteField): Promise<void> => {
    const query = fields[field].query.trim();
    if (query.length < 2 || fields[field].busy) return;

    searchControllersRef.current[field]?.abort();
    const controller = new AbortController();
    searchControllersRef.current[field] = controller;
    updateField(field, { busy: true, candidates: [], error: '' });
    try {
      const candidates = await onAddressSearch(query, controller.signal);
      if (controller.signal.aborted || searchControllersRef.current[field] !== controller) return;
      if (candidates.length === 0) {
        updateField(field, { error: 'Adres bulunamadı. Daha açık bir adres deneyin.' });
        return;
      }
      updateField(field, { candidates: candidates.slice(0, 5) });
    } catch (error) {
      if (controller.signal.aborted || searchControllersRef.current[field] !== controller) return;
      updateField(field, {
        error: error instanceof Error && error.message
          ? error.message
          : 'Adres aranamadı. Yeniden deneyin.',
      });
    } finally {
      if (searchControllersRef.current[field] === controller) {
        delete searchControllersRef.current[field];
        updateField(field, { busy: false });
      }
    }
  };

  const changeField = (field: RouteField, query: string): void => {
    searchControllersRef.current[field]?.abort();
    delete searchControllersRef.current[field];
    routeControllerRef.current?.abort();
    routeControllerRef.current = null;
    setRouteBusy(false);
    setRouteError('');
    onClearRoute();
    setRoute(null);
    updateField(field, {
      query,
      selection: null,
      candidates: [],
      busy: false,
      error: '',
    });
  };

  const selectCandidate = (field: RouteField, selection: AddressGeocodingResult): void => {
    routeControllerRef.current?.abort();
    routeControllerRef.current = null;
    setRouteBusy(false);
    onClearRoute();
    setRoute(null);
    setRouteError('');
    updateField(field, {
      query: selection.displayName,
      selection,
      candidates: [],
      error: '',
    });
  };

  const calculateRoute = async (): Promise<void> => {
    const origin = fields.origin.selection;
    const destination = fields.destination.selection;
    if (!origin || !destination || routeBusy) return;

    routeControllerRef.current?.abort();
    const controller = new AbortController();
    routeControllerRef.current = controller;
    const sequence = ++requestSequenceRef.current;
    setRouteBusy(true);
    setRouteError('');
    try {
      const result = await onPlanRoute(origin, destination, mode, controller.signal);
      if (controller.signal.aborted || requestSequenceRef.current !== sequence) return;
      setRoute(result);
    } catch (error) {
      if (controller.signal.aborted || requestSequenceRef.current !== sequence) return;
      setRouteError(error instanceof Error && error.message
        ? error.message
        : 'Rota hesaplanamadı. Daha sonra yeniden deneyin.');
    } finally {
      if (requestSequenceRef.current === sequence) {
        routeControllerRef.current = null;
        setRouteBusy(false);
      }
    }
  };

  const cancelRoute = (): void => {
    requestSequenceRef.current += 1;
    routeControllerRef.current?.abort();
    routeControllerRef.current = null;
    setRouteBusy(false);
  };

  const clearRoute = (): void => {
    cancelRoute();
    onClearRoute();
    setRoute(null);
    setRouteError('');
  };

  const renderField = (field: RouteField, label: string, placeholder: string) => {
    const state = fields[field];
    const inputId = `map-navigation-${id}-${field}`;
    const resultId = `${inputId}-results`;
    return (
      <div className="map-navigation__field">
        <label htmlFor={inputId}>{label}</label>
        <div className="map-navigation__input-row">
          <input
            id={inputId}
            ref={field === 'origin' ? originInputRef : undefined}
            type="search"
            value={state.query}
            placeholder={placeholder}
            maxLength={180}
            autoComplete="off"
            aria-describedby={state.error ? `${inputId}-error` : undefined}
            aria-controls={state.candidates.length > 0 ? resultId : undefined}
            aria-expanded={state.candidates.length > 0}
            onChange={(event) => changeField(field, event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                if (state.selection) {
                  void calculateRoute();
                  return;
                }
                void searchField(field);
              }
              if (event.key === 'Escape' && state.candidates.length > 0) {
                updateField(field, { candidates: [] });
                event.stopPropagation();
              }
            }}
          />
          <button
            type="button"
            className="map-navigation__search"
            aria-label={`${label} adresini ara`}
            onClick={() => { void searchField(field); }}
            disabled={state.busy || state.query.trim().length < 2}
          >
            {state.busy ? <span className="map-navigation__spinner" aria-hidden="true" /> : 'Ara'}
          </button>
        </div>
        {state.error ? <p id={`${inputId}-error`} className="map-navigation__error" role="alert">{state.error}</p> : null}
        {state.candidates.length > 0 ? (
          <ul id={resultId} className="map-navigation__candidates" aria-label={`${label} adres seçenekleri`}>
            {state.candidates.map((candidate, index) => (
              <li key={`${candidate.latitude}:${candidate.longitude}:${index}`}>
                <button
                  type="button"
                  onClick={() => selectCandidate(field, candidate)}
                >
                  {candidate.displayName}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  };

  return (
    <aside
      id="map-navigation-panel"
      className="map-navigation"
      aria-label="Uygulama içi yol tarifi"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <div className="map-navigation__header">
        <div>
          <p className="map-navigation__eyebrow">KENT REHBERİ</p>
          <h2>Yol tarifi</h2>
        </div>
        <button
          type="button"
          className="map-navigation__close"
          onClick={onClose}
          aria-label="Yol tarifi panelini kapat"
        >
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="m6 6 12 12M18 6 6 18" />
          </svg>
        </button>
      </div>

      <form
        className="map-navigation__form"
        onSubmit={(event) => { event.preventDefault(); void calculateRoute(); }}
      >
        {renderField('origin', 'Başlangıç', 'Adres veya yer adı')}
        {renderField('destination', 'Varış', 'Adres veya yer adı')}
        <label className="map-navigation__mode" htmlFor={`map-navigation-${id}-mode`}>Ulaşım türü</label>
        <select
          id={`map-navigation-${id}-mode`}
          value={mode}
          onChange={(event) => {
            cancelRoute();
            setMode(event.currentTarget.value === 'walking' ? 'walking' : 'driving');
            onClearRoute();
            setRoute(null);
            setRouteError('');
          }}
        >
          <option value="driving">Araç</option>
          <option value="walking">Yürüyüş</option>
        </select>
        <button
          type="submit"
          className="map-navigation__submit"
          disabled={routeBusy || !fields.origin.selection || !fields.destination.selection}
        >
          {routeBusy ? 'Rota hesaplanıyor…' : 'Rotayı haritada göster'}
        </button>
        {routeBusy ? (
          <button type="button" className="map-navigation__cancel" onClick={cancelRoute}>
            Hesaplamayı iptal et
          </button>
        ) : null}
        <p className="map-navigation__disclaimer">
          Rota, Esri yol ağıyla hesaplanır; adresler servise gönderilir ve API kullanım kredisi gerekebilir.
        </p>
      </form>

      {routeError ? <p className="map-navigation__error" role="alert">{routeError}</p> : null}

      {route ? (
        <section className="map-navigation__route" aria-label="Hesaplanan rota">
          <div className="map-navigation__summary" aria-live="polite">
            <strong>{formatDuration(route.durationMinutes)}</strong>
            <span>{formatDistance(route.distanceKm)}</span>
            <span>{mode === 'walking' ? 'Yürüyüş' : 'Araç'}</span>
          </div>
          {route.steps.length > 0 ? (
            <ol className="map-navigation__steps" aria-label="Adım adım yönlendirme">
              {route.steps.map((step) => (
                <li key={step.id}>
                  <span>{step.instruction}</span>
                  {step.distanceKm > 0 ? <small>{formatDistance(step.distanceKm)}</small> : null}
                </li>
              ))}
            </ol>
          ) : (
            <p className="map-navigation__empty-steps">Rota haritada gösteriliyor. Adım adım yön bilgisi alınamadı.</p>
          )}
          <button type="button" className="map-navigation__clear" onClick={clearRoute}>
            Rotayı temizle
          </button>
        </section>
      ) : null}
    </aside>
  );
}
