import React, { useEffect, useImperativeHandle, useRef, useState } from "react";
import { Button, Form } from "react-bootstrap";
import { NumberingQueryBusiness } from "../../../Business/NumberingQueryBusiness";
import { Constants_MessageType, Constants_ServiceResultType } from "../../../Core/Constants";
import MapManager from "../../../Store/Managers/MapManager";
import { CommonQueryWindowTools } from "../_Common/CommonQueryWindowTools";
import { FastAccessQueryBusiness } from "../../../Business/FastAccessQueryBusiness";
import { BiSearch } from "react-icons/bi";
import { FiMapPin, FiPhone } from "react-icons/fi";
import { HiOutlineArrowNarrowLeft } from "react-icons/hi";
import { CommonQueryResultItemTools } from "../_Common/CommonQueryResultItemTools";
import { CommonBusiness } from "../../../Business/CommonBusiness";
import { DebugHelper } from "../../../Toolbox/DebugHelper";
import { GisGraphicsHelper } from "../../../Toolbox/GisGraphicsHelper";
import { ButtonLoading } from "../../Common/Loading";
import { LoggingBusiness } from "../../../Business/LoggingBusiness";

export const FastAccessQueryWindow = React.forwardRef((props, ref) => {

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



    const txtName_OnChange = (e) => {
        const name = e.target.value;
        setQueryField("name", name);
    }

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

    const defaultQuery = { name: null, districtId: null, nbhoodId: null, showMapSelect: false, showNearby: false, bufferDistance:0 };
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

        LoggingBusiness.CreateClientLog("Hızlı Erişim/Sorgu/"+props.windowTitle, query.districtName+"/"+query.nbhoodName+"/"+query.name);

        FastAccessQueryBusiness.QueryFastAccessService(props.queryServiceTitle,query,false).then((_result) => {

            if (_result.type == Constants_ServiceResultType.Success) {

                setActiveTab("query");

                const _symbol={
                    type: "picture-marker",
                    url: props.windowLogo,
                    width: "48px",
                    height: "48px"
                };

                CommonBusiness.Clustering.CreateClusterLayer(props.queryServiceTitle, props.windowTitle, query, _symbol).then((_clusterLayer) => {

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
        }).catch(error => {
            props.windowManager.ShowMessage(Constants_MessageType.Error,error.message); 
            setLoading(false);
        });

    }


    const getItemDetailsById=async(_item)=>{

        return new Promise((resolve, reject)=>{
            FastAccessQueryBusiness.QueryFastAccessService(props.queryServiceTitle,{ObjectId: _item.ObjectId},true).then((_result) => {
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

        LoggingBusiness.CreateClientLog("Hızlı Erişim/Detay Göster/"+props.windowTitle, _item.Id+"/"+_item.Title);

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
                <img className="common-query-window-header-icon" src={props.windowLogo}></img>
                <span>{props.windowTitle}</span>
                <CommonQueryWindowTools
                    ref={commonToolsComponentRef}
                    windowManager={props.windowManager}
                    windowId={props.id}
                    setQueryField={setQueryField}
                    showNearbySearch={activeTab == "form"}
                    showMapSelect={activeTab == "form"}
                    />
            </div>
            <div className={"common-query-window-body "+ (props.windowManager.IsMinimized(props.id) ? "common-query-window-body-collapsed" : "")}>
                {
                    activeTab === "form" ?
                        <>
                            <Form onSubmit={(e) => btnSubmit_OnClick(e)}>
                                {
                                    !query.mapSelect && <Form.Group>
                                        <label className="form-label">Adı</label>
                                        <input className="form-control" onChange={((e) => txtName_OnChange(e))} value={query.name} />
                                    </Form.Group>
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
                                                    <div className="result-item-info-address">
                                                        <FiMapPin />&nbsp;
                                                        {_item.Address}
                                                    </div>
                                           {
                                            /*
                                            
                                                    <div className="result-item-info-phone">
                                                        <FiPhone />&nbsp;
                                                        {_item.Phone}
                                                    </div>
                                            */
                                           }
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