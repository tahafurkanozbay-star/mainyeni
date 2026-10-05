import { useId, useMemo, type ReactNode } from 'react';
import {
  createFeedbackHistoryDigest,
  type FeedbackHistoryHealth,
} from '../../experience/feedbackHistoryDigest';
import type {
  FeedbackHistoryFilter,
  FeedbackHistoryState,
} from '../../experience/feedbackHistoryExperience';
import './experience-feedback-digest.css';

export interface ExperienceFeedbackDigestProps {
  readonly history: FeedbackHistoryState;
  readonly selectedFilter: FeedbackHistoryFilter;
  readonly onSelectFilter: (filter: FeedbackHistoryFilter) => void;
  readonly now?: number;
}

const HEALTH_LABELS: Readonly<Record<FeedbackHistoryHealth, string>> = Object.freeze({
  quiet: 'Sakin',
  stable: 'Kararlı',
  attention: 'Dikkat',
  critical: 'Kritik',
});

const TONE_LABELS = Object.freeze({
  danger: 'Hata',
  warning: 'Uyarı',
  success: 'Başarılı',
  neutral: 'Bilgi',
});

const toneSummary = (digest: ReturnType<typeof createFeedbackHistoryDigest>): string => {
  const parts: string[] = [];
  if (digest.toneCounts.danger > 0) parts.push(`${digest.toneCounts.danger} hata`);
  if (digest.toneCounts.warning > 0) parts.push(`${digest.toneCounts.warning} uyarı`);
  if (digest.toneCounts.success > 0) parts.push(`${digest.toneCounts.success} başarılı`);
  if (digest.toneCounts.neutral > 0) parts.push(`${digest.toneCounts.neutral} bilgi`);
  return parts.length > 0 ? parts.join(' · ') : 'Henüz ton dağılımı yok';
};

export const ExperienceFeedbackDigest = ({
  history,
  selectedFilter,
  onSelectFilter,
  now = Date.now(),
}: ExperienceFeedbackDigestProps): ReactNode => {
  const titleId = useId();
  const summaryId = useId();
  const digest = useMemo(() => createFeedbackHistoryDigest(history, now), [history, now]);
  const dominantToneLabel = digest.dominantTone ? TONE_LABELS[digest.dominantTone] : 'Yok';

  return (
    <aside
      className="experience-feedback-digest"
      data-health={digest.health}
      aria-labelledby={titleId}
      aria-describedby={summaryId}
    >
      <div className="experience-feedback-digest__lead">
        <div className="experience-feedback-digest__heading-row">
          <span className="experience-feedback-digest__health" data-health={digest.health}>
            <span className="experience-feedback-digest__health-dot" aria-hidden="true" />
            {HEALTH_LABELS[digest.health]}
          </span>
          <span className="experience-feedback-digest__fresh" aria-label={`${digest.timeCounts.fresh} yeni bildirim`}>
            Son 15 dk: <strong>{digest.timeCounts.fresh}</strong>
          </span>
        </div>
        <h3 id={titleId}>{digest.headline}</h3>
        <p id={summaryId}>{digest.summary}</p>
      </div>

      <div className="experience-feedback-digest__metrics" aria-label="Bildirim hızlı filtreleri">
        {digest.metrics.slice(0, 3).map((metric) => (
          <button
            key={metric.id}
            type="button"
            className="experience-feedback-digest__metric"
            data-emphasized={metric.emphasized || undefined}
            aria-pressed={selectedFilter === metric.filter}
            disabled={!metric.actionable}
            onClick={() => onSelectFilter(metric.filter)}
          >
            <span className="experience-feedback-digest__metric-value">{metric.value}</span>
            <span className="experience-feedback-digest__metric-label">{metric.label}</span>
          </button>
        ))}
      </div>

      <div className="experience-feedback-digest__details">
        <div className="experience-feedback-digest__detail-card">
          <span className="experience-feedback-digest__detail-label">Dağılım</span>
          <strong>{toneSummary(digest)}</strong>
          <span>Baskın ton: {dominantToneLabel}</span>
        </div>

        <div className="experience-feedback-digest__detail-card">
          <span className="experience-feedback-digest__detail-label">Zaman</span>
          <strong>{digest.timeCounts.today + digest.timeCounts.fresh} son 24 saat</strong>
          <span>{digest.timeCounts.older} daha eski kayıt</span>
        </div>

        <div className="experience-feedback-digest__detail-card" data-important={Boolean(digest.latestImportant) || undefined}>
          <span className="experience-feedback-digest__detail-label">Son önemli olay</span>
          {digest.latestImportant ? (
            <>
              <strong>{digest.latestImportant.title}</strong>
              <span>{digest.latestImportant.read ? 'İncelendi' : 'Henüz okunmadı'}</span>
            </>
          ) : (
            <>
              <strong>Bekleyen önemli olay yok</strong>
              <span>Çalışma alanı normal akışta.</span>
            </>
          )}
        </div>
      </div>

      {digest.recommendedFilter !== selectedFilter && digest.totalCount > 0 ? (
        <div className="experience-feedback-digest__recommendation">
          <span>
            {digest.recommendedFilter === 'important'
              ? 'Önemli olayları önce incelemek yararlı olabilir.'
              : digest.recommendedFilter === 'unread'
                ? 'Okunmamış bildirimleri hızlıca gözden geçirebilirsiniz.'
                : 'Tüm bildirimleri birlikte görüntüleyebilirsiniz.'}
          </span>
          <button
            type="button"
            onClick={() => onSelectFilter(digest.recommendedFilter)}
          >
            {digest.recommendedFilter === 'important'
              ? 'Önemlileri göster'
              : digest.recommendedFilter === 'unread'
                ? 'Okunmamışları göster'
                : 'Tümünü göster'}
          </button>
        </div>
      ) : null}
    </aside>
  );
};

export default ExperienceFeedbackDigest;
