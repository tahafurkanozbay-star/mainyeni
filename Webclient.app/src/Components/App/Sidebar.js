import React, { useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { DebugHelper } from "../../Toolbox/DebugHelper";
import MapManager from "../../Store/Managers/MapManager";
import { CommonBusiness } from "../../Business/CommonBusiness";
import { createPictureMarkerSymbol } from "../../gis-engine/iconPresentation";
import { SharedGISIcon } from "../Common/SharedGISIcon";
import {
    INITIAL_CITY_LAYER_SERVICE_KEYS,
    SIDEBAR_GROUPS,
    getSidebarItemsForGroup
} from "./SidebarCatalog";
import "./Sidebar.css";
import "./SidebarModern.css";

const createInitialOperationalLayer = async (mapView, serviceKey) => {
    const symbol = createPictureMarkerSymbol(
        { type: serviceKey, title: serviceKey },
        mapView.zoom,
        { minSize: 25, maxSize: 25 }
    );

    const result = await CommonBusiness.Clustering.CreateLayerWithoutClustering(
        serviceKey,
        "Kent Rehberi",
        {},
        symbol
    );

    return result?.layerObj || null;
};

export const Sidebar = React.forwardRef(({ id, windowManager }, ref) => {
    const [activeGroup, setActiveGroup] = useState(null);
    const [visible, setVisible] = useState(true);
    const mountedOperationalLayers = useRef([]);

    useImperativeHandle(ref, () => ({
        id,
        visible: true,
        minimized: false,
        OnShow: () => {
            DebugHelper.Log(`show ${id}`);
            setVisible(true);
        },
        OnClose: () => {
            DebugHelper.Log(`closing ${id}`);
            setVisible(false);
            setActiveGroup(null);
        }
    }), [id]);

    useEffect(() => {
        windowManager.RegisterWindow(ref);
        return () => windowManager.UnregisterWindow?.(id, ref);
    }, [id, ref, windowManager]);

    useEffect(() => {
        const mapView = MapManager.GetMapView();
        if (!mapView?.map) return undefined;

        let cancelled = false;

        const loadOperationalLayers = async () => {
            const layers = await Promise.all(INITIAL_CITY_LAYER_SERVICE_KEYS.map(async serviceKey => {
                try {
                    return await createInitialOperationalLayer(mapView, serviceKey);
                } catch (error) {
                    DebugHelper.Log(error);
                    return null;
                }
            }));

            if (cancelled) return;

            const validLayers = layers.filter(Boolean);
            validLayers.forEach(layer => {
                if (!mapView.map.layers?.includes?.(layer)) mapView.map.add(layer);
            });
            mountedOperationalLayers.current = validLayers;
        };

        loadOperationalLayers();

        return () => {
            cancelled = true;
            mountedOperationalLayers.current.forEach(layer => {
                try {
                    if (mapView?.map?.layers?.includes?.(layer)) mapView.map.remove(layer);
                } catch (error) {
                    DebugHelper.Log(error);
                }
            });
            mountedOperationalLayers.current = [];
        };
    }, []);

    const activeGroupMeta = useMemo(
        () => SIDEBAR_GROUPS.find(group => group.id === activeGroup) || null,
        [activeGroup]
    );
    const activeItems = useMemo(
        () => activeGroup ? getSidebarItemsForGroup(activeGroup) : [],
        [activeGroup]
    );

    const toggleGroup = groupId => {
        setActiveGroup(current => current === groupId ? null : groupId);
    };

    const openWindow = windowId => {
        windowManager.ShowWindow(windowId);
    };

    if (!visible) return null;

    return (
        <aside className="sidebar-container kr-sidebar" aria-label="Kent Rehberi hizmet kategorileri">
            <nav className="ns-sidebar-header kr-sidebar__groups" aria-label="Kurum kategorileri">
                {SIDEBAR_GROUPS.map(group => (
                    <button
                        key={group.id}
                        type="button"
                        className={`kr-sidebar__group ns-btn${group.id} ${activeGroup === group.id ? "active" : ""}`}
                        onClick={() => toggleGroup(group.id)}
                        aria-pressed={activeGroup === group.id}
                        aria-controls="kr-sidebar-services"
                        title={group.label}
                    >
                        <img src={group.logo} alt="" aria-hidden="true" loading="lazy" decoding="async" />
                        <span className="kr-sidebar__group-label" aria-hidden="true">{group.shortLabel || group.id}</span>
                        <span className="experience-sr-only">{group.label}</span>
                    </button>
                ))}
            </nav>

            <section id="kr-sidebar-services" className="kr-sidebar__panel" aria-live="polite">
                {activeGroupMeta ? <>
                    <header className="kr-sidebar__panel-head">
                        <h2>{activeGroupMeta.label}</h2>
                        <span>{activeItems.length} hizmet</span>
                    </header>
                    <div className="ns-sidebar-container kr-sidebar__items">
                        {activeItems.map(item => (
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
                </> : (
                    <p className="kr-sidebar__empty">Hizmetleri görüntülemek için yukarıdaki kurumlardan birini seçin.</p>
                )}
            </section>
        </aside>
    );
});

Sidebar.displayName = "Sidebar";
