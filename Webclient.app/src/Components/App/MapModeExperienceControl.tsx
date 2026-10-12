import {
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  EXPERIENCE_COMMAND_EVENT,
  EXPERIENCE_MAP_MODE_EVENT,
  EXPERIENCE_RUNTIME_EVENT,
  type ExperienceMapMode,
  type ExperienceRuntimeSnapshot,
} from '../../experience/experienceRuntime';
import { runtimeDiagnostics } from '../../platform/runtime/runtimeDiagnostics';
import {
  MapModeExperienceModel,
  type MapModeExperienceSnapshot,
} from './mapModeExperienceModel';
import { MapModeFocusModel, type MapModeFocusMove } from './mapModeFocusModel';
import './MapModeExperienceControl.css';

export interface MapModeExperienceControlProps {
  readonly model?: MapModeExperienceModel;
  readonly requestTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;
const MIN_REQUEST_TIMEOUT_MS = 2_000;
const MAX_REQUEST_TIMEOUT_MS = 20_000;

const normalizeTimeout = (value: number | undefined): number => {
  if (!Number.isFinite(value)) return DEFAULT_REQUEST_TIMEOUT_MS;
  return Math.max(MIN_REQUEST_TIMEOUT_MS, Math.min(MAX_REQUEST_TIMEOUT_MS, Math.trunc(value ?? DEFAULT_REQUEST_TIMEOUT_MS)));
};

const isMapMode = (value: unknown): value is ExperienceMapMode => value === '2d' || value === '3d';

const dispatchModeCommand = (mode: ExperienceMapMode): boolean => {
  if (typeof window === 'undefined' || typeof CustomEvent === 'undefined') return false;
  return window.dispatchEvent(new CustomEvent(EXPERIENCE_COMMAND_EVENT, {
    detail: {
      name: 'map-mode',
      mode,
      source: 'map-mode-experience-control',
      timestamp: Date.now(),
    },
  }));
};

const requestMode = (model: MapModeExperienceModel, mode: ExperienceMapMode): void => {
  const requestId = model.requestMode(mode);
  if (requestId === null) return;
  if (!dispatchModeCommand(mode)) model.markDispatchRejected(requestId);
};

const retryRequestedMode = (model: MapModeExperienceModel): void => {
  const requestId = model.retry();
  if (requestId === null) return;
  const mode = model.getSnapshot().requestedMode;
  if (!mode || dispatchModeCommand(mode)) return;
  model.markDispatchRejected(requestId);
};

const transitionDetail = (snapshot: MapModeExperienceSnapshot): string => {
  if (snapshot.phase === 'requesting' && snapshot.requestedMode) {
    return `${snapshot.requestedMode === '3d' ? '3B' : '2B'} görünüm hazırlanıyor · ${snapshot.attempt}/${snapshot.maxAttempts}`;
  }
  if (snapshot.phase === 'error') {
    if (snapshot.errorKind === 'timeout') return 'Geçiş zaman aşımına uğradı';
    if (snapshot.errorKind === 'runtime-recovery') return 'Güvenli görünüm korundu';
    if (snapshot.errorKind === 'dispatch-rejected') return 'Geçiş isteği iletilemedi';
    return 'Geçiş tamamlanamadı';
  }
  if (snapshot.lastTransitionMs !== null && snapshot.lastTransitionMs >= 500) {
    const seconds = Math.max(0.1, snapshot.lastTransitionMs / 1_000).toFixed(1);
    return `Son geçiş ${seconds} sn`;
  }
  return snapshot.currentMode === '3d' ? '3B kamera ve sahne araçları etkin' : '2B harita araçları etkin';
};

export function MapModeExperienceControl({
  model: suppliedModel,
  requestTimeoutMs,
}: MapModeExperienceControlProps): ReactNode {
  const ownedModel = useMemo(() => suppliedModel ?? new MapModeExperienceModel({
    onObserverError(error) {
      runtimeDiagnostics.captureError(error, {
        source: 'experience.map-mode-control.observer',
      }, 'warn');
    },
  }), [suppliedModel]);
  const model = ownedModel;
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const focusModel = useMemo(() => new MapModeFocusModel({
    initialMode: model.getSnapshot().currentMode,
    onObserverError(error) {
      runtimeDiagnostics.captureError(error, {
        source: 'experience.map-mode-control.focus-observer',
      }, 'warn');
    },
  }), [model]);
  const focusSnapshot = useSyncExternalStore(focusModel.subscribe, focusModel.getSnapshot, focusModel.getSnapshot);
  const mode2DRef = useRef<HTMLButtonElement | null>(null);
  const mode3DRef = useRef<HTMLButtonElement | null>(null);
  const timeoutMs = normalizeTimeout(requestTimeoutMs);

  useEffect(() => {
    if (suppliedModel) return undefined;
    return () => model.dispose();
  }, [model, suppliedModel]);

  useEffect(() => () => focusModel.dispose(), [focusModel]);

  useEffect(() => {
    focusModel.sync(snapshot.currentMode, snapshot.phase === 'requesting');
  }, [focusModel, snapshot.currentMode, snapshot.phase]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    const onModeChanged = (event: Event): void => {
      const detail = (event as CustomEvent<{ mode?: unknown; source?: unknown }>).detail;
      if (!detail || !isMapMode(detail.mode)) return;
      model.confirmMode(detail.mode, detail.source);
    };

    const onRuntimeChanged = (event: Event): void => {
      const detail = (event as CustomEvent<ExperienceRuntimeSnapshot>).detail;
      if (!detail) return;
      model.setEnvironment({
        viewport: detail.viewport,
        reducedMotion: detail.reducedMotion,
        forcedColors: detail.forcedColors,
        coarsePointer: detail.coarsePointer,
      });
    };

    window.addEventListener(EXPERIENCE_MAP_MODE_EVENT, onModeChanged as EventListener);
    window.addEventListener(EXPERIENCE_RUNTIME_EVENT, onRuntimeChanged as EventListener);
    return () => {
      window.removeEventListener(EXPERIENCE_MAP_MODE_EVENT, onModeChanged as EventListener);
      window.removeEventListener(EXPERIENCE_RUNTIME_EVENT, onRuntimeChanged as EventListener);
    };
  }, [model]);

  useEffect(() => {
    if (snapshot.phase !== 'requesting') return undefined;
    const requestId = snapshot.requestId;
    const timer = window.setTimeout(() => model.markTimeout(requestId), timeoutMs);
    return () => window.clearTimeout(timer);
  }, [model, snapshot.phase, snapshot.requestId, timeoutMs]);

  const interactionDisabled = snapshot.phase === 'requesting';
  const statusRole = snapshot.phase === 'error' ? 'alert' : 'status';

  const focusModeButton = (mode: ExperienceMapMode): void => {
    const target = mode === '2d' ? mode2DRef.current : mode3DRef.current;
    target?.focus({ preventScroll: true });
  };

  const handleModeKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    let move: MapModeFocusMove | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') move = 'next';
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') move = 'previous';
    if (event.key === 'Home') move = 'first';
    if (event.key === 'End') move = 'last';
    if (!move) return;
    event.preventDefault();
    const next = focusModel.move(move);
    focusModeButton(next);
    if (next !== snapshot.currentMode) requestMode(model, next);
  };

  return (
    <section
      className="map-mode-experience"
      aria-label="Harita görünüm modu"
      data-phase={snapshot.phase}
      data-current-mode={snapshot.currentMode}
      data-viewport={snapshot.environment.viewport}
      data-coarse-pointer={String(snapshot.environment.coarsePointer)}
      data-reduced-motion={String(snapshot.environment.reducedMotion)}
      data-forced-colors={String(snapshot.environment.forcedColors)}
    >
      <div className="map-mode-experience__header">
        <span className="map-mode-experience__eyebrow">Görünüm</span>
        <strong className="map-mode-experience__title">
          {snapshot.currentMode === '3d' ? '3B sahne' : '2B harita'}
        </strong>
      </div>

      <div
        className="map-mode-experience__switcher"
        role="radiogroup"
        aria-label="2B veya 3B görünüm seç"
        aria-busy={interactionDisabled}
      >
        <button
          ref={mode2DRef}
          type="button"
          role="radio"
          className="map-mode-experience__mode"
          aria-checked={snapshot.currentMode === '2d'}
          aria-label="2B harita görünümüne geç"
          disabled={interactionDisabled}
          tabIndex={focusSnapshot.tabIndex2D}
          data-active={snapshot.currentMode === '2d' ? 'true' : 'false'}
          onFocus={() => focusModel.setFocused('2d')}
          onKeyDown={handleModeKeyDown}
          onClick={() => requestMode(model, '2d')}
        >
          <span aria-hidden="true">2B</span>
          <small>Harita</small>
        </button>
        <button
          ref={mode3DRef}
          type="button"
          role="radio"
          className="map-mode-experience__mode"
          aria-checked={snapshot.currentMode === '3d'}
          aria-label="3B sahne görünümüne geç"
          disabled={interactionDisabled}
          tabIndex={focusSnapshot.tabIndex3D}
          data-active={snapshot.currentMode === '3d' ? 'true' : 'false'}
          onFocus={() => focusModel.setFocused('3d')}
          onKeyDown={handleModeKeyDown}
          onClick={() => requestMode(model, '3d')}
        >
          <span aria-hidden="true">3B</span>
          <small>Sahne</small>
        </button>
      </div>

      <div className="map-mode-experience__status" role={statusRole} aria-live={snapshot.phase === 'error' ? 'assertive' : 'polite'} aria-atomic="true">
        <span className="map-mode-experience__status-dot" aria-hidden="true" />
        <span className="map-mode-experience__status-copy">
          <strong>{transitionDetail(snapshot)}</strong>
          <span className="experience-sr-only">{snapshot.announcement}</span>
        </span>
      </div>

      {snapshot.phase === 'error' ? (
        <div className="map-mode-experience__recovery">
          {snapshot.canRetry && snapshot.requestedMode ? (
            <button
              type="button"
              className="map-mode-experience__retry"
              onClick={() => retryRequestedMode(model)}
            >
              {snapshot.requestedMode === '3d' ? '3B görünümü yeniden dene' : '2B görünümü yeniden dene'}
            </button>
          ) : (
            <span className="map-mode-experience__limit">Görünüm geçişi için yeniden deneme sınırına ulaşıldı.</span>
          )}
        </div>
      ) : null}
    </section>
  );
}

export default MapModeExperienceControl;
