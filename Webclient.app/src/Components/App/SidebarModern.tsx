import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { CommonBusiness } from '../../Business/CommonBusiness';
import MapManager from '../../Store/Managers/MapManager';
import { DebugHelper } from '../../Toolbox/DebugHelper';
import type { ManagedWindowHandle, WindowManagerLike } from '../../experience/contracts';
import { createPictureMarkerSymbol } from '../../gis-engine/iconPresentation';
import { createSidebarKeyboardController, type SidebarKeyboardFocusTarget } from '../../shell/sidebarKeyboardController';
import { createSidebarLayerLoadController } from '../../shell/sidebarLayerLoadController';
import { createSidebarNavigationModel, type SidebarNavigationView } from '../../shell/sidebarNavigationModel';
import { createSidebarPreferenceStore } from '../../shell/sidebarPreferenceStore';
import { SharedGISIcon } from '../Common/SharedGISIcon';
import {
  INITIAL_CITY_LAYER_SERVICE_KEYS,
  SIDEBAR_GROUPS,
  SIDEBAR_ITEMS,
  type SidebarGroup,
  type SidebarItem,
} from './SidebarCatalog';
import './Sidebar.css';
import './SidebarModern.css';
import './SidebarInteraction.css';
import './SidebarLayerStatus.css';

interface SidebarProps {
  readonly id: string;
  readonly windowManager: WindowManagerLike;
}

interface MapLayerCollection {
  includes?: (layer: unknown) => boolean;
}

interface MapLike {
  readonly layers?: MapLayerCollection;
  readonly add: (layer: unknown) => void;
  readonly remove: (layer: unknown) => void;
}

interface MapViewLike {
  readonly zoom: number;
  readonly map?: MapLike;
}

const GROUPS = SIDEBAR_GROUPS as readonly SidebarGroup[];
const ITEMS = SIDEBAR_ITEMS as readonly SidebarItem[];
const SERVICE_KEYS = INITIAL_CITY_LAYER_SERVICE_KEYS as readonly string[];
const MAX_RECENT_SERVICES = 6;
const LAYER_LOAD_CONCURRENCY = 4;
const GROUP_IDS = Object.freeze(GROUPS.map((group) => group.id));
const ITEM_IDS = Object.freeze(ITEMS.map((item) => item.windowId));

const createInitialOperationalLayer = async (
  mapView: MapViewLike,
  serviceKey: string,
): Promise<unknown | null> => {
  const symbol = createPictureMarkerSymbol(
    { type: serviceKey, title: serviceKey },
    mapView.zoom,
    { minSize: 25, maxSize: 25 },
  );
  const result = await CommonBusiness.Clustering.CreateLayerWithoutClustering(
    serviceKey,
    'Kent Rehberi',
    {},
    symbol,
  );
  return result?.layerObj ?? null;
};

const addLayerSafely = (map: MapLike, layer: unknown): boolean => {
  try {
    if (map.layers?.includes?.(layer)) return true;
    map.add(layer);
    return true;
  } catch (error) {
    DebugHelper.Log(error);
    return false;
  }
};

const removeLayerSafely = (map: MapLike, layer: unknown): void => {
  try {
    if (!map.layers?.includes || map.layers.includes(layer)) map.remove(layer);
  } catch (error) {
    DebugHelper.Log(error);
  }
};

const ServiceSearchGlyph = (): ReactNode => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="m16 16 4 4" />
  </svg>
);

const FavoriteGlyph = ({ active }: { readonly active: boolean }): ReactNode => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
    <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-2.9-5.6 2.9 1.1-6.2L3 9.6l6.2-.9L12 3Z" />
  </svg>
);

const viewLabel = (view: SidebarNavigationView): string => {
  if (view === 'favorites') return 'Favoriler';
  if (view === 'recent') return 'Son';
  return 'Tümü';
};

const resolveLocalStorage = (): Storage | null => {
  try {
    return window.localStorage;
  } catch (error) {
    DebugHelper.Log(error);
    return null;
  }
};

export const SidebarModern = forwardRef<ManagedWindowHandle, SidebarProps>(function SidebarModern(
  { id, windowManager },
  ref,
) {
  const preferenceStore = useMemo(() => createSidebarPreferenceStore({
    storage: resolveLocalStorage(),
    validItemIds: ITEM_IDS,
    maxRecentIds: MAX_RECENT_SERVICES,
  }), []);

  const navigationModel = useMemo(() => {
    const preferences = preferenceStore.load();
    return createSidebarNavigationModel({
      groups: GROUPS,
      items: ITEMS,
      initialFavoriteIds: preferences.favoriteIds,
      initialRecentIds: preferences.recentIds,
      limits: { maxRecentIds: MAX_RECENT_SERVICES },
    });
  }, [preferenceStore]);

  const navigation = useSyncExternalStore(
    navigationModel.subscribe,
    navigationModel.getSnapshot,
    navigationModel.getSnapshot,
  );

  const keyboardController = useMemo(() => createSidebarKeyboardController({
    model: navigationModel,
    groupIds: GROUP_IDS,
    pageSize: 6,
  }), [navigationModel]);

  const mapViewRef = useRef<MapViewLike | null>(null);
  const mountedOperationalLayers = useRef<unknown[]>([]);
  const layerLoadController = useMemo(() => createSidebarLayerLoadController<unknown>({
    serviceKeys: SERVICE_KEYS,
    concurrency: LAYER_LOAD_CONCURRENCY,
    loadLayer: async (serviceKey) => {
      const mapView = mapViewRef.current;
      if (!mapView?.map) return null;
      return createInitialOperationalLayer(mapView, serviceKey);
    },
  }), []);
  const layerLoad = useSyncExternalStore(
    layerLoadController.subscribe,
    layerLoadController.getSnapshot,
    layerLoadController.getSnapshot,
  );

  const registrationRef = useRef<ManagedWindowHandle | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const groupButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const serviceButtonRefs = useRef(new Map<string, HTMLButtonElement>());

  const createManagedWindowHandle = (): ManagedWindowHandle => ({
    id,
    visible: navigation.visible,
    minimized: navigation.collapsed,
    OnShow: () => {
      DebugHelper.Log(`show ${id}`);
      navigationModel.show();
    },
    OnClose: () => {
      DebugHelper.Log(`closing ${id}`);
      navigationModel.close();
    },
  });

  useImperativeHandle(ref, createManagedWindowHandle, [id, navigation.collapsed, navigation.visible, navigationModel]);
  useImperativeHandle(registrationRef, createManagedWindowHandle, [id, navigation.collapsed, navigation.visible, navigationModel]);

  useEffect(() => {
    windowManager.RegisterWindow(registrationRef);
    return () => windowManager.UnregisterWindow?.(id, registrationRef);
  }, [id, windowManager]);

  useEffect(() => {
    const mapView = MapManager.GetMapView() as MapViewLike | null;
    mapViewRef.current = mapView;
    const map = mapView?.map;
    if (!map) {
      return () => {
        mapViewRef.current = null;
      };
    }

    void layerLoadController.start();

    return () => {
      layerLoadController.cancel();
      for (const layer of mountedOperationalLayers.current) removeLayerSafely(map, layer);
      mountedOperationalLayers.current = [];
      mapViewRef.current = null;
    };
  }, [layerLoadController]);

  useEffect(() => {
    const map = mapViewRef.current?.map;
    if (!map) return;
    for (const entry of layerLoad.loadedLayers) {
      if (mountedOperationalLayers.current.includes(entry.layer)) continue;
      if (addLayerSafely(map, entry.layer)) mountedOperationalLayers.current.push(entry.layer);
    }
  }, [layerLoad.loadedLayers]);

  const focusKeyboardTarget = (target: SidebarKeyboardFocusTarget): void => {
    if (target === null) return;
    if (target.kind === 'search') {
      searchInputRef.current?.focus({ preventScroll: true });
      return;
    }
    if (target.kind === 'group') {
      groupButtonRefs.current.get(target.groupId)?.focus({ preventScroll: true });
      return;
    }
    serviceButtonRefs.current.get(target.windowId)?.focus({ preventScroll: true });
  };

  const openWindow = (windowId: string): void => {
    navigationModel.recordRecent(windowId);
    preferenceStore.saveRecents(navigationModel.getSnapshot().recentIds);
    windowManager.ShowWindow(windowId);
  };

  const toggleFavorite = (windowId: string): void => {
    navigationModel.toggleFavorite(windowId);
    preferenceStore.saveFavorites(navigationModel.getSnapshot().favoriteIds);
  };

  const handleServiceKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    const result = keyboardController.handleServiceKey(event);
    if (!result.handled) return;
    event.preventDefault();
    if (result.activateWindowId !== null) openWindow(result.activateWindowId);
    focusKeyboardTarget(result.focus);
  };

  const handleSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    const result = keyboardController.handleSearchKey(event);
    if (!result.handled) return;
    event.preventDefault();
    focusKeyboardTarget(result.focus);
  };

  const handleGroupKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, groupId: string): void => {
    const result = keyboardController.handleGroupKey(event, groupId);
    if (!result.handled) return;
    event.preventDefault();
    focusKeyboardTarget(result.focus);
  };

  if (!navigation.visible) return null;

  const panelTitle = navigation.view === 'favorites'
    ? 'Favorilerim'
    : navigation.view === 'recent'
      ? 'Son kullanılanlar'
      : navigation.activeGroup?.label ?? 'Tüm kent servisleri';
  const emptyTitle = navigation.emptyReason === 'no-favorites'
    ? 'Henüz favori yok'
    : navigation.emptyReason === 'no-recents'
      ? 'Henüz geçmiş yok'
      : 'Hizmet bulunamadı';
  const emptyDescription = navigation.normalizedQuery
    ? 'Arama ifadenizi değiştirin veya filtreyi temizleyin.'
    : navigation.emptyReason === 'no-favorites'
      ? 'Sık kullandığınız bir hizmeti yıldızlayın.'
      : navigation.emptyReason === 'no-recents'
        ? 'Açtığınız hizmetler burada en yeniden eskiye görünür.'
        : 'Başka bir kurum veya görünüm seçin.';
  const rovingGroupId = navigation.activeGroupId ?? GROUPS[0]?.id ?? null;
  const layerProgressValue = layerLoad.totalCount === 0
    ? 100
    : Math.round((layerLoad.completedCount / layerLoad.totalCount) * 100);
  const layerTitle = layerLoad.phase === 'loading'
    ? 'Harita katmanları hazırlanıyor'
    : layerLoad.phase === 'degraded'
      ? 'Bazı harita katmanları hazırlanamadı'
      : 'Harita katmanları hazır';
  const layerDetail = layerLoad.phase === 'loading'
    ? `${layerLoad.completedCount}/${layerLoad.totalCount} tamamlandı`
    : layerLoad.phase === 'degraded'
      ? `${layerLoad.loadedCount} hazır · ${layerLoad.failedCount} yeniden denenebilir`
      : `${layerLoad.loadedCount} katman kullanıma hazır`;
  const showLayerStatus = layerLoad.phase !== 'idle' && layerLoad.phase !== 'cancelled';

  return (
    <aside
      className={`sidebar-container kr-sidebar kr-sidebar--next kr-sidebar--governed ${navigation.collapsed ? 'is-collapsed' : ''}`}
      aria-label="Kent Rehberi hizmet kategorileri"
      data-navigation-revision={navigation.revision}
    >
      <header className="kr-sidebar__topline">
        <div className="kr-sidebar__title">
          <span>ŞEHİR SERVİSLERİ</span>
          <strong>Keşfet</strong>
        </div>
        <button
          type="button"
          className="kr-sidebar__toggle"
          onClick={() => navigationModel.toggleCollapsed()}
          aria-expanded={!navigation.collapsed}
          aria-controls="kr-sidebar-services"
          aria-label={navigation.collapsed ? 'Hizmet panelini genişlet' : 'Hizmet panelini daralt'}
          title={navigation.collapsed ? 'Paneli genişlet' : 'Paneli daralt'}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
      </header>

      <nav className="ns-sidebar-header kr-sidebar__groups" aria-label="Kurum kategorileri">
        {GROUPS.map(group => (
          <button
            key={group.id}
            ref={(node) => {
              if (node) groupButtonRefs.current.set(group.id, node);
              else groupButtonRefs.current.delete(group.id);
            }}
            type="button"
            className={`kr-sidebar__group ns-btn${group.id} ${navigation.activeGroupId === group.id ? 'active' : ''}`}
            onClick={() => navigationModel.toggleGroup(group.id)}
            onKeyDown={(event) => handleGroupKeyDown(event, group.id)}
            aria-pressed={navigation.activeGroupId === group.id}
            aria-controls="kr-sidebar-services"
            tabIndex={rovingGroupId === group.id ? 0 : -1}
            title={group.label}
          >
            <img src={group.logo} alt="" aria-hidden="true" loading="lazy" decoding="async" />
            <span className="kr-sidebar__group-label" aria-hidden="true">{group.shortLabel}</span>
            <span className="experience-sr-only">{group.label}</span>
          </button>
        ))}
      </nav>

      <section id="kr-sidebar-services" className="kr-sidebar__panel" aria-labelledby="kr-sidebar-panel-title">
        <div className="kr-sidebar__discovery">
          <label className="kr-sidebar__search">
            <span className="experience-sr-only">Kent servislerinde ara</span>
            <ServiceSearchGlyph />
            <input
              ref={searchInputRef}
              type="search"
              value={navigation.query}
              onChange={event => navigationModel.setQuery(event.target.value)}
              onKeyDown={handleSearchKeyDown}
              placeholder="Hizmet ara…"
              autoComplete="off"
              enterKeyHint="search"
              aria-controls="kr-sidebar-service-list"
              aria-describedby="kr-sidebar-live-status kr-sidebar-keyboard-help"
            />
            {navigation.query ? (
              <button type="button" onClick={() => navigationModel.clearQuery()} aria-label="Hizmet aramasını temizle">×</button>
            ) : null}
          </label>
          <div className="kr-sidebar__views" role="group" aria-label="Hizmet görünümü">
            {(['all', 'favorites', 'recent'] as const).map(value => (
              <button
                key={value}
                type="button"
                className={navigation.view === value ? 'is-active' : ''}
                onClick={() => navigationModel.setView(value)}
                aria-pressed={navigation.view === value}
              >
                <span>{viewLabel(value)}</span><small>{navigation.counts[value]}</small>
              </button>
            ))}
          </div>
        </div>

        <header className="kr-sidebar__panel-head">
          <div>
            <span className="kr-sidebar__context">{navigation.normalizedQuery ? 'ARAMA SONUÇLARI' : 'KENT SERVİSLERİ'}</span>
            <h2 id="kr-sidebar-panel-title">{panelTitle}</h2>
          </div>
          <span aria-hidden="true">{navigation.resultCount} hizmet</span>
        </header>

        {showLayerStatus ? (
          <div className="kr-sidebar__layer-load" data-phase={layerLoad.phase}>
            <div className="kr-sidebar__layer-load-copy">
              <span className="kr-sidebar__layer-load-dot" aria-hidden="true" />
              <span>
                <strong>{layerTitle}</strong>
                <small>{layerDetail}</small>
              </span>
            </div>
            {layerLoad.phase === 'loading' ? (
              <progress
                className="kr-sidebar__layer-progress"
                max={100}
                value={layerProgressValue}
                aria-label="Harita katmanları hazırlama ilerlemesi"
              >
                %{layerProgressValue}
              </progress>
            ) : null}
            {layerLoad.canRetry ? (
              <button
                type="button"
                className="kr-sidebar__layer-retry"
                onClick={() => { void layerLoadController.retryFailed(); }}
              >
                Yeniden dene
              </button>
            ) : null}
            <span className="experience-sr-only" role="status" aria-live="polite" aria-atomic="true">
              {layerLoad.announcement}
            </span>
          </div>
        ) : null}

        <span id="kr-sidebar-keyboard-help" className="experience-sr-only">
          Hizmetler arasında yukarı ve aşağı okları, ilk ve son öğe için Home ve End tuşlarını kullanın. Enter hizmeti açar.
        </span>
        <span id="kr-sidebar-live-status" className="experience-sr-only" role="status" aria-live="polite" aria-atomic="true">
          {navigation.announcement}
        </span>

        {navigation.resultCount > 0 ? (
          <ul id="kr-sidebar-service-list" className="ns-sidebar-container kr-sidebar__items" aria-label={`${panelTitle} hizmet listesi`}>
            {navigation.visibleItems.map((item, index) => {
              const favorite = navigation.favoriteIds.includes(item.windowId);
              const group = GROUPS.find(candidate => candidate.id === item.group);
              const active = navigation.activeItemId === item.windowId;
              return (
                <li className="kr-sidebar__service" key={item.windowId} data-active={active ? 'true' : 'false'} aria-posinset={index + 1} aria-setsize={navigation.resultCount}>
                  <button
                    ref={(node) => {
                      if (node) serviceButtonRefs.current.set(item.windowId, node);
                      else serviceButtonRefs.current.delete(item.windowId);
                    }}
                    type="button"
                    className="ns-card kr-sidebar__item"
                    onClick={() => openWindow(item.windowId)}
                    onFocus={() => navigationModel.setActiveItem(item.windowId)}
                    onKeyDown={handleServiceKeyDown}
                    aria-label={`${item.label} sorgusunu aç`}
                    tabIndex={active ? 0 : -1}
                  >
                    <SharedGISIcon
                      record={{ type: item.iconType ?? item.label, title: item.label }}
                      size={32}
                      className="kr-sidebar__item-icon"
                    />
                    <span className="kr-sidebar__item-copy">
                      <strong>{item.label}</strong>
                      <small>{group?.shortLabel}</small>
                    </span>
                    <span className="kr-sidebar__item-arrow" aria-hidden="true">›</span>
                  </button>
                  <button
                    type="button"
                    className={`kr-sidebar__favorite ${favorite ? 'is-active' : ''}`}
                    onClick={() => toggleFavorite(item.windowId)}
                    aria-pressed={favorite}
                    aria-label={favorite ? `${item.label} favorilerden çıkar` : `${item.label} favorilere ekle`}
                    title={favorite ? 'Favorilerden çıkar' : 'Favorilere ekle'}
                  >
                    <FavoriteGlyph active={favorite} />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="kr-sidebar__empty kr-sidebar__empty--search" role="status">
            <strong>{emptyTitle}</strong>
            <span>{emptyDescription}</span>
          </div>
        )}
      </section>
    </aside>
  );
});

SidebarModern.displayName = 'SidebarModern';

export default SidebarModern;
