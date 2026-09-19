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
import type {
  ManagedWindowHandle,
  ManagedWindowRef,
  WindowManagerApi,
} from '../../Store/Managers/WindowManager';
import MapManager from '../../Store/Managers/MapManager';
import { DebugHelper } from '../../Toolbox/DebugHelper';
import { createPictureMarkerSymbol } from '../../gis-engine/iconPresentation';
import { SharedGISIcon } from '../Common/SharedGISIcon';
import {
  INITIAL_CITY_LAYER_SERVICE_KEYS,
  SIDEBAR_GROUPS,
  getSidebarItemsForGroup,
  type SidebarGroupId,
} from './SidebarCatalog';
import './Sidebar.css';
import './SidebarModern.css';

interface SidebarLayerCollection {
  readonly includes?: (layer: unknown) => boolean;
}

interface SidebarMap {
  readonly layers?: SidebarLayerCollection | null;
  readonly add: (layer: unknown) => unknown;
  readonly remove: (layer: unknown) => unknown;
}

interface SidebarMapView {
  readonly zoom?: number;
  readonly map?: SidebarMap | null;
}

interface SidebarProps {
  readonly id: string;
  readonly windowManager: Pick<
    WindowManagerApi,
    'RegisterWindow' | 'UnregisterWindow' | 'ShowWindow'
  >;
}

interface LayerEnvelope {
  readonly layerObj?: unknown;
}

const isLayerEnvelope = (value: unknown): value is LayerEnvelope =>
  value !== null && typeof value === 'object' && 'layerObj' in value;

const createInitialOperationalLayer = async (
  mapView: SidebarMapView,
  serviceKey: string,
): Promise<unknown | null> => {
  const symbol = createPictureMarkerSymbol(
    { type: serviceKey, title: serviceKey },
    mapView.zoom ?? 0,
    { minSize: 25, maxSize: 25 },
  );

  const result = await CommonBusiness.Clustering.CreateLayerWithoutClustering(
    serviceKey,
    'Kent Rehberi',
    {},
    symbol,
  );

  return isLayerEnvelope(result) ? result.layerObj ?? null : null;
};

const mapContainsLayer = (
  map: SidebarMap,
  layer: unknown,
): boolean => Boolean(map.layers?.includes?.(layer));

export const Sidebar = forwardRef<ManagedWindowHandle, SidebarProps>(
  ({ id, windowManager }, ref): ReactNode => {
    const [activeGroup, setActiveGroup] = useState<SidebarGroupId | null>(null);
    const [visible, setVisible] = useState(true);
    const [collapsed, setCollapsed] = useState(false);
    const mountedOperationalLayers = useRef<unknown[]>([]);

    useImperativeHandle(ref, () => ({
      id,
      visible: true,
      minimized: false,
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
    }), [id]);

    useEffect(() => {
      const windowRef = ref as unknown as ManagedWindowRef;
      windowManager.RegisterWindow(windowRef);
      return () => {
        windowManager.UnregisterWindow?.(id, windowRef);
      };
    }, [id, ref, windowManager]);

    useEffect(() => {
      const mapView = MapManager.GetMapView() as SidebarMapView | null;
      const map = mapView?.map;
      if (!map) return undefined;

      let cancelled = false;

      const loadOperationalLayers = async (): Promise<void> => {
        const layers = await Promise.all(
          INITIAL_CITY_LAYER_SERVICE_KEYS.map(async (serviceKey) => {
            try {
              return await createInitialOperationalLayer(mapView, serviceKey);
            } catch (error) {
              DebugHelper.Log(error);
              return null;
            }
          }),
        );

        if (cancelled) return;

        const validLayers = layers.filter((layer): layer is unknown => layer !== null);
        validLayers.forEach((layer) => {
          if (!mapContainsLayer(map, layer)) map.add(layer);
        });
        mountedOperationalLayers.current = validLayers;
      };

      void loadOperationalLayers();

      return () => {
        cancelled = true;
        mountedOperationalLayers.current.forEach((layer) => {
          try {
            if (mapContainsLayer(map, layer)) map.remove(layer);
          } catch (error) {
            DebugHelper.Log(error);
          }
        });
        mountedOperationalLayers.current = [];
      };
    }, []);

    const activeGroupMeta = useMemo(
      () => SIDEBAR_GROUPS.find((group) => group.id === activeGroup) ?? null,
      [activeGroup],
    );
    const activeItems = useMemo(
      () => activeGroup ? getSidebarItemsForGroup(activeGroup) : [],
      [activeGroup],
    );

    const toggleGroup = (groupId: SidebarGroupId): void => {
      if (collapsed) {
        setCollapsed(false);
        setActiveGroup(groupId);
        return;
      }
      setActiveGroup((current) => current === groupId ? null : groupId);
    };

    const openWindow = (windowId: string): void => {
      windowManager.ShowWindow(windowId);
    };

    if (!visible) return null;

    return (
      <aside
        className={`sidebar-container kr-sidebar ${collapsed ? 'is-collapsed' : ''}`}
        aria-label="Kent Rehberi hizmet kategorileri"
      >
        <header className="kr-sidebar__topline">
          <div className="kr-sidebar__title">
            <span>ŞEHİR SERVİSLERİ</span>
            <strong>Keşfet</strong>
          </div>
          <button
            type="button"
            className="kr-sidebar__toggle"
            onClick={() => setCollapsed((value) => !value)}
            aria-expanded={!collapsed}
            aria-label={collapsed ? 'Hizmet panelini genişlet' : 'Hizmet panelini daralt'}
            title={collapsed ? 'Paneli genişlet' : 'Paneli daralt'}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="m15 18-6-6 6-6" />
            </svg>
          </button>
        </header>

        <nav
          className="ns-sidebar-header kr-sidebar__groups"
          aria-label="Kurum kategorileri"
        >
          {SIDEBAR_GROUPS.map((group) => (
            <button
              key={group.id}
              type="button"
              className={`kr-sidebar__group ns-btn${group.id} ${activeGroup === group.id ? 'active' : ''}`}
              onClick={() => toggleGroup(group.id)}
              aria-pressed={activeGroup === group.id}
              aria-controls="kr-sidebar-services"
              title={group.label}
            >
              <img
                src={group.logo}
                alt=""
                aria-hidden="true"
                loading="lazy"
                decoding="async"
              />
              <span className="kr-sidebar__group-label" aria-hidden="true">
                {group.shortLabel}
              </span>
              <span className="experience-sr-only">{group.label}</span>
            </button>
          ))}
        </nav>

        <section
          id="kr-sidebar-services"
          className="kr-sidebar__panel"
          aria-live="polite"
        >
          {activeGroupMeta ? (
            <>
              <header className="kr-sidebar__panel-head">
                <h2>{activeGroupMeta.label}</h2>
                <span>{activeItems.length} hizmet</span>
              </header>
              <div className="ns-sidebar-container kr-sidebar__items">
                {activeItems.map((item) => (
                  <button
                    key={item.windowId}
                    type="button"
                    className="ns-card kr-sidebar__item"
                    onClick={() => openWindow(item.windowId)}
                    aria-label={`${item.label} sorgusunu aç`}
                  >
                    <SharedGISIcon
                      record={{ type: item.iconType, title: item.label }}
                      size={32}
                      className="kr-sidebar__item-icon"
                    />
                    <span className="kr-sidebar__item-copy">{item.label}</span>
                    <span className="kr-sidebar__item-arrow" aria-hidden="true">›</span>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <p className="kr-sidebar__empty">
              Hizmetleri görüntülemek için yukarıdaki kurumlardan birini seçin.
            </p>
          )}
        </section>
      </aside>
    );
  },
);

Sidebar.displayName = 'Sidebar';
