import React, { useEffect, useImperativeHandle, useState } from "react";
import { Button, Form } from "react-bootstrap";
import { NumberingQueryBusiness } from "../../../Business/NumberingQueryBusiness";
import { Constants_MessageType, Constants_ServiceResultType } from "../../../Core/Constants";
import MapManager from "../../../Store/Managers/MapManager";
import { CommonQueryWindowTools } from "../_Common/CommonQueryWindowTools";
import { EventQueryBusiness } from "../../../Business/EventQueryBusiness";
import { BiSearch } from "react-icons/bi";
import { FiMapPin, FiPhone } from "react-icons/fi";
import { HiOutlineArrowNarrowLeft } from "react-icons/hi";
import { CommonQueryResultItemTools } from "../_Common/CommonQueryResultItemTools";
import { CommonBusiness } from "../../../Business/CommonBusiness";
import { DebugHelper } from "../../../Toolbox/DebugHelper";
import { GisGraphicsHelper } from "../../../Toolbox/GisGraphicsHelper";
import { ButtonLoading } from "../../Common/Loading";

import ReactDatePicker from "react-datepicker";
import "react-datepicker/dist/react-datepicker.css";
import tr from 'date-fns/locale/tr';
import { registerLocale } from "react-datepicker";
import { DatetimeHelper } from "../../../Toolbox/DatetimeHelper";
import { LoggingBusiness } from "../../../Business/LoggingBusiness";

export const EventQueryWindow = React.forwardRef((props, ref) => {

    registerLocale('tr', tr)

    const windowTitle = "Etkinlik";
    const windowLogo = "images/icons/sidebar/etkinlikler.png";

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

    const [styleLink,setStyleLink]=useState(null);
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



    const [nbhoodList, setNbhoodList] = useState(null);
    const cmbDistrict_OnChange = (e) => {

        const districtId = e.target.value;
        setQueryField("districtId", districtId);
        setQueryField("districtName", e.target.selectedOptions[0].text);
        
        setNbhoodList(null);

        NumberingQueryBusiness.GetNeighborhoodsOfDistrict(districtId).then((_result) => {

            if (_result.type == Constants_ServiceResultType.Success) {
                setNbhoodList(_result.data);
            }

        });
    }

    const cmbNbhood_OnChange = (e) => {
        const nbhoodId = e.target.value;
        setQueryField("nbhoodId", nbhoodId);
        setQueryField("nbhoodName", e.target.selectedOptions[0].text);
    }

    const defaultQuery = { name: null, districtId: null, nbhoodId: null, showMapSelect: false, showNearby: false };
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

    const [loading, setLoading]=useState(false);
    const btnSubmit_OnClick = (e) => {

        e?.preventDefault();
        setLoading(true);

        LoggingBusiness.CreateClientLog("Etkinlikler/Sorgu", query.districtName+"/"+query.nbhoodName+"/"+query.name);
        

        EventQueryBusiness.Query(query,false).then((_result) => {

            if (_result.type == Constants_ServiceResultType.Success) {

                setActiveTab("query");

                const symbol={
                    type: "picture-marker",
                    url: windowLogo,
                    width: "48px",
                    height: "48px"
                };

                CommonBusiness.Clustering.CreateClusterLayer("EventQueryUrl", props.windowTitle, query, symbol, true, "EventQueryAttachmentUrl").then((_clusterLayer) => {

                    removeLastClusterLayer();

                    setClusterLayer(_clusterLayer);
                    mapView.map.add(_clusterLayer.layerObj);

                });

                let list = [];

                _result.data.forEach(_item => {
                    list.push({
                        ObjectId: _item.attr.objectid,
                        Title: _item.attr["adi"],
                        Address: _item.attr["adres"],
                        StartDate: DatetimeHelper.ConvertFromEsriDate(_item.attr["baslangictarihi"]),
                        EndDate: DatetimeHelper.ConvertFromEsriDate(_item.attr["bitistarihi"]),
                    });
                });
                setResultList(list);
                setLoading(false);

            }
        }).catch(error => {
            props.windowManager.ShowMessage(Constants_MessageType.Error,error.message); 
            setLoading(false);
        });

    }


    const getItemDetailsById=async(_item)=>{

        return new Promise((resolve, reject)=>{
            EventQueryBusiness.Query({ObjectId: _item.ObjectId},true).then((_result) => {
                if(_result.type==Constants_ServiceResultType.Success){
                    if(_result.data!=null){
                        const _resultItem=_result.data[0];
                        resolve(_resultItem);
                    }
                    else{
                        reject(null);
                    }
                }
            });
        });

    }

    const item_OnClick = (e, _item) => {

        LoggingBusiness.CreateClientLog("Etkinlikler/Detay Göster", _item.Id+"/"+_item.Title);

        getItemDetailsById(_item).then(_itemDetails =>  {
            
            GisGraphicsHelper.ZoomToGeometry(mapView, _itemDetails?.geometry, 18);
            
            if(window.screen.width<960){
                props.windowManager.ToggleMinimiseWindow(props.id);
            }     
        });   
    }

    const item_ShowRoute=(e, _item)=>{
        
        getItemDetailsById(_item).then(_itemDetails =>  {

            if(_itemDetails!=null){
                const lat=_itemDetails.geometry.latitude;
            const lng=_itemDetails.geometry.longitude;
            let url = "https://www.google.com.tr/maps?saddr=My+Location&daddr=" + lat + "," + lng;
            window.open(url, "_blank");
            //TODO: create log
            }
            else{
                props.windowManager.ShowMessage(Constants_MessageType.Error,"Yol tarifi alınamadı - öğe detayları bulunamadı");
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
                                {
                                    !query.mapSelect && 
                                    <>
                                    <div className="horizontal-layout">
                                    <Form.Group className="vertical-layout">
                                        <label className="form-label">Başlangıç Tarihi</label>
                                        <ReactDatePicker selected={query.startDate} locale="tr" dateFormat="dd.MM.yyyy"
                                        className="form-control" placeholderText="Seçiniz..."
                                        onChange={(date) => setQueryField("startDate",date)} />
                                    </Form.Group>
                                    <Form.Group className="vertical-layout">
                                        <label className="form-label">Bitiş Tarihi</label>
                                        <ReactDatePicker selected={query.endDate} locale="tr" dateFormat="dd.MM.yyyy"
                                        className="form-control" placeholderText="Seçiniz..."
                                        onChange={(date) => setQueryField("endDate",date)} />
                                    </Form.Group>
                                    </div>
                                    
                                    </>
                                }

                                {
                                    (!query.showNearby && !query.mapSelect) && <>
                                        <Form.Group>
                                            <label className="form-label">İlçe</label>
                                            <select className="form-select form-control" onChange={((e) => cmbDistrict_OnChange(e))}
                                                value={query.districtId}>
                                                <option value="">Seçiniz..</option>
                                                {
                                                    districtList?.map(_item => {
                                                        return <option value={_item.attr.id}>{_item.attr.ad}</option>
                                                    })
                                                }
                                            </select>
                                        </Form.Group>
                                        <Form.Group>
                                            <label className="form-label">Mahalle</label>
                                            <select className="form-select" onChange={((e) => cmbNbhood_OnChange(e))}
                                                value={query.nbhoodId}>
                                                <option value="">Seçiniz..</option>
                                                {
                                                    nbhoodList?.map(_item => {
                                                        return <option value={_item.attr.id}>{_item.attr.ad}</option>
                                                    })
                                                }
                                            </select>
                                        </Form.Group></>
                                }
                                {
                                    !query.mapSelect &&
                                    <Form.Group>
                                        {
                                         loading ? <ButtonLoading/>
                                         :<Button type="button" className="form-button" onClick={(e) => btnSubmit_OnClick()}>
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
                                                    <div className="result-item-info-date">
                                                        {
                                                         _item.StartDate ==_item.EndDate  ? _item.StartDate : _item.StartDate+" - "+_item.EndDate
                                                        }
                                                    </div>
                                                    <div className="result-item-info-address">
                                                        <FiMapPin />&nbsp;
                                                        {_item.Address}
                                                    </div>
                                                </div>
                                                <CommonQueryResultItemTools 
                                                    item={_item}
                                                    zoomCallback={(e)=>item_OnClick(e,_item)}
                                                    showRouteCallback={(e)=>item_ShowRoute(e,_item)}
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