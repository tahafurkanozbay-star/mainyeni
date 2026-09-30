import { useCallback, useEffect, useRef, type MutableRefObject, type ReactNode } from 'react';
import MapManager from '../../Store/Managers/MapManager';
import type { ArcgisAccessorWatch } from '../../gis-engine/arcgisReactiveRuntime';
import type { ViewState } from '../../gis-engine/contracts';
import {
  EXPERIENCE_COMMAND_EVENT,
  EXPERIENCE_MAP_MODE_EVENT,
  type ExperienceMapMode,
} from '../../experience/experienceRuntime';
import { ExperienceMapModeBridge } from './ExperienceMapModeBridge';
import { MapModeTransitionControl } from './MapModeTransitionControl';
import {
  createMapModeTransitionCoordinator,
  type MapModeTransitionCoordinator,
} from './mapModeTransitionCoordinator';
import {
  createMapModeTransitionModel,
  type MapModeTransitionModel,
  type MapModeTransitionSource,
} from './mapModeTransitionModel';
import {
  createMapViewportContinuityModel,
  type MapViewportContinuityModel,
} from './mapViewportContinuityModel';

interface ArcGisMapViewLike {
  map: unknown;
  padding?: unknown;
  destroyed?: boolean;
  container?: unknown;
}

interface ViewStateBridgeLike {
  getState: () => ViewState;
}

export interface ExperienceMapModeGovernedBridgeProps {
  readonly mapView: ArcGisMapViewLike;
  readonly modeRef?: MutableRefObject<ExperienceMapMode>;
  readonly accessorWatch?: ArcgisAccessorWatch | undefined;
  readonly transitionTimeoutMs?: number;
}

interface ModeChangeDetail {
  readonly mode?: unknown;
  readonly source?: unknown;
}

const DEFAULT_TRANSITION_TIMEOUT_MS = 12_000;
const MIN_TRANSITION_TIMEOUT_MS = 2_000;
const MAX_TRANSITION_TIMEOUT_MS = 30_000;

const clampTimeout = (value: number | undefined): number => {
  if (!Number.isFinite(value)) return DEFAULT_TRANSITION_TIMEOUT_MS;
  return Math.max(MIN_TRANSITION_TIMEOUT_MS, Math.min(MAX_TRANSITION_TIMEOUT_MS, Math.trunc(value ?? DEFAULT_TRANSITION_TIMEOUT_MS)));
};

const mediaMatches = (query: string): boolean => (
  typeof window !== 'undefined'
  && typeof window.matchMedia === 'function'
  && window.matchMedia(query).matches
);

const createTransitionModel = (): MapModeTransitionModel => createMapModeTransitionModel({
  initialMode: '2d',
  reducedMotion: mediaMatches('(prefers-reduced-motion: reduce)'),
  forcedColors: mediaMatches('(forced-colors: active)'),
  coarsePointer: mediaMatches('(pointer: coarse)'),
});

const isExperienceMode = (value: unknown): value is ExperienceMapMode => value === '2d' || value === '3d';

const currentViewState = (): ViewState | null => {
  const bridge = MapManager.GetViewStateBridge?.() as ViewStateBridgeLike | null;
  if (!bridge?.getState) return null;
  try {
    return bridge.getState();
  } catch {
    return null;
  }
};

const dispatchModeCommand = (mode: ExperienceMapMode): boolean => {
  if (typeof window === 'undefined' || typeof CustomEvent === 'undefined') return false;
  return window.dispatchEvent(new CustomEvent(EXPERIENCE_COMMAND_EVENT, {
    detail: Object.freeze({
      name: 'map-mode',
      mode,
      source: 'governed-map-mode-control',
      timestamp: Date.now(),
    }),
  }));
};

const waitForMode = (
  targetMode: ExperienceMapMode,
  timeoutMs: number,
): Promise<ExperienceMapMode> => new Promise((resolve, reject) => {
  if (typeof window === 'undefined') {
    reject(new Error('MapModeWindowUnavailable'));
    return;
  }

  let settled = false;
  const finish = (mode: ExperienceMapMode): void => {
    if (settled) return;
    settled = true;
    window.clearTimeout(timeoutId);
    window.removeEventListener(EXPERIENCE_MAP_MODE_EVENT, onModeChange as EventListener);
    resolve(mode);
  };
  const fail = (): void => {
    if (settled) return;
    settled = true;
    window.removeEventListener(EXPERIENCE_MAP_MODE_EVENT, onModeChange as EventListener);
    reject(new Error('MapModeTransitionTimeout'));
  };
  const onModeChange = (event: Event): void => {
    const detail = (event as CustomEvent<ModeChangeDetail>).detail;
    if (!isExperienceMode(detail?.mode)) return;
    if (detail.mode === targetMode) finish(detail.mode);
  };
  const timeoutId = window.setTimeout(fail, timeoutMs);
  window.addEventListener(EXPERIENCE_MAP_MODE_EVENT, onModeChange as EventListener);
});

export const ExperienceMapModeGovernedBridge = ({
  mapView,
  modeRef,
  accessorWatch,
  transitionTimeoutMs,
}: ExperienceMapModeGovernedBridgeProps): ReactNode => {
  const timeoutMs = clampTimeout(transitionTimeoutMs);
  const modelRef = useRef<MapModeTransitionModel | null>(null);
  const continuityRef = useRef<MapViewportContinuityModel | null>(null);
  const coordinatorRef = useRef<MapModeTransitionCoordinator | null>(null);
  if (!modelRef.current) modelRef.current = createTransitionModel();
  if (!continuityRef.current) continuityRef.current = createMapViewportContinuityModel();
  const model = modelRef.current;
  const continuity = continuityRef.current;

  if (!coordinatorRef.current) {
    coordinatorRef.current = createMapModeTransitionCoordinator(model, async (targetMode, context) => {
      const sourceState = currentViewState();
      const completion = waitForMode(targetMode, timeoutMs);
      if (!dispatchModeCommand(targetMode)) throw new Error('MapModeCommandDispatchFailed');
      const activeMode = await completion;
      const targetState = currentViewState();
      if (sourceState && targetState) {
        continuity.assess(context.request.requestId, sourceState, targetState, targetMode);
      }
      return activeMode;
    });
  }
  const coordinator = coordinatorRef.current;

  const requestMode = useCallback((mode: ExperienceMapMode, source: MapModeTransitionSource): void => {
    void coordinator.request(mode, source);
  }, [coordinator]);

  useEffect(() => {
    coordinator.setExecutor(async (targetMode, context) => {
      const sourceState = currentViewState();
      const completion = waitForMode(targetMode, timeoutMs);
      if (!dispatchModeCommand(targetMode)) throw new Error('MapModeCommandDispatchFailed');
      const activeMode = await completion;
      const targetState = currentViewState();
      if (sourceState && targetState) {
        continuity.assess(context.request.requestId, sourceState, targetState, targetMode);
      }
      return activeMode;
    });
  }, [continuity, coordinator, timeoutMs]);

  useEffect(() => {
    const onModeChange = (event: Event): void => {
      const detail = (event as CustomEvent<ModeChangeDetail>).detail;
      if (!isExperienceMode(detail?.mode)) return;
      if (!model.getSnapshot().busy) model.acknowledge(detail.mode, 'runtime');
    };
    window.addEventListener(EXPERIENCE_MAP_MODE_EVENT, onModeChange as EventListener);
    return () => window.removeEventListener(EXPERIENCE_MAP_MODE_EVENT, onModeChange as EventListener);
  }, [model]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const forced = window.matchMedia('(forced-colors: active)');
    const coarse = window.matchMedia('(pointer: coarse)');
    const update = (): void => {
      model.setPresentation({
        reducedMotion: reduced.matches,
        forcedColors: forced.matches,
        coarsePointer: coarse.matches,
      });
    };
    update();
    reduced.addEventListener?.('change', update);
    forced.addEventListener?.('change', update);
    coarse.addEventListener?.('change', update);
    return () => {
      reduced.removeEventListener?.('change', update);
      forced.removeEventListener?.('change', update);
      coarse.removeEventListener?.('change', update);
    };
  }, [model]);

  useEffect(() => () => {
    coordinator.dispose();
    continuity.dispose();
    model.dispose();
  }, [continuity, coordinator, model]);

  return (
    <>
      <ExperienceMapModeBridge
        mapView={mapView as never}
        modeRef={modeRef}
        accessorWatch={accessorWatch}
      />
      <MapModeTransitionControl model={model} onRequest={requestMode} />
      <MapViewportContinuityStatus model={continuity} />
    </>
  );
};

const MapViewportContinuityStatus = ({ model }: { readonly model: MapViewportContinuityModel }): ReactNode => {
  const snapshot = React.useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  if (!snapshot.latestReport) return null;
  return (
    <output
      className="map-mode-continuity-status"
      data-status={snapshot.status}
      aria-live="polite"
      aria-label="Harita görünüm sürekliliği"
    >
      <span className="map-mode-continuity-status__indicator" aria-hidden="true" />
      <span>{snapshot.status === 'preserved' ? 'Konum korundu' : 'Konum kontrol edildi'}</span>
      <span className="map-mode-continuity-status__score" aria-hidden="true">{snapshot.latestReport.score}/100</span>
      <span className="map-mode-continuity-status__announcement">{snapshot.announcement}</span>
    </output>
  );
};

export default ExperienceMapModeGovernedBridge;
