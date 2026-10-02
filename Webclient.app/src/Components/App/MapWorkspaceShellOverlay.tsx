import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { runtimeDiagnostics } from '../../platform/runtime/runtimeDiagnostics';
import {
  MapWorkspaceShellModel,
  type MapWorkspaceLandmarkId,
  type MapWorkspaceShellPhase,
} from './mapWorkspaceShellModel';
import { MapWorkspaceShellBrowserRuntime } from './mapWorkspaceShellBrowserRuntime';
import { resolveMapWorkspaceShellDensity } from './mapWorkspaceShellDensityPolicy';
import { MapWorkspaceShellKeyboardController } from './mapWorkspaceShellKeyboardController';
import { MapWorkspaceShellPlacementRuntime } from './mapWorkspaceShellPlacementRuntime';
import { MapWorkspaceShellSessionStore } from './mapWorkspaceShellSessionStore';
import './MapWorkspaceShellOverlay.css';

export interface MapWorkspaceShellOverlayProps {
  readonly phase?: MapWorkspaceShellPhase;
}

const PHASE_LABEL: Readonly<Record<MapWorkspaceShellPhase, string>> = Object.freeze({
  booting: 'Hazırlanıyor',
  ready: 'Hazır',
  updating: 'Güncelleniyor',
  error: 'Dikkat gerekiyor',
});

const PHASE_DETAIL: Readonly<Record<MapWorkspaceShellPhase, string>> = Object.freeze({
  booting: 'Harita araçları hazırlanıyor.',
  ready: 'Harita ve çalışma alanı kontrolleri kullanıma hazır.',
  updating: 'Harita verisi veya görünümü güncelleniyor; kontroller kullanılabilir.',
  error: 'Harita görünümü hazırlanamadı. Sayfa gezinmesi ve yardım seçenekleri kullanılabilir.',
});

const LANDMARK_HINT: Readonly<Record<MapWorkspaceLandmarkId, string>> = Object.freeze({
  map: 'Harita yüzeyine odaklan',
  navigation: 'Üst gezinmeye git',
  search: 'Adres, yer veya katman aramasına git',
  sidebar: 'Katman ve hizmet menüsüne git',
  toolbar: 'Harita araçlarına git',
  help: 'Çalışma alanı yardımını aç veya odakla',
});

const isWorkspacePhase = (value: string | undefined): value is MapWorkspaceShellPhase => (
  value === 'booting' || value === 'ready' || value === 'updating' || value === 'error'
);

export const MapWorkspaceShellOverlay = ({ phase }: MapWorkspaceShellOverlayProps) => {
  const rootRef = useRef<HTMLElement | null>(null);
  const model = useMemo(() => new MapWorkspaceShellModel({
    initialPhase: phase ?? 'booting',
    initialEnvironment: {
      width: typeof window === 'undefined' ? 1280 : window.innerWidth,
      height: typeof window === 'undefined' ? 720 : window.innerHeight,
      coarsePointer: false,
      reducedMotion: false,
      forcedColors: false,
    },
    onListenerError(error) {
      runtimeDiagnostics.captureError(error, { source: 'experience.workspace-shell.observer' }, 'warn');
    },
  }), []);
  const sessionStore = useMemo(() => new MapWorkspaceShellSessionStore({
    onError(error) {
      runtimeDiagnostics.captureError(error, { source: 'experience.workspace-shell.session' }, 'warn');
    },
  }), []);
  const runtimeRef = useRef<MapWorkspaceShellBrowserRuntime | null>(null);
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);

  useEffect(() => {
    if (phase) model.setPhase(phase);
  }, [model, phase]);

  useEffect(() => {
    if (phase || typeof document === 'undefined') return undefined;
    const mapRoot = document.getElementById('esri-map-container');
    if (!(mapRoot instanceof HTMLElement)) return undefined;

    const syncPhase = (): void => {
      const candidate = mapRoot.dataset.workspacePhase;
      if (isWorkspacePhase(candidate)) model.setPhase(candidate);
    };

    syncPhase();
    if (typeof MutationObserver === 'undefined') return undefined;
    const observer = new MutationObserver(syncPhase);
    observer.observe(mapRoot, { attributes: true, attributeFilter: ['data-workspace-phase'] });
    return () => observer.disconnect();
  }, [model, phase]);

  useEffect(() => {
    const preference = sessionStore.read();
    if (preference) model.setUtilityCollapsed(preference.collapsed);
  }, [model, sessionStore]);

  useEffect(() => {
    sessionStore.write({ collapsed: snapshot.utilityCollapsed });
  }, [sessionStore, snapshot.utilityCollapsed]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return undefined;
    const runtime = new MapWorkspaceShellBrowserRuntime(model, {
      onError(error) {
        runtimeDiagnostics.captureError(error, { source: 'experience.workspace-shell.focus' }, 'warn');
      },
    });
    const keyboard = new MapWorkspaceShellKeyboardController(model, runtime);
    runtimeRef.current = runtime;
    runtime.start();
    keyboard.attach();
    return () => {
      runtimeRef.current = null;
      keyboard.dispose();
      runtime.dispose();
    };
  }, [model]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof window === 'undefined' || typeof document === 'undefined') return undefined;
    const placement = new MapWorkspaceShellPlacementRuntime(root);
    placement.start();
    return () => placement.dispose();
  }, []);

  useEffect(() => () => model.dispose(), [model]);

  const focusLandmark = (id: MapWorkspaceLandmarkId): void => {
    const result = runtimeRef.current?.focus(id);
    if (!result?.ok) {
      runtimeDiagnostics.record('experience.workspace-shell.focus-unavailable', {
        landmarkId: id,
        reason: result?.reason ?? 'runtime-unavailable',
      });
    }
  };

  const availableLandmarks = snapshot.landmarks.filter((landmark) => landmark.available);
  const density = resolveMapWorkspaceShellDensity({
    viewport: snapshot.viewport,
    width: snapshot.width,
    height: snapshot.height,
    coarsePointer: snapshot.coarsePointer,
    phase: snapshot.phase,
    utilityCollapsed: snapshot.utilityCollapsed,
    availableLandmarkCount: snapshot.availableLandmarkCount,
  });
  const statusId = 'map-workspace-shell-status';

  return (
    <aside
      ref={rootRef}
      className="map-workspace-shell-overlay"
      data-viewport={snapshot.viewport}
      data-density={density.density}
      data-density-reason={density.reason}
      data-health={snapshot.healthTone}
      data-input-modality={snapshot.inputModality}
      data-coarse-pointer={String(snapshot.coarsePointer)}
      data-reduced-motion={String(snapshot.reducedMotion)}
      data-forced-colors={String(snapshot.forcedColors)}
      data-collapsed={String(snapshot.utilityCollapsed)}
      aria-label="Çalışma alanı durumu ve hızlı gezinme"
    >
      <div className="map-workspace-shell-overlay__status" aria-describedby={statusId}>
        <span className="map-workspace-shell-overlay__pulse" aria-hidden="true" />
        <span className="map-workspace-shell-overlay__status-copy">
          <strong>{PHASE_LABEL[snapshot.phase]}</strong>
          <span id={statusId} className={density.showStatusDetail ? undefined : 'experience-sr-only'}>{PHASE_DETAIL[snapshot.phase]}</span>
        </span>
        <span className="map-workspace-shell-overlay__count" aria-label={`${snapshot.availableLandmarkCount} hızlı gezinme hedefi`}>
          {snapshot.availableLandmarkCount}
        </span>
        <button
          type="button"
          className="map-workspace-shell-overlay__collapse"
          aria-expanded={density.showActions}
          aria-controls="map-workspace-shell-actions"
          onClick={() => model.toggleUtilityCollapsed()}
        >
          {snapshot.utilityCollapsed ? 'Hızlı gezinmeyi aç' : 'Daralt'}
        </button>
      </div>

      <div
        id="map-workspace-shell-actions"
        className="map-workspace-shell-overlay__actions"
        hidden={!density.showActions}
        aria-label="Hızlı gezinme hedefleri"
      >
        {availableLandmarks.map((landmark) => (
          <button
            key={landmark.id}
            type="button"
            className="map-workspace-shell-overlay__action"
            data-landmark={landmark.id}
            data-active={landmark.active || undefined}
            aria-current={landmark.active ? 'location' : undefined}
            aria-label={LANDMARK_HINT[landmark.id]}
            onClick={() => focusLandmark(landmark.id)}
          >
            <span>{landmark.shortLabel}</span>
          </button>
        ))}
        {density.showKeyboardHint ? (
          <span className="map-workspace-shell-overlay__shortcut-hint" aria-hidden="true">
            <kbd>F6</kbd> ileri · <kbd>Shift</kbd>+<kbd>F6</kbd> geri
          </span>
        ) : null}
      </div>

      <span className="map-workspace-shell-overlay__announcement experience-sr-only" aria-live="polite" aria-atomic="true">
        {snapshot.announcement}
      </span>
    </aside>
  );
};

export default MapWorkspaceShellOverlay;
