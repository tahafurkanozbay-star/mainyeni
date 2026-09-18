import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useState,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { BiBookAdd, BiTrash, BiZoomIn } from 'react-icons/bi';
import { FiMapPin } from 'react-icons/fi';
import { LocalStorageHelper } from '../../../Toolbox/LocalStorageHelper';
import { Constants_ConfigKeys, Constants_MessageType } from '../../../Core/Constants';
import MapManager from '../../../Store/Managers/MapManager';
import type { ManagedWindowHandle } from '../../../experience/contracts';
import {
  MapWidgetEmptyState,
  MapWidgetSection,
  MapWidgetSurface,
  type MapWidgetManagerLike,
} from '../_shared/MapWidgetSurface';
import {
  appendBookmark,
  createBookmarkRecord,
  decodeBookmarks,
  removeBookmarkAt,
  sanitizeWidgetLabel,
  type BookmarkRecord,
} from '../_shared/MapWidgetRuntime';

interface BookmarkMapView {
  readonly center?: {
    readonly latitude?: unknown;
    readonly longitude?: unknown;
    readonly x?: unknown;
    readonly y?: unknown;
  } | null;
  readonly zoom?: unknown;
  readonly goTo?: (target: unknown) => Promise<unknown> | unknown;
}

export interface BookmarkWidgetProps {
  readonly id: string;
  readonly windowManager: MapWidgetManagerLike;
}

export const BookmarkWidget = forwardRef<ManagedWindowHandle, BookmarkWidgetProps>(
  ({ id, windowManager }, ref): ReactNode => {
    const [mapView, setMapView] = useState<BookmarkMapView | null>(null);
    const [list, setList] = useState<readonly BookmarkRecord[]>([]);
    const [title, setTitle] = useState('');
    const [storageWarning, setStorageWarning] = useState<string | null>(null);

    const persist = useCallback((bookmarks: readonly BookmarkRecord[]): void => {
      LocalStorageHelper.Set(Constants_ConfigKeys.BOOKMARKS, bookmarks);
      setList(bookmarks);
    }, []);

    const refreshBookmarks = useCallback((): void => {
      const result = decodeBookmarks(LocalStorageHelper.Get(Constants_ConfigKeys.BOOKMARKS));
      setList(result.bookmarks);
      setStorageWarning(
        result.rejected > 0
          ? `${result.rejected} geçersiz veya yinelenen yer işareti güvenli biçimde atlandı.`
          : null,
      );
    }, []);

    useImperativeHandle(ref, () => ({
      id,
      visible: false,
      minimized: false,
      OnShow: () => {
        refreshBookmarks();
        setMapView(MapManager.GetMapView() as BookmarkMapView | null);
        windowManager.ShowWindow('sidebar');
      },
      OnClose: () => {
        setTitle('');
        setStorageWarning(null);
      },
    }), [id, refreshBookmarks, windowManager]);

    useEffect(() => {
      windowManager.RegisterWindow(ref as RefObject<ManagedWindowHandle | null>);
      setMapView(MapManager.GetMapView() as BookmarkMapView | null);
      refreshBookmarks();
      return () => windowManager.UnregisterWindow?.(id, ref as RefObject<ManagedWindowHandle | null>);
    }, [id, ref, refreshBookmarks, windowManager]);

    const gotoBookmark = useCallback(async (bookmark: BookmarkRecord): Promise<void> => {
      const view = mapView ?? (MapManager.GetMapView() as BookmarkMapView | null);
      if (!view?.goTo) {
        windowManager.ShowMessage(Constants_MessageType.Error, 'Harita görünümü henüz hazır değil.');
        return;
      }
      try {
        await Promise.resolve(view.goTo({
          center: [bookmark.Lng, bookmark.Lat],
          zoom: bookmark.Zoom,
        }));
      } catch {
        windowManager.ShowMessage(Constants_MessageType.Error, 'Yer işaretine gidilemedi.');
      }
    }, [mapView, windowManager]);

    const deleteBookmark = useCallback((index: number): void => {
      persist(removeBookmarkAt(list, index));
    }, [list, persist]);

    const saveBookmark = useCallback((event: FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      const normalizedTitle = sanitizeWidgetLabel(title, '');
      if (!normalizedTitle) {
        windowManager.ShowMessage(Constants_MessageType.Warning, 'Lütfen yer işareti adını doldurunuz.');
        return;
      }

      const view = mapView ?? (MapManager.GetMapView() as BookmarkMapView | null);
      const bookmark = createBookmarkRecord(normalizedTitle, view?.center, view?.zoom);
      if (!bookmark) {
        windowManager.ShowMessage(Constants_MessageType.Error, 'Harita konumu okunamadı.');
        return;
      }

      const next = appendBookmark(list, bookmark);
      if (next === list) {
        windowManager.ShowMessage(
          Constants_MessageType.Warning,
          'Aynı adla bir yer işareti bulunuyor. Lütfen farklı bir isim giriniz.',
        );
        return;
      }

      persist(next);
      setTitle('');
      setStorageWarning(null);
    }, [list, mapView, persist, title, windowManager]);

    return (
      <MapWidgetSurface
        id={id}
        title="Yer İşaretleri"
        iconSrc="images/icons/toolbar/bookmark.png"
        windowManager={windowManager}
        status={storageWarning ?? (list.length > 0 ? `${list.length} yer işareti kayıtlı` : null)}
        statusTone={storageWarning ? 'warning' : 'info'}
      >
        <MapWidgetSection
          title="Bu görünümü kaydet"
          description="Haritanın merkezini ve yakınlaştırma düzeyini yalnızca bu tarayıcıda saklar."
        >
          <form onSubmit={saveBookmark} className="map-widget-bookmark-form">
            <div className="map-widget-field">
              <label htmlFor={`${id}-bookmark-title`}>Yer işareti adı</label>
              <input
                id={`${id}-bookmark-title`}
                type="text"
                value={title}
                maxLength={120}
                autoComplete="off"
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Örn. Kızılay çalışma alanı"
              />
            </div>
            <button type="submit" className="map-widget-action map-widget-action--primary">
              <BiBookAdd aria-hidden="true" />
              <span>Görünümü kaydet</span>
            </button>
          </form>
        </MapWidgetSection>

        <MapWidgetSection
          title="Kayıtlı görünümler"
          description="Seçtiğiniz kayda güvenli ve deterministik biçimde geri dönün."
        >
          {list.length === 0 ? (
            <MapWidgetEmptyState
              title="Henüz yer işareti yok"
              description="Sık kullandığınız harita görünümlerini yukarıdaki formdan kaydedebilirsiniz."
            />
          ) : (
            <div className="map-widget-card-list" role="list" aria-label="Kayıtlı yer işaretleri">
              {list.map((item, index) => (
                <article
                  className="map-widget-card"
                  role="listitem"
                  key={`${item.Title}-${item.Lat}-${item.Lng}`}
                >
                  <div>
                    <h3 className="map-widget-card__title">{item.Title}</h3>
                    <div className="map-widget-card__meta">
                      <FiMapPin aria-hidden="true" />{' '}
                      {item.Lat.toFixed(4)}, {item.Lng.toFixed(4)} · Yakınlaştırma {item.Zoom.toFixed(1)}
                    </div>
                  </div>
                  <div className="map-widget-card__actions" aria-label={`${item.Title} işlemleri`}>
                    <button
                      type="button"
                      className="map-widget-action"
                      onClick={() => void gotoBookmark(item)}
                    >
                      <BiZoomIn aria-hidden="true" />
                      <span>Haritada göster</span>
                    </button>
                    <button
                      type="button"
                      className="map-widget-action map-widget-action--danger"
                      onClick={() => deleteBookmark(index)}
                    >
                      <BiTrash aria-hidden="true" />
                      <span>Sil</span>
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </MapWidgetSection>
      </MapWidgetSurface>
    );
  },
);

BookmarkWidget.displayName = 'BookmarkWidget';
