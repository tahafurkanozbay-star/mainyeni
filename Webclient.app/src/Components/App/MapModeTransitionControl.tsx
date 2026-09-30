import { useId, useSyncExternalStore, type ReactNode } from 'react';
import type { ExperienceMapMode } from '../../experience/experienceRuntime';
import type {
  MapModeTransitionModel,
  MapModeTransitionSource,
} from './mapModeTransitionModel';
import './MapModeTransitionControl.css';

export interface MapModeTransitionControlProps {
  readonly model: MapModeTransitionModel;
  readonly onRequest: (mode: ExperienceMapMode, source: MapModeTransitionSource) => void;
  readonly className?: string;
}

const modeDescription = (mode: ExperienceMapMode): string => mode === '3d'
  ? '3B sahne görünümüne geç'
  : '2B harita görünümüne geç';

const statusLabel = (phase: string): string => {
  if (phase === 'queued') return 'Sırada';
  if (phase === 'transitioning') return 'Geçiş yapılıyor';
  if (phase === 'error') return 'Geçiş sorunu';
  if (phase === 'ready') return 'Hazır';
  return 'Etkin';
};

export const MapModeTransitionControl = ({
  model,
  onRequest,
  className = '',
}: MapModeTransitionControlProps): ReactNode => {
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const statusId = useId();
  const retryId = useId();
  const classNames = ['map-mode-transition-control', className].filter(Boolean).join(' ');
  const canRetry = snapshot.phase === 'error' && snapshot.activeMode !== snapshot.desiredMode;

  const request = (mode: ExperienceMapMode, source: MapModeTransitionSource = 'control'): void => {
    if (snapshot.busy && snapshot.desiredMode === mode) return;
    onRequest(mode, source);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    if (event.key === 'ArrowLeft' || event.key === 'Home') request('2d');
    else request('3d');
  };

  return (
    <section
      className={classNames}
      data-phase={snapshot.phase}
      data-active-mode={snapshot.activeMode}
      data-desired-mode={snapshot.desiredMode}
      data-reduced-motion={String(snapshot.presentation.reducedMotion)}
      data-forced-colors={String(snapshot.presentation.forcedColors)}
      data-coarse-pointer={String(snapshot.presentation.coarsePointer)}
      aria-label="Harita görünüm modu"
      aria-busy={snapshot.busy}
    >
      <div className="map-mode-transition-control__header">
        <span className="map-mode-transition-control__eyebrow">Görünüm</span>
        <span className="map-mode-transition-control__status" aria-hidden="true">
          {statusLabel(snapshot.phase)}
        </span>
      </div>

      <div
        className="map-mode-transition-control__segments"
        role="group"
        aria-label="2B ve 3B görünüm seçimi"
        aria-describedby={statusId}
        onKeyDown={handleKeyDown}
      >
        {(['2d', '3d'] as const).map((mode) => {
          const active = snapshot.activeMode === mode;
          const desired = snapshot.desiredMode === mode;
          const pending = snapshot.busy && desired;
          return (
            <button
              key={mode}
              type="button"
              className="map-mode-transition-control__segment"
              aria-pressed={active}
              aria-label={modeDescription(mode)}
              aria-describedby={pending ? statusId : undefined}
              data-active={active || undefined}
              data-pending={pending || undefined}
              onClick={() => request(mode)}
            >
              <span className="map-mode-transition-control__mode" aria-hidden="true">
                {mode === '3d' ? '3B' : '2B'}
              </span>
              <span className="map-mode-transition-control__mode-label">
                {mode === '3d' ? 'Sahne' : 'Harita'}
              </span>
              {pending && (
                <span className="map-mode-transition-control__progress" aria-hidden="true" />
              )}
            </button>
          );
        })}
      </div>

      <p
        id={statusId}
        className="map-mode-transition-control__announcement"
        role={snapshot.phase === 'error' ? 'alert' : 'status'}
        aria-live={snapshot.phase === 'error' ? 'assertive' : 'polite'}
        aria-atomic="true"
      >
        {snapshot.announcement}
      </p>

      <div className="map-mode-transition-control__meta" aria-hidden="true">
        <span>{snapshot.activeMode === '3d' ? '3B çalışma alanı' : '2B çalışma alanı'}</span>
        {snapshot.lastDurationMs !== null && (
          <span>{snapshot.lastDurationMs} ms</span>
        )}
      </div>

      {canRetry && (
        <div className="map-mode-transition-control__recovery" id={retryId}>
          <span>Mevcut {snapshot.activeMode === '3d' ? '3B' : '2B'} görünüm korunuyor.</span>
          <button
            type="button"
            className="map-mode-transition-control__retry"
            onClick={() => request(snapshot.desiredMode, 'recovery')}
          >
            {snapshot.desiredMode === '3d' ? '3B geçişini yeniden dene' : '2B geçişini yeniden dene'}
          </button>
        </div>
      )}
    </section>
  );
};

export default MapModeTransitionControl;
