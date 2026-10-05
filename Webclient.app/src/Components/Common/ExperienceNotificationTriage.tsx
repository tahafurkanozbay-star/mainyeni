import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import {
  type NotificationCenterModel,
  type NotificationCenterSnapshot,
} from '../../experience/notificationCenterModel';
import {
  createNotificationTriageCommandDefinitions,
  resolveNotificationTriageIntent,
  type NotificationTriageIntent,
} from '../../experience/notificationTriageController';
import {
  NotificationTriageModel,
  type NotificationTriageScope,
  type NotificationTriageSort,
} from '../../experience/notificationTriageModel';
import { createNotificationTriageWindow } from '../../experience/notificationTriageWindow';
import { runtimeDiagnostics } from '../../platform/runtime/runtimeDiagnostics';
import './experience-notification-triage.css';

export interface ExperienceNotificationTriageProps {
  readonly model: NotificationCenterModel;
  readonly previewLimit?: number;
  readonly label?: string;
  readonly onOpenCenter?: () => void;
}

interface ScopeOption {
  readonly id: NotificationTriageScope;
  readonly label: string;
  readonly shortLabel: string;
}

interface SortOption {
  readonly id: NotificationTriageSort;
  readonly label: string;
}

const SCOPE_OPTIONS: readonly ScopeOption[] = Object.freeze([
  Object.freeze({ id: 'all', label: 'Tüm bildirimler', shortLabel: 'Tümü' }),
  Object.freeze({ id: 'unread', label: 'Okunmamış bildirimler', shortLabel: 'Okunmamış' }),
  Object.freeze({ id: 'important', label: 'Önemli bildirimler', shortLabel: 'Önemli' }),
  Object.freeze({ id: 'urgent', label: 'Acil bildirimler', shortLabel: 'Acil' }),
  Object.freeze({ id: 'actionable', label: 'İşlem içeren bildirimler', shortLabel: 'İşlemli' }),
]);

const SORT_OPTIONS: readonly SortOption[] = Object.freeze([
  Object.freeze({ id: 'newest', label: 'En yeni önce' }),
  Object.freeze({ id: 'oldest', label: 'En eski önce' }),
  Object.freeze({ id: 'priority', label: 'Önceliğe göre' }),
]);

const commandTarget = (target: EventTarget | null) => target instanceof HTMLElement
  ? Object.freeze({
    tagName: target.tagName,
    isContentEditable: target.isContentEditable,
    role: target.getAttribute('role'),
  })
  : null;

const semanticToken = (value: string): string => {
  let result = '';
  let separator = false;
  for (const character of value.normalize('NFKD').toLocaleLowerCase('tr-TR')) {
    const code = character.codePointAt(0);
    const accepted = code !== undefined && (
      (code >= 48 && code <= 57)
      || (code >= 97 && code <= 122)
    );
    if (accepted) {
      result += character;
      separator = false;
    } else if (!separator && result) {
      result += '-';
      separator = true;
    }
    if (result.length >= 64) break;
  }
  return result.replace(/-+$/u, '') || 'notification';
};

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

const emptyMessage = (reason: 'none' | 'no-items' | 'query' | 'scope'): string => {
  if (reason === 'query') return 'Arama ifadesini kısaltın veya başka bir terim deneyin.';
  if (reason === 'scope') return 'Başka bir bildirim filtresi seçin.';
  return 'Henüz gösterilecek bir bildirim bulunmuyor.';
};

export const ExperienceNotificationTriage = ({
  model,
  previewLimit = 6,
  label = 'Bildirim hızlı işlemleri',
  onOpenCenter,
}: ExperienceNotificationTriageProps): ReactNode => {
  const [centerSnapshot, setCenterSnapshot] = useState<NotificationCenterSnapshot>(() => model.snapshot());
  const [expanded, setExpanded] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const triageModel = useMemo(() => {
    const next = new NotificationTriageModel({
      maxItems: 96,
      pageSize: 6,
      onObserverError(error) {
        runtimeDiagnostics.captureError(error, {
          source: 'experience.notification-triage.observer',
        }, 'warn');
      },
    });
    next.reconcile(model.snapshot().items);
    return next;
  }, [model]);

  const triage = useSyncExternalStore(
    triageModel.subscribe,
    triageModel.getSnapshot,
    triageModel.getSnapshot,
  );

  useEffect(() => model.subscribe((snapshot) => {
    setCenterSnapshot(snapshot);
    triageModel.reconcile(snapshot.items);
  }), [model, triageModel]);

  useEffect(() => () => triageModel.dispose(), [triageModel]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const collapseForFullCenter = (event: Event): void => {
      const detail = (event as CustomEvent<{ readonly name?: string }>).detail;
      if (detail?.name === 'notifications') setExpanded(false);
    };
    window.addEventListener('kentrehberi:command', collapseForFullCenter);
    return () => window.removeEventListener('kentrehberi:command', collapseForFullCenter);
  }, []);

  const windowed = useMemo(
    () => createNotificationTriageWindow(triage, previewLimit),
    [previewLimit, triage],
  );
  const commandDefinitions = useMemo(
    () => createNotificationTriageCommandDefinitions(triage),
    [triage],
  );

  const openCenter = useCallback((): void => {
    try {
      if (onOpenCenter) onOpenCenter();
      else dispatchOpenCenter();
      setExpanded(false);
    } catch (error) {
      runtimeDiagnostics.captureError(error, {
        source: 'experience.notification-triage.open-center',
      }, 'warn');
    }
  }, [onOpenCenter]);

  const applyIntent = useCallback((intent: NotificationTriageIntent): void => {
    switch (intent.type) {
      case 'none':
        return;
      case 'focus-search':
        searchRef.current?.focus({ preventScroll: true });
        return;
      case 'move':
        triageModel.moveActive(intent.move);
        return;
      case 'clear-query':
        triageModel.setQuery('');
        return;
      case 'mark-active-read':
        model.markRead(intent.id);
        return;
      case 'dismiss-active':
        model.dismiss(intent.id);
        return;
      case 'mark-all-read':
        model.markAllRead();
        return;
      case 'clear-read':
        model.clearRead();
        return;
    }
  }, [model, triageModel]);

  const handleKeyboard = useCallback((event: ReactKeyboardEvent<HTMLElement>): void => {
    const intent = resolveNotificationTriageIntent({
      key: event.key,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      repeat: event.repeat,
      defaultPrevented: event.defaultPrevented,
      isComposing: event.nativeEvent.isComposing,
      target: commandTarget(event.target),
    }, triage);
    if (intent.type === 'none') return;
    event.preventDefault();
    applyIntent(intent);
  }, [applyIntent, triage]);

  const toggle = (): void => {
    const willOpen = !expanded;
    setExpanded(willOpen);
    if (willOpen && typeof window !== 'undefined') {
      window.requestAnimationFrame(() => {
        if (triage.query) searchRef.current?.focus({ preventScroll: true });
        else listRef.current?.focus({ preventScroll: true });
      });
    }
  };

  const close = (): void => {
    setExpanded(false);
    if (typeof window !== 'undefined') {
      window.requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }));
    }
  };

  const shouldSurface = centerSnapshot.unreadCount > 0 || centerSnapshot.urgentUnreadCount > 0;
  if (!shouldSurface && !expanded) return null;

  const activeSemanticId = triage.activeId
    ? `experience-notification-triage-${semanticToken(triage.activeId)}`
    : undefined;

  return (
    <aside
      className="experience-notification-triage"
      data-expanded={String(expanded)}
      data-has-important={String(triage.importantCount > 0)}
      aria-label={label}
    >
      <button
        ref={triggerRef}
        type="button"
        className="experience-notification-triage__trigger"
        aria-expanded={expanded}
        aria-controls="experience-notification-triage-panel"
        aria-haspopup="true"
        onClick={toggle}
      >
        <span className="experience-notification-triage__pulse" aria-hidden="true" />
        <span className="experience-notification-triage__trigger-copy">
          <strong>{triage.unreadCount} okunmamış</strong>
          <span>{triage.urgentCount > 0 ? `${triage.urgentCount} acil` : triage.importantCount > 0 ? `${triage.importantCount} önemli` : 'Yeni bildirimler'}</span>
        </span>
        <span className="experience-notification-triage__trigger-key" aria-hidden="true">Alt+N</span>
      </button>

      {expanded ? (
        <section
          id="experience-notification-triage-panel"
          className="experience-notification-triage__panel"
          aria-label="Bildirim hızlı inceleme paneli"
          onKeyDown={handleKeyboard}
        >
          <header className="experience-notification-triage__header">
            <div>
              <p className="experience-notification-triage__eyebrow">Hızlı inceleme</p>
              <h2>Bildirimler</h2>
              <p>Harita akışından ayrılmadan arayın, önceliklendirin ve gerekli bildirimleri yönetin.</p>
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
            <span><strong>{triage.totalCount}</strong> toplam</span>
            <span><strong>{triage.unreadCount}</strong> okunmamış</span>
            <span><strong>{triage.urgentCount}</strong> acil</span>
            <span><strong>{triage.importantCount}</strong> önemli</span>
            <span><strong>{triage.actionableCount}</strong> işlemli</span>
          </div>

          <div className="experience-notification-triage__search-row">
            <label htmlFor="experience-notification-triage-search">Bildirim ara</label>
            <div className="experience-notification-triage__search-shell">
              <input
                ref={searchRef}
                id="experience-notification-triage-search"
                type="search"
                value={triage.query}
                placeholder="Başlık, mesaj, kategori veya işlem ara"
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => triageModel.setQuery(event.currentTarget.value)}
                aria-controls="experience-notification-triage-list"
                aria-describedby="experience-notification-triage-status"
              />
              {triage.query ? (
                <button
                  type="button"
                  aria-label="Bildirim aramasını temizle"
                  onClick={() => triageModel.setQuery('')}
                >
                  Temizle
                </button>
              ) : null}
            </div>
          </div>

          <div className="experience-notification-triage__scopes" role="group" aria-label="Hızlı bildirim filtresi">
            {SCOPE_OPTIONS.map((scope) => (
              <button
                key={scope.id}
                type="button"
                className="experience-notification-triage__scope"
                aria-pressed={triage.scope === scope.id}
                aria-label={scope.label}
                onClick={() => triageModel.setScope(scope.id)}
              >
                {scope.shortLabel}
              </button>
            ))}
          </div>

          <label className="experience-notification-triage__sort-label" htmlFor="experience-notification-triage-sort">
            Sıralama
          </label>
          <select
            id="experience-notification-triage-sort"
            className="experience-notification-triage__sort"
            value={triage.sort}
            onChange={(event) => triageModel.setSort(event.currentTarget.value as NotificationTriageSort)}
          >
            {SORT_OPTIONS.map((sort) => <option key={sort.id} value={sort.id}>{sort.label}</option>)}
          </select>

          <p
            id="experience-notification-triage-status"
            className="experience-notification-triage__status"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {windowed.statusText}
          </p>

          {windowed.entries.length > 0 ? (
            <div
              ref={listRef}
              id="experience-notification-triage-list"
              className="experience-notification-triage__list"
              role="listbox"
              tabIndex={0}
              aria-label="Hızlı bildirim listesi"
              aria-activedescendant={activeSemanticId}
            >
              {windowed.entries.map((item) => (
                <article
                  id={`experience-notification-triage-${semanticToken(item.id)}`}
                  key={item.id}
                  className={`experience-notification-triage__item experience-notification-triage__item--${item.tone}`}
                  role="option"
                  aria-selected={item.selected}
                  aria-posinset={item.position}
                  aria-setsize={item.setSize}
                  data-active={String(item.selected)}
                  data-read={String(item.read)}
                  onMouseMove={() => triageModel.setActive(item.id)}
                  onMouseDown={() => triageModel.setActive(item.id)}
                >
                  <div className="experience-notification-triage__item-main">
                    <div className="experience-notification-triage__item-meta">
                      <span>{toneLabel(item.tone)}</span>
                      {item.category !== 'general' ? <span>· {item.category}</span> : null}
                      {item.occurrenceCount > 1 ? <span>· {item.occurrenceCount}×</span> : null}
                      {item.urgent ? <span className="experience-notification-triage__important">Acil</span> : item.important ? <span className="experience-notification-triage__important">Önemli</span> : null}
                      {item.actionable ? <span>· İşlem var</span> : null}
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
              <strong>Eşleşen bildirim yok</strong>
              <span>{emptyMessage(triage.emptyReason)}</span>
              <button type="button" onClick={() => triageModel.reset()}>
                Filtreleri ve aramayı sıfırla
              </button>
            </div>
          )}

          <details className="experience-notification-triage__keyboard-help">
            <summary>Klavye komutları</summary>
            <ul>
              {commandDefinitions.map((command) => (
                <li key={command.id} data-enabled={String(command.enabled)}>
                  <kbd>{command.shortcut}</kbd>
                  <span><strong>{command.label}</strong> — {command.description}</span>
                </li>
              ))}
            </ul>
          </details>

          <footer className="experience-notification-triage__footer">
            <div className="experience-notification-triage__bulk-actions">
              <button
                type="button"
                disabled={triage.unreadCount === 0}
                onClick={() => model.markAllRead()}
              >
                Tümünü okundu yap
              </button>
              <button
                type="button"
                disabled={triage.totalCount <= triage.unreadCount}
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
