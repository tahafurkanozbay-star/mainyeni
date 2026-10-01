import type { ReactNode } from 'react';
import { ExperienceStatus } from '../../Common/ExperienceStatus';
import type {
  MeasurementActivityEntry,
  MeasurementExperienceSnapshot,
} from './measurementExperienceModel';
import './MeasurementExperiencePanel.css';

export interface MeasurementExperiencePanelProps {
  readonly snapshot: MeasurementExperienceSnapshot;
  readonly onRetry: () => void;
}

const toneFor = (snapshot: MeasurementExperienceSnapshot): 'info' | 'success' | 'warning' | 'danger' => {
  if (snapshot.phase === 'error') return 'danger';
  if (snapshot.phase === 'waiting-map') return 'warning';
  if (snapshot.activeTool) return 'success';
  return 'info';
};

const phaseLabel = (snapshot: MeasurementExperienceSnapshot): string => {
  switch (snapshot.phase) {
    case 'waiting-map': return 'Harita bekleniyor';
    case 'loading': return 'Hazırlanıyor';
    case 'ready': return snapshot.activeTool ? 'Ölçüm etkin' : 'Hazır';
    case 'error': return 'İşlem tamamlanamadı';
    case 'destroyed': return 'Oturum kapatıldı';
    default: return 'Hazır';
  }
};

const activityIcon = (entry: MeasurementActivityEntry): string => {
  switch (entry.kind) {
    case 'tool': return '◆';
    case 'clear': return '○';
    case 'retry': return '↻';
    case 'error': return '!';
    case 'opened': return '↗';
    case 'closed': return '×';
  }
};

const latestActivity = (entries: readonly MeasurementActivityEntry[]): readonly MeasurementActivityEntry[] => (
  entries.slice(Math.max(0, entries.length - 5)).reverse()
);

export const MeasurementExperiencePanel = ({
  snapshot,
  onRetry,
}: MeasurementExperiencePanelProps): ReactNode => {
  const recentActivity = latestActivity(snapshot.activity);
  const retryLabel = snapshot.retryCount > 0
    ? `Yeniden dene (${snapshot.retryCount}/${snapshot.maxRetries})`
    : 'Yeniden dene';

  return (
    <div
      className="measurement-experience"
      data-phase={snapshot.phase}
      data-input-modality={snapshot.modality}
    >
      <div className="measurement-experience__status-row">
        <ExperienceStatus
          tone={toneFor(snapshot)}
          live={snapshot.phase === 'error' ? 'assertive' : 'polite'}
        >
          {snapshot.announcement}
        </ExperienceStatus>
        <span className="measurement-experience__phase" aria-hidden="true">
          {phaseLabel(snapshot)}
        </span>
      </div>

      <section
        className="measurement-experience__guidance"
        aria-labelledby="measurement-experience-guidance-title"
      >
        <div className="measurement-experience__guidance-copy">
          <h3 id="measurement-experience-guidance-title">Ölçüm rehberi</h3>
          <p>{snapshot.guidance}</p>
        </div>
        <div
          className="measurement-experience__facts"
          role="group"
          aria-label="Ölçüm oturumu durumu"
        >
          <span>
            <strong>Harita</strong>
            <span>{snapshot.viewReady ? 'Hazır' : 'Bekleniyor'}</span>
          </span>
          <span>
            <strong>Girdi</strong>
            <span>{snapshot.modality === 'keyboard' ? 'Klavye' : snapshot.modality === 'pointer' ? 'İşaretçi' : 'Belirlenmedi'}</span>
          </span>
        </div>
      </section>

      {snapshot.phase === 'error' && (
        <section className="measurement-experience__recovery" role="alert" aria-labelledby="measurement-recovery-title">
          <div>
            <h3 id="measurement-recovery-title">Ölçüm aracı kullanılamıyor</h3>
            <p>{snapshot.errorMessage ?? 'Ölçüm aracı başlatılamadı.'}</p>
            {snapshot.errorCode && (
              <p className="measurement-experience__error-code">
                <span>Tanı kodu</span>
                <code>{snapshot.errorCode}</code>
              </p>
            )}
          </div>
          {snapshot.canRetry ? (
            <button
              type="button"
              className="measurement-experience__retry"
              onClick={onRetry}
            >
              {retryLabel}
            </button>
          ) : (
            <p className="measurement-experience__retry-limit">
              Yeniden deneme sınırına ulaşıldı. Pencereyi kapatıp harita hazır olduğunda yeniden açın.
            </p>
          )}
        </section>
      )}

      {snapshot.phase === 'waiting-map' && (
        <p className="measurement-experience__waiting" role="status">
          Harita görünümü hazır olduğunda araçlar otomatik olarak yeniden kullanılabilir hale gelir.
        </p>
      )}

      {recentActivity.length > 0 && (
        <details className="measurement-experience__activity">
          <summary>
            <span>Oturum hareketleri</span>
            <span className="measurement-experience__activity-count" aria-hidden="true">
              {snapshot.activity.length}
            </span>
          </summary>
          <ol aria-label="Son ölçüm oturumu hareketleri">
            {recentActivity.map((entry) => (
              <li key={entry.id}>
                <span className="measurement-experience__activity-icon" aria-hidden="true">
                  {activityIcon(entry)}
                </span>
                <span>{entry.label}</span>
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
};

export default MeasurementExperiencePanel;
