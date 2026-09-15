import React, { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { loadModules } from "esri-loader";
import { Accordion, Button, Tab, Tabs } from "react-bootstrap";
import { BiZoomIn } from "react-icons/bi";
import { LoggingBusiness } from "../../../Business/LoggingBusiness";
import MapManager from "../../../Store/Managers/MapManager";
import { GisGraphicsHelper } from "../../../Toolbox/GisGraphicsHelper";
import { IsNull } from "../../../Toolbox/ObjectHelper";
import { ContainerLoading, NoResultsFound } from "../../Common/Loading";
import { CommonQueryWindowTools } from "../../Query/_Common/CommonQueryWindowTools";
import "./GlobalIdentifyWidget.css";

const safeLog = (eventName, payload) => Promise.resolve(LoggingBusiness.CreateClientLog(eventName, payload)).catch(() => {});

export const GlobalIdentifyWidget = React.forwardRef((props, ref) => {
    const { id, windowManager } = props;
    const mapViewRef = useRef(null);
    const selectedGraphicRef = useRef(null);
    const requestIdRef = useRef(0);

    const [results, setResults] = useState(null);
    const [loading, setLoading] = useState(false);
    const [errorMessage, setErrorMessage] = useState("");

    const clearSelectedGraphic = useCallback(() => {
        if (selectedGraphicRef.current && mapViewRef.current) {
            GisGraphicsHelper.RemoveGraphics(mapViewRef.current, selectedGraphicRef.current);
            selectedGraphicRef.current = null;
        }
    }, []);

    const executeIdentify = useCallback(async event => {
        const mapView = mapViewRef.current || MapManager.GetMapView();
        const requestId = ++requestIdRef.current;
        if (!event?.mapPoint || !mapView?.map) {
            setResults([]);
            setLoading(false);
            return;
        }

        setLoading(true);
        setErrorMessage("");
        try {
            const [identify, IdentifyParameters] = await loadModules([
                "esri/rest/identify",
                "esri/rest/support/IdentifyParameters"
            ]);
            if (requestId !== requestIdRef.current) return;

            const requests = mapView.map.allLayers.items
                .filter(layer => layer.visible && !IsNull(layer.title) && layer.url)
                .map(layer => identify.identify(layer.url, new IdentifyParameters({
                    returnGeometry: true,
                    geometry: event.mapPoint,
                    tolerance: 3,
                    mapExtent: mapView.extent
                })));

            const responses = await Promise.allSettled(requests);
            if (requestId !== requestIdRef.current) return;

            const nextResults = responses.flatMap(response => {
                if (response.status !== "fulfilled" || !response.value?.results?.length) return [];
                const first = response.value.results[0];
                return [{
                    layerId: first.layerId,
                    layerName: first.layerName || "Katman",
                    features: response.value.results
                }];
            });
            setResults(nextResults);

            if (responses.some(response => response.status === "rejected")) {
                setErrorMessage("Bazı katmanlardan bilgi alınamadı; erişilebilen sonuçlar gösteriliyor.");
            }
        } catch (error) {
            if (requestId !== requestIdRef.current) return;
            setResults([]);
            setErrorMessage(error?.message || "Harita bilgi sorgusu tamamlanamadı.");
        } finally {
            if (requestId === requestIdRef.current) setLoading(false);
        }
    }, []);

    const resetWidget = useCallback(() => {
        requestIdRef.current += 1;
        clearSelectedGraphic();
        setResults(null);
        setLoading(false);
        setErrorMessage("");
    }, [clearSelectedGraphic]);

    useImperativeHandle(ref, () => ({
        id,
        visible: false,
        minimized: false,
        OnShow: () => executeIdentify(MapManager.GetMapClickEvent()),
        OnClose: resetWidget
    }), [executeIdentify, id, resetWidget]);

    useEffect(() => {
        windowManager.RegisterWindow(ref);
        mapViewRef.current = MapManager.GetMapView();
        return () => {
            requestIdRef.current += 1;
            clearSelectedGraphic();
            mapViewRef.current = null;
        };
    }, [clearSelectedGraphic, ref, windowManager]);

    const goToItem = async item => {
        const geometry = item?.feature?.geometry;
        if (!geometry) return;
        safeLog("Bilgi al/zoom", item?.feature?.attributes?.OBJECTID ?? item?.layerName ?? "");

        try {
            const projectedGeometry = await GisGraphicsHelper.ProjectGeometry(geometry, "4326");
            const graphic = await GisGraphicsHelper.CreateGraphicFromGeometry(projectedGeometry);
            clearSelectedGraphic();
            selectedGraphicRef.current = graphic;
            GisGraphicsHelper.AddGraphics(mapViewRef.current, graphic);
            GisGraphicsHelper.ZoomToGeometry(mapViewRef.current, projectedGeometry, null);
            if (window.matchMedia?.("(max-width: 767px)").matches) windowManager.ToggleMinimiseWindow(id);
        } catch (error) {
            setErrorMessage(error?.message || "Seçilen kayıt haritada gösterilemedi.");
        }
    };

    return (
        <section
            className="common-query-window common-query-window-right"
            aria-label="Bilgi Al"
            style={{ visibility: windowManager.IsVisible(id) ? "visible" : "hidden" }}
        >
            <header className="common-query-window-header">
                <img className="common-query-window-header-icon" src="images/icons/toolbar/bilgi.png" alt="" aria-hidden="true" />
                <span>Bilgi Al</span>
                <CommonQueryWindowTools windowManager={windowManager} windowId={id} showNearbySearch={false} showMapSelect={false} setQueryField={() => {}} query={null} />
            </header>
            <div className="common-query-window-body layer-list-window-body">
                {errorMessage && <div className="kr-status-banner kr-status-banner--warning" role="status">{errorMessage}</div>}
                <div className="global-identify-results-container" aria-live="polite">
                    {loading ? <ContainerLoading /> : results?.length === 0 ? <NoResultsFound /> : (
                        <Accordion defaultActiveKey={[]} alwaysOpen>
                            {results?.map((resultGroup, groupIndex) => (
                                <Accordion.Item
                                    key={`${resultGroup.layerId}-${resultGroup.layerName}-${groupIndex}`}
                                    eventKey={String(groupIndex)}
                                    className="global-identify-results-accordion-item"
                                >
                                    <Accordion.Header className="global-identify-results-accordion-item-header">
                                        <span>{resultGroup.layerName} ({resultGroup.features?.length ?? 0})</span>
                                    </Accordion.Header>
                                    <Accordion.Body>
                                        <Tabs defaultActiveKey="0" aria-label={`${resultGroup.layerName} sonuçları`}>
                                            {resultGroup.features?.map((feature, featureIndex) => {
                                                const objectId = feature?.feature?.attributes?.OBJECTID ?? featureIndex + 1;
                                                return (
                                                    <Tab key={`${objectId}-${featureIndex}`} title={String(objectId)} eventKey={String(featureIndex)}>
                                                        <div className="global-identify-result-item-container">
                                                            <div className="global-identify-result-item-row">
                                                                <Button className="w-100 form-button" onClick={() => goToItem(feature)}>
                                                                    <BiZoomIn aria-hidden="true" />&nbsp;&nbsp;Haritada Göster
                                                                </Button>
                                                            </div>
                                                            {Object.entries(feature?.feature?.attributes || {}).map(([key, value]) => (
                                                                <div className="global-identify-result-item-row" key={key}>
                                                                    <div className="global-identify-result-item-row-label"><strong>{key}</strong></div>
                                                                    <div className="global-identify-result-item-row-text">{String(value ?? "")}</div>
                                                                </div>
                                                            ))}
                                                        </div>
                                                    </Tab>
                                                );
                                            })}
                                        </Tabs>
                                    </Accordion.Body>
                                </Accordion.Item>
                            ))}
                        </Accordion>
                    )}
                </div>
            </div>
        </section>
    );
});

GlobalIdentifyWidget.displayName = "GlobalIdentifyWidget";
