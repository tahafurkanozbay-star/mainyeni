import React, { useEffect, useImperativeHandle, useState } from "react";
import { Button, Form, Tab, Tabs } from "react-bootstrap";
import { NumberingQueryBusiness } from "../../../Business/NumberingQueryBusiness";
import { Constants_MessageType, Constants_ServiceResultType } from "../../../Core/Constants";
import MapManager from "../../../Store/Managers/MapManager";
import { CommonQueryWindowTools } from "../_Common/CommonQueryWindowTools";
import { TransitRouteQueryBusiness } from "../../../Business/TransitRouteQueryBusiness";
import { BiBus, BiCar, BiCycling, BiMap, BiSearch, BiSort, BiTargetLock, BiWalk, BiXCircle } from "react-icons/bi";
import { FiMapPin, FiPhone } from "react-icons/fi";
import { HiOutlineArrowNarrowLeft } from "react-icons/hi";
import { CommonQueryResultItemTools } from "../_Common/CommonQueryResultItemTools";
import { CommonBusiness } from "../../../Business/CommonBusiness";
import { DebugHelper } from "../../../Toolbox/DebugHelper";
import { GisGraphicsHelper } from "../../../Toolbox/GisGraphicsHelper";
import { ButtonLoading } from "../../Common/Loading";
import "./TransitRouteQueryWindow.css";
import { BsStoplights, BsToggleOff, BsToggleOn } from "react-icons/bs";
import { TbPoint } from "react-icons/tb";

export const TransitRouteQueryWindow = React.forwardRef((props, ref) => {

    const windowTitle = "Ulaşım Ağları";
    const windowLogo = "images/icons/sidebar/ulasimaglari.png";

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
        }
    }));

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
    }


    const defaultQuery = { stops: [{ address: "", coordinates: "" }, { address: "", coordinates: "" }] };
    const [query, setQuery] = useState(defaultQuery);
    const setQueryField = (_field, _value) => {
        setQuery( query => {
            return { ...query,[_field]: _value}
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

        TransitRouteQueryBusiness.Query(query, false).then((_result) => {

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
                        ObjectId: _item.attr.objectid,
                        Title: _item.attr.adi,
                        Phone: _item.attr.telefon,
                        Address: _item.attr.adres,
                        AddressDescription: "Adres tarifi bulunmuyor"
                    });
                });
                setResultList(list);
                setLoading(false);

            }
        });

    }


    const getItemDetailsById = async (_item) => {

        return new Promise((resolve, reject) => {
            TransitRouteQueryBusiness.Query({ Id: _item.Id }, true).then((_result) => {
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

        getItemDetailsById(_item).then(_itemDetails => {
            
            GisGraphicsHelper.ZoomToGeometry(mapView, _itemDetails?.geometry, 18);

            if(window.screen.width<960){
                props.windowManager.ToggleMinimiseWindow(props.id);
            } 
        });
    }

    const item_ShowTransitRoute = (e, _item) => {

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

    const addStop=(e)=>{
        const _query={...query};
        _query.stops.push({ address: "", coordinates: "" });
        setQuery(_query);
    }

    const removeStop=(e,_index)=>{

        const _query={...query};
            
        if(_query.stops.length>2){
            _query.stops.splice(_index,1);
            setQuery(_query);
        }
    }

    return (<>
        <div className="common-query-window"
            style={{ visibility: props.windowManager.IsVisible(props.id) ? 'visible' : 'hidden' }}>
            <div className="common-query-window-header">
                <img className="common-query-window-header-icon" src={windowLogo}></img>
                <span>{windowTitle}</span>
                <CommonQueryWindowTools
                    windowManager={props.windowManager}
                    windowId={props.id}
                    setQueryField={setQueryField}
                    query={query}
                    showNearbySearch={activeTab == "form"}
                    showMapSelect={activeTab == "form"} />

            </div>
            <div className={"common-query-window-body "+ (props.windowManager.IsMinimized(props.id) ? "common-query-window-body-collapsed" : "")}>
                {
                    activeTab === "form" ?
                        <>
                            <Form onSubmit={(e) => btnSubmit_OnClick(e)}>
                                <Tabs defaultActiveKey="masstransitTab">
                                    <Tab eventKey="masstransitTab" title={<BiBus title="Toplu Taşıma" className="transit-route-query-tab-icon" />} onClick={(e) => setQueryField("type", "masstransit")}>
                                        <div className="transit-route-query-tab-container">
                                            <div className="transit-route-query-tab-title">Toplu Taşıma</div>
                                            <div className="transit-route-query-tab-body">

                                                <div onClick={(e) => setQueryField("showBusLines", !query.showBusLines)}
                                                    className="form-checkbox">
                                                    <span>Otobüs Hatları</span>{
                                                        query && query.showBusLines ? <BsToggleOn /> : <BsToggleOff />
                                                    }
                                                </div>

                                                <div onClick={(e) => setQueryField("showDolmusLines", !query.showDolmusLines)}
                                                    className="form-checkbox">
                                                    <span>Dolmuş Hatları</span>{
                                                        query && query.showDolmusLines ? <BsToggleOn /> : <BsToggleOff />
                                                    }
                                                </div>

                                                <div onClick={(e) => setQueryField("showMetroLines", !query.showMetroLines)}
                                                    className="form-checkbox">
                                                    <span>Metro Hatları</span>{
                                                        query && query.showMetroLines ? <BsToggleOn /> : <BsToggleOff />
                                                    }
                                                </div>

                                                <div onClick={(e) => setQueryField("showCablecarLines", !query.showCablecarLines)}
                                                    className="form-checkbox">
                                                    <span>Teleferik Hatları</span>{
                                                        query && query.showCablecarLines ? <BsToggleOn /> : <BsToggleOff />
                                                    }
                                                </div>
                                            </div>
                                        </div>
                                    </Tab>

                                    <Tab eventKey="carTab" title={<BiCar title="Araç" className="transit-route-query-tab-icon" />} onClick={(e) => setQueryField("type", "car")}>

                                    </Tab>

                                    <Tab eventKey="cycleTab" title={<BiCycling title="Bisiklet" className="transit-route-query-tab-icon" />} onClick={(e) => setQueryField("type", "bicycle")}>

                                    </Tab>

                                    <Tab eventKey="walkTab" title={<BiWalk title="Yürüme" className="transit-route-query-tab-icon" />} onClick={(e) => setQueryField("type", "walk")}>

                                    </Tab>
                                </Tabs>
                                <div className="transit-route-query-stops-select-container">
                                    <div>
                                            {
                                                query && query.stops.map((_stop,_index) => {
                                                    return <>
                                                    <div className="transit-route-query-stop-container">
                                                        <BiTargetLock className="transit-route-query-stop-icon" />
                                                        <input className="transit-route-query-stop-textbox" />
                                                        <BiMap className="transit-route-query-stop-icon-button" />
                                                        <BiXCircle className="transit-route-query-remove-icon-button" onClick={(e)=>removeStop(e,_index)} />
                                                        
                                                    </div>
                                                    {
                                                        _index != query.stops.length-1 && <>
                                                            <div className="transit-route-query-stop-dots"></div>

                                                        <BiSort className="transit-route-query-exchange-icon-button"/>
                                                        </>
                                                    }
                                                    
                                                    </>
                                                    
                                                })
                                            } 
                                        <div>
                                        <Button type="button" className="transit-route-query-add-stop-button" onClick={(e)=>addStop(e)}>
                                                <BiMap/> <span>Hedef Ekle</span>
                                            </Button>
                                        
                                        </div>
                                    </div>

                                </div>
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
                                            return <div className="result-item-container" onClick={(e) => item_OnClick(e, _item)}>
                                                <div className="result-item-info">
                                                    <div className="result-item-info-title">
                                                        {_item.Title}
                                                    </div>
                                                    <div className="result-item-info-address">
                                                        <FiMapPin />&nbsp;
                                                        {_item.Address}
                                                    </div>
                                          
                                                    <div className="result-item-info-phone">
                                                        <FiPhone />&nbsp;
                                                        {_item.Phone}
                                                    </div>
                                                </div>
                                                <CommonQueryResultItemTools
                                                    item={_item}
                                                    zoomCallback={(e) => item_OnClick(e, _item)}
                                                    showTransitRouteCallback={(e) => item_ShowTransitRoute(e, _item)}
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