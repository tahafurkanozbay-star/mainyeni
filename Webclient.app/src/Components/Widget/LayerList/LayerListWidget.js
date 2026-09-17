import React, { useEffect, useImperativeHandle, useRef, useState } from "react";
import { LayerBusiness } from "../../../Business/LayerBusiness";
import { Constants_ServiceResultType } from "../../../Core/Constants";
import { MapManager } from "../../../Store/Managers/MapManager";
import { loadArcgisModules as loadModules } from "../../../gis-engine/arcgisModuleRuntime";
import { Accordion, Form, Tab, Tabs } from "react-bootstrap";
import { CommonBusiness } from "../../../Business/CommonBusiness";
import { ContainerLoading, NoResultsFound } from "../../Common/Loading";
import { DynamicLayerManager } from "../../../Store/Managers/DynamicLayerManager";
import { CommonQueryWindowTools } from "../../Query/_Common/CommonQueryWindowTools";
import { SharedGISIcon } from "../../Common/SharedGISIcon";
import { createLayerOwner } from "../../../gis-engine/layerOwnership";
import "./LayerListWidget.css";
import { BiCheckCircle, BiCircle, BiMinusCircle } from "react-icons/bi";

const OWNER_ID = 'layer-list-widget';

const evaluateGroupVisibility = (layerGroup) => {
    const layers = Array.isArray(layerGroup?.layers) ? layerGroup.layers : [];
    const visibleLayersCount = layers.filter((layer) => layer.visible).length;
    return {
        ...layerGroup,
        visible: layers.length > 0 && visibleLayersCount === layers.length,
        semiVisible: visibleLayersCount > 0 && visibleLayersCount < layers.length,
    };
};

const getConfiguredOperationalGroup = (groups = []) => {
    if (groups[2]?.layers?.length) return groups[2];
    return groups.find((group) => Array.isArray(group?.layers) && group.layers.length > 0) || null;
};

export const LayerListWidget = React.forwardRef((props, ref) => {
    const [layerGroups, setLayerGroups] = useState(null);
    const [mapView, setMapView] = useState(null);
    const [activeGroup, setActiveGroup] = useState(null);
    const [, setLegend] = useState(null);
    const ownerRef = useRef(null);
    const legendRef = useRef(null);
    const requestVersionRef = useRef(0);
    const mountedRef = useRef(true);

    const getOwner = () => {
        const view = MapManager.GetMapView();
        if (!view?.map) return null;
        if (!ownerRef.current) ownerRef.current = createLayerOwner(view, OWNER_ID);
        return ownerRef.current;
    };

    const disposeLegend = () => {
        legendRef.current?.destroy?.();
        legendRef.current = null;
        setLegend(null);
    };

    const fetchQueryResults = async () => {
        const view = MapManager.GetMapView();
        if (!view?.map) {
            if (mountedRef.current) setLayerGroups([]);
            return;
        }

        setMapView(view);
        const owner = getOwner();
        owner?.clear();
        const requestVersion = ++requestVersionRef.current;

        try {
            const result = await LayerBusiness.GetLayers();
            if (!mountedRef.current || requestVersion !== requestVersionRef.current) return;
            if (result?.type !== Constants_ServiceResultType.Success) {
                setLayerGroups([]);
                return;
            }

            const groups = Array.isArray(result?.data) ? result.data : [];
            const operationalGroup = getConfiguredOperationalGroup(groups);
            const layerItems = Array.isArray(operationalGroup?.layers) ? operationalGroup.layers : [];
            const layerCount = layerItems.length;

            const creations = layerItems.map(async (layerItem, layerIndex) => {
                try {
                    const layerObject = await CommonBusiness.CreateLayer(layerItem);
                    if (!mountedRef.current || requestVersion !== requestVersionRef.current) {
                        layerObject?.destroy?.();
                        return null;
                    }
                    if (!layerObject) return null;

                    const requestedPriority = Number.parseInt(layerItem.priority, 10);
                    const normalizedPriority = Number.isFinite(requestedPriority)
                        ? Math.max(0, layerCount - requestedPriority)
                        : layerIndex;
                    owner?.add(layerObject, normalizedPriority);
                    return {
                        source: layerItem,
                        layerObject,
                        priority: normalizedPriority,
                    };
                } catch {
                    return null;
                }
            });

            const createdLayers = await Promise.all(creations);
            if (!mountedRef.current || requestVersion !== requestVersionRef.current) return;

            const layerObjectBySource = new Map(
                createdLayers
                    .filter(Boolean)
                    .map((entry) => [entry.source, entry]),
            );

            const hydratedGroups = groups.map((group) => {
                const hydratedLayers = (Array.isArray(group?.layers) ? group.layers : []).map((layerItem) => {
                    const created = layerObjectBySource.get(layerItem);
                    return created
                        ? { ...layerItem, priority: created.priority, layerObj: created.layerObject }
                        : { ...layerItem, layerObj: layerItem.layerObj || null };
                });
                return evaluateGroupVisibility({ ...group, layers: hydratedLayers });
            });
            setLayerGroups(hydratedGroups);
        } catch {
            if (mountedRef.current && requestVersion === requestVersionRef.current) setLayerGroups([]);
        }
    };

    useImperativeHandle(ref, () => ({
        id: props.id,
        visible: false,
        minimized: false,
        OnShow: () => {
            props.windowManager.ShowWindow("sidebar");
            fetchQueryResults();
        },
        OnClose: () => {},
    }));

    useEffect(() => {
        mountedRef.current = true;
        props.windowManager.RegisterWindow(ref);
        fetchQueryResults();

        return () => {
            mountedRef.current = false;
            requestVersionRef.current += 1;
            ownerRef.current?.clear();
            ownerRef.current = null;
            legendRef.current?.destroy?.();
            legendRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const toggleGroupVisibility = (event, groupIndex) => {
        event.stopPropagation();
        setLayerGroups((current) => {
            if (!Array.isArray(current) || !current[groupIndex]) return current;
            const groups = [...current];
            const group = { ...groups[groupIndex] };
            const visible = !group.visible;
            group.layers = (group.layers || []).map((layer) => {
                if (layer.layerObj) layer.layerObj.visible = visible;
                return { ...layer, visible };
            });
            groups[groupIndex] = { ...group, visible, semiVisible: false };
            return groups;
        });
    };

    const toggleLayerVisibility = (event, layer, groupIndex, layerIndex) => {
        event.stopPropagation();
        const layerObject = layer?.layerObj;
        if (!layerObject) return;

        layerObject.visible = !layerObject.visible;
        setLayerGroups((current) => {
            if (!Array.isArray(current) || !current[groupIndex]) return current;
            const groups = [...current];
            const group = { ...groups[groupIndex], layers: [...(groups[groupIndex].layers || [])] };
            group.layers[layerIndex] = {
                ...group.layers[layerIndex],
                visible: layerObject.visible,
            };
            groups[groupIndex] = evaluateGroupVisibility(group);
            return groups;
        });
    };

    const changeLayerOpacity = (event, layer, groupIndex, layerIndex) => {
        const opacity = Math.min(100, Math.max(0, Number(event.target.value) || 0));
        if (layer?.layerObj) layer.layerObj.opacity = opacity / 100;

        setLayerGroups((current) => {
            if (!Array.isArray(current) || !current[groupIndex]) return current;
            const groups = [...current];
            const group = { ...groups[groupIndex], layers: [...(groups[groupIndex].layers || [])] };
            group.layers[layerIndex] = { ...group.layers[layerIndex], opacity };
            groups[groupIndex] = group;
            return groups;
        });
    };

    const refreshLegend = async () => {
        if (legendRef.current || !mapView) return;
        try {
            const [Legend] = await loadModules(["esri/widgets/Legend"]);
            if (!mountedRef.current || legendRef.current) return;
            const nextLegend = new Legend({ view: mapView, container: "legendDiv" });
            legendRef.current = nextLegend;
            setLegend(nextLegend);
        } catch {
            disposeLegend();
        }
    };

    return (
        <section
            className="common-query-window common-query-window-right"
            aria-label="Katman ve lejand yönetimi"
            style={{ visibility: props.windowManager.IsVisible(props.id) ? 'visible' : 'hidden' }}
        >
            <header className="common-query-window-header">
                <img className="common-query-window-header-icon" src="images/icons/toolbar/katmanyonetimi.png" alt="" />
                <span>Katmanlar</span>
                <CommonQueryWindowTools
                    windowManager={props.windowManager}
                    windowId={props.id}
                    showNearbySearch={false}
                    showMapSelect={false}
                    setQueryField={() => {}}
                    query={null}
                />
            </header>
            <div className="common-query-window-body layer-list-window-body">
                {layerGroups == null ? (
                    <ContainerLoading message="Katmanlar hazırlanıyor…" />
                ) : props.windowManager.IsMinimized(props.id) ? (
                    <div aria-hidden="true" />
                ) : (
                    <Tabs
                        defaultActiveKey="layers"
                        onSelect={(key) => {
                            if (key === "legend") refreshLegend();
                        }}
                    >
                        <Tab eventKey="layers" title="Katmanlar">
                            <div>
                                {DynamicLayerManager.List?.length > 0 ? (
                                    <Accordion defaultActiveKey="dynamiclayers">
                                        <Accordion.Item eventKey="dynamiclayers">
                                            <Accordion.Header>
                                                <div className="row w-100">
                                                    <div className="col-1"><SharedGISIcon record={{ category: "default" }} size={24} /></div>
                                                    <div className="col-11 layer-list-group-title"><span>Özel Katmanlar</span></div>
                                                </div>
                                            </Accordion.Header>
                                            <Accordion.Body>
                                                {DynamicLayerManager.List.map((layer) => (
                                                    <div className="layer-list-item" key={layer.id || layer.title}>
                                                        <div className="col-1"><SharedGISIcon record={layer} size={24} /></div>
                                                        <span className="col-8 layer-list-item-title" title={layer.title}>{layer.title}</span>
                                                        <div className="col-3" />
                                                    </div>
                                                ))}
                                            </Accordion.Body>
                                        </Accordion.Item>
                                    </Accordion>
                                ) : null}

                                <Accordion defaultActiveKey={activeGroup}>
                                    {layerGroups.length === 0 ? (
                                        <NoResultsFound message="Gösterilecek katman bulunmuyor" />
                                    ) : layerGroups.map((group, groupIndex) => {
                                        const groupKey = group.id || `group-${groupIndex}`;
                                        return (
                                            <Accordion.Item key={groupKey} eventKey={groupKey} className="layer-list-group-accordion-item">
                                                <Accordion.Header className="layer-list-group-accordion-item-header">
                                                    <div className="row w-100">
                                                        <div className="col-1">
                                                            <button
                                                                type="button"
                                                                className="kr-layer-toggle"
                                                                onClick={(event) => toggleGroupVisibility(event, groupIndex)}
                                                                aria-label={`${group.title} grubunu ${group.visible ? "gizle" : "göster"}`}
                                                                aria-pressed={Boolean(group.visible)}
                                                            >
                                                                {group.visible ? <BiCheckCircle aria-hidden="true" /> : group.semiVisible ? <BiMinusCircle aria-hidden="true" /> : <BiCircle aria-hidden="true" />}
                                                            </button>
                                                        </div>
                                                        <button
                                                            type="button"
                                                            className="col-11 s layer-list-group-title"
                                                            onClick={() => setActiveGroup(groupKey)}
                                                            aria-expanded={activeGroup === groupKey}
                                                        >
                                                            <SharedGISIcon record={group} size={24} />
                                                            <span>{group.title}</span>
                                                        </button>
                                                    </div>
                                                </Accordion.Header>
                                                <Accordion.Body>
                                                    {(group.layers || []).map((layer, layerIndex) => (
                                                        <div className="layer-list-item row" key={layer.id || `${groupKey}-${layerIndex}`}>
                                                            <div className="col-1">
                                                                <button
                                                                    type="button"
                                                                    className="kr-layer-toggle"
                                                                    onClick={(event) => toggleLayerVisibility(event, layer, groupIndex, layerIndex)}
                                                                    aria-label={`${layer.title} katmanını ${layer.visible ? "gizle" : "göster"}`}
                                                                    aria-pressed={Boolean(layer.visible)}
                                                                    disabled={!layer.layerObj}
                                                                >
                                                                    {layer.visible ? <BiCheckCircle aria-hidden="true" /> : <BiCircle aria-hidden="true" />}
                                                                </button>
                                                            </div>
                                                            <div className="col-1 kr-layer-item-icon"><SharedGISIcon record={layer} size={24} /></div>
                                                            <button
                                                                type="button"
                                                                className="col-7 layer-list-item-title"
                                                                onClick={(event) => toggleLayerVisibility(event, layer, groupIndex, layerIndex)}
                                                                title={layer.title}
                                                                disabled={!layer.layerObj}
                                                            >
                                                                {layer.title}
                                                            </button>
                                                            <div className="col-3">
                                                                <label className="experience-sr-only" htmlFor={`layer-opacity-${groupKey}-${layer.id || layerIndex}`}>
                                                                    Katman opaklığı: {layer.title}
                                                                </label>
                                                                <Form.Range
                                                                    id={`layer-opacity-${groupKey}-${layer.id || layerIndex}`}
                                                                    min="0"
                                                                    max="100"
                                                                    value={layer.opacity ?? 100}
                                                                    onChange={(event) => changeLayerOpacity(event, layer, groupIndex, layerIndex)}
                                                                    aria-valuetext={`${layer.opacity ?? 100} yüzde`}
                                                                    disabled={!layer.layerObj}
                                                                />
                                                            </div>
                                                        </div>
                                                    ))}
                                                </Accordion.Body>
                                            </Accordion.Item>
                                        );
                                    })}
                                </Accordion>
                            </div>
                        </Tab>
                        <Tab eventKey="legend" title="Lejant">
                            <div className="legend-container"><div id="legendDiv" aria-label="Harita lejantı"></div></div>
                        </Tab>
                    </Tabs>
                )}
            </div>
        </section>
    );
});
