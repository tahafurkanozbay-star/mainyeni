import React, { useEffect, useImperativeHandle, useState } from "react";
import { loadModules } from "esri-loader";
import MapManager from "../../../Store/Managers/MapManager";
import { CommonQueryWindowTools } from "../../Query/_Common/CommonQueryWindowTools";
import { CommonQueryResultItemTools } from "../../Query/_Common/CommonQueryResultItemTools";
import "./VicinityQueryWindow.css";
import { BiInfoCircle, BiLayer, BiSearch, BiZoomIn } from "react-icons/bi";
import { FiMapPin, FiPhone } from "react-icons/fi";
import { IsNull } from "../../../Toolbox/ObjectHelper";
import { ContainerLoading, NoResultsFound } from "../../Common/Loading";
import { Accordion, Button, Form, Tab, Tabs } from "react-bootstrap";
import { GisGraphicsHelper } from "../../../Toolbox/GisGraphicsHelper";
import { FulltextSearchQueryBusiness } from "../../../Business/FulltextSearchQueryBusiness";
import { LoggingBusiness } from "../../../Business/LoggingBusiness";
import { NumberingQueryBusiness } from "../../../Business/NumberingQueryBusiness";
import { GoogleMapsBusiness } from "../../../Business/GoogleMapsBusiness";
import { Constants_MessageType } from "../../../Core/Constants";

export const VicinityQueryWindow = React.forwardRef((props, ref) => {

    useImperativeHandle(ref, () => ({

        id: props.id, visible: false, minimized: false,
        OnShow: () => {
            setBufferDistance(defaultBufferDistance);
            bufferDistanceChange();
        },
        OnClose: () => {
            setFilteredOptions(null);
            setBufferDistance(defaultBufferDistance);
            MapManager.RemoveAllGraphics();
            MapManager.RemoveGraphics(lastItemGraphic);
            setLastItemGraphic(null);

            setResults(null);
        }
    }));


    const defaultBufferDistance = 20;
    const [mapView, setMapView] = useState(null);
    useEffect(() => {

        props.windowManager.RegisterWindow(ref);

        const _mapView = MapManager.GetMapView();
        setMapView(_mapView);

        NumberingQueryBusiness.GetAllNeighborhoods().then((_results) => {
            setNeighborhoodList(_results.data);
        });

    }, []);


    const [results, setResults] = useState(null);
    const [loading, setLoading] = useState(false);
    const [neighborhoodList, setNeighborhoodList] = useState(null);
    const [flatArray, setFlatArray] = useState(null);
    const [filteredOptions, setFilteredOptions] = useState(null);

    const [lastItemGraphic, setLastItemGraphic] = useState(null);
    const item_OnClick = (e, _item) => {

        LoggingBusiness.CreateClientLog("Yakınımda Ara/Tıklama", _item.Id + "/" + _item.Title);

        GisGraphicsHelper.ProjectGeometry(_item.geometry, "4326").then((_projectedGeometry) => {

            GisGraphicsHelper.CreateGraphicFromGeometry(_projectedGeometry).then(_graphic => {

                MapManager.RemoveGraphics(lastItemGraphic);
                setLastItemGraphic(_graphic);


                GisGraphicsHelper.AddGraphics(mapView, _graphic);
                GisGraphicsHelper.ZoomToGeometry(mapView, _graphic, 15);

                //LoggingBusiness.CreateClientLog("cityblockparcelquery-zoomtoparcel", item);

                if (window.screen.width < 768) {
                    props.windowManager.ToggleMinimiseWindow(props.id);
                }

            });
        });
    }

    const item_ShowRoute = (e, _item) => {

        LoggingBusiness.CreateClientLog("Yakınımda Ara/Yol Tarifi", _item.Id + "/" + _item.Title);

        if (_item != null) {
            let url = GoogleMapsBusiness.CreateRoutesUrlFromPoint(_item.geometry);
            window.open(url, "_blank");
            //TODO: create log
        }
        else {
            props.windowManager.ShowMessage(Constants_MessageType.Error, "Yol tarifi alınamadı - öğe detayları bulunamadı");
        }

    }


    const [bufferDistance, setBufferDistance] = useState(20);
    const bufferDistanceChange = async (e) => {

        const value = parseInt(e?.target?.value ?? defaultBufferDistance);

        if (value >= 1) {
            setBufferDistance(value);
        }


        loadModules(["esri/geometry/Circle", "esri/Graphic",]).then(([Circle, Graphic]) => {

            const event = MapManager.GetMapClickEvent();

            const circleGeometry = new Circle({
                center: event.mapPoint,
                geodesic: true,
                numberOfPoints: 100,
                radius: value * 100,
                radiusUnit: "meters"
            });


            var _graphic = new Graphic({
                geometry: circleGeometry,
                symbol: {
                    type: "simple-fill",
                    color: [255, 255, 255, 0.3],
                    outline: {
                        width: 3,
                        color: "#8f06e7"
                    }
                }
            });

            MapManager.AddGraphics(_graphic, true)

        });


    }




    const maxSubOptionsLength = 50;
    const createOption = (_results, _title, _category, _idField, _titleField) => {

        let option = {

            Title: _title,
            Count: _results?.length,
            Options: _results?.slice(0, maxSubOptionsLength)?.map(_item => {

                let obj = { ..._item };


                if (IsNull(_item.attr.mahalle_adi)) {
                    let mahalleResult = neighborhoodList.find(x => x.attr["id"] == _item.attr["mahalleid"]);
                    obj.attr._MAHALLE_ADI = mahalleResult?.attr.ad;
                }
                else {
                    obj.attr._MAHALLE_ADI = _item.attr.mahalle_adi;
                }

                obj.Id = _item.attr[_idField];
                obj.Category = _category;
                obj.Title = _item.attr[_titleField];
                obj.Geometry = _item.geometry;

                return obj;
            })
        };

        return option;
    }


    const btnSearch_OnClick = (e) => {

        const event = MapManager.GetMapClickEvent();

        const lat = event.mapPoint.latitude;
        const lng = event.mapPoint.longitude;

        LoggingBusiness.CreateClientLog("Yakınımda Ara/Sorgu", lat+"/"+lng+"/"+bufferDistance);

        setLoading(true);
        let promises = [];
        const configServices = [...MapManager.GetConfigurationServices()];
        configServices.filter(x => x.showInSearch == true).forEach(_configService => {
            promises.push(FulltextSearchQueryBusiness.QueryService(_configService,
                {
                    showNearby: true, userLocation: event.mapPoint,
                    bufferDistance: bufferDistance
                }, true));
        });

        Promise.allSettled(promises).then((_results) => {

            let searchOptions = [];
            let totalCount = 0;
            let _flatArray = [];

            _results.forEach(_result => {
                let _item = _result.value;
                let option = createOption(_item.Data, _item.Title, _item.Title, "ID", "AD");
                searchOptions.push(option);
            });

            searchOptions?.forEach((_option, _index) => {
                _option?.Options?.forEach((_suboption, _subindex) => {
                    totalCount++;
                    if (_subindex < maxSubOptionsLength) {
                        _flatArray.push(_suboption);
                    }
                });
            });

            setFlatArray(_flatArray);

            setFilteredOptions(searchOptions);
            setLoading(false);

        });
    }

    return (<div className="common-query-window"
        style={{ visibility: props.windowManager.IsVisible(props.id) ? 'visible' : 'hidden' }}>
        <div className="common-query-window-header">
            <img className="common-query-window-header-icon" src="images/icons/toolbar/bilgi.png"></img>
            <span>Yakınımda Ara</span>
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
                !loading && <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', alignContent: 'center' }}>
                    <div style={{ flexShrink: '0', flexGrow: '1' }}>
                        <Form.Range defaultValue={bufferDistance}
                            value={bufferDistance}
                            onInput={(e) => { bufferDistanceChange(e) }} />
                    </div>
                    <div className="common-query-window-tools-buffer-distance-indicator">
                        {bufferDistance * 100} m
                    </div>
                    &nbsp;&nbsp;
                    <Button className="form-button" style={{ marginTop: 0 }} onClick={(e) => btnSearch_OnClick(e)} >
                        <BiSearch />&nbsp;&nbsp;Ara</Button>
                </div>
            }
            <div className="vicinity-query-results-container">
                {
                    loading ? <ContainerLoading /> :
                        filteredOptions?.length == 0 ? <NoResultsFound /> :
                            <>
                                <Accordion defaultActiveKey={-1}>
                                    {
                                        filteredOptions?.map((_optionGroup, _optionGroupIndex) => {
                                            return _optionGroup.Count == 0 ? null : <Accordion.Item eventKey={_optionGroupIndex}
                                                className="vicinity-query-results-accordion-item">
                                                <Accordion.Header className="vicinity-query-results-accordion-item-header">
                                                    <BiLayer /> <span>{_optionGroup.Title} ({_optionGroup?.Count})</span>
                                                </Accordion.Header>
                                                <Accordion.Body>
                                                    <div className="vicinity-query-results-accordion-item-body">
                                                        {
                                                            _optionGroup.Options?.map((_item, _itemIndex) => {
                                                                return <> <div className="result-item-container" onClick={(e) => item_OnClick(e, _item)}>
                                                                    <div className="result-item-info">
                                                                        <div className="result-item-info-title">
                                                                            {_item.attr?.adi}
                                                                        </div>
                                                                        <div className="result-item-info-address">
                                                                            <FiMapPin />&nbsp;
                                                                            {_item.attr?._MAHALLE_ADI}
                                                                        </div>
                                                                        <div className="result-item-info-address-description">
                                                                            <FiMapPin />&nbsp;
                                                                            {_item.attr.adres}
                                                                        </div>
                                                                    </div>
                                                                    <CommonQueryResultItemTools
                                                                        item={_item}
                                                                        zoomCallback={(e) => item_OnClick(e, _item)}
                                                                        showRouteCallback={(e) => item_ShowRoute(e, _item)} />
                                                                </div></>
                                                            })
                                                        }
                                                    </div>
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