import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import {
  NotificationCenterModel,
  type NotificationCenterSnapshot,
} from '../../experience/notificationCenterModel';
import { ExperienceFeedbackCenter } from './ExperienceFeedbackCenter';
import './experience-feedback-center-overlay.css';

export interface ExperienceFeedbackCenterOverlayProps {
  readonly model: NotificationCenterModel;
}

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

export const ExperienceFeedbackCenterOverlay = ({
  model,
}: ExperienceFeedbackCenterOverlayProps): ReactNode => {
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
        <span className="experience-feedback-overlay__trigger-label">Bildirimler</span>
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
              />
            </div>
          </aside>
        </>
      ) : null}
    </div>
  );
};

export default ExperienceFeedbackCenterOverlay;
