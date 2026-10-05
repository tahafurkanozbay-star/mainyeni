import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { Constants_ConfigKeys } from '../../../Core/Constants';
import MapManager from '../../../Store/Managers/MapManager';
import { LocalStorageHelper } from '../../../Toolbox/LocalStorageHelper';
import type { ManagedWindowHandle } from '../../../experience/contracts';
import {
  MapWidgetEmptyState,
  MapWidgetSection,
  MapWidgetSurface,
  type MapWidgetManagerLike,
} from '../_shared/MapWidgetSurface';
import {
  createBookmarkExperienceModel,
  type BookmarkMove,
} from './bookmarkExperienceModel';
import {
  createBookmarkInteractionController,
  type BookmarkMapViewPort,
} from './bookmarkInteractionController';
import './BookmarkWidgetModern.css';

export interface BookmarkWidgetProps {
  readonly id: string;
  readonly windowManager: MapWidgetManagerLike;
}

const MOVEMENT_KEYS: Readonly<Partial<Record<string, BookmarkMove>>> = Object.freeze({
  ArrowDown: 'next',
  ArrowRight: 'next',
  ArrowUp: 'previous',
  ArrowLeft: 'previous',
  Home: 'first',
  End: 'last',
  PageDown: 'page-next',
  PageUp: 'page-previous',
});

const NoticeGlyph = ({ severity }: { readonly severity: 'info' | 'warning' | 'error' }) => (
  <span className="bookmark-modern__notice-glyph" aria-hidden="true">
    {severity === 'error' ? '!' : severity === 'warning' ? '△' : '✓'}
  </span>
);

const ActionGlyph = ({ kind }: { readonly kind: 'save' | 'locate' | 'delete' | 'search' }) => (
  <span className="bookmark-modern__glyph" aria-hidden="true">
    {kind === 'save' ? '+' : kind === 'locate' ? '↗' : kind === 'delete' ? '×' : '⌕'}
  </span>
);

export const BookmarkWidget = forwardRef<ManagedWindowHandle, BookmarkWidgetProps>(
  ({ id, windowManager }, ref): ReactNode => {
    const [title, setTitle] = useState('');
    const [pendingDeleteKey, setPendingDeleteKey] = useState<string | null>(null);
    const searchRef = useRef<HTMLInputElement | null>(null);
    const titleRef = useRef<HTMLInputElement | null>(null);

    const model = useMemo(() => createBookmarkExperienceModel({ pageSize: 6 }), []);
    const controller = useMemo(() => createBookmarkInteractionController({
      model,
      storage: {
        read: () => LocalStorageHelper.Get(Constants_ConfigKeys.BOOKMARKS),
        write: (bookmarks) => LocalStorageHelper.Set(Constants_ConfigKeys.BOOKMARKS, bookmarks),
      },
      map: {
        getView: () => MapManager.GetMapView() as BookmarkMapViewPort | null,
      },
      operationTimeoutMs: 15_000,
    }), [model]);

    const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
    const interaction = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
    const activeEntry = snapshot.entries.find((entry) => entry.id === snapshot.activeId) ?? null;
    const busy = interaction.phase === 'saving'
      || interaction.phase === 'deleting'
      || interaction.phase === 'navigating';

    const refreshBookmarks = useCallback((): void => {
      controller.refresh();
      setPendingDeleteKey(null);
    }, [controller]);

    useImperativeHandle(ref, () => ({
      id,
      visible: false,
      minimized: false,
      OnShow: () => {
        refreshBookmarks();
        windowManager.ShowWindow('sidebar');
      },
      OnClose: () => {
        setTitle('');
        setPendingDeleteKey(null);
        model.resetInteraction();
        controller.clearNotice();
      },
    }), [controller, id, model, refreshBookmarks, windowManager]);

    useEffect(() => {
      windowManager.RegisterWindow(ref as RefObject<ManagedWindowHandle | null>);
      refreshBookmarks();
      return () => {
        windowManager.UnregisterWindow?.(id, ref as RefObject<ManagedWindowHandle | null>);
        controller.dispose();
        model.dispose();
      };
    }, [controller, id, model, ref, refreshBookmarks, windowManager]);

    useEffect(() => {
      if (!activeEntry) return;
      const node = document.getElementById(activeEntry.id);
      node?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    }, [activeEntry]);

    const saveBookmark = (event: FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      if (controller.saveCurrentView(title)) {
        setTitle('');
        titleRef.current?.focus({ preventScroll: true });
      }
    };

    const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
      const movement = MOVEMENT_KEYS[event.key];
      if (!movement || snapshot.entries.length === 0) return;
      event.preventDefault();
      model.moveActive(movement);
    };

    const handleListKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
      const movement = MOVEMENT_KEYS[event.key];
      if (movement && snapshot.entries.length > 0) {
        event.preventDefault();
        model.moveActive(movement);
        return;
      }
      if (event.key === 'Enter' && activeEntry) {
        event.preventDefault();
        void controller.navigate(activeEntry.key);
      }
      if (event.key === 'Escape' && pendingDeleteKey) {
        event.preventDefault();
        setPendingDeleteKey(null);
      }
    };

    const status = interaction.lastNotice?.message
      ?? snapshot.storageWarning
      ?? (snapshot.totalCount > 0 ? `${snapshot.totalCount} yer işareti kayıtlı` : null);
    const statusTone = interaction.lastNotice?.severity === 'error'
      ? 'error'
      : interaction.lastNotice?.severity === 'warning' || snapshot.storageWarning
        ? 'warning'
        : 'info';

    return (
      <MapWidgetSurface
        id={id}
        title="Yer İşaretleri"
        windowManager={windowManager}
        busy={busy}
        busyLabel={interaction.phase === 'navigating' ? 'Harita görünümüne gidiliyor…' : 'Yer işareti işlemi tamamlanıyor…'}
        status={status}
        statusTone={statusTone}
      >
        <div className="bookmark-modern" data-view={snapshot.viewMode} data-busy={String(busy)}>
          <MapWidgetSection
            title="Bu görünümü kaydet"
            description="Haritanın merkezini ve yakınlaştırma düzeyini yalnızca bu tarayıcıda saklar."
          >
            <form onSubmit={saveBookmark} className="bookmark-modern__save-form" aria-busy={interaction.phase === 'saving'}>
              <div className="map-widget-field bookmark-modern__title-field">
                <label htmlFor={`${id}-bookmark-title`}>Yer işareti adı</label>
                <div className="bookmark-modern__input-row">
                  <input
                    ref={titleRef}
                    id={`${id}-bookmark-title`}
                    type="text"
                    value={title}
                    maxLength={120}
                    autoComplete="off"
                    onChange={(event) => setTitle(event.currentTarget.value)}
                    placeholder="Örn. Kızılay çalışma alanı"
                    aria-describedby={`${id}-bookmark-title-hint`}
                  />
                  <button
                    type="submit"
                    className="map-widget-action map-widget-action--primary bookmark-modern__primary-action"
                    disabled={busy}
                  >
                    <ActionGlyph kind="save" />
                    <span>Görünümü kaydet</span>
                  </button>
                </div>
                <p id={`${id}-bookmark-title-hint`} className="bookmark-modern__field-hint">
                  En fazla 120 karakter. Kayıt yalnızca bu tarayıcıda tutulur.
                </p>
              </div>
            </form>
          </MapWidgetSection>

          <MapWidgetSection
            title="Kayıtlı görünümler"
            description="Kayıtları arayın, klavyeyle gezin veya seçtiğiniz konuma güvenli biçimde dönün."
          >
            <div className="bookmark-modern__toolbar" aria-label="Yer işareti görünüm araçları">
              <label className="bookmark-modern__search" htmlFor={`${id}-bookmark-search`}>
                <span className="bookmark-modern__search-label">Yer işareti ara</span>
                <span className="bookmark-modern__search-shell">
                  <ActionGlyph kind="search" />
                  <input
                    ref={searchRef}
                    id={`${id}-bookmark-search`}
                    type="search"
                    value={snapshot.query}
                    onChange={(event) => model.setQuery(event.currentTarget.value)}
                    onKeyDown={handleSearchKeyDown}
                    placeholder="Ad, koordinat veya yakınlaştırma"
                    autoComplete="off"
                    spellCheck={false}
                    role="combobox"
                    aria-autocomplete="list"
                    aria-controls={`${id}-bookmark-list`}
                    aria-expanded={snapshot.resultCount > 0}
                    aria-activedescendant={activeEntry?.id}
                    aria-describedby={`${id}-bookmark-status`}
                  />
                  {snapshot.query && (
                    <button
                      type="button"
                      className="bookmark-modern__clear"
                      onClick={() => {
                        model.setQuery('');
                        searchRef.current?.focus({ preventScroll: true });
                      }}
                      aria-label="Yer işareti aramasını temizle"
                    >
                      ×
                    </button>
                  )}
                </span>
              </label>

              <div className="bookmark-modern__view-switch" role="group" aria-label="Yer işareti görünümü">
                <button
                  type="button"
                  className="bookmark-modern__view-button"
                  aria-pressed={snapshot.viewMode === 'grid'}
                  onClick={() => model.setViewMode('grid')}
                >
                  <span aria-hidden="true">▦</span>
                  <span>Kart</span>
                </button>
                <button
                  type="button"
                  className="bookmark-modern__view-button"
                  aria-pressed={snapshot.viewMode === 'list'}
                  onClick={() => model.setViewMode('list')}
                >
                  <span aria-hidden="true">☷</span>
                  <span>Liste</span>
                </button>
              </div>
            </div>

            <p
              id={`${id}-bookmark-status`}
              className="bookmark-modern__result-status"
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              {snapshot.announcement}
            </p>

            {interaction.lastNotice && (
              <div
                className="bookmark-modern__notice"
                data-severity={interaction.lastNotice.severity}
                role={interaction.lastNotice.severity === 'error' ? 'alert' : 'status'}
              >
                <NoticeGlyph severity={interaction.lastNotice.severity} />
                <span>{interaction.lastNotice.message}</span>
                <button type="button" onClick={() => controller.clearNotice()} aria-label="İşlem bildirimini kapat">×</button>
              </div>
            )}

            {snapshot.emptyReason === 'no-bookmarks' ? (
              <MapWidgetEmptyState
                title="Henüz yer işareti yok"
                description="Sık kullandığınız harita görünümlerini yukarıdaki formdan kaydedebilirsiniz."
              />
            ) : snapshot.emptyReason === 'no-results' ? (
              <div className="bookmark-modern__empty" role="note">
                <strong>Eşleşme bulunamadı</strong>
                <span>Aramayı kısaltın veya kayıtlı yer işaretlerinin tamamına dönün.</span>
                <button
                  type="button"
                  className="map-widget-action"
                  onClick={() => {
                    model.setQuery('');
                    searchRef.current?.focus({ preventScroll: true });
                  }}
                >
                  Tüm yer işaretlerini göster
                </button>
              </div>
            ) : (
              <div
                id={`${id}-bookmark-list`}
                className="bookmark-modern__collection"
                data-view={snapshot.viewMode}
                role="listbox"
                aria-label="Kayıtlı yer işaretleri"
                aria-activedescendant={activeEntry?.id}
                tabIndex={0}
                onKeyDown={handleListKeyDown}
              >
                {snapshot.entries.map((entry) => {
                  const item = entry.bookmark;
                  const pendingDelete = pendingDeleteKey === entry.key;
                  const navigating = interaction.phase === 'navigating' && interaction.pendingBookmarkKey === entry.key;
                  return (
                    <article
                      id={entry.id}
                      className="bookmark-modern__card"
                      role="option"
                      aria-selected={entry.active}
                      aria-posinset={entry.position}
                      aria-setsize={entry.setSize}
                      data-active={entry.active || undefined}
                      data-pending-delete={pendingDelete || undefined}
                      key={entry.key}
                      onMouseMove={() => model.setActive(entry.id)}
                    >
                      <div className="bookmark-modern__card-main">
                        <span className="bookmark-modern__pin" aria-hidden="true">⌖</span>
                        <div className="bookmark-modern__card-copy">
                          <h3 className="bookmark-modern__card-title">{item.Title}</h3>
                          <p className="bookmark-modern__card-meta">
                            {item.Lat.toFixed(4)}, {item.Lng.toFixed(4)}
                            <span aria-hidden="true"> · </span>
                            <span>Yakınlaştırma {item.Zoom.toFixed(1)}</span>
                          </p>
                        </div>
                      </div>

                      {pendingDelete ? (
                        <div className="bookmark-modern__delete-confirm" role="group" aria-label={`${item.Title} silme onayı`}>
                          <span>Bu kayıt silinsin mi?</span>
                          <button
                            type="button"
                            className="map-widget-action map-widget-action--danger"
                            onClick={() => {
                              if (controller.remove(entry.key)) setPendingDeleteKey(null);
                            }}
                            disabled={busy}
                          >
                            Evet, sil
                          </button>
                          <button type="button" className="map-widget-action" onClick={() => setPendingDeleteKey(null)}>
                            Vazgeç
                          </button>
                        </div>
                      ) : (
                        <div className="bookmark-modern__card-actions" aria-label={`${item.Title} işlemleri`}>
                          <button
                            type="button"
                            className="map-widget-action bookmark-modern__locate"
                            onClick={() => void controller.navigate(entry.key)}
                            disabled={busy}
                          >
                            <ActionGlyph kind="locate" />
                            <span>{navigating ? 'Gidiliyor…' : 'Haritada göster'}</span>
                          </button>
                          <button
                            type="button"
                            className="map-widget-action map-widget-action--danger bookmark-modern__delete"
                            onClick={() => setPendingDeleteKey(entry.key)}
                            disabled={busy}
                            aria-label={`${item.Title} yer işaretini sil`}
                          >
                            <ActionGlyph kind="delete" />
                            <span>Sil</span>
                          </button>
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </MapWidgetSection>
        </div>
      </MapWidgetSurface>
    );
  },
);

BookmarkWidget.displayName = 'BookmarkWidget';
