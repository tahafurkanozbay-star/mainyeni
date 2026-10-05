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
  NotificationCenterModel,
  type NotificationAction,
  type NotificationCenterSnapshot,
  type NotificationItem,
} from '../../experience/notificationCenterModel';
import {
  createFeedbackHistoryAccessibilityModel,
  type FeedbackHistoryViewport,
} from '../../experience/feedbackHistoryAccessibility';
import {
  createFeedbackHistoryControlsSnapshot,
  resolveFeedbackHistoryControlsIntent,
} from '../../experience/feedbackHistoryControls';
import {
  createFeedbackHistorySnapshot,
  reduceFeedbackHistory,
  type FeedbackHistoryAction,
  type FeedbackHistoryFilter,
  type FeedbackHistorySort,
} from '../../experience/feedbackHistoryExperience';
import {
  createDefaultFeedbackHistoryPreferenceEnvelope,
  createFeedbackHistoryPreferenceSnapshot,
  parseFeedbackHistoryPreferenceEnvelope,
  reduceFeedbackHistoryPreferences,
  serializeFeedbackHistoryPreferenceEnvelope,
  type FeedbackHistoryAnnouncementMode,
  type FeedbackHistoryPreferenceAction,
  type FeedbackHistoryPreferenceEnvelope,
} from '../../experience/feedbackHistoryPreferences';
import {
  createFeedbackHistorySessionState,
  reduceFeedbackHistorySession,
  type FeedbackHistorySessionCommand,
  type FeedbackHistorySessionState,
} from '../../experience/feedbackHistorySession';
import { synchronizeNotificationHistory } from '../../experience/feedbackNotificationAdapter';
import { runtimeDiagnostics } from '../../platform/runtime/runtimeDiagnostics';
import { ExperienceFeedbackDigest } from './ExperienceFeedbackDigest';
import './experience-feedback-center.css';

export interface ExperienceFeedbackCenterProps {
  readonly model: NotificationCenterModel;
  readonly label?: string;
  readonly callerId?: string;
  readonly onAction?: (notification: NotificationItem, action: NotificationAction) => void;
}

interface EnvironmentSnapshot {
  readonly viewport: FeedbackHistoryViewport;
  readonly coarsePointer: boolean;
  readonly reducedMotion: boolean;
  readonly forcedColors: boolean;
}

const DEFAULT_ENVIRONMENT: EnvironmentSnapshot = Object.freeze({
  viewport: 'desktop',
  coarsePointer: false,
  reducedMotion: false,
  forcedColors: false,
});

const viewportForWidth = (width: number): FeedbackHistoryViewport => {
  if (!Number.isFinite(width)) return 'desktop';
  if (width <= 720) return 'phone';
  if (width <= 1120) return 'tablet';
  return 'desktop';
};

const readEnvironment = (): EnvironmentSnapshot => {
  if (typeof window === 'undefined') return DEFAULT_ENVIRONMENT;
  const media = typeof window.matchMedia === 'function'
    ? (query: string): boolean => window.matchMedia(query).matches
    : (): boolean => false;
  return Object.freeze({
    viewport: viewportForWidth(window.innerWidth),
    coarsePointer: media('(pointer: coarse)'),
    reducedMotion: media('(prefers-reduced-motion: reduce)'),
    forcedColors: media('(forced-colors: active)'),
  });
};

const loadPreferences = (now: number): FeedbackHistoryPreferenceEnvelope => {
  if (typeof window === 'undefined') return createDefaultFeedbackHistoryPreferenceEnvelope(now);
  try {
    return parseFeedbackHistoryPreferenceEnvelope(
      window.sessionStorage.getItem('kent-rehberi:feedback-history-preferences:v1'),
      { now },
    );
  } catch (error) {
    runtimeDiagnostics.captureError(error, {
      source: 'experience.feedback-center.preference-read',
    }, 'warn');
    return createDefaultFeedbackHistoryPreferenceEnvelope(now);
  }
};

const initialSession = (
  notificationSnapshot: NotificationCenterSnapshot,
  preferences: FeedbackHistoryPreferenceEnvelope,
  now: number,
): FeedbackHistorySessionState => {
  let state = synchronizeNotificationHistory(
    createFeedbackHistorySessionState(now),
    notificationSnapshot,
    now,
  ).state;
  state = reduceFeedbackHistorySession(state, {
    type: 'filter',
    filter: preferences.preferences.filter,
  }, now).state;
  state = reduceFeedbackHistorySession(state, {
    type: 'sort',
    sort: preferences.preferences.sort,
  }, now).state;
  return state;
};

const toneLabel = (tone: string): string => {
  switch (tone) {
    case 'danger': return 'Hata';
    case 'warning': return 'Uyarı';
    case 'success': return 'Başarılı';
    default: return 'Bilgi';
  }
};

const timeLabel = (timestamp: number): string => {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 'Zaman bilgisi yok';
  try {
    return new Intl.DateTimeFormat('tr-TR', {
      hour: '2-digit',
      minute: '2-digit',
      day: '2-digit',
      month: 'short',
    }).format(timestamp);
  } catch {
    return 'Zaman bilgisi yok';
  }
};

const nextRevision = (value: number): number =>
  Number.isSafeInteger(value) && value >= 0 ? Math.min(Number.MAX_SAFE_INTEGER, value + 1) : 1;

export const ExperienceFeedbackCenter = ({
  model,
  label = 'Bildirim merkezi',
  callerId = 'experience-utility-notifications',
  onAction,
}: ExperienceFeedbackCenterProps): ReactNode => {
  const initialNow = Date.now();
  const [preferences, setPreferences] = useState<FeedbackHistoryPreferenceEnvelope>(() => loadPreferences(initialNow));
  const [environment, setEnvironment] = useState<EnvironmentSnapshot>(() => readEnvironment());
  const [notifications, setNotifications] = useState<NotificationCenterSnapshot>(() => model.snapshot());
  const [session, setSession] = useState<FeedbackHistorySessionState>(() => initialSession(model.snapshot(), loadPreferences(initialNow), initialNow));
  const sessionRef = useRef(session);
  const listRef = useRef<HTMLDivElement | null>(null);
  const sessionStorageErrorRef = useRef(false);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => model.subscribe(setNotifications), [model]);

  useEffect(() => {
    const synchronized = synchronizeNotificationHistory(
      sessionRef.current,
      notifications,
      Date.now(),
    ).state;
    sessionRef.current = synchronized;
    setSession(synchronized);
  }, [notifications]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    let frame = 0;
    const synchronize = (): void => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        setEnvironment(readEnvironment());
      });
    };
    const mediaQueries = typeof window.matchMedia === 'function'
      ? [
        window.matchMedia('(pointer: coarse)'),
        window.matchMedia('(prefers-reduced-motion: reduce)'),
        window.matchMedia('(forced-colors: active)'),
      ]
      : [];
    window.addEventListener('resize', synchronize, { passive: true });
    for (const query of mediaQueries) query.addEventListener('change', synchronize);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', synchronize);
      for (const query of mediaQueries) query.removeEventListener('change', synchronize);
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const serialized = serializeFeedbackHistoryPreferenceEnvelope(preferences);
    if (!serialized) return;
    try {
      window.sessionStorage.setItem('kent-rehberi:feedback-history-preferences:v1', serialized);
      sessionStorageErrorRef.current = false;
    } catch (error) {
      if (!sessionStorageErrorRef.current) {
        runtimeDiagnostics.captureError(error, {
          source: 'experience.feedback-center.preference-write',
        }, 'warn');
      }
      sessionStorageErrorRef.current = true;
    }
  }, [preferences]);

  const history = useMemo(() => createFeedbackHistorySnapshot(session.history), [session.history]);
  const accessibility = useMemo(() => createFeedbackHistoryAccessibilityModel({
    snapshot: history,
    filter: session.history.filter,
    sort: session.history.sort,
    viewport: environment.viewport,
    open: true,
    coarsePointer: environment.coarsePointer,
    reducedMotion: environment.reducedMotion,
    forcedColors: environment.forcedColors,
    callerId,
  }), [callerId, environment, history, session.history.filter, session.history.sort]);
  const controls = useMemo(() => createFeedbackHistoryControlsSnapshot({
    history,
    filter: session.history.filter,
    sort: session.history.sort,
    viewport: environment.viewport,
    coarsePointer: environment.coarsePointer,
    reducedMotion: environment.reducedMotion,
    forcedColors: environment.forcedColors,
  }), [environment, history, session.history.filter, session.history.sort]);
  const preferenceSnapshot = useMemo(() => createFeedbackHistoryPreferenceSnapshot(preferences, {
    now: Date.now(),
    coarsePointer: environment.coarsePointer,
    reducedMotion: environment.reducedMotion,
    forcedColors: environment.forcedColors,
  }), [environment, preferences]);
  const liveById = useMemo(
    () => new Map(notifications.items.map((item) => [item.id, item] as const)),
    [notifications.items],
  );

  const focusTarget = useCallback((id: string | null): void => {
    if (!id || typeof document === 'undefined') return;
    window.requestAnimationFrame(() => {
      const target = document.getElementById(id);
      if (target instanceof HTMLElement) {
        target.focus({ preventScroll: true });
        target.scrollIntoView?.({ block: 'nearest' });
      }
    });
  }, []);

  const commitSession = useCallback((command: FeedbackHistorySessionCommand): void => {
    const result = reduceFeedbackHistorySession(sessionRef.current, command, Date.now());
    sessionRef.current = result.state;
    setSession(result.state);
    if (result.effect.type === 'focus' || result.effect.type === 'restore-focus') {
      focusTarget(result.effect.targetId);
    }
  }, [focusTarget]);

  const mutateHistory = useCallback((action: FeedbackHistoryAction): void => {
    const current = sessionRef.current;
    const historyState = reduceFeedbackHistory(current.history, action, Date.now());
    if (historyState === current.history) return;
    const next = Object.freeze({
      ...current,
      history: historyState,
      revision: nextRevision(current.revision),
    });
    sessionRef.current = next;
    setSession(next);
  }, []);

  const updatePreference = useCallback((action: FeedbackHistoryPreferenceAction): void => {
    const next = reduceFeedbackHistoryPreferences(preferences, action, Date.now());
    setPreferences(next);
    if (action.type === 'set-filter') commitSession({ type: 'filter', filter: action.filter });
    if (action.type === 'set-sort') commitSession({ type: 'sort', sort: action.sort });
  }, [commitSession, preferences]);

  const selectFilter = (filter: FeedbackHistoryFilter): void => {
    if (filter === session.history.filter) return;
    updatePreference({ type: 'set-filter', filter });
  };

  const selectSort = (sort: FeedbackHistorySort): void => {
    if (sort === session.history.sort) return;
    updatePreference({ type: 'set-sort', sort });
  };

  const handleControlsKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const intent = resolveFeedbackHistoryControlsIntent(event, {
      filter: session.history.filter,
      sort: session.history.sort,
    });
    if (!intent || intent.type === 'close') return;
    event.preventDefault();
    if (intent.type === 'set-filter') selectFilter(intent.filter);
    if (intent.type === 'set-sort') selectSort(intent.sort);
    if (intent.type === 'mark-all-read') {
      model.markAllRead();
      commitSession({ type: 'mark-all-read' });
    }
    if (intent.type === 'clear-read') {
      model.clearRead();
      commitSession({ type: 'clear-read' });
    }
  };

  const handleListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const before = sessionRef.current;
    const result = reduceFeedbackHistorySession(before, {
      type: 'keyboard',
      event: {
        key: event.key,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        repeat: event.repeat,
        defaultPrevented: event.defaultPrevented,
        isComposing: event.nativeEvent.isComposing,
        target: event.target instanceof HTMLElement
          ? { tagName: event.target.tagName, isContentEditable: event.target.isContentEditable }
          : null,
      },
    }, Date.now());
    if (result.state === before && result.effect.type === 'none') return;
    event.preventDefault();
    sessionRef.current = result.state;
    setSession(result.state);
    if (result.effect.type === 'focus') focusTarget(result.effect.targetId);
    if (result.effect.type === 'open-item' && preferenceSnapshot.envelope.preferences.autoMarkRead) {
      model.markRead(result.effect.id);
      mutateHistory({ type: 'mark-read', id: result.effect.id });
    }
  };

  const markReadState = (id: string, read: boolean): void => {
    if (read) model.markUnread(id);
    else model.markRead(id);
    mutateHistory({ type: 'mark-read', id });
  };

  const removeHistoryItem = (id: string): void => {
    const live = liveById.get(id);
    if (live?.dismissible) model.dismiss(id);
    mutateHistory({ type: 'remove', id });
  };

  const activateAction = (notification: NotificationItem, action: NotificationAction): void => {
    model.markRead(notification.id);
    mutateHistory({ type: 'mark-read', id: notification.id });
    onAction?.(notification, action);
  };

  const resetPreferences = (): void => {
    const next = reduceFeedbackHistoryPreferences(preferences, { type: 'reset' }, Date.now());
    setPreferences(next);
    commitSession({ type: 'filter', filter: next.preferences.filter });
    commitSession({ type: 'sort', sort: next.preferences.sort });
  };

  const announcementMode = preferenceSnapshot.envelope.preferences.announcementMode;
  const statusLive = announcementMode === 'off' ? 'off' : 'polite';

  return (
    <section
      className="experience-feedback-center"
      data-placement={accessibility.placement}
      data-density={preferenceSnapshot.envelope.preferences.density}
      data-motion={accessibility.motion}
      data-forced-colors={String(accessibility.forcedColors)}
      aria-labelledby={accessibility.headingId}
      aria-describedby={accessibility.descriptionId}
    >
      <header className="experience-feedback-center__header">
        <div>
          <p className="experience-feedback-center__eyebrow">Çalışma alanı geçmişi</p>
          <h2 id={accessibility.headingId}>{label}</h2>
          <p id={accessibility.descriptionId}>
            Harita ve işlem bildirimlerini filtreleyin, klavyeyle gezinip önemli olayları tekrar inceleyin.
          </p>
        </div>
        <div className="experience-feedback-center__metrics" aria-label="Bildirim özeti">
          <span><strong>{history.visibleItems.length}</strong> gösteriliyor</span>
          <span><strong>{history.unreadCount}</strong> okunmamış</span>
          <span><strong>{history.importantCount}</strong> önemli</span>
        </div>
      </header>

      <ExperienceFeedbackDigest
        history={session.history}
        selectedFilter={session.history.filter}
        onSelectFilter={selectFilter}
      />

      <div
        id={controls.toolbarId}
        className="experience-feedback-center__controls"
        data-placement={controls.placement}
        onKeyDown={handleControlsKeyDown}
      >
        <div className="experience-feedback-center__control-group" role="group" aria-label={controls.filterGroupLabel}>
          <span className="experience-feedback-center__control-label">Filtre</span>
          <div className="experience-feedback-center__segmented">
            {controls.filters.map((filter) => (
              <button
                key={filter.id}
                id={filter.id}
                type="button"
                aria-pressed={filter.selected}
                disabled={filter.disabled}
                tabIndex={filter.tabIndex}
                onClick={() => selectFilter(filter.value)}
              >
                {filter.label}
              </button>
            ))}
          </div>
        </div>

        <div className="experience-feedback-center__control-group" role="group" aria-label={controls.sortGroupLabel}>
          <span className="experience-feedback-center__control-label">Sıralama</span>
          <div className="experience-feedback-center__segmented">
            {controls.sorts.map((sort) => (
              <button
                key={sort.id}
                id={sort.id}
                type="button"
                aria-pressed={sort.selected}
                disabled={sort.disabled}
                tabIndex={sort.tabIndex}
                onClick={() => selectSort(sort.value)}
              >
                {sort.label}
              </button>
            ))}
          </div>
        </div>

        <div className="experience-feedback-center__bulk-actions">
          <button
            type="button"
            disabled={controls.markAllReadDisabled}
            onClick={() => {
              model.markAllRead();
              commitSession({ type: 'mark-all-read' });
            }}
          >
            Tümünü okundu işaretle
          </button>
          <button
            type="button"
            disabled={controls.clearReadDisabled}
            onClick={() => {
              model.clearRead();
              commitSession({ type: 'clear-read' });
            }}
          >
            Okunanları temizle
          </button>
        </div>
      </div>

      <details className="experience-feedback-center__preferences">
        <summary>Görünüm ve duyuru tercihleri</summary>
        <div className="experience-feedback-center__preference-grid">
          <label>
            <span>Yoğunluk</span>
            <select
              value={preferenceSnapshot.envelope.preferences.density}
              onChange={(event) => updatePreference({
                type: 'set-density',
                density: event.currentTarget.value === 'compact' ? 'compact' : 'comfortable',
              })}
            >
              <option value="comfortable">Rahat</option>
              <option value="compact">Kompakt</option>
            </select>
          </label>
          <label>
            <span>Ekran okuyucu duyuruları</span>
            <select
              value={announcementMode}
              onChange={(event) => updatePreference({
                type: 'set-announcement-mode',
                mode: event.currentTarget.value as FeedbackHistoryAnnouncementMode,
              })}
            >
              <option value="important">Yalnız önemli</option>
              <option value="all">Tümü</option>
              <option value="off">Kapalı</option>
            </select>
          </label>
          <label className="experience-feedback-center__checkbox">
            <input
              type="checkbox"
              checked={preferenceSnapshot.envelope.preferences.autoMarkRead}
              onChange={(event) => updatePreference({
                type: 'set-auto-mark-read',
                enabled: event.currentTarget.checked,
              })}
            />
            <span>Enter ile açılan bildirimi otomatik okundu say</span>
          </label>
          <button type="button" className="experience-feedback-center__reset" onClick={resetPreferences}>
            Tercihleri sıfırla
          </button>
        </div>
      </details>

      <p
        id={accessibility.statusId}
        className="experience-feedback-center__status"
        role="status"
        aria-live={statusLive}
        aria-atomic="true"
      >
        {accessibility.statusText || controls.summary}
      </p>

      <div
        ref={listRef}
        id={accessibility.listId}
        className="experience-feedback-center__list"
        role="list"
        aria-label="Bildirim geçmişi"
        onKeyDown={handleListKeyDown}
      >
        {history.visibleItems.length === 0 ? (
          <div className="experience-feedback-center__empty" role="status">
            <strong>{history.emptyMessage ?? 'Bildirim geçmişi boş.'}</strong>
            <span>Harita, sorgu ve çalışma alanı olayları oluştuğunda burada görünecek.</span>
            {session.history.filter !== 'all' ? (
              <button type="button" onClick={() => selectFilter('all')}>Tüm bildirimleri göster</button>
            ) : null}
          </div>
        ) : history.visibleItems.map((item, index) => {
          const semantic = accessibility.items[index];
          const live = liveById.get(item.id);
          if (!semantic) return null;
          return (
            <article
              key={item.id}
              id={semantic.semanticId}
              className={`experience-feedback-center__item experience-feedback-center__item--${item.tone}`}
              role="listitem"
              tabIndex={semantic.tabIndex}
              data-active={String(semantic.selected)}
              data-read={String(item.read)}
              aria-labelledby={semantic.labelId}
              aria-describedby={semantic.descriptionId}
              onFocus={() => mutateHistory({ type: 'activate', id: item.id })}
            >
              <div className="experience-feedback-center__item-head">
                <div>
                  <p className="experience-feedback-center__item-meta">
                    <span>{toneLabel(item.tone)}</span>
                    <span>·</span>
                    <span>{semantic.readLabel}</span>
                    {semantic.importanceLabel ? <><span>·</span><span>{semantic.importanceLabel}</span></> : null}
                    <span>·</span>
                    <time dateTime={new Date(item.occurredAt).toISOString()}>{timeLabel(item.occurredAt)}</time>
                  </p>
                  <h3 id={semantic.labelId}>{item.title}</h3>
                </div>
                <span className="experience-feedback-center__position" aria-hidden="true">{semantic.positionLabel}</span>
              </div>

              <p id={semantic.descriptionId} className="experience-feedback-center__item-message">
                {item.message || 'Ek ayrıntı sağlanmadı.'}
              </p>

              <div className="experience-feedback-center__item-actions">
                {live?.actions.map((action) => (
                  <button
                    key={action.id}
                    type="button"
                    onClick={() => activateAction(live, action)}
                  >
                    {action.label}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => markReadState(item.id, item.read)}
                  aria-label={item.read ? `${item.title}: okunmadı işaretle` : `${item.title}: okundu işaretle`}
                >
                  {item.read ? 'Okunmadı yap' : 'Okundu yap'}
                </button>
                <button
                  type="button"
                  className="experience-feedback-center__danger-action"
                  onClick={() => removeHistoryItem(item.id)}
                  aria-label={semantic.removeLabel}
                >
                  Geçmişten kaldır
                </button>
              </div>
            </article>
          );
        })}
      </div>

      <footer className="experience-feedback-center__footer">
        <span>↑ ↓ Home End ile geçmişte gezin; Delete etkin kaydı kaldırır.</span>
        <span aria-hidden="true">{controls.summary}</span>
      </footer>
    </section>
  );
};

export default ExperienceFeedbackCenter;
