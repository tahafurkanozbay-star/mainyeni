import React, { useEffect, useImperativeHandle, useRef, useState } from "react";
import { LayerBusiness } from "../../../Business/LayerBusiness";
import { Constants_ServiceResultType } from "../../../Core/Constants";
import { MapManager } from "../../../Store/Managers/MapManager";
import { loadModules } from "esri-loader";
import { Accordion, Form, Tab, Tabs } from "react-bootstrap";
import { CommonBusiness } from "../../../Business/CommonBusiness";
import { ContainerLoading, NoResultsFound } from "../../Common/Loading";
import { DynamicLayerManager } from "../../../Store/Managers/DynamicLayerManager";
import { CommonQueryWindowTools } from "../../Query/_Common/CommonQueryWindowTools";
import { SharedGISIcon } from "../../Common/SharedGISIcon";
import "./LayerListWidget.css";
import { BiCheckCircle, BiCircle, BiMinusCircle } from "react-icons/bi";

export const LayerListWidget = React.forwardRef((props, ref) => {
    const ownedLayersRef = useRef([]);
    const [LayerGroups, setLayerGroups] = useState(null);
    const [mapView, setMapView] = useState(null);
    const [activeGroup, setActiveGroup] = useState(null);
    const [legend, setLegend] = useState(null);

    const removeOwnedLayers = map => {
        ownedLayersRef.current.forEach(layer => {
            if (layer) map?.remove(layer);
        });
        ownedLayersRef.current = [];
    };

    const fetchQueryResults = () => {
        const currentMapView = MapManager.GetMapView();
        if (!currentMapView?.map) {
            setLayerGroups([]);
            return;
        }
        setMapView(currentMapView);
        removeOwnedLayers(currentMapView.map);

        LayerBusiness.GetLayers().then(result => {
            if (result?.type !== Constants_ServiceResultType.Success) {
                setLayerGroups([]);
                return;
            }

            const layerGroups = result?.data ?? [];
            const firstGroup = layerGroups[2];
            const layerCount = firstGroup?.layers?.length || 0;
            firstGroup?.layers?.forEach(layerItem => {
                CommonBusiness.AddProxyRule(CommonBusiness.GenerateUrl(layerItem), "LayerListWidget");
                CommonBusiness.CreateLayer(layerItem).then(layerObject => {
                    if (!layerObject) return;
                    layerItem.priority = layerCount - Number.parseInt(layerItem.priority, 10);
                    layerItem.layerObj = layerObject;
                    ownedLayersRef.current.push(layerObject);
                    currentMapView.map.add(layerObject, layerItem.priority);
                });
            });
            setLayerGroups(layerGroups);
        }).catch(() => setLayerGroups([]));
    };

    useImperativeHandle(ref, () => ({
        id: props.id,
        visible: false,
        minimized: false,
        OnShow: () => {
            props.windowManager.ShowWindow("sidebar");
            fetchQueryResults();
        },
        OnClose: () => {}
    }));

    useEffect(() => {
        props.windowManager.RegisterWindow(ref);
        fetchQueryResults();
        return () => {
            legend?.destroy?.();
            removeOwnedLayers(MapManager.GetMapView()?.map);
        };
        // Window registration and initial GIS hydration intentionally run once for this mounted widget.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const evaluateGroupVisibility = layerGroup => {
        const layerCount = layerGroup?.layers?.length || 0;
        const visibleLayersCount = layerGroup?.layers?.filter(layer => layer.visible).length || 0;
        return {
            ...layerGroup,
            visible: layerCount > 0 && visibleLayersCount === layerCount,
            semiVisible: visibleLayersCount > 0 && visibleLayersCount < layerCount
        };
    };

    const toggleGroupVisibility = (event, groupIndex) => {
        event.stopPropagation();
        const nextGroups = [...LayerGroups];
        const visible = !nextGroups[groupIndex].visible;
        nextGroups[groupIndex] = {
            ...nextGroups[groupIndex],
            visible,
            semiVisible: false,
            layers: nextGroups[groupIndex].layers.map(layer => {
                if (layer.layerObj) layer.layerObj.visible = visible;
                return { ...layer, visible };
            })
        };
        setLayerGroups(nextGroups);
    };

    const toggleLayerVisibility = (event, layer, groupIndex, layerIndex) => {
        event.stopPropagation();
        if (!layer?.layerObj) return;
        layer.layerObj.visible = !layer.layerObj.visible;
        const nextGroups = [...LayerGroups];
        const nextGroup = { ...nextGroups[groupIndex], layers: [...nextGroups[groupIndex].layers] };
        nextGroup.layers[layerIndex] = { ...nextGroup.layers[layerIndex], visible: layer.layerObj.visible };
        nextGroups[groupIndex] = evaluateGroupVisibility(nextGroup);
        setLayerGroups(nextGroups);
    };

    const toggleDynamicLayerVisibility = (event, layer) => {
        event.stopPropagation();
        const layerObject = layer?.layerObj || layer;
        if (typeof layerObject?.visible === "boolean") layerObject.visible = !layerObject.visible;
    };

    const changeLayerOpacity = (event, layer, groupIndex, layerIndex) => {
        const opacity = Number(event.target.value);
        if (layer?.layerObj) layer.layerObj.opacity = opacity / 100;
        const nextGroups = [...LayerGroups];
        const nextGroup = { ...nextGroups[groupIndex], layers: [...nextGroups[groupIndex].layers] };
        nextGroup.layers[layerIndex] = { ...nextGroup.layers[layerIndex], opacity };
        nextGroups[groupIndex] = nextGroup;
        setLayerGroups(nextGroups);
    };

    const refreshLegend = () => {
        if (legend === null && mapView) {
            loadModules(["esri/widgets/Legend"]).then(([Legend]) => setLegend(new Legend({ view: mapView, container: "legendDiv" })));
        }
    };

    return (
        <section className="common-query-window common-query-window-right" aria-label="Katman ve lejand yönetimi" style={{ visibility: props.windowManager.IsVisible(props.id) ? 'visible' : 'hidden' }}>
            <header className="common-query-window-header">
                <img className="common-query-window-header-icon" src="images/icons/toolbar/katmanyonetimi.png" alt="" aria-hidden="true" />
                <span>Katmanlar</span>
                <CommonQueryWindowTools windowManager={props.windowManager} windowId={props.id} showNearbySearch={false} showMapSelect={false} setQueryField={() => {}} query={null} />
            </header>
            <div className="common-query-window-body layer-list-window-body">
                {LayerGroups === null ? <ContainerLoading message="Katmanlar hazırlanıyor…" /> : props.windowManager.IsMinimized(props.id) ? <div aria-hidden="true" /> :
                    <Tabs defaultActiveKey="layers" onSelect={key => { if (key === "legend") refreshLegend(); }}>
                        <Tab eventKey="layers" title="Katmanlar">
                            <div>
                                {DynamicLayerManager.List?.length > 0 ? <Accordion defaultActiveKey="dynamiclayers"><Accordion.Item eventKey="dynamiclayers"><Accordion.Header><div className="row w-100"><div className="col-1"><SharedGISIcon record={{ category: "default" }} size={24} /></div><div className="col-11 layer-list-group-title"><span>Özel Katmanlar</span></div></div></Accordion.Header><Accordion.Body>{DynamicLayerManager.List.map(layer => <div className="layer-list-item" key={layer.id || layer.title}><div className="col-1"><SharedGISIcon record={layer} size={24} /></div><button type="button" className="col-8 layer-list-item-title" onClick={event => toggleDynamicLayerVisibility(event, layer)} title={layer.title}>{layer.title}</button><div className="col-3" /></div>)}</Accordion.Body></Accordion.Item></Accordion> : null}
                                <Accordion defaultActiveKey={activeGroup}>
                                    {LayerGroups.length === 0 ? <NoResultsFound message="Gösterilecek katman bulunmuyor" /> : LayerGroups.map((group, groupIndex) => {
                                        const groupKey = group.id || `group-${groupIndex}`;
                                        return <Accordion.Item key={groupKey} eventKey={groupKey} className="layer-list-group-accordion-item">
                                            <Accordion.Header className="layer-list-group-accordion-item-header"><div className="row w-100"><div className="col-1"><button type="button" className="kr-layer-toggle" onClick={event => toggleGroupVisibility(event, groupIndex)} aria-label={`${group.title} grubunu ${group.visible ? "gizle" : "göster"}`} aria-pressed={Boolean(group.visible)}>{group.visible ? <BiCheckCircle aria-hidden="true" /> : group.semiVisible ? <BiMinusCircle aria-hidden="true" /> : <BiCircle aria-hidden="true" />}</button></div><button type="button" className="col-11 s layer-list-group-title" onClick={() => setActiveGroup(groupKey)} aria-expanded={activeGroup === groupKey}><SharedGISIcon record={group} size={24} /><span>{group.title}</span></button></div></Accordion.Header>
                                            <Accordion.Body>{group.layers.map((layer, layerIndex) => <div className="layer-list-item row" key={layer.id || `${groupKey}-${layerIndex}`}><div className="col-1"><button type="button" className="kr-layer-toggle" onClick={event => toggleLayerVisibility(event, layer, groupIndex, layerIndex)} aria-label={`${layer.title} katmanını ${layer.visible ? "gizle" : "göster"}`} aria-pressed={Boolean(layer.visible)}>{layer.visible ? <BiCheckCircle aria-hidden="true" /> : <BiCircle aria-hidden="true" />}</button></div><div className="col-1 kr-layer-item-icon"><SharedGISIcon record={layer} size={24} /></div><button type="button" className="col-7 layer-list-item-title" onClick={event => toggleLayerVisibility(event, layer, groupIndex, layerIndex)} title={layer.title}>{layer.title}</button><div className="col-3"><label className="experience-sr-only" htmlFor={`layer-opacity-${groupKey}-${layer.id || layerIndex}`}>Katman opaklığı: {layer.title}</label><Form.Range id={`layer-opacity-${groupKey}-${layer.id || layerIndex}`} min="0" max="100" value={layer.opacity ?? 100} onChange={event => changeLayerOpacity(event, layer, groupIndex, layerIndex)} aria-valuetext={`${layer.opacity ?? 100} yüzde`} /></div></div>)}</Accordion.Body>
                                        </Accordion.Item>;
                                    })}
                                </Accordion>
                            </div>
                        </Tab>
                        <Tab eventKey="legend" title="Lejant"><div className="legend-container"><div id="legendDiv" aria-label="Harita lejantı" /></div></Tab>
                    </Tabs>}
            </div>
        </section>
    );
});

LayerListWidget.displayName = "LayerListWidget";
