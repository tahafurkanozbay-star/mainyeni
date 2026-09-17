import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { CommonBusiness } from '../../Business/CommonBusiness';
import MapManager from '../../Store/Managers/MapManager';
import { DebugHelper } from '../../Toolbox/DebugHelper';
import type { ManagedWindowHandle, WindowManagerLike } from '../../experience/contracts';
import { createPictureMarkerSymbol } from '../../gis-engine/iconPresentation';
import { SharedGISIcon } from '../Common/SharedGISIcon';
import {
  INITIAL_CITY_LAYER_SERVICE_KEYS,
  SIDEBAR_GROUPS,
  SIDEBAR_ITEMS,
} from './SidebarCatalog';
import './Sidebar.css';
import './SidebarModern.css';

type GroupId = 'ABB' | 'EGO' | 'ASKI' | 'ISTIRAK';
type ServiceView = 'all' | 'favorites' | 'recent';

interface SidebarGroup {
  readonly id: GroupId;
  readonly shortLabel: string;
  readonly label: string;
  readonly logo: string;
}

interface SidebarItem {
  readonly group: GroupId;
  readonly label: string;
  readonly windowId: string;
  readonly iconType: string;
}

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
const FAVORITES_KEY = 'kentrehberi:service-favorites';
const RECENTS_KEY = 'kentrehberi:service-recents';
const MAX_RECENT_SERVICES = 6;

const normalize = (value: string): string => value
  .toLocaleLowerCase('tr-TR')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .trim();

const readStoredIds = (key: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(key) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
};

const persistIds = (key: string, ids: readonly string[]): void => {
  try {
    window.localStorage.setItem(key, JSON.stringify(ids));
  } catch (error: unknown) {
    DebugHelper.Log(error);
  }
};

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

export const SidebarModern = forwardRef<ManagedWindowHandle, SidebarProps>(function SidebarModern(
  { id, windowManager },
  ref,
) {
  const [activeGroup, setActiveGroup] = useState<GroupId | null>(null);
  const [visible, setVisible] = useState(true);
  const [collapsed, setCollapsed] = useState(false);
  const [query, setQuery] = useState('');
  const [serviceView, setServiceView] = useState<ServiceView>('all');
  const [favoriteIds, setFavoriteIds] = useState<string[]>(() => readStoredIds(FAVORITES_KEY));
  const [recentIds, setRecentIds] = useState<string[]>(() => readStoredIds(RECENTS_KEY));
  const registrationRef = useRef<ManagedWindowHandle | null>(null);
  const mountedOperationalLayers = useRef<unknown[]>([]);

  const createManagedWindowHandle = (): ManagedWindowHandle => ({
    id,
    visible,
    minimized: collapsed,
    OnShow: () => {
      DebugHelper.Log(`show ${id}`);
      setVisible(true);
      setCollapsed(false);
    },
    OnClose: () => {
      DebugHelper.Log(`closing ${id}`);
      setVisible(false);
      setActiveGroup(null);
    },
  });

  useImperativeHandle(ref, createManagedWindowHandle, [collapsed, id, visible]);
  useImperativeHandle(registrationRef, createManagedWindowHandle, [collapsed, id, visible]);

  useEffect(() => {
    windowManager.RegisterWindow(registrationRef);
    return () => windowManager.UnregisterWindow?.(id, registrationRef);
  }, [id, windowManager]);

  useEffect(() => persistIds(FAVORITES_KEY, favoriteIds), [favoriteIds]);
  useEffect(() => persistIds(RECENTS_KEY, recentIds), [recentIds]);

  useEffect(() => {
    const mapView = MapManager.GetMapView() as MapViewLike | null;
    if (!mapView?.map) return undefined;

    let cancelled = false;
    const loadOperationalLayers = async (): Promise<void> => {
      const layers = await Promise.all(SERVICE_KEYS.map(async serviceKey => {
        try {
          return await createInitialOperationalLayer(mapView, serviceKey);
        } catch (error: unknown) {
          DebugHelper.Log(error);
          return null;
        }
      }));

      if (cancelled) return;
      const validLayers = layers.filter((layer): layer is unknown => layer !== null);
      validLayers.forEach(layer => {
        if (!mapView.map?.layers?.includes?.(layer)) mapView.map?.add(layer);
      });
      mountedOperationalLayers.current = validLayers;
    };

    void loadOperationalLayers();

    return () => {
      cancelled = true;
      mountedOperationalLayers.current.forEach(layer => {
        try {
          if (mapView.map?.layers?.includes?.(layer)) mapView.map.remove(layer);
        } catch (error: unknown) {
          DebugHelper.Log(error);
        }
      });
      mountedOperationalLayers.current = [];
    };
  }, []);

  const activeGroupMeta = useMemo(
    () => GROUPS.find(group => group.id === activeGroup) ?? null,
    [activeGroup],
  );

  const visibleItems = useMemo(() => {
    const needle = normalize(query);
    let candidates = activeGroup ? ITEMS.filter(item => item.group === activeGroup) : ITEMS;

    if (serviceView === 'favorites') {
      candidates = candidates.filter(item => favoriteIds.includes(item.windowId));
    } else if (serviceView === 'recent') {
      candidates = recentIds
        .map(windowId => candidates.find(item => item.windowId === windowId))
        .filter((item): item is SidebarItem => Boolean(item));
    }

    if (!needle) return candidates;
    return candidates.filter(item => normalize(`${item.label} ${item.iconType} ${item.group}`).includes(needle));
  }, [activeGroup, favoriteIds, query, recentIds, serviceView]);

  const toggleGroup = (groupId: GroupId): void => {
    if (collapsed) setCollapsed(false);
    setActiveGroup(current => current === groupId ? null : groupId);
    setServiceView('all');
    setQuery('');
  };

  const openWindow = (item: SidebarItem): void => {
    setRecentIds(current => [item.windowId, ...current.filter(idValue => idValue !== item.windowId)].slice(0, MAX_RECENT_SERVICES));
    windowManager.ShowWindow(item.windowId);
  };

  const toggleFavorite = (windowId: string): void => {
    setFavoriteIds(current => current.includes(windowId)
      ? current.filter(idValue => idValue !== windowId)
      : [...current, windowId]);
  };

  if (!visible) return null;

  const panelTitle = serviceView === 'favorites'
    ? 'Favorilerim'
    : serviceView === 'recent'
      ? 'Son kullanılanlar'
      : activeGroupMeta?.label ?? 'Tüm kent servisleri';

  return (
    <aside className={`sidebar-container kr-sidebar kr-sidebar--next ${collapsed ? 'is-collapsed' : ''}`} aria-label="Kent Rehberi hizmet kategorileri">
      <header className="kr-sidebar__topline">
        <div className="kr-sidebar__title">
          <span>ŞEHİR SERVİSLERİ</span>
          <strong>Keşfet</strong>
        </div>
        <button
          type="button"
          className="kr-sidebar__toggle"
          onClick={() => setCollapsed(value => !value)}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Hizmet panelini genişlet' : 'Hizmet panelini daralt'}
          title={collapsed ? 'Paneli genişlet' : 'Paneli daralt'}
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
            type="button"
            className={`kr-sidebar__group ns-btn${group.id} ${activeGroup === group.id ? 'active' : ''}`}
            onClick={() => toggleGroup(group.id)}
            aria-pressed={activeGroup === group.id}
            aria-controls="kr-sidebar-services"
            title={group.label}
          >
            <img src={group.logo} alt="" aria-hidden="true" loading="lazy" decoding="async" />
            <span className="kr-sidebar__group-label" aria-hidden="true">{group.shortLabel}</span>
            <span className="experience-sr-only">{group.label}</span>
          </button>
        ))}
      </nav>

      <section id="kr-sidebar-services" className="kr-sidebar__panel" aria-live="polite">
        <div className="kr-sidebar__discovery">
          <label className="kr-sidebar__search">
            <span className="experience-sr-only">Kent servislerinde ara</span>
            <ServiceSearchGlyph />
            <input
              type="search"
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="Hizmet ara…"
              autoComplete="off"
              enterKeyHint="search"
            />
            {query ? <button type="button" onClick={() => setQuery('')} aria-label="Hizmet aramasını temizle">×</button> : null}
          </label>
          <div className="kr-sidebar__views" role="group" aria-label="Hizmet görünümü">
            {([
              ['all', 'Tümü', ITEMS.length],
              ['favorites', 'Favoriler', favoriteIds.length],
              ['recent', 'Son', recentIds.length],
            ] as const).map(([value, label, count]) => (
              <button
                key={value}
                type="button"
                className={serviceView === value ? 'is-active' : ''}
                onClick={() => setServiceView(value)}
                aria-pressed={serviceView === value}
              >
                <span>{label}</span><small>{count}</small>
              </button>
            ))}
          </div>
        </div>

        <header className="kr-sidebar__panel-head">
          <div>
            <span className="kr-sidebar__context">{query ? 'ARAMA SONUÇLARI' : 'KENT SERVİSLERİ'}</span>
            <h2>{panelTitle}</h2>
          </div>
          <span>{visibleItems.length} hizmet</span>
        </header>

        {visibleItems.length ? (
          <div className="ns-sidebar-container kr-sidebar__items">
            {visibleItems.map(item => {
              const favorite = favoriteIds.includes(item.windowId);
              const group = GROUPS.find(candidate => candidate.id === item.group);
              return (
                <div className="kr-sidebar__service" key={item.windowId}>
                  <button
                    type="button"
                    className="ns-card kr-sidebar__item"
                    onClick={() => openWindow(item)}
                    aria-label={`${item.label} sorgusunu aç`}
                  >
                    <SharedGISIcon
                      record={{ type: item.iconType, title: item.label }}
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
                </div>
              );
            })}
          </div>
        ) : (
          <div className="kr-sidebar__empty kr-sidebar__empty--search">
            <strong>{serviceView === 'favorites' ? 'Henüz favori yok' : serviceView === 'recent' ? 'Henüz geçmiş yok' : 'Hizmet bulunamadı'}</strong>
            <span>{query ? 'Arama ifadenizi değiştirin.' : 'Bir hizmeti yıldızlayın veya açın.'}</span>
          </div>
        )}
      </section>
    </aside>
  );
});

SidebarModern.displayName = 'SidebarModern';

export default SidebarModern;
