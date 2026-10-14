import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
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
  readonly returnFocusId?: string;
  readonly onOpenCenter?: () => void;
  readonly onAction?: (notification: NotificationItem, action: NotificationAction) => void;
}

interface ExperienceNotificationToastsProps {
  readonly model: NotificationCenterModel;
  readonly maxVisibleToasts: number;
  readonly label: string;
  readonly returnFocusId?: string;
  readonly onOpenCenter?: () => void;
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
  returnFocusId,
  onOpenCenter,
}: ExperienceNotificationToastsProps): ReactNode => {
  const [snapshot, setSnapshot] = useState<NotificationCenterSnapshot>(() => model.snapshot());

  useEffect(() => model.subscribe(setSnapshot), [model]);

  const instanceId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<number | null>(null);
  const unreadItems = snapshot.items.filter((item) => !item.read);
  // Stable sorting keeps source order within each urgency group.
  unreadItems.sort((a, b) => Number(b.priority === 'urgent' || b.tone === 'error')
    - Number(a.priority === 'urgent' || a.tone === 'error'));
  const visibleItems = unreadItems.slice(0, normalizeVisible(maxVisibleToasts));
  const hiddenCount = unreadItems.length - visibleItems.length;

  useLayoutEffect(() => {
    const index = pendingFocus.current;
    if (index === null) return;
    pendingFocus.current = null;
    const list = listRef.current;
    if (!list) return;
    // Do not override focus deliberately moved by an action callback.
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body && active.isConnected) return;
    const cards = list.querySelectorAll<HTMLElement>('.experience-notification');
    const next = cards[Math.min(index, cards.length - 1)];
    const target = next?.querySelector<HTMLElement>('button:not(:disabled)') ?? next;
    const fallback = returnFocusId ? document.getElementById(returnFocusId) : null;
    if (target) target.focus();
    else if (fallback && !fallback.closest('[inert], [aria-hidden="true"]') && !fallback.matches(':disabled')) {
      fallback.focus();
    } else list.parentElement?.focus();
  }, [snapshot.revision, returnFocusId]);

  const prepareFocus = (id: string): void => {
    const cards = Array.from(listRef.current?.querySelectorAll<HTMLElement>('.experience-notification') ?? []);
    const index = cards.findIndex((card) => card.dataset.notificationId === id);
    if (index >= 0 && cards[index]?.contains(document.activeElement)) pendingFocus.current = index;
  };

  const activateAction = (notification: NotificationItem, action: NotificationAction): void => {
    prepareFocus(notification.id);
    model.markRead(notification.id);
    onAction?.(notification, action);
  };

  return (
    <aside
      className="experience-notifications experience-notifications--toasts"
      aria-label={label}
      tabIndex={-1}
      data-unread-count={snapshot.unreadCount}
      data-urgent-count={snapshot.urgentUnreadCount}
    >
      <ExperienceNotificationLiveRegions snapshot={snapshot} />

      <div ref={listRef} className="experience-notifications__list">
        {visibleItems.map((item) => (
          <article
            key={item.id}
            className={`experience-notification experience-notification--${item.tone}`}
            data-priority={item.priority}
            data-read={String(item.read)}
            data-notification-id={item.id}
            tabIndex={-1}
            aria-labelledby={`${instanceId}-notification-title-${encodeURIComponent(item.id)}`}
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
              <h3 id={`${instanceId}-notification-title-${encodeURIComponent(item.id)}`} className="experience-notification__title">
                {item.title}
              </h3>
              {item.message ? <p className="experience-notification__message">{item.message}</p> : null}
              {onAction && item.actions.length > 0 ? (
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
                  onClick={() => {
                    prepareFocus(item.id);
                    model.dismiss(item.id);
                  }}
                >
                  <span aria-hidden="true">×</span>
                </button>
              ) : null}
            </div>
          </article>
        ))}
      </div>
      {hiddenCount > 0 ? (
        <div className="experience-notifications__overflow">
          <span>{hiddenCount} bildirim daha var</span>
          {onOpenCenter ? (
            <button type="button" className="experience-notifications__secondary-action" onClick={onOpenCenter}>
              Tüm bildirimleri aç
            </button>
          ) : null}
        </div>
      ) : null}
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
  returnFocusId,
  onOpenCenter,
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
      {...(returnFocusId ? { returnFocusId } : {})}
      {...(onOpenCenter ? { onOpenCenter } : {})}
      {...(onAction ? { onAction } : {})}
    />
  );
};

export default ExperienceNotificationCenter;
