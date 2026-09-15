import React, { useEffect, useImperativeHandle, useState } from "react";
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faLayerGroup } from '@fortawesome/free-solid-svg-icons';
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
    useImperativeHandle(ref, () => ({
        id: props.id, visible: false, minimized: false,
        OnShow: () => {
            props.windowManager.ShowWindow("sidebar");
            const mapView = MapManager.GetMapView();
            mapView?.map?.removeAll();
            fetchQueryResults();
        },
        OnClose: () => undefined
    }));

    const [LayerGroups, setLayerGroups] = useState(null);
    const [mapView, setMapView] = useState(null);
    const [activeGroup, setActiveGroup] = useState(null);
    const [legend, setLegend] = useState(null);

    useEffect(() => {
        props.windowManager.RegisterWindow(ref);
        fetchQueryResults();
        return () => legend?.destroy?.();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const fetchQueryResults = () => {
        const _mapView = MapManager.GetMapView();
        if (!_mapView?.map) {
            setLayerGroups([]);
            return;
        }
        setMapView(_mapView);
        _mapView.map.removeAll();
        LayerBusiness.GetLayers().then((_result) => {
            if (_result?.type !== Constants_ServiceResultType.Success) {
                setLayerGroups([]);
                return;
            }
            const layerGroups = _result?.data ?? [];
            const firstGroup = layerGroups[2];
            const layerCount = firstGroup?.layers?.length || 0;
            firstGroup?.layers?.forEach(_layerItem => {
                CommonBusiness.AddProxyRule(CommonBusiness.GenerateUrl(_layerItem), "LayerListWidget");
                CommonBusiness.CreateLayer(_layerItem).then((_layerObj) => {
                    if (_layerObj != null) {
                        _layerItem.priority = layerCount - parseInt(_layerItem.priority, 10);
                        _layerItem.layerObj = _layerObj;
                        _mapView.map.add(_layerObj, _layerItem.priority);
                    }
                });
            });
            setLayerGroups(layerGroups);
        }).catch(() => setLayerGroups([]));
    };

    const toggleGroupVisibility = (e, _groupIndex) => {
        e.stopPropagation();
        const _LayerGroups = [...LayerGroups];
        const _visible = !_LayerGroups[_groupIndex].visible;
        _LayerGroups[_groupIndex].layers.forEach(_layer => {
            _layer.visible = _visible;
            if (_layer.layerObj) _layer.layerObj.visible = _visible;
        });
        _LayerGroups[_groupIndex].visible = _visible;
        _LayerGroups[_groupIndex].semiVisible = false;
        setLayerGroups(_LayerGroups);
    };

    const toggleLayerVisibility = (e, layer, _groupIndex, _layerIndex) => {
        e.stopPropagation();
        if (!layer?.layerObj) return;
        const visible = !layer.layerObj.visible;
        layer.layerObj.visible = visible;
        const _LayerGroups = [...LayerGroups];
        const _LayerGroup = { ..._LayerGroups[_groupIndex], layers: [..._LayerGroups[_groupIndex].layers] };
        _LayerGroup.layers[_layerIndex] = { ..._LayerGroup.layers[_layerIndex], visible };
        _LayerGroups[_groupIndex] = evaluateGroupVisibility(_LayerGroup);
        setLayerGroups(_LayerGroups);
    };

    const evaluateGroupVisibility = (_layerGroup) => {
        const visibleLayersCount = _layerGroup?.layers?.filter(_layer => _layer.visible).length || 0;
        return {
            ..._layerGroup,
            visible: visibleLayersCount === (_layerGroup?.layers?.length || 0),
            semiVisible: visibleLayersCount > 0 && visibleLayersCount < (_layerGroup?.layers?.length || 0)
        };
    };

    const changeLayerOpacity = (e, layer, _groupIndex, _layerIndex) => {
        const opacity = Number(e.target.value);
        if (layer?.layerObj) layer.layerObj.opacity = opacity / 100;
        const _LayerGroups = [...LayerGroups];
        const _layerGroup = { ..._LayerGroups[_groupIndex], layers: [..._LayerGroups[_groupIndex].layers] };
        _layerGroup.layers[_layerIndex] = { ..._layerGroup.layers[_layerIndex], opacity };
        _LayerGroups[_groupIndex] = _layerGroup;
        setLayerGroups(_LayerGroups);
    };

    const refreshLegend = () => {
        if (legend != null || !mapView) return;
        loadModules(["esri/widgets/Legend"]).then(([Legend]) => setLegend(new Legend({ view: mapView, container: "legendDiv" })));
    };

    return (
        <section className="common-query-window common-query-window-right" aria-label="Katman ve lejand yönetimi" style={{ visibility: props.windowManager.IsVisible(props.id) ? 'visible' : 'hidden' }}>
            <header className="common-query-window-header">
                <img className="common-query-window-header-icon" src="images/icons/toolbar/katmanyonetimi.png" alt="" />
                <span>Katmanlar</span>
                <CommonQueryWindowTools windowManager={props.windowManager} windowId={props.id} showNearbySearch={false} showMapSelect={false} setQueryField={() => {}} query={null}/>
            </header>
            <div className="common-query-window-body layer-list-window-body">
                {LayerGroups == null ? <ContainerLoading message="Katmanlar hazırlanıyor…" /> : props.windowManager.IsMinimized(props.id) ? <div aria-hidden="true" /> :
                    <Tabs defaultActiveKey="layers" onSelect={(key) => { if (key === "legend") refreshLegend(); }}>
                        <Tab eventKey="layers" title="Katmanlar">
                            <div>
                                {DynamicLayerManager.List?.length > 0 && <Accordion defaultActiveKey="dynamiclayers"><Accordion.Item eventKey="dynamiclayers"><Accordion.Header><div className="row w-100"><div className="col-1"><SharedGISIcon record={{ category: "default" }} size={24} /></div><div className="col-11 layer-list-group-title"><span>Özel Katmanlar</span></div></div></Accordion.Header><Accordion.Body>{DynamicLayerManager.List.map(layer => <div className="layer-list-item" key={layer.id || layer.title}><div className="col-1"><SharedGISIcon record={layer} size={24} /></div><button type="button" className="col-11 layer-list-item-title" onClick={() => layer.layerObj && (layer.layerObj.visible = !layer.layerObj.visible)} title={layer.title}>{layer.title}</button></div>)}</Accordion.Body></Accordion.Item></Accordion>}
                                <Accordion defaultActiveKey={activeGroup}>
                                    {LayerGroups.length === 0 ? <NoResultsFound message="Gösterilecek katman bulunmuyor" /> : LayerGroups.map((_group, _groupIndex) => {
                                        const _groupKey = _group.id || `group-${_groupIndex}`;
                                        return <Accordion.Item key={_groupKey} eventKey={_groupKey} className="layer-list-group-accordion-item">
                                            <Accordion.Header className="layer-list-group-accordion-item-header">
                                                <div className="row w-100">
                                                    <div className="col-1">
                                                        <button type="button" className="kr-layer-toggle" onClick={(e) => toggleGroupVisibility(e, _groupIndex)} aria-label={`${_group.title} katman grubunu ${_group.visible ? "gizle" : "göster"}`} aria-pressed={Boolean(_group.visible)}>
                                                            {_group.visible ? <BiCheckCircle aria-hidden="true" /> : _group.semiVisible ? <BiMinusCircle aria-hidden="true" /> : <BiCircle aria-hidden="true" />}
                                                        </button>
                                                    </div>
                                                    <button type="button" className="col-11 s layer-list-group-title" onClick={() => setActiveGroup(_groupKey)} aria-expanded={activeGroup === _groupKey}><SharedGISIcon record={_group} size={24} /><span>{_group.title}</span></button>
                                                </div>
                                            </Accordion.Header>
                                            <Accordion.Body>
                                                {_group.layers.map((layer, _layerIndex) => <div className="layer-list-item row" key={layer.id || `${_groupKey}-${_layerIndex}`}>
                                                    <div className="col-1"><button type="button" className="kr-layer-toggle" onClick={(e) => toggleLayerVisibility(e, layer, _groupIndex, _layerIndex)} aria-label={`${layer.title} katmanını ${layer.visible ? "gizle" : "göster"}`} aria-pressed={Boolean(layer.visible)}>{layer.visible ? <BiCheckCircle aria-hidden="true" /> : <BiCircle aria-hidden="true" />}</button></div>
                                                    <div className="col-1 kr-layer-item-icon"><SharedGISIcon record={layer} size={24} /></div>
                                                    <button type="button" className="col-7 layer-list-item-title" onClick={(e) => toggleLayerVisibility(e, layer, _groupIndex, _layerIndex)} title={layer.title}>{layer.title}</button>
                                                    <div className="col-3"><label className="experience-sr-only" htmlFor={`layer-opacity-${_groupKey}-${layer.id || _layerIndex}`}>Katman opaklığı: {layer.title}</label><Form.Range id={`layer-opacity-${_groupKey}-${layer.id || _layerIndex}`} min="0" max="100" value={layer.opacity ?? 100} onChange={(e) => changeLayerOpacity(e, layer, _groupIndex, _layerIndex)} aria-valuetext={`${layer.opacity ?? 100} yüzde`} /></div>
                                                </div>)}
                                            </Accordion.Body>
                                        </Accordion.Item>;
                                    })}
                                </Accordion>
                            </div>
                        </Tab>
                        <Tab eventKey="legend" title="Lejant"><div className="legend-container"><div id="legendDiv" aria-label="Harita lejantı"></div></div></Tab>
                    </Tabs>}
            </div>
        </section>
    );
});
