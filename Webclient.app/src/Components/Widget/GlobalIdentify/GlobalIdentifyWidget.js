import React, { useEffect, useImperativeHandle, useRef, useState } from "react";
import MapManager from "../../../Store/Managers/MapManager";
import { CommonQueryWindowTools } from "../../Query/_Common/CommonQueryWindowTools";
import "./GlobalIdentifyWidget.css";
import { BiZoomIn } from "react-icons/bi";
import { ContainerLoading, NoResultsFound } from "../../Common/Loading";
import { Accordion, Button, Tab, Tabs } from "react-bootstrap";
import { GisGraphicsHelper } from "../../../Toolbox/GisGraphicsHelper";
import { LoggingBusiness } from "../../../Business/LoggingBusiness";
import { createIdentifySession } from "../../../gis-engine/identifyRuntime";

const objectIdOf = (result, fallback) => {
    const attributes = result?.attributes || result?.feature?.attributes || {};
    return attributes.OBJECTID
        ?? attributes.ObjectID
        ?? attributes.objectid
        ?? attributes.FID
        ?? attributes.fid
        ?? fallback;
};

export const GlobalIdentifyWidget = React.forwardRef((props, ref) => {
    const [mapView, setMapView] = useState(null);
    const [results, setResults] = useState(null);
    const [loading, setLoading] = useState(false);
    const sessionRef = useRef(createIdentifySession());
    const mountedRef = useRef(true);
    const highlightGraphicRef = useRef(null);

    const clearHighlight = () => {
        const view = MapManager.GetMapView() || mapView;
        if (view && highlightGraphicRef.current) {
            GisGraphicsHelper.RemoveGraphics(view, highlightGraphicRef.current);
            highlightGraphicRef.current = null;
        }
    };

    const cancelIdentify = () => {
        sessionRef.current.cancel();
        if (mountedRef.current) setLoading(false);
    };

    const executeIdentify = async (event) => {
        const view = MapManager.GetMapView() || mapView;
        if (!view || !event?.mapPoint) {
            if (mountedRef.current) {
                setResults([]);
                setLoading(false);
            }
            return;
        }

        setLoading(true);
        setResults(null);
        try {
            const response = await sessionRef.current.run(view, event, {
                tolerance: 3,
                concurrency: 4,
                returnGeometry: true,
            });
            if (!mountedRef.current) return;
            setResults(response.groups);
        } catch (error) {
            if (!mountedRef.current || error?.code === 'CANCELLED') return;
            setResults([]);
        } finally {
            if (mountedRef.current) setLoading(false);
        }
    };

    useImperativeHandle(ref, () => ({
        id: props.id,
        visible: false,
        minimized: false,
        OnShow: () => {
            const event = MapManager.GetMapClickEvent();
            executeIdentify(event);
        },
        OnClose: () => {
            cancelIdentify();
            clearHighlight();
            setResults(null);
        },
    }));

    useEffect(() => {
        mountedRef.current = true;
        props.windowManager.RegisterWindow(ref);
        setMapView(MapManager.GetMapView());

        return () => {
            mountedRef.current = false;
            sessionRef.current.cancel();
            const view = MapManager.GetMapView();
            if (view && highlightGraphicRef.current) {
                GisGraphicsHelper.RemoveGraphics(view, highlightGraphicRef.current);
                highlightGraphicRef.current = null;
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const goToItem = async (item) => {
        const view = MapManager.GetMapView() || mapView;
        const geometry = item?.geometry || item?.feature?.geometry;
        if (!view || !geometry) return;

        LoggingBusiness.CreateClientLog("Bilgi al/zoom", {
            layerId: item.layerId,
            objectId: objectIdOf(item, null),
        });

        try {
            const projectedGeometry = await GisGraphicsHelper.ProjectGeometry(geometry, "4326");
            const graphic = await GisGraphicsHelper.CreateGraphicFromGeometry(projectedGeometry);
            clearHighlight();
            GisGraphicsHelper.AddGraphics(view, graphic);
            highlightGraphicRef.current = graphic;
            GisGraphicsHelper.ZoomToGeometry(view, graphic, null);

            if (window.screen.width < 768) {
                props.windowManager.ToggleMinimiseWindow(props.id);
            }
        } catch (_) {
            // Identify results remain usable even if projection/highlight fails.
        }
    };

    return (
        <div
            className="common-query-window common-query-window-right"
            style={{ visibility: props.windowManager.IsVisible(props.id) ? 'visible' : 'hidden' }}
        >
            <div className="common-query-window-header">
                <img className="common-query-window-header-icon" src="images/icons/toolbar/bilgi.png" alt="" />
                <span>Bilgi Al</span>
                <CommonQueryWindowTools
                    windowManager={props.windowManager}
                    windowId={props.id}
                    showNearbySearch={false}
                    showMapSelect={false}
                    setQueryField={() => {}}
                    query={null}
                />
            </div>
            <div className="common-query-window-body layer-list-window-body">
                <div className="global-identify-results-container" aria-live="polite">
                    {loading ? (
                        <ContainerLoading />
                    ) : results?.length === 0 ? (
                        <NoResultsFound />
                    ) : (
                        <Accordion defaultActiveKey={-1}>
                            {results?.map((resultGroup, resultGroupIndex) => {
                                const groupKey = String(resultGroup.layerId ?? resultGroupIndex);
                                return (
                                    <Accordion.Item
                                        eventKey={groupKey}
                                        key={groupKey}
                                        className="global-identify-results-accordion-item"
                                    >
                                        <Accordion.Header className="global-identify-results-accordion-item-header">
                                            <span>{resultGroup.layerName} ({resultGroup.features?.length || 0})</span>
                                        </Accordion.Header>
                                        <Accordion.Body>
                                            <Tabs defaultActiveKey="0">
                                                {resultGroup.features?.map((featureResult, featureIndex) => {
                                                    const objectId = objectIdOf(featureResult, featureIndex + 1);
                                                    const attributes = featureResult.attributes || featureResult.feature?.attributes || {};
                                                    return (
                                                        <Tab
                                                            title={String(objectId)}
                                                            eventKey={String(featureIndex)}
                                                            key={`${groupKey}-${objectId}-${featureIndex}`}
                                                        >
                                                            <div className="global-identify-result-item-container">
                                                                <div className="global-identify-result-item-row">
                                                                    <Button
                                                                        className="w-100 form-button"
                                                                        onClick={() => goToItem(featureResult)}
                                                                        disabled={!featureResult.geometry && !featureResult.feature?.geometry}
                                                                    >
                                                                        <BiZoomIn aria-hidden="true" />&nbsp;&nbsp;Haritada Göster
                                                                    </Button>
                                                                </div>
                                                                {Object.entries(attributes).map(([key, value]) => (
                                                                    <div className="global-identify-result-item-row" key={key}>
                                                                        <div className="global-identify-result-item-row-label"><strong>{key}</strong></div>
                                                                        <div className="global-identify-result-item-row-text">{String(value ?? '')}</div>
                                                                    </div>
                                                                ))}
                                                            </div>
                                                        </Tab>
                                                    );
                                                })}
                                            </Tabs>
                                        </Accordion.Body>
                                    </Accordion.Item>
                                );
                            })}
                        </Accordion>
                    )}
                </div>
            </div>
        </div>
    );
});
