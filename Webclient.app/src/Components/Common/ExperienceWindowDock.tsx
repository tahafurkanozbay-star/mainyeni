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
import type { WindowManagerApi } from '../../Store/Managers/WindowManager';
import { runtimeDiagnostics } from '../../platform/runtime/runtimeDiagnostics';
import {
  WINDOW_WORKSPACE_SCOPES,
  createWindowWorkspaceModel,
  type WindowWorkspaceEntry,
  type WindowWorkspaceScope,
} from '../../experience/workspace/windowWorkspaceModel';
import {
  createWindowWorkspaceKeyboardPolicy,
  windowWorkspaceKeyboardHelp,
  type WindowWorkspaceKeyboardIntent,
} from '../../experience/workspace/windowWorkspaceKeyboardController';
import { ExperienceDialog, type ExperienceDialogCloseReason } from './ExperienceDialog';
import './experience-window-dock.css';

export interface ExperienceWindowDockProps {
  readonly windowManager: WindowManagerApi;
}

const policy = createWindowWorkspaceKeyboardPolicy();

const emptyCopy = (reason: ReturnType<ReturnType<typeof createWindowWorkspaceModel>['getSnapshot']>['emptyReason']): Readonly<{
  title: string;
  description: string;
}> => {
  switch (reason) {
    case 'no-windows':
      return Object.freeze({
        title: 'Henüz çalışma penceresi yok',
        description: 'Bir kent servisi veya harita aracı açtığınızda burada görünecek.',
      });
    case 'no-recent':
      return Object.freeze({
        title: 'Son kullanılan pencere yok',
        description: 'Açtığınız sorgular ve araçlar bu oturum boyunca hızlı erişim için burada tutulur.',
      });
    case 'no-open':
      return Object.freeze({
        title: 'Açık pencere yok',
        description: 'Açık veya küçültülmüş bir pencere olduğunda bu görünümden hızlıca geri dönebilirsiniz.',
      });
    case 'no-results':
      return Object.freeze({
        title: 'Eşleşme bulunamadı',
        description: 'Arama ifadesini değiştirin veya farklı bir kapsam seçin.',
      });
    case 'none':
      return Object.freeze({ title: '', description: '' });
  }
};

const schedule = (callback: () => void): void => {
  if (typeof queueMicrotask === 'function') {
    queueMicrotask(callback);
    return;
  }
  void Promise.resolve().then(callback);
};

const stateDescription = (entry: WindowWorkspaceEntry): string => {
  if (entry.state === 'active') return 'Şu anda açık';
  if (entry.state === 'minimized') return 'Küçültülmüş';
  return entry.recentRank === null ? 'Kapalı' : 'Son kullanılan';
};

export const ExperienceWindowDock = ({
  windowManager,
}: ExperienceWindowDockProps): ReactNode => {
  const launcherRef = useRef<HTMLButtonElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const entryRefs = useRef(new Map<string, HTMLButtonElement>());
  const [open, setOpen] = useState(false);

  const managerSnapshot = useSyncExternalStore(
    windowManager.SubscribeWindows,
    windowManager.GetWindowSnapshot,
    windowManager.GetWindowSnapshot,
  );

  const model = useMemo(() => createWindowWorkspaceModel({
    maxWindows: 160,
    maxRecent: 14,
    maxListeners: 48,
    pageSize: 7,
    onListenerError(error) {
      runtimeDiagnostics.captureError(error, {
        source: 'experience.window-workspace.observer',
      }, 'warn');
    },
  }), []);

  const snapshot = useSyncExternalStore(
    model.subscribe,
    model.getSnapshot,
    model.getSnapshot,
  );

  useEffect(() => {
    model.ingest(managerSnapshot);
  }, [managerSnapshot, model]);

  useEffect(() => () => model.dispose(), [model]);

  useEffect(() => {
    const onGlobalKeyDown = (event: KeyboardEvent): void => {
      const intent = policy.evaluate(event, {
        open,
        snapshot: model.getSnapshot(),
        source: 'global',
      });
      if (intent.kind === 'none') return;
      event.preventDefault();
      if (intent.kind === 'open-dock') {
        model.resetDiscovery();
        setOpen(true);
        return;
      }
      if (intent.kind === 'close-dock') {
        setOpen(false);
        schedule(() => launcherRef.current?.focus({ preventScroll: true }));
      }
    };
    window.addEventListener('keydown', onGlobalKeyDown, true);
    return () => window.removeEventListener('keydown', onGlobalKeyDown, true);
  }, [model, open]);

  useEffect(() => {
    if (!open) return;
    model.resetDiscovery();
  }, [model, open]);

  const focusSearch = useCallback((): void => {
    schedule(() => searchRef.current?.focus({ preventScroll: true }));
  }, []);

  const focusActiveEntry = useCallback((): void => {
    schedule(() => {
      const activeId = model.getSnapshot().activeEntryId;
      if (!activeId) return;
      entryRefs.current.get(activeId)?.focus({ preventScroll: true });
    });
  }, [model]);

  const closeDock = useCallback((restoreLauncher = true): void => {
    setOpen(false);
    if (restoreLauncher) {
      schedule(() => launcherRef.current?.focus({ preventScroll: true }));
    }
  }, []);

  const activateWindow = useCallback((windowId: string): void => {
    model.noteActivated(windowId);
    const activated = windowManager.ShowWindow(windowId);
    if (!activated) return;
    setOpen(false);
  }, [model, windowManager]);

  const applyIntent = useCallback((
    event: ReactKeyboardEvent<HTMLElement>,
    intent: WindowWorkspaceKeyboardIntent,
    source: 'search' | 'entry',
  ): void => {
    if (intent.kind === 'none') return;
    event.preventDefault();

    if (intent.kind === 'clear-query') {
      model.clearQuery();
      focusSearch();
      return;
    }
    if (intent.kind === 'close-dock') {
      closeDock(true);
      return;
    }
    if (intent.kind === 'focus-search') {
      focusSearch();
      return;
    }
    if (intent.kind === 'move') {
      model.moveActive(intent.move);
      if (source === 'entry') focusActiveEntry();
      return;
    }
    if (intent.kind === 'activate') {
      activateWindow(intent.windowId);
    }
  }, [activateWindow, closeDock, focusActiveEntry, focusSearch, model]);

  const handleSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    applyIntent(event, policy.evaluate(event.nativeEvent, {
      open,
      snapshot: model.getSnapshot(),
      source: 'search',
    }), 'search');
  };

  const handleEntryKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    windowId: string,
  ): void => {
    model.setActive(windowId);
    applyIntent(event, policy.evaluate(event.nativeEvent, {
      open,
      snapshot: model.getSnapshot(),
      source: 'entry',
      currentWindowId: windowId,
    }), 'entry');
  };

  const minimizeWindow = (windowId: string): void => {
    if (!windowManager.IsVisible(windowId) || windowManager.IsMinimized(windowId)) return;
    windowManager.ToggleMinimiseWindow(windowId);
    focusSearch();
  };

  const hideWindow = (windowId: string): void => {
    if (!windowManager.IsVisible(windowId)) return;
    windowManager.HideWindow(windowId);
    focusSearch();
  };

  const handleDialogClose = (_reason: ExperienceDialogCloseReason): void => {
    closeDock(true);
  };

  const openDock = (): void => {
    model.resetDiscovery();
    setOpen(true);
  };

  const activeEntry = snapshot.entries.find((entry) => entry.id === snapshot.activeEntryId) ?? null;
  const empty = emptyCopy(snapshot.emptyReason);
  const dialogTitleId = 'experience-window-dock-title';
  const dialogDescriptionId = 'experience-window-dock-description';
  const statusId = 'experience-window-dock-status';
  const searchId = 'experience-window-dock-search';
  const listId = 'experience-window-dock-list';

  return (
    <>
      <button
        ref={launcherRef}
        type="button"
        className="experience-workspace__action experience-window-dock__launcher"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-keyshortcuts={policy.ariaKeyShortcut}
        aria-label={`Çalışma pencerelerini aç, ${policy.shortcutLabel}`}
        onClick={openDock}
      >
        <span aria-hidden="true">Pencereler</span>
        <span
          className="experience-window-dock__launcher-count"
          aria-label={`${snapshot.openCount} açık pencere`}
        >
          {snapshot.openCount}
        </span>
      </button>

      <ExperienceDialog
        open={open}
        onClose={handleDialogClose}
        labelledBy={dialogTitleId}
        describedBy={`${dialogDescriptionId} ${statusId}`}
        initialFocusRef={searchRef}
        backdropClassName="experience-window-dock__backdrop"
        dialogClassName="experience-window-dock"
        restoreFocus={false}
        testId="experience-window-dock"
      >
        <header className="experience-window-dock__header">
          <div className="experience-window-dock__heading-copy">
            <span className="experience-window-dock__eyebrow">ÇALIŞMA ALANI</span>
            <h2 id={dialogTitleId}>Pencereler arasında hızlı geçiş</h2>
            <p id={dialogDescriptionId}>
              Açık, küçültülmüş ve son kullanılan sorgu veya harita araçlarını tek yerden bulun.
            </p>
          </div>
          <button
            type="button"
            className="experience-window-dock__close"
            aria-label="Pencere değiştiriciyi kapat"
            onClick={() => closeDock(true)}
          >
            Kapat
          </button>
        </header>

        <div className="experience-window-dock__metrics" aria-label="Pencere özeti">
          <span>
            <small>Kayıtlı</small>
            <strong>{snapshot.totalCount}</strong>
          </span>
          <span>
            <small>Açık</small>
            <strong>{snapshot.openCount}</strong>
          </span>
          <span>
            <small>Küçültülmüş</small>
            <strong>{snapshot.minimizedCount}</strong>
          </span>
          <span>
            <small>Son</small>
            <strong>{snapshot.recentCount}</strong>
          </span>
        </div>

        <div className="experience-window-dock__body">
          <div className="experience-window-dock__discovery">
            <label htmlFor={searchId}>Pencere ara</label>
            <div className="experience-window-dock__search-shell">
              <input
                ref={searchRef}
                id={searchId}
                type="search"
                value={snapshot.query}
                placeholder="Örn. parklar, ölçüm, yer işaretleri"
                autoComplete="off"
                enterKeyHint="search"
                aria-controls={snapshot.resultCount > 0 ? listId : undefined}
                aria-describedby={`${statusId} experience-window-dock-keyboard-help`}
                onChange={(event) => model.setQuery(event.currentTarget.value)}
                onKeyDown={handleSearchKeyDown}
              />
              {snapshot.query ? (
                <button
                  type="button"
                  onClick={() => {
                    model.clearQuery();
                    focusSearch();
                  }}
                  aria-label="Pencere aramasını temizle"
                >
                  Temizle
                </button>
              ) : null}
            </div>

            <div className="experience-window-dock__scopes" role="group" aria-label="Pencere kapsamı">
              {WINDOW_WORKSPACE_SCOPES.map((scope) => (
                <button
                  key={scope.id}
                  type="button"
                  aria-pressed={snapshot.scope === scope.id}
                  onClick={() => {
                    model.setScope(scope.id as WindowWorkspaceScope);
                    focusSearch();
                  }}
                >
                  {scope.label}
                </button>
              ))}
            </div>
          </div>

          <p
            id={statusId}
            className="experience-window-dock__status"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {snapshot.announcement}
          </p>

          {snapshot.resultCount > 0 ? (
            <ul
              id={listId}
              className="experience-window-dock__list"
              aria-label="Çalışma pencereleri"
            >
              {snapshot.entries.map((entry) => (
                <li
                  key={entry.id}
                  id={entry.domId}
                  className="experience-window-dock__item"
                  data-selected={entry.selected ? 'true' : 'false'}
                  data-state={entry.state}
                  aria-posinset={entry.position}
                  aria-setsize={entry.setSize}
                  onMouseMove={() => model.setActive(entry.id)}
                >
                  <button
                    ref={(node) => {
                      if (node) entryRefs.current.set(entry.id, node);
                      else entryRefs.current.delete(entry.id);
                    }}
                    type="button"
                    className="experience-window-dock__primary"
                    tabIndex={entry.selected ? 0 : -1}
                    aria-current={entry.id === snapshot.activeWindowId ? 'true' : undefined}
                    aria-describedby={`${entry.domId}-meta`}
                    onFocus={() => model.setActive(entry.id)}
                    onClick={() => activateWindow(entry.id)}
                    onKeyDown={(event) => handleEntryKeyDown(event, entry.id)}
                  >
                    <span className="experience-window-dock__title">{entry.title}</span>
                    <span id={`${entry.domId}-meta`} className="experience-window-dock__meta">
                      {entry.kindLabel} · {stateDescription(entry)}
                    </span>
                  </button>

                  <div className="experience-window-dock__item-actions">
                    {entry.visible && entry.minimized ? (
                      <button
                        type="button"
                        onClick={() => activateWindow(entry.id)}
                        aria-label={`${entry.title} penceresini geri yükle`}
                      >
                        Geri yükle
                      </button>
                    ) : null}
                    {entry.visible && !entry.minimized ? (
                      <button
                        type="button"
                        onClick={() => minimizeWindow(entry.id)}
                        aria-label={`${entry.title} penceresini küçült`}
                      >
                        Küçült
                      </button>
                    ) : null}
                    {entry.visible ? (
                      <button
                        type="button"
                        onClick={() => hideWindow(entry.id)}
                        aria-label={`${entry.title} penceresini kapat`}
                      >
                        Kapat
                      </button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="experience-window-dock__empty" role="note">
              <strong>{empty.title}</strong>
              <span>{empty.description}</span>
              {(snapshot.query || snapshot.scope !== 'all') ? (
                <button
                  type="button"
                  onClick={() => {
                    model.clearQuery();
                    model.setScope('all');
                    focusSearch();
                  }}
                >
                  Tüm pencereleri göster
                </button>
              ) : null}
            </div>
          )}
        </div>

        <footer className="experience-window-dock__footer">
          <p id="experience-window-dock-keyboard-help">
            {windowWorkspaceKeyboardHelp.search} {windowWorkspaceKeyboardHelp.global}
          </p>
          <div className="experience-window-dock__footer-actions">
            {activeEntry ? (
              <span aria-hidden="true">
                {activeEntry.position}/{activeEntry.setSize}
              </span>
            ) : null}
            <button type="button" onClick={() => closeDock(true)}>Tamam</button>
          </div>
        </footer>
      </ExperienceDialog>
    </>
  );
};

export default ExperienceWindowDock;
