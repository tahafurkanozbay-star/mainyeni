import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import {
  type NotificationCenterModel,
  type NotificationCenterSnapshot,
} from '../../experience/notificationCenterModel';
import {
  NOTIFICATION_TRIAGE_SCOPES,
  createNotificationTriageSnapshot,
  createNotificationTriageState,
  notificationTriageKeyboardHelp,
  resolveNotificationTriageEffect,
  setNotificationTriageActive,
  setNotificationTriageExpanded,
  setNotificationTriageScope,
  toggleNotificationTriage,
  type NotificationTriageEffect,
  type NotificationTriageState,
} from '../../experience/notificationTriageExperience';
import { runtimeDiagnostics } from '../../platform/runtime/runtimeDiagnostics';
import './experience-notification-triage.css';

export interface ExperienceNotificationTriageProps {
  readonly model: NotificationCenterModel;
  readonly previewLimit?: number;
  readonly label?: string;
  readonly onOpenCenter?: () => void;
}

const commandTarget = (target: EventTarget | null) => target instanceof HTMLElement
  ? Object.freeze({
    tagName: target.tagName,
    isContentEditable: target.isContentEditable,
    role: target.getAttribute('role'),
  })
  : null;

const toneLabel = (tone: 'info' | 'success' | 'warning' | 'error'): string => {
  if (tone === 'error') return 'Hata';
  if (tone === 'warning') return 'Uyarı';
  if (tone === 'success') return 'Başarılı';
  return 'Bilgi';
};

const dispatchOpenCenter = (): void => {
  window.dispatchEvent(new CustomEvent('kentrehberi:command', {
    detail: { name: 'notifications', source: 'triage' },
  }));
};

export const ExperienceNotificationTriage = ({
  model,
  previewLimit = 6,
  label = 'Bildirim hızlı işlemleri',
  onOpenCenter,
}: ExperienceNotificationTriageProps): ReactNode => {
  const [centerSnapshot, setCenterSnapshot] = useState<NotificationCenterSnapshot>(() => model.snapshot());
  const [state, setState] = useState<NotificationTriageState>(() => createNotificationTriageState());
  const listRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => model.subscribe(setCenterSnapshot), [model]);

  const snapshot = useMemo(
    () => createNotificationTriageSnapshot(centerSnapshot, state, { previewLimit }),
    [centerSnapshot, previewLimit, state],
  );
  const keyboardHelp = useMemo(() => notificationTriageKeyboardHelp(snapshot), [snapshot]);

  const updateState = useCallback((next: NotificationTriageState): void => {
    setState(next);
  }, []);

  const openCenter = useCallback((): void => {
    try {
      if (onOpenCenter) onOpenCenter();
      else dispatchOpenCenter();
      setState((current) => setNotificationTriageExpanded(current, false));
    } catch (error) {
      runtimeDiagnostics.captureError(error, {
        source: 'experience.notification-triage.open-center',
      }, 'warn');
    }
  }, [onOpenCenter]);

  const focusActivePresentation = useCallback((id: string): void => {
    setState((current) => setNotificationTriageActive(current, id));
    if (typeof window === 'undefined') return;
    window.requestAnimationFrame(() => {
      const active = document.querySelector<HTMLElement>(`[data-notification-triage-id="${CSS.escape(id)}"]`);
      active?.scrollIntoView?.({ block: 'nearest' });
    });
  }, []);

  const applyEffect = useCallback((effect: NotificationTriageEffect): void => {
    switch (effect.type) {
      case 'none':
        return;
      case 'open-center':
        openCenter();
        return;
      case 'focus':
        focusActivePresentation(effect.id);
        return;
      case 'mark-read':
        model.markRead(effect.id);
        return;
      case 'mark-all-read':
        model.markAllRead();
        return;
      case 'clear-read':
        model.clearRead();
        return;
      case 'dismiss':
        model.dismiss(effect.id);
        return;
    }
  }, [focusActivePresentation, model, openCenter]);

  const handleKeyboard = useCallback((event: ReactKeyboardEvent<HTMLElement>): void => {
    const effect = resolveNotificationTriageEffect({
      key: event.key,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      repeat: event.repeat,
      defaultPrevented: event.defaultPrevented,
      isComposing: event.nativeEvent.isComposing,
      target: commandTarget(event.target),
    }, snapshot);
    if (effect.type === 'none') return;
    event.preventDefault();
    applyEffect(effect);
  }, [applyEffect, snapshot]);

  const toggle = (): void => {
    const willOpen = !state.expanded;
    updateState(toggleNotificationTriage(state));
    if (willOpen && typeof window !== 'undefined') {
      window.requestAnimationFrame(() => listRef.current?.focus({ preventScroll: true }));
    }
  };

  const close = (): void => {
    updateState(setNotificationTriageExpanded(state, false));
    if (typeof window !== 'undefined') {
      window.requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }));
    }
  };

  if (!snapshot.shouldSurface && !snapshot.expanded) return null;

  const activeSemanticId = snapshot.items.find((item) => item.id === snapshot.activeId)?.semanticId;

  return (
    <aside
      className="experience-notification-triage"
      data-expanded={String(snapshot.expanded)}
      data-has-important={String(snapshot.importantCount > 0)}
      aria-label={label}
    >
      <button
        ref={triggerRef}
        type="button"
        className="experience-notification-triage__trigger"
        aria-expanded={snapshot.expanded}
        aria-controls="experience-notification-triage-panel"
        aria-haspopup="true"
        onClick={toggle}
      >
        <span className="experience-notification-triage__pulse" aria-hidden="true" />
        <span className="experience-notification-triage__trigger-copy">
          <strong>{snapshot.unreadCount} okunmamış</strong>
          <span>{snapshot.importantCount > 0 ? `${snapshot.importantCount} önemli` : 'Yeni bildirimler'}</span>
        </span>
        <span className="experience-notification-triage__trigger-key" aria-hidden="true">Alt+N</span>
      </button>

      {snapshot.expanded ? (
        <section
          id="experience-notification-triage-panel"
          className="experience-notification-triage__panel"
          aria-label="Bildirim hızlı inceleme paneli"
        >
          <header className="experience-notification-triage__header">
            <div>
              <p className="experience-notification-triage__eyebrow">Hızlı inceleme</p>
              <h2>Bildirimler</h2>
              <p>Harita akışından ayrılmadan önemli bildirimleri gözden geçirin.</p>
            </div>
            <button
              type="button"
              className="experience-notification-triage__close"
              aria-label="Hızlı bildirim panelini kapat"
              onClick={close}
            >
              <span aria-hidden="true">×</span>
            </button>
          </header>

          <div className="experience-notification-triage__metrics" aria-label="Bildirim özeti">
            <span><strong>{snapshot.totalCount}</strong> toplam</span>
            <span><strong>{snapshot.unreadCount}</strong> okunmamış</span>
            <span><strong>{snapshot.importantCount}</strong> önemli</span>
          </div>

          <div className="experience-notification-triage__scopes" role="group" aria-label="Hızlı bildirim filtresi">
            {NOTIFICATION_TRIAGE_SCOPES.map((scope) => (
              <button
                key={scope.id}
                type="button"
                className="experience-notification-triage__scope"
                aria-pressed={snapshot.scope === scope.id}
                aria-label={scope.label}
                onClick={() => setState((current) => setNotificationTriageScope(current, scope.id))}
              >
                {scope.shortLabel}
              </button>
            ))}
          </div>

          <p
            className="experience-notification-triage__status"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {snapshot.statusText}
          </p>

          {snapshot.items.length > 0 ? (
            <div
              ref={listRef}
              className="experience-notification-triage__list"
              role="listbox"
              tabIndex={0}
              aria-label="Hızlı bildirim listesi"
              aria-activedescendant={activeSemanticId}
              onKeyDown={handleKeyboard}
            >
              {snapshot.items.map((item) => (
                <article
                  id={item.semanticId}
                  key={item.id}
                  className={`experience-notification-triage__item experience-notification-triage__item--${item.tone}`}
                  role="option"
                  aria-selected={item.active}
                  aria-posinset={item.position}
                  aria-setsize={item.setSize}
                  data-active={String(item.active)}
                  data-read={String(item.read)}
                  data-notification-triage-id={item.id}
                  onMouseMove={() => setState((current) => setNotificationTriageActive(current, item.id))}
                >
                  <div className="experience-notification-triage__item-main">
                    <div className="experience-notification-triage__item-meta">
                      <span>{toneLabel(item.tone)}</span>
                      {item.category !== 'general' ? <span>· {item.category}</span> : null}
                      {item.occurrenceCount > 1 ? <span>· {item.occurrenceCount}×</span> : null}
                      {item.important ? <span className="experience-notification-triage__important">Önemli</span> : null}
                    </div>
                    <h3>{item.title}</h3>
                    {item.message ? <p>{item.message}</p> : null}
                  </div>

                  <div className="experience-notification-triage__item-actions">
                    {!item.read ? (
                      <button
                        type="button"
                        onClick={() => model.markRead(item.id)}
                        aria-label={`${item.title}: okundu olarak işaretle`}
                      >
                        Okundu
                      </button>
                    ) : (
                      <span className="experience-notification-triage__read">Okundu</span>
                    )}
                    {item.dismissible ? (
                      <button
                        type="button"
                        onClick={() => model.dismiss(item.id)}
                        aria-label={`${item.title}: bildirimi kaldır`}
                      >
                        Kaldır
                      </button>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="experience-notification-triage__empty" role="note">
              <strong>Bu filtrede bildirim yok</strong>
              <span>{snapshot.emptyText}</span>
              {snapshot.scope !== 'all' ? (
                <button
                  type="button"
                  onClick={() => setState((current) => setNotificationTriageScope(current, 'all'))}
                >
                  Tüm bildirimleri göster
                </button>
              ) : null}
            </div>
          )}

          <details className="experience-notification-triage__keyboard-help">
            <summary>Klavye komutları</summary>
            <ul>
              {keyboardHelp.map((instruction) => <li key={instruction}>{instruction}</li>)}
            </ul>
          </details>

          <footer className="experience-notification-triage__footer">
            <div className="experience-notification-triage__bulk-actions">
              <button
                type="button"
                disabled={!snapshot.command.canMarkAllRead}
                onClick={() => model.markAllRead()}
              >
                Tümünü okundu yap
              </button>
              <button
                type="button"
                disabled={!snapshot.command.canClearRead}
                onClick={() => model.clearRead()}
              >
                Okunanları temizle
              </button>
            </div>
            <button
              type="button"
              className="experience-notification-triage__open-center"
              aria-keyshortcuts="Alt+N"
              onClick={openCenter}
            >
              Tam bildirim merkezini aç
            </button>
          </footer>
        </section>
      ) : null}
    </aside>
  );
};

export default ExperienceNotificationTriage;
