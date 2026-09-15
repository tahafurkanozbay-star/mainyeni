import React, { useEffect, useImperativeHandle, useState } from "react";
import { loadModules } from "esri-loader";
import MapManager from "../../../Store/Managers/MapManager";
import { CommonQueryWindowTools } from "../../Query/_Common/CommonQueryWindowTools";
import "./GlobalIdentifyWidget.css";
import { BiZoomIn } from "react-icons/bi";
import { IsNull } from "../../../Toolbox/ObjectHelper";
import { ContainerLoading, NoResultsFound } from "../../Common/Loading";
import { Accordion, Button, Tab, Tabs } from "react-bootstrap";
import { GisGraphicsHelper } from "../../../Toolbox/GisGraphicsHelper";
import { LoggingBusiness } from "../../../Business/LoggingBusiness";

export const GlobalIdentifyWidget = React.forwardRef((props, ref) => {
    const [mapView, setMapView] = useState(null);
    const [results, setResults] = useState(null);
    const [loading, setLoading] = useState(false);

    const executeIdentify = async event => {
        const currentMapView = MapManager.GetMapView();
        if (!event?.mapPoint || !currentMapView?.map) {
            setResults([]);
            return;
        }

        setLoading(true);
        try {
            const [identify, IdentifyParameters] = await loadModules(["esri/rest/identify", "esri/rest/support/IdentifyParameters"]);
            const requests = currentMapView.map.allLayers.items
                .filter(layer => layer.visible && !IsNull(layer.title) && layer.url)
                .map(layer => identify.identify(layer.url, new IdentifyParameters({
                    returnGeometry: true,
                    geometry: event.mapPoint,
                    tolerance: 3,
                    mapExtent: currentMapView.extent
                })));

            const responses = await Promise.allSettled(requests);
            const nextResults = [];
            responses.forEach(response => {
                if (response.status !== 'fulfilled' || !response.value?.results?.length) return;
                nextResults.push({
                    layerId: response.value.results[0].layerId,
                    layerName: response.value.results[0].layerName,
                    features: response.value.results
                });
            });
            setResults(nextResults);
        } catch (error) {
            console.error("Identify request failed", error);
            setResults([]);
        } finally {
            setLoading(false);
        }
    };

    useImperativeHandle(ref, () => ({
        id: props.id,
        visible: false,
        minimized: false,
        OnShow: () => executeIdentify(MapManager.GetMapClickEvent()),
        OnClose: () => {
            GisGraphicsHelper.RemoveAllGraphics(MapManager.GetMapView());
            setResults(null);
        }
    }), [props.id]);

    useEffect(() => {
        props.windowManager.RegisterWindow(ref);
        setMapView(MapManager.GetMapView());
    }, [props.windowManager, ref]);

    const goToItem = async item => {
        LoggingBusiness.CreateClientLog("Bilgi al/zoom", item);
        const projectedGeometry = await GisGraphicsHelper.ProjectGeometry(item.feature.geometry, "4326");
        const graphic = await GisGraphicsHelper.CreateGraphicFromGeometry(projectedGeometry);
        GisGraphicsHelper.RemoveAllGraphics(mapView);
        GisGraphicsHelper.AddGraphics(mapView, graphic);
        GisGraphicsHelper.ZoomToGeometry(mapView, graphic, null);
        if (window.screen.width < 768) props.windowManager.ToggleMinimiseWindow(props.id);
    };

    return (
        <div className="common-query-window common-query-window-right" style={{ visibility: props.windowManager.IsVisible(props.id) ? 'visible' : 'hidden' }}>
            <div className="common-query-window-header">
                <img className="common-query-window-header-icon" src="images/icons/toolbar/bilgi.png" alt="" aria-hidden="true" />
                <span>Bilgi Al</span>
                <CommonQueryWindowTools windowManager={props.windowManager} windowId={props.id} showNearbySearch={false} showMapSelect={false} setQueryField={() => {}} query={null} />
            </div>
            <div className="common-query-window-body layer-list-window-body">
                <div className="global-identify-results-container">
                    {loading ? <ContainerLoading /> : results?.length === 0 ? <NoResultsFound /> :
                        <Accordion defaultActiveKey={-1}>
                            {results?.map((resultGroup, groupIndex) => <Accordion.Item key={`${resultGroup.layerId}-${groupIndex}`} eventKey={groupIndex} className="global-identify-results-accordion-item">
                                <Accordion.Header className="global-identify-results-accordion-item-header"><span>{resultGroup.layerName} ({resultGroup.features?.length})</span></Accordion.Header>
                                <Accordion.Body>
                                    <Tabs>
                                        {resultGroup.features?.map((feature, featureIndex) => <Tab key={`${feature.feature.attributes.OBJECTID ?? featureIndex}`} title={feature.feature.attributes.OBJECTID ?? featureIndex + 1} eventKey={featureIndex}>
                                            <div className="global-identify-result-item-container">
                                                <div className="global-identify-result-item-row"><Button className="w-100 form-button" onClick={() => goToItem(feature)}><BiZoomIn aria-hidden="true" />&nbsp;&nbsp;Haritada Göster</Button></div>
                                                {Object.entries(feature.feature.attributes).map(([key, value]) => <div className="global-identify-result-item-row" key={key}><div className="global-identify-result-item-row-label"><strong>{key}</strong></div><div className="global-identify-result-item-row-text">{String(value ?? '')}</div></div>)}
                                            </div>
                                        </Tab>)}
                                    </Tabs>
                                </Accordion.Body>
                            </Accordion.Item>)}
                        </Accordion>}
                </div>
            </div>
        </div>
    );
});

GlobalIdentifyWidget.displayName = "GlobalIdentifyWidget";
