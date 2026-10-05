import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import {
  NotificationCenterModel,
  type NotificationAction,
  type NotificationCenterSnapshot,
  type NotificationItem,
} from '../../experience/notificationCenterModel';
import { ExperienceFeedbackCenter } from './ExperienceFeedbackCenter';
import './experience-notification-center.css';
import './experience-feedback-center-overlay.css';

export interface ExperienceNotificationCenterProps {
  readonly model: NotificationCenterModel;
  readonly mode?: 'toasts' | 'center' | 'drawer';
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

const triggerLabel = (snapshot: NotificationCenterSnapshot): string =>
  snapshot.unreadCount > 0
    ? `Bildirimler, ${snapshot.unreadCount} okunmamış`
    : 'Bildirimler';

const unreadSummary = (snapshot: NotificationCenterSnapshot): string => {
  if (snapshot.unreadCount === 0) return 'Yeni bildirim yok';
  if (snapshot.urgentUnreadCount > 0) {
    return `${snapshot.unreadCount} okunmamış, ${snapshot.urgentUnreadCount} önemli`;
  }
  return `${snapshot.unreadCount} okunmamış`;
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

const ExperienceNotificationDrawer = ({
  model,
  label,
  onAction,
}: Pick<ExperienceNotificationCenterProps, 'model' | 'label' | 'onAction'> & { readonly label: string }): ReactNode => {
  const [snapshot, setSnapshot] = useState<NotificationCenterSnapshot>(() => model.snapshot());
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => model.subscribe(setSnapshot), [model]);

  useEffect(() => {
    if (!open) return undefined;
    const frame = window.requestAnimationFrame(() => closeRef.current?.focus({ preventScroll: true }));
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      event.preventDefault();
      setOpen(false);
      window.requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }));
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const close = (): void => {
    setOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }));
  };

  const onPanelKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    close();
  };

  return (
    <div className="experience-feedback-overlay" data-open={String(open)}>
      <ExperienceNotificationLiveRegions snapshot={snapshot} />
      <button
        ref={triggerRef}
        id="experience-feedback-trigger"
        type="button"
        className="experience-feedback-overlay__trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="experience-feedback-drawer"
        aria-label={triggerLabel(snapshot)}
        title={unreadSummary(snapshot)}
        onClick={() => setOpen((value) => !value)}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
          <path d="M10 21h4" />
        </svg>
        <span className="experience-feedback-overlay__trigger-label">{label}</span>
        {snapshot.unreadCount > 0 ? (
          <span
            className="experience-feedback-overlay__badge"
            aria-hidden="true"
            data-urgent={String(snapshot.urgentUnreadCount > 0)}
          >
            {snapshot.unreadCount > 99 ? '99+' : snapshot.unreadCount}
          </span>
        ) : null}
      </button>

      {open ? (
        <>
          <button
            type="button"
            className="experience-feedback-overlay__scrim"
            aria-label="Bildirim merkezini kapat"
            onClick={close}
          />
          <aside
            id="experience-feedback-drawer"
            className="experience-feedback-overlay__drawer"
            role="dialog"
            aria-modal="false"
            aria-labelledby="experience-feedback-drawer-title"
            aria-describedby="experience-feedback-drawer-description"
            onKeyDown={onPanelKeyDown}
          >
            <div className="experience-feedback-overlay__drawer-head">
              <div>
                <p className="experience-feedback-overlay__eyebrow">Çalışma alanı</p>
                <h2 id="experience-feedback-drawer-title">Bildirimler ve işlem geçmişi</h2>
                <p id="experience-feedback-drawer-description">{unreadSummary(snapshot)}. Harita üzerinde çalışmaya devam ederken geçmişi inceleyebilirsiniz.</p>
              </div>
              <button
                ref={closeRef}
                type="button"
                className="experience-feedback-overlay__close"
                aria-label="Bildirim merkezini kapat"
                onClick={close}
              >
                <span aria-hidden="true">×</span>
              </button>
            </div>
            <div className="experience-feedback-overlay__content">
              <ExperienceFeedbackCenter
                model={model}
                label="Bildirim geçmişi"
                callerId="experience-feedback-trigger"
                {...(onAction ? { onAction } : {})}
              />
            </div>
          </aside>
        </>
      ) : null}
    </div>
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
  if (mode === 'drawer') {
    return (
      <ExperienceNotificationDrawer
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
