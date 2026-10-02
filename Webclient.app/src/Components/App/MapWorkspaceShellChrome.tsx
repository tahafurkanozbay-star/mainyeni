import {
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { runtimeDiagnostics } from '../../platform/runtime/runtimeDiagnostics';
import {
  createMapWorkspaceShellController,
  type MapWorkspaceShellController,
} from './mapWorkspaceShellController';
import { buildMapWorkspaceRegionGuideEntries } from './mapWorkspaceRegionGuide';
import {
  createMapWorkspaceShellModel,
  type MapWorkspaceShellModel,
  type MapWorkspaceShellPhase,
  type MapWorkspaceShellRegionId,
} from './mapWorkspaceShellModel';
import './MapWorkspaceShellChrome.css';

export interface MapWorkspaceShellChromeProps {
  readonly phase: MapWorkspaceShellPhase;
  readonly errorMessage?: string | null;
  readonly onRetry?: () => void;
  readonly model?: MapWorkspaceShellModel;
  readonly controller?: MapWorkspaceShellController;
}

const STATUS_LABELS: Readonly<Record<MapWorkspaceShellPhase, string>> = Object.freeze({
  booting: 'Hazırlanıyor',
  ready: 'Hazır',
  updating: 'Güncelleniyor',
  error: 'Hata',
});

const STATUS_ICONS: Readonly<Record<MapWorkspaceShellPhase, string>> = Object.freeze({
  booting: '…',
  ready: '✓',
  updating: '↻',
  error: '!',
});

const sanitizeVisibleError = (value: string | null | undefined): string | null => {
  if (!value) return null;
  let output = '';
  for (const character of value) {
    const code = character.codePointAt(0);
    output += code !== undefined && (code < 32 || code === 127) ? ' ' : character;
    if (output.length >= 180) break;
  }
  const normalized = output.replace(/\s+/gu, ' ').trim();
  return normalized || null;
};

interface RegionMenuProps {
  readonly model: MapWorkspaceShellModel;
  readonly controller: MapWorkspaceShellController;
}

const RegionMenu = ({ model, controller }: RegionMenuProps): ReactNode => {
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const detailsRef = useRef<HTMLDetailsElement | null>(null);
  const entries = buildMapWorkspaceRegionGuideEntries(snapshot.regions);

  const moveToRegion = (id: MapWorkspaceShellRegionId): void => {
    if (!controller.focusRegion(id)) return;
    if (detailsRef.current) detailsRef.current.open = false;
  };

  return (
    <details ref={detailsRef} className="map-workspace-shell__regions">
      <summary
        className="map-workspace-shell__regions-summary"
        aria-label="Çalışma alanı bölgeleri"
      >
        <span aria-hidden="true">⌘</span>
        <span>Bölgeler</span>
        <span className="map-workspace-shell__region-count" aria-hidden="true">
          {snapshot.availableRegionIds.length}
        </span>
      </summary>
      <div className="map-workspace-shell__region-menu" role="group" aria-label="Odaklanılabilir çalışma alanı bölgeleri">
        <p className="map-workspace-shell__region-help">
          Klavyede <kbd>F6</kbd> ile ileri, <kbd>Shift</kbd>+<kbd>F6</kbd> ile geri dolaşabilirsiniz.
        </p>
        <div className="map-workspace-shell__region-grid">
          {entries.map((region) => (
            <button
              key={region.id}
              type="button"
              className="map-workspace-shell__region-button"
              disabled={!region.available}
              aria-pressed={region.active || undefined}
              aria-label={`${region.shortLabel}. ${region.stateLabel}. ${region.purpose}`}
              data-region={region.id}
              onClick={() => moveToRegion(region.id)}
            >
              <span className="map-workspace-shell__region-dot" aria-hidden="true" />
              <span className="map-workspace-shell__region-name">{region.shortLabel}</span>
              <small className="map-workspace-shell__region-purpose">{region.purpose}</small>
              <span className="map-workspace-shell__region-state">{region.stateLabel}</span>
              <span className="map-workspace-shell__region-keyboard">{region.keyboardHint}</span>
            </button>
          ))}
        </div>
      </div>
    </details>
  );
};

export const MapWorkspaceShellChrome = ({
  phase,
  errorMessage,
  onRetry,
  model: suppliedModel,
  controller: suppliedController,
}: MapWorkspaceShellChromeProps): ReactNode => {
  const model = useMemo(() => suppliedModel ?? createMapWorkspaceShellModel({
    maxRetries: 3,
    onObserverError(error) {
      runtimeDiagnostics.captureError(error, {
        source: 'experience.map-workspace-shell.observer',
      }, 'warn');
    },
  }), [suppliedModel]);
  const controller = useMemo(() => suppliedController ?? createMapWorkspaceShellController({ model }), [model, suppliedController]);
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const visibleError = sanitizeVisibleError(errorMessage);

  useEffect(() => {
    const release = controller.install();
    return release;
  }, [controller]);

  useEffect(() => {
    model.setPhase(phase);
    controller.refreshAvailability();
  }, [controller, model, phase]);

  useEffect(() => () => {
    if (!suppliedController) controller.dispose();
    if (!suppliedModel) model.dispose();
  }, [controller, model, suppliedController, suppliedModel]);

  const handleRetry = (): void => {
    if (!onRetry || !model.requestRetry()) return;
    runtimeDiagnostics.record('experience.map-workspace-shell.retry', {
      attempt: model.getSnapshot().retryAttempt,
      maxRetries: model.getSnapshot().maxRetries,
    });
    onRetry();
  };

  const renderRecoveryAction = (): ReactNode => {
    if (snapshot.canRetry && onRetry) {
      return (
        <button type="button" className="map-workspace-shell__retry" onClick={handleRetry}>
          Haritayı yeniden hazırla
        </button>
      );
    }
    if (snapshot.canRetry) {
      return (
        <span className="map-workspace-shell__retry-limit" role="note">
          Bu ekranda yeniden başlatma eylemi kullanılamıyor. Bağlantınızı kontrol edip sayfayı yeniden yükleyebilirsiniz.
        </span>
      );
    }
    return (
      <span className="map-workspace-shell__retry-limit" role="note">
        Yeniden deneme güvenlik sınırına ulaşıldı. Bağlantınızı kontrol edip sayfayı yeniden yükleyebilirsiniz.
      </span>
    );
  };

  return (
    <aside
      className="map-workspace-shell"
      aria-label="Harita çalışma alanı durumu ve bölge navigasyonu"
      data-phase={snapshot.phase}
      data-tone={snapshot.tone}
      data-modality={snapshot.modality}
      data-active-region={snapshot.activeRegion ?? 'none'}
    >
      <div
        className="map-workspace-shell__status"
        role={snapshot.phase === 'error' ? 'alert' : 'status'}
        aria-live={snapshot.phase === 'error' ? 'assertive' : 'polite'}
        aria-atomic="true"
      >
        <span className="map-workspace-shell__status-icon" aria-hidden="true">
          {STATUS_ICONS[snapshot.phase]}
        </span>
        <span className="map-workspace-shell__status-copy">
          <strong>{STATUS_LABELS[snapshot.phase]}</strong>
          <span>{snapshot.visualMessage}</span>
        </span>
        {snapshot.busy ? <span className="map-workspace-shell__busy" aria-hidden="true" /> : null}
      </div>

      <RegionMenu model={model} controller={controller} />

      <p className="map-workspace-shell__keyboard-hint" aria-hidden="true">
        <kbd>F6</kbd>
        <span>Bölgeler arasında geç</span>
      </p>

      <span className="map-workspace-shell__announcement" aria-live="polite" aria-atomic="true">
        {snapshot.activeRegion
          ? `${snapshot.regions.find((region) => region.id === snapshot.activeRegion)?.label ?? 'Çalışma alanı'} bölgesi etkin.`
          : snapshot.announcement}
      </span>

      {snapshot.phase === 'error' ? (
        <section className="map-workspace-shell__recovery" aria-labelledby="map-workspace-shell-recovery-title">
          <div className="map-workspace-shell__recovery-copy">
            <span className="map-workspace-shell__recovery-eyebrow">Harita çalışma alanı</span>
            <h2 id="map-workspace-shell-recovery-title">Harita hazırlanamadı</h2>
            <p>
              {visibleError ?? 'Harita motoru başlatılırken bir sorun oluştu. Mevcut sayfa ve navigasyon kullanılabilir durumda.'}
            </p>
            <p className="map-workspace-shell__recovery-meta">
              Deneme {snapshot.retryAttempt}/{snapshot.maxRetries}
            </p>
          </div>
          {renderRecoveryAction()}
        </section>
      ) : null}
    </aside>
  );
};

export default MapWorkspaceShellChrome;