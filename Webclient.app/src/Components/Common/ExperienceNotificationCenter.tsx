import { useEffect, useState, type ReactNode } from 'react';
import {
  NotificationCenterModel,
  type NotificationAction,
  type NotificationCenterSnapshot,
  type NotificationItem,
} from '../../experience/notificationCenterModel';
import { ExperienceFeedbackCenter } from './ExperienceFeedbackCenter';
import './experience-notification-center.css';

export interface ExperienceNotificationCenterProps {
  readonly model: NotificationCenterModel;
  readonly mode?: 'toasts' | 'center';
  readonly maxVisibleToasts?: number;
  readonly label?: string;
  readonly onAction?: (notification: NotificationItem, action: NotificationAction) => void;
}

interface ExperienceNotificationToastsProps {
  readonly model: NotificationCenterModel;
  readonly maxVisibleToasts: number;
  readonly label: string;
  readonly onAction?: (notification: NotificationItem, action: NotificationAction) => void;
}

interface ExperienceNotificationLiveRegionsProps {
  readonly snapshot: NotificationCenterSnapshot;
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

const ExperienceNotificationLiveRegions = ({ snapshot }: ExperienceNotificationLiveRegionsProps): ReactNode => (
  <>
    <div className="experience-notifications__live" aria-live="polite" aria-atomic="true">
      {snapshot.announcement?.politeness === 'polite' ? snapshot.announcement.text : ''}
    </div>
    <div className="experience-notifications__live" role="alert" aria-atomic="true">
      {snapshot.announcement?.politeness === 'assertive' ? snapshot.announcement.text : ''}
    </div>
  </>
);

const ExperienceNotificationToasts = ({
  model,
  maxVisibleToasts,
  label,
  onAction,
}: ExperienceNotificationToastsProps): ReactNode => {
  const [snapshot, setSnapshot] = useState<NotificationCenterSnapshot>(() => model.snapshot());

  useEffect(() => model.subscribe(setSnapshot), [model]);

  const visibleItems = snapshot.items
    .filter((item) => !item.read)
    .slice(0, normalizeVisible(maxVisibleToasts));

  const activateAction = (notification: NotificationItem, action: NotificationAction): void => {
    model.markRead(notification.id);
    onAction?.(notification, action);
  };

  return (
    <aside
      className="experience-notifications experience-notifications--toasts"
      aria-label={label}
      data-unread-count={snapshot.unreadCount}
      data-urgent-count={snapshot.urgentUnreadCount}
    >
      <ExperienceNotificationLiveRegions snapshot={snapshot} />

      <div className="experience-notifications__list">
        {visibleItems.map((item) => (
          <article
            key={item.id}
            className={`experience-notification experience-notification--${item.tone}`}
            data-priority={item.priority}
            data-read={String(item.read)}
            role={item.tone === 'error' ? 'alert' : 'status'}
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

const ExperienceNotificationCenterMode = ({
  model,
  label,
  onAction,
}: Pick<ExperienceNotificationCenterProps, 'model' | 'label' | 'onAction'> & { readonly label: string }): ReactNode => {
  const [snapshot, setSnapshot] = useState<NotificationCenterSnapshot>(() => model.snapshot());

  useEffect(() => model.subscribe(setSnapshot), [model]);

  return (
    <aside
      className="experience-notifications experience-notifications--center"
      aria-label={label}
      data-unread-count={snapshot.unreadCount}
      data-urgent-count={snapshot.urgentUnreadCount}
    >
      <ExperienceNotificationLiveRegions snapshot={snapshot} />
      <ExperienceFeedbackCenter
        model={model}
        label={label}
        callerId="experience-utility-notifications"
        {...(onAction ? { onAction } : {})}
      />
    </aside>
  );
};

export const ExperienceNotificationCenter = ({
  model,
  mode = 'toasts',
  maxVisibleToasts = 4,
  label = 'Bildirimler',
  onAction,
}: ExperienceNotificationCenterProps): ReactNode => {
  if (mode === 'center') {
    return (
      <ExperienceNotificationCenterMode
        model={model}
        label={label}
        {...(onAction ? { onAction } : {})}
      />
    );
  }

  return (
    <ExperienceNotificationToasts
      model={model}
      maxVisibleToasts={maxVisibleToasts}
      label={label}
      {...(onAction ? { onAction } : {})}
    />
  );
};

export default ExperienceNotificationCenter;
