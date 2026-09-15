import React, { useEffect, useImperativeHandle, useState } from "react";
import { loadModules } from "esri-loader";
import MapManager from "../../../Store/Managers/MapManager";
import { CommonQueryWindowTools } from "../../Query/_Common/CommonQueryWindowTools";
import "./GlobalIdentifyWidget.css";
import { BiInfoCircle, BiZoomIn } from "react-icons/bi";
import { IsNull } from "../../../Toolbox/ObjectHelper";
import { ContainerLoading, NoResultsFound } from "../../Common/Loading";
import { Accordion, Button, Tab, Tabs } from "react-bootstrap";
import { GisGraphicsHelper } from "../../../Toolbox/GisGraphicsHelper";
import { LoggingBusiness } from "../../../Business/LoggingBusiness";

export const GlobalIdentifyWidget = React.forwardRef((props, ref) => {

    useImperativeHandle(ref, () => ({

        id: props.id, visible: false, minimized: false,
        OnShow: () => {

            //startIdentify();
            const event = MapManager.GetMapClickEvent();
            executeIdentify(event);
        },
        OnClose: () => {

            GisGraphicsHelper.RemoveAllGraphics(mapView);
            cancelIdentify();
            setResults();

        }
    }));

    const [mapView, setMapView] = useState(null);
    useEffect(() => {
        
        props.windowManager.RegisterWindow(ref);

        const _mapView = MapManager.GetMapView();
        setMapView(_mapView);

    }, []);


    const [mapClickEvent, setMapClickEvent] = useState(null);
    const startIdentify = () => {

        //mapView.popup.autoOpenEnabled = false;

        if (mapClickEvent == null) {

            const _mapClickEvent = mapView.on("click", function (event) {
                executeIdentify(event);
            });

            setMapClickEvent(_mapClickEvent);
        }
    }

    const cancelIdentify = () => {
        mapClickEvent?.remove();
        setMapClickEvent(null);
    }


    const [results, setResults] = useState(null);
    const [loading, setLoading] = useState(false);

    const executeIdentify = (_event) => {

        loadModules(["esri/rest/identify", "esri/rest/support/IdentifyParameters"]).then(([identify, IdentifyParameters]) => {

            let promises = [];
            setLoading(true);


            mapView?.map?.allLayers.items.forEach(_layer => {

                if (_layer.visible) {

                    if (!IsNull(_layer.title)) {

                        let params = new IdentifyParameters({
                            returnGeometry: true,
                            geometry: _event.mapPoint,
                            tolerance: 3,
                            mapExtent: mapView.extent
                        });

                        let url = _layer.url;

                        promises.push(identify.identify(url, params));

                    }

                }
            });

            Promise.allSettled(promises).then((responses) => {


                let resultArray = [];
                responses.forEach((response) => {

                    if (response.status == 'fulfilled') {
                        if (response?.value.results?.length > 0) {
                            resultArray.push({
                                layerId: response.value.results[0].layerId,
                                layerName: response.value.results[0].layerName,
                                features: response.value.results
                            });

                        }
                    }


                });

                setResults(resultArray);
                setLoading(false);

            });

        });

    }


    const goToItem = (_item) => {

        LoggingBusiness.CreateClientLog("Bilgi al/zoom", _item);

        GisGraphicsHelper.ProjectGeometry(_item.feature.geometry, "4326").then((_projectedGeometry) => {

            GisGraphicsHelper.CreateGraphicFromGeometry(_projectedGeometry).then(_graphic => {

                GisGraphicsHelper.RemoveAllGraphics(mapView);
                GisGraphicsHelper.AddGraphics(mapView, _graphic);
                GisGraphicsHelper.ZoomToGeometry(mapView, _graphic, null);

                //LoggingBusiness.CreateClientLog("cityblockparcelquery-zoomtoparcel", item);

                if (window.screen.width < 768) {
                    props.windowManager.ToggleMinimiseWindow(props.id);
                }

            });
        });
    }


    return (<div className="common-query-window common-query-window-right"
        style={{ visibility: props.windowManager.IsVisible(props.id) ? 'visible' : 'hidden' }}>
        <div className="common-query-window-header">
            <img className="common-query-window-header-icon" src="images/icons/toolbar/bilgi.png"></img>
            <span>Bilgi Al</span>
            <CommonQueryWindowTools
                windowManager={props.windowManager}
                windowId={props.id}
                showNearbySearch={false}
                showMapSelect={false}
                setQueryField={(e) => { }}
                query={null} />
        </div>
        <div className="common-query-window-body layer-list-window-body">

            {
                /*
                
            <div className="global-identify-message-container">
                <BiInfoCircle className="global-identify-message-icon" />
                <span className="global-identify-message-text">Bilgi almak için haritaya tıklayın</span>
            </div>
            */
            }

            <div className="global-identify-results-container">
                {
                    loading ? <ContainerLoading /> :
                        results?.length == 0 ? <NoResultsFound /> :
                            <>
                                <Accordion defaultActiveKey={-1}>
                                    {
                                        results?.map((_resultGroup, _resultGroupIndex) => {
                                            return <Accordion.Item eventKey={_resultGroupIndex}
                                                className="global-identify-results-accordion-item">
                                                <Accordion.Header className="global-identify-results-accordion-item-header">
                                                    <span>{_resultGroup.layerName} ({_resultGroup.features?.length})</span>
                                                </Accordion.Header>
                                                <Accordion.Body>
                                                    <Tabs>
                                                        {
                                                            _resultGroup.features?.map((_feature, _featureIndex) => {
                                                                return <Tab title={_feature.feature.attributes.OBJECTID}
                                                                    eventKey={_featureIndex}>
                                                                    <div className="global-identify-result-item-container">
                                                                        <div className="global-identify-result-item-row">

                                                                            <Button className="w-100 form-button" onClick={(e) => goToItem(_feature)}>
                                                                                <BiZoomIn />&nbsp;&nbsp;
                                                                                Haritada Göster</Button>
                                                                        </div>
                                                                        {
                                                                            Object.entries(_feature.feature.attributes).map(_kvArray => {
                                                                                return <div className="global-identify-result-item-row">
                                                                                    <div className="global-identify-result-item-row-label"><strong>{_kvArray[0]}</strong></div>
                                                                                    <div className="global-identify-result-item-row-text">{_kvArray[1]}</div>
                                                                                </div>
                                                                            })
                                                                        }
                                                                    </div>


                                                                </Tab>
                                                            })
                                                        }
                                                    </Tabs>
                                                </Accordion.Body>
                                            </Accordion.Item>
                                        })
                                    }
                                </Accordion>
                            </>
                }
            </div>
        </div>
    </div>);
});