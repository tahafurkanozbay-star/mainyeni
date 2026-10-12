import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { MapWorkspaceRecoveryModel } from './mapWorkspaceRecoveryModel';
import './MapWorkspaceRecoverySurface.css';

export interface MapWorkspaceRecoverySurfaceProps {
  readonly model: MapWorkspaceRecoveryModel;
  readonly onRetry: () => void;
  readonly delayedAfterMs?: number;
}

const DEFAULT_DELAYED_AFTER_MS = 6_000;
const MIN_DELAYED_AFTER_MS = 2_000;
const MAX_DELAYED_AFTER_MS = 30_000;

const normalizeDelay = (value: number | undefined): number => {
  if (!Number.isFinite(value)) return DEFAULT_DELAYED_AFTER_MS;
  return Math.max(MIN_DELAYED_AFTER_MS, Math.min(MAX_DELAYED_AFTER_MS, Math.trunc(value ?? DEFAULT_DELAYED_AFTER_MS)));
};

const durationLabel = (milliseconds: number | null): string | null => {
  if (milliseconds === null || milliseconds < 1_000) return null;
  const seconds = Math.max(1, Math.round(milliseconds / 1_000));
  return `${seconds} sn`;
};

export function MapWorkspaceRecoverySurface({
  model,
  onRetry,
  delayedAfterMs,
}: MapWorkspaceRecoverySurfaceProps): ReactNode {
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const delay = normalizeDelay(delayedAfterMs);

  useEffect(() => {
    if (snapshot.phase !== 'booting') return undefined;
    const attemptId = snapshot.attemptId;
    const timer = window.setTimeout(() => model.markDelayed(attemptId), delay);
    return () => window.clearTimeout(timer);
  }, [delay, model, snapshot.attemptId, snapshot.phase]);

  const visible = snapshot.phase === 'delayed' || snapshot.phase === 'error';
  if (!visible) return null;

  const isError = snapshot.phase === 'error';
  const elapsed = durationLabel(snapshot.lastDurationMs);

  return (
    <aside
      className="map-workspace-recovery"
      data-phase={snapshot.phase}
      role={isError ? 'alert' : 'status'}
      aria-live={isError ? 'assertive' : 'polite'}
      aria-atomic="true"
      aria-label={isError ? 'Harita başlatma sorunu' : 'Harita hazırlanıyor'}
    >
      <div className="map-workspace-recovery__icon" aria-hidden="true">
        {isError ? '!' : '…'}
      </div>
      <div className="map-workspace-recovery__content">
        <span className="map-workspace-recovery__eyebrow">
          {isError ? 'Çalışma alanı kurtarma' : 'Harita hazırlanıyor'}
        </span>
        <strong className="map-workspace-recovery__title">
          {isError ? 'Harita henüz kullanıma hazır değil' : 'Hazırlık beklenenden uzun sürüyor'}
        </strong>
        <p className="map-workspace-recovery__message">
          {isError
            ? snapshot.errorMessage
            : 'Katmanlar ve grafik bileşenleri hazırlanıyor. Sayfayı yenilemeden bekleyebilirsiniz.'}
        </p>
        <div className="map-workspace-recovery__meta" aria-label="Başlatma bilgileri">
          <span>Deneme {snapshot.attempt}/{snapshot.maxAttempts}</span>
          {elapsed ? <span>Son süre {elapsed}</span> : null}
        </div>
      </div>

      {isError ? (
        <div className="map-workspace-recovery__actions">
          {snapshot.canRetry ? (
            <button
              type="button"
              className="map-workspace-recovery__retry"
              onClick={() => {
                if (!model.canRetry()) return;
                onRetry();
              }}
            >
              Haritayı yeniden başlat
            </button>
          ) : (
            <span className="map-workspace-recovery__limit">
              Yeniden deneme sınırına ulaşıldı. Daha sonra sayfayı yeniden açabilirsiniz.
            </span>
          )}
        </div>
      ) : null}

      <span className="experience-sr-only">{snapshot.announcement}</span>
    </aside>
  );
}

export default MapWorkspaceRecoverySurface;
