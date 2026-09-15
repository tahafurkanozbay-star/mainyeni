import React, { useEffect, useImperativeHandle, useState } from "react";
import { Button, Form } from "react-bootstrap";
import { NumberingQueryBusiness } from "../../../Business/NumberingQueryBusiness";
import { Constants_MessageType, Constants_ServiceResultType } from "../../../Core/Constants";
import MapManager from "../../../Store/Managers/MapManager";
import { CommonQueryWindowTools } from "../_Common/CommonQueryWindowTools";
import { RouteQueryBusiness } from "../../../Business/RouteQueryBusiness";
import { BiRadioCircle, BiRadioCircleMarked, BiSearch } from "react-icons/bi";
import { FiArrowUp, FiMapPin, FiPhone, FiType } from "react-icons/fi";
import { HiOutlineArrowNarrowLeft } from "react-icons/hi";
import { CommonQueryResultItemTools } from "../_Common/CommonQueryResultItemTools";
import { CommonBusiness } from "../../../Business/CommonBusiness";
import { DebugHelper } from "../../../Toolbox/DebugHelper";
import { GisGraphicsHelper } from "../../../Toolbox/GisGraphicsHelper";
import { ButtonLoading } from "../../Common/Loading";
import { BsToggleOff, BsToggleOn } from "react-icons/bs";
import { LoggingBusiness } from "../../../Business/LoggingBusiness";
import { RiRouteFill } from "react-icons/ri";
import { useRef } from "react";
import { TextHelper } from "../../../Toolbox/TextHelper";

export const RouteQueryWindow = React.forwardRef((props, ref) => {

    const windowTitle = "Rotalar";
    const windowLogo = "images/icons/sidebar/rotalar.png";

    useImperativeHandle(ref, () => ({

        id: props.id, visible: false, minimized: false,
        OnShow: () => {
            DebugHelper.Log("show " + props.id);
        },
        OnClose: () => {
            DebugHelper.Log("closing " + props.id);
            setQuery(defaultQuery);
            setActiveTab("form");
            setResultList(null);
            removeLastClusterLayer();
            MapManager.RemoveAllGraphics();
            commonToolsComponentRef.current.OnClose();
        }
    }));

    const commonToolsComponentRef=useRef();
    const [mapView, setMapView] = useState(null);
    const [districtList, setDistrictList] = useState(null);
    useEffect(() => {

        props.windowManager.RegisterWindow(ref);
        
        const _mapView = MapManager.GetMapView();
        setMapView(_mapView);

        NumberingQueryBusiness.GetDistricts().then(_result => {

            if (_result.type == Constants_ServiceResultType.Success) {
                setDistrictList(_result.data);
            }
        });

    }, []);


    const cmbDistrict_OnChange = (e) => {

        const districtId = e.target.value;
        setQueryField("districtId", districtId);
        setQueryField("districtName", e.target.selectedOptions[0].text);
    }


    const defaultQuery = { name: null, districtId: null, showMapSelect: false, showNearby: false, routeLevel: 3, showCultureWalkingRoute:true, showNatureWalkingRoute:true };
    const [query, setQuery] = useState(defaultQuery);
    const setQueryField = (_field, _value) => {
        setQuery(query => {
            return { ...query, [_field]: _value }
        })
    }

    const [clusterLayer, setClusterLayer] = useState(null);
    const removeLastClusterLayer = () => {
        if (clusterLayer != null) {
            mapView.map.remove(clusterLayer.layerObj);
            setClusterLayer(null);
        }
    }


    const [resultList, setResultList] = useState(null);
    const [activeTab, setActiveTab] = useState("form");
    const btnBack_OnClick = (e) => {
        removeLastClusterLayer();
        setActiveTab("form");
    }

    const [loading, setLoading] = useState(false);
    const btnSubmit_OnClick = (e) => {

        e?.preventDefault();
        setLoading(true);

        RouteQueryBusiness.Query(query, false).then((_result) => {

            if (_result.type == Constants_ServiceResultType.Success) {

                setActiveTab("query");

                CommonBusiness.Clustering.CreateClusterLayer(props.queryServiceTitle, windowTitle, null, null).then((_clusterLayer) => {

                    removeLastClusterLayer();

                    setClusterLayer(_clusterLayer);
                    mapView.map.add(_clusterLayer.layerObj);

                });

                let list = [];

                _result.data.forEach(_item => {
                    list.push({
                        Id: _item.attr.id ?? _item.attr.objectid,
                        Title: _item.attr.ADI ?? _item.attr.adi,
                        Description: _item.attr.ACIKLAMA ?? _item.attr.aciklama,
                        RouteLevel: _item.attr.ZORLUKDERECESI ?? _item.attr.zorlukderecesi,
                        District: _item.attr.ILCE ?? _item.attr.ilce,
                        RouteType: _item.attr.TIP ?? _item.attr.tip,
                    });
                });
                setResultList(list);
                setLoading(false);

            }
        });

    }


    const getItemDetailsById = async (_item) => {

        return new Promise((resolve, reject) => {
            RouteQueryBusiness.Query({ Id: _item.Id }, true).then((_result) => {
                if (_result.type == Constants_ServiceResultType.Success) {
                    if (_result.data != null) {
                        const _resultItem = _result.data[0];
                        resolve(_resultItem);
                    }
                    else {
                        reject(null);
                    }
                }
            });
        });

    }

    const item_OnClick = (e, _item) => {

        LoggingBusiness.CreateClientLog("Rota/Detay Göster", _item.Id + "/" + _item.Title);
        getItemDetailsById(_item).then(_itemDetails => {

            GisGraphicsHelper.ProjectGeometry(_itemDetails?.geometry, "4326").then((_pGeometry)=>{

                GisGraphicsHelper.CreateGraphicFromGeometry(_pGeometry,null).then((_graphic)=>{
                    MapManager.AddGraphics(_graphic,true);
                    GisGraphicsHelper.ZoomToGeometryExtent(mapView, _pGeometry, 1.5);
                
                });

                if (window.screen.width < 960) {
                    props.windowManager.ToggleMinimiseWindow(props.id);
                }


            });

        });
    }

    const item_ShowRoute = (e, _item) => {

        getItemDetailsById(_item).then(_itemDetails => {

            if (_itemDetails != null) {
                const lat = _itemDetails.geometry.latitude;
                const lng = _itemDetails.geometry.longitude;
                let url = "https://www.google.com.tr/maps?saddr=My+Location&daddr=" + lat + "," + lng;
                window.open(url, "_blank");
                //TODO: create log
            }
            else {
                props.windowManager.ShowMessage(Constants_MessageType.Error, "Yol tarifi alınamadı - öğe detayları bulunamadı");
            }


        });
    }

    return (<>
        <div className="common-query-window"
            style={{ visibility: props.windowManager.IsVisible(props.id) ? 'visible' : 'hidden' }}>
            <div className="common-query-window-header">
                <img className="common-query-window-header-icon" src={windowLogo}></img>
                <span>{windowTitle}</span>
                <CommonQueryWindowTools
                    ref={commonToolsComponentRef}
                    windowManager={props.windowManager}
                    windowId={props.id}
                    setQueryField={setQueryField}
                    query={query}
                    showNearbySearch={activeTab == "form"}
                    showMapSelect={activeTab == "form"} />

            </div>
            <div className={"common-query-window-body " + (props.windowManager.IsMinimized(props.id) ? "common-query-window-body-collapsed" : "")}>
                {
                    activeTab === "form" ?
                        <>
                            <Form onSubmit={(e) => btnSubmit_OnClick(e)}>
                                <div className="horizontal-layout">
                                    {<div onClick={(e) => setQueryField("showCultureWalkingRoute", !query.showCultureWalkingRoute)}
                                        className="form-checkbox form-checkbox-vertical">
                                        <span>Kültürel Rotalar</span>{
                                            query && query.showCultureWalkingRoute ? <BsToggleOn /> : <BsToggleOff />
                                        }
                                    </div>
                                    }

                                    {<div onClick={(e) => setQueryField("showNatureWalkingRoute", !query.showNatureWalkingRoute)}
                                        className="form-checkbox form-checkbox-vertical">
                                        <span>Doğal Yürüyüş Rotaları</span>{
                                            query && query.showNatureWalkingRoute ? <BsToggleOn /> : <BsToggleOff />
                                        }
                                    </div>
                                    }
                                </div>
                                {
                                    (!query.showNearby && !query.mapSelect) && <>
                                        <Form.Group>
                                            <label className="form-label">İlçe</label>
                                            <select className="form-select form-control" onChange={((e) => cmbDistrict_OnChange(e))}
                                                value={query.districtId}>
                                                <option value="">Seçiniz..</option>
                                                {
                                                    districtList?.map(_item => {
                                                        return <option key={TextHelper.CreateRandomNumber()} value={_item.attr.id}>{_item.attr.ad}</option>
                                                    })
                                                }
                                            </select>
                                        </Form.Group>
                                    </>
                                }

                                <Form.Group>
                                    
                                    <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', marginTop: '20px' }}>
                                    <label className="form-label">Zorluk Derecesi</label>
                                        <div style={{ flexShrink: '0', flexGrow: '1' }}>

                                            <div className="radio-group">
                                                {
                                                    
                                                    [1, 2, 3, 4, 5].map(_level => {
                                                        return <div className="radio-group-item" 
                                                        key={TextHelper.CreateRandomNumber()}
                                                        onClick={(e)=>setQueryField("routeLevel",_level)}>
                                                            {
                                                                query.routeLevel==_level ? <BiRadioCircleMarked className="radio-group-item-icon" />
                                                                : <BiRadioCircle className="radio-group-item-icon" />
                                                            }
                                                            <span>{_level}</span>
                                                        </div>
                                                    })
                                                }

                                            </div>

                                        </div>
                                    
                                    </div>

                                </Form.Group>
                                {
                                    !query.mapSelect &&
                                    <Form.Group>
                                        {
                                            loading ? <ButtonLoading />
                                                : <Button type="button" className="form-button" onClick={(e) => btnSubmit_OnClick()}>
                                                    <BiSearch className="form-button-icon" /><span>Sorgula</span>
                                                </Button>
                                        }
                                    </Form.Group>
                                }

                            </Form>
                        </> : <div className="results-container">
                            {
                                <>
                                    <div className="results-container-toolbar">
                                        <div className="results-container-back-button" onClick={(e) => btnBack_OnClick(e)}>
                                            <HiOutlineArrowNarrowLeft className="results-container-back-button-icon" />
                                            &nbsp;Geri Dön
                                        </div>
                                        <div className="results-container-count">
                                            <strong>{resultList?.length ?? 0}</strong> adet sonuç bulundu
                                        </div>
                                    </div>
                                    {
                                        resultList?.map(_item => {
                                            return <div className="result-item-container" key={TextHelper.CreateRandomNumber()} onClick={(e) => item_OnClick(e, _item)}>
                                                <div className="result-item-info">
                                                    <div className="result-item-info-title">
                                                        {_item.Title}
                                                    </div>
                                                    <div className="result-item-info-address">
                                                        <FiMapPin />&nbsp;
                                                        {_item.District}
                                                    </div>
                                                    <div className="result-item-info-address-description">
                                                        <FiMapPin />&nbsp;
                                                        {_item.Description}
                                                    </div>
                                                    <div className="result-item-info-phone">
                                                        <FiArrowUp />&nbsp;
                                                        {_item.RouteLevel}
                                                        &nbsp;&nbsp;&nbsp;&nbsp;
                                                        <RiRouteFill />&nbsp;
                                                        {_item.RouteType==1 ? "Kültürel Yürüyüş Rotası" : "Doğa Yürüyüş Rotası"}
                                                    </div>
                                                </div>
                                                <CommonQueryResultItemTools
                                                    item={_item}
                                                    zoomCallback={(e) => item_OnClick(e, _item)}
                                                    showRouteCallback={(e) => item_ShowRoute(e, _item)}
                                                />
                                            </div>
                                        })
                                    }
                                </>
                            }
                        </div>
                }
            </div>
        </div>
    </>);
});