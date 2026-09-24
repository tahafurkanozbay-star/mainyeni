import { useEffect, useState, type ReactNode } from 'react';
import {
  NotificationCenterModel,
  type NotificationAction,
  type NotificationCenterSnapshot,
  type NotificationItem,
} from '../../experience/notificationCenterModel';
import './experience-notification-center.css';

export interface ExperienceNotificationCenterProps {
  readonly model: NotificationCenterModel;
  readonly mode?: 'toasts' | 'center';
  readonly maxVisibleToasts?: number;
  readonly label?: string;
  readonly onAction?: (notification: NotificationItem, action: NotificationAction) => void;
}

const toneLabel = (tone: NotificationItem['tone']): string => {
  switch (tone) {
    case 'success': return 'Başarılı';
    case 'warning': return 'Uyarı';
    case 'error': return 'Hata';
    default: return 'Bilgi';
  }
};

const normalizeVisible = (value: number | undefined): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 4;
  return Math.max(1, Math.min(8, Math.floor(numeric)));
};

export const ExperienceNotificationCenter = ({
  model,
  mode = 'toasts',
  maxVisibleToasts = 4,
  label = 'Bildirimler',
  onAction,
}: ExperienceNotificationCenterProps): ReactNode => {
  const [snapshot, setSnapshot] = useState<NotificationCenterSnapshot>(() => model.snapshot());

  useEffect(() => model.subscribe(setSnapshot), [model]);

  const visibleItems = mode === 'toasts'
    ? snapshot.items.filter((item) => !item.read).slice(0, normalizeVisible(maxVisibleToasts))
    : snapshot.items;

  const activateAction = (notification: NotificationItem, action: NotificationAction): void => {
    model.markRead(notification.id);
    onAction?.(notification, action);
  };

  return (
    <aside
      className={`experience-notifications experience-notifications--${mode}`}
      aria-label={label}
      data-unread-count={snapshot.unreadCount}
      data-urgent-count={snapshot.urgentUnreadCount}
    >
      <div className="experience-notifications__live" aria-live="polite" aria-atomic="true">
        {snapshot.announcement?.politeness === 'polite' ? snapshot.announcement.text : ''}
      </div>
      <div className="experience-notifications__live" role="alert" aria-atomic="true">
        {snapshot.announcement?.politeness === 'assertive' ? snapshot.announcement.text : ''}
      </div>

      {mode === 'center' ? (
        <header className="experience-notifications__header">
          <div>
            <h2 className="experience-notifications__heading">{label}</h2>
            <p className="experience-notifications__summary">
              {snapshot.unreadCount > 0 ? `${snapshot.unreadCount} okunmamış bildirim` : 'Tüm bildirimler okundu'}
            </p>
          </div>
          <div className="experience-notifications__header-actions">
            <button
              type="button"
              className="experience-notifications__secondary-action"
              disabled={snapshot.unreadCount === 0}
              onClick={() => model.markAllRead()}
            >
              Tümünü okundu işaretle
            </button>
            <button
              type="button"
              className="experience-notifications__secondary-action"
              onClick={() => model.clearRead()}
            >
              Okunanları temizle
            </button>
          </div>
        </header>
      ) : null}

      <div className="experience-notifications__list" role={mode === 'center' ? 'list' : undefined}>
        {visibleItems.length === 0 ? (
          mode === 'center' ? (
            <div className="experience-notifications__empty" role="status">
              <strong>Yeni bildirim yok</strong>
              <span>İşlem ve harita durumları burada görünecek.</span>
            </div>
          ) : null
        ) : visibleItems.map((item) => (
          <article
            key={item.id}
            className={`experience-notification experience-notification--${item.tone}`}
            data-priority={item.priority}
            data-read={String(item.read)}
            role={mode === 'center' ? 'listitem' : item.tone === 'error' ? 'alert' : 'status'}
            aria-labelledby={`experience-notification-title-${item.id}`}
          >
            <div className="experience-notification__tone" aria-hidden="true">
              {item.tone === 'success' ? '✓' : item.tone === 'warning' ? '!' : item.tone === 'error' ? '×' : 'i'}
            </div>
            <div className="experience-notification__content">
              <div className="experience-notification__eyebrow">
                <span>{toneLabel(item.tone)}</span>
                {item.category !== 'general' ? <span>· {item.category}</span> : null}
                {item.occurrenceCount > 1 ? <span>· {item.occurrenceCount}×</span> : null}
              </div>
              <h3 id={`experience-notification-title-${item.id}`} className="experience-notification__title">
                {item.title}
              </h3>
              {item.message ? <p className="experience-notification__message">{item.message}</p> : null}
              {item.actions.length > 0 ? (
                <div className="experience-notification__actions" aria-label={`${item.title} işlemleri`}>
                  {item.actions.map((action) => (
                    <button
                      key={action.id}
                      type="button"
                      className="experience-notification__action"
                      onClick={() => activateAction(item, action)}
                    >
                      {action.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="experience-notification__controls">
              {mode === 'center' ? (
                <button
                  type="button"
                  className="experience-notification__icon-action"
                  aria-label={item.read ? `${item.title}: okunmadı işaretle` : `${item.title}: okundu işaretle`}
                  onClick={() => item.read ? model.markUnread(item.id) : model.markRead(item.id)}
                >
                  <span aria-hidden="true">{item.read ? '○' : '●'}</span>
                </button>
              ) : null}
              {item.dismissible ? (
                <button
                  type="button"
                  className="experience-notification__icon-action"
                  aria-label={`${item.title}: bildirimi kapat`}
                  onClick={() => model.dismiss(item.id)}
                >
                  <span aria-hidden="true">×</span>
                </button>
              ) : null}
            </div>
          </article>
        ))}
      </div>
    </aside>
  );
};

export default ExperienceNotificationCenter;