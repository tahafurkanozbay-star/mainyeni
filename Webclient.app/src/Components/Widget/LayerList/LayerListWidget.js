import React, { useEffect, useImperativeHandle, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faLayerGroup } from "@fortawesome/free-solid-svg-icons";
import { LayerBusiness } from "../../../Business/LayerBusiness";
import { Constants_ServiceResultType } from "../../../Core/Constants";
import { MapManager } from "../../../Store/Managers/MapManager";
import { loadModules } from "esri-loader";
import { Accordion, Form, Tab, Tabs } from "react-bootstrap";
import { CommonBusiness } from "../../../Business/CommonBusiness";
import { ContainerLoading, NoResultsFound } from "../../Common/Loading";
import { DynamicLayerManager } from "../../../Store/Managers/DynamicLayerManager";
import { CommonQueryWindowTools } from "../../Query/_Common/CommonQueryWindowTools";
import "./LayerListWidget.css";
import { BiCheckCircle, BiCircle, BiMinusCircle } from "react-icons/bi";

export const LayerListWidget = React.forwardRef((props, ref) => {
    const [layerGroups, setLayerGroups] = useState(null);
    const [mapView, setMapView] = useState(null);
    const [activeGroup, setActiveGroup] = useState(null);
    const [activeTab, setActiveTab] = useState("layers");
    const [legend, setLegend] = useState(null);
    const [loadingError, setLoadingError] = useState(false);

    useImperativeHandle(ref, () => ({
        id: props.id,
        visible: false,
        minimized: false,
        OnShow: (tab = "layers") => {
            setActiveTab(tab === "legend" ? "legend" : "layers");
            props.windowManager.ShowWindow("sidebar");
            const view = MapManager.GetMapView();
            if (view?.map) view.map.removeAll();
            fetchLayerGroups();
        },
        OnClose: () => undefined
    }));

    useEffect(() => {
        props.windowManager.RegisterWindow(ref);
        fetchLayerGroups();
        return () => { if (legend?.destroy) legend.destroy(); };
        // Register once for the window lifecycle.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const fetchLayerGroups = () => {
        const view = MapManager.GetMapView();
        if (!view?.map) {
            setLoadingError(true);
            setLayerGroups([]);
            return;
        }
        setMapView(view);
        setLoadingError(false);
        view.map.removeAll();
        LayerBusiness.GetLayers().then(result => {
            if (result?.type !== Constants_ServiceResultType.Success) {
                setLayerGroups([]);
                setLoadingError(true);
                return;
            }
            const groups = result.data || [];
            const targetGroup = groups[2];
            const layerCount = targetGroup?.layers?.length || 0;
            targetGroup?.layers?.forEach(layerItem => {
                CommonBusiness.AddProxyRule(CommonBusiness.GenerateUrl(layerItem), "LayerListWidget");
                CommonBusiness.CreateLayer(layerItem).then(layerObject => {
                    if (!layerObject) return;
                    layerItem.priority = layerCount - parseInt(layerItem.priority, 10);
                    layerItem.layerObj = layerObject;
                    view.map.add(layerObject, layerItem.priority);
                });
            });
            setLayerGroups(groups);
        }).catch(() => {
            setLayerGroups([]);
            setLoadingError(true);
        });
    };

    const evaluateGroupVisibility = group => {
        const visibleCount = group?.layers?.filter(layer => layer.visible).length || 0;
        return { ...group, visible: visibleCount === group.layers.length, semiVisible: visibleCount > 0 && visibleCount < group.layers.length };
    };

    const toggleGroupVisibility = (event, groupIndex) => {
        event.stopPropagation();
        setLayerGroups(current => {
            const next = [...(current || [])];
            const group = { ...next[groupIndex], layers: [...(next[groupIndex]?.layers || [])] };
            const visible = !group.visible;
            group.layers = group.layers.map(layer => {
                if (layer.layerObj) layer.layerObj.visible = visible;
                return { ...layer, visible };
            });
            group.visible = visible;
            group.semiVisible = false;
            next[groupIndex] = group;
            return next;
        });
    };

    const toggleLayerVisibility = (event, layer, groupIndex, layerIndex) => {
        event.stopPropagation();
        if (!layer?.layerObj) return;
        const visible = !layer.layerObj.visible;
        layer.layerObj.visible = visible;
        setLayerGroups(current => {
            const next = [...(current || [])];
            const group = { ...next[groupIndex], layers: [...next[groupIndex].layers] };
            group.layers[layerIndex] = { ...group.layers[layerIndex], visible };
            next[groupIndex] = evaluateGroupVisibility(group);
            return next;
        });
    };

    const changeLayerOpacity = (event, layer, groupIndex, layerIndex) => {
        const opacity = Number(event.target.value);
        if (layer?.layerObj) layer.layerObj.opacity = opacity / 100;
        setLayerGroups(current => {
            const next = [...(current || [])];
            const group = { ...next[groupIndex], layers: [...next[groupIndex].layers] };
            group.layers[layerIndex] = { ...group.layers[layerIndex], opacity };
            next[groupIndex] = group;
            return next;
        });
    };

    const refreshLegend = () => {
        if (legend || !mapView) return;
        loadModules(["esri/widgets/Legend"]).then(([Legend]) => setLegend(new Legend({ view: mapView, container: "legendDiv" })));
    };

    const renderVisibilityIcon = visible => visible ? <BiCheckCircle aria-hidden="true" /> : <BiCircle aria-hidden="true" />;
    const isVisible = props.windowManager.IsVisible(props.id);

    return (
        <section className="common-query-window common-query-window-right" aria-label="Katman ve lejand yönetimi" style={{ visibility: isVisible ? "visible" : "hidden" }}>
            <header className="common-query-window-header">
                <img className="common-query-window-header-icon" src="images/icons/toolbar/katmanyonetimi.png" alt="" />
                <span>Katmanlar ve lejand</span>
                <CommonQueryWindowTools windowManager={props.windowManager} windowId={props.id} showNearbySearch={false} showMapSelect={false} setQueryField={() => {}} query={null} />
            </header>
            <div className="common-query-window-body layer-list-window-body">
                {layerGroups == null ? <ContainerLoading message="Katmanlar hazırlanıyor…" /> : props.windowManager.IsMinimized(props.id) ? <div aria-hidden="true" /> :
                    <Tabs activeKey={activeTab} onSelect={key => { setActiveTab(key || "layers"); if (key === "legend") refreshLegend(); }}>
                        <Tab eventKey="layers" title="Katmanlar">
                            {loadingError && <div className="kr-status-banner kr-status-banner--warning" role="status">Katman servislerinden biri yanıt vermedi. Kullanılabilen katmanlar gösteriliyor.</div>}
                            {DynamicLayerManager.List?.length > 0 && <div className="kr-layer-group"><div className="kr-layer-group__head"><span className="kr-layer-toggle" aria-hidden="true"><FontAwesomeIcon icon={faLayerGroup} /></span><strong className="kr-layer-row__title">Özel Katmanlar</strong><span className="kr-layer-row__meta">{DynamicLayerManager.List.length}</span></div>{DynamicLayerManager.List.map(layer => <div className="kr-layer-row" key={layer.id || layer.title}><span className="kr-layer-toggle" aria-hidden="true"><FontAwesomeIcon icon={faLayerGroup} /></span><span className="kr-table-icon" aria-hidden="true"><FontAwesomeIcon icon={faLayerGroup} /></span><span className="kr-layer-row__title" title={layer.title}>{layer.title}</span><span className="kr-layer-row__meta">Dinamik</span></div>)}</div>}
                            {layerGroups.length === 0 ? <NoResultsFound message="Gösterilecek katman bulunmuyor" /> : <Accordion defaultActiveKey={activeGroup} className="kr-layer-tree">{layerGroups.map((group, groupIndex) => { const groupKey = group.id || `group-${groupIndex}`; return <Accordion.Item key={groupKey} eventKey={groupKey} className="layer-list-group-accordion-item"><Accordion.Header className="layer-list-group-accordion-item-header"><div className="kr-layer-group__head w-100"><button type="button" className="kr-layer-toggle" onClick={event => toggleGroupVisibility(event, groupIndex)} aria-label={`${group.title} katman grubunu ${group.visible ? "gizle" : "göster"}`} aria-pressed={Boolean(group.visible)}>{group.semiVisible ? <BiMinusCircle aria-hidden="true" /> : renderVisibilityIcon(group.visible)}</button><span className="layer-list-group-title" onClick={() => setActiveGroup(groupKey)}>{group.title}</span><span className="kr-layer-row__meta">{group.layers?.length || 0}</span></div></Accordion.Header><Accordion.Body>{(group.layers || []).map((layer, layerIndex) => <div className="layer-list-item row" key={layer.id || `${groupKey}-${layerIndex}`}><button type="button" className="kr-layer-toggle col-1" onClick={event => toggleLayerVisibility(event, layer, groupIndex, layerIndex)} aria-label={`${layer.title} katmanını ${layer.visible ? "gizle" : "göster"}`} aria-pressed={Boolean(layer.visible)}>{renderVisibilityIcon(layer.visible)}</button><button type="button" className="layer-list-item-title col-8" onClick={event => toggleLayerVisibility(event, layer, groupIndex, layerIndex)} title={layer.title}>{layer.title}</button><div className="col-3"><label className="experience-sr-only" htmlFor={`layer-opacity-${groupKey}-${layer.id || layerIndex}`}>Katman opaklığı, {layer.title}</label><Form.Range id={`layer-opacity-${groupKey}-${layer.id || layerIndex}`} min="0" max="100" value={layer.opacity ?? 100} onChange={event => changeLayerOpacity(event, layer, groupIndex, layerIndex)} aria-valuetext={`${layer.opacity ?? 100} yüzde`} /></div></div>)}</Accordion.Body></Accordion.Item>; })}</Accordion>}
                        </Tab>
                        <Tab eventKey="legend" title="Lejand"><div className="legend-container" aria-live="polite"><div id="legendDiv" aria-label="Harita lejandı" /></div></Tab>
                    </Tabs>}
            </div>
        </section>
    );
});
